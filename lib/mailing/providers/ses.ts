import { GetAccountCommand, GetEmailIdentityCommand, SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { assertServerOnly } from "../../server-only.js";
import { loadMailConfig } from "../config.js";
import type { AccountStatus, IdentityStatus, MailProvider, OutboundMessage, SendOutcome } from "./types.js";

assertServerOnly("lib/mailing/providers/ses.ts");

/** El proveedor respondió, con certeza, que NO envió el mensaje. */
const DEFINITE_REJECTIONS = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "AccountSuspendedException",
  "SendingPausedException",
  "NotFoundException",
  "BadRequestException",
  "InvalidParameterValue",
  "ValidationException",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "ExpiredTokenException",
  // el SDK no pudo obtener credenciales: no se llegó a llamar a SES
  "CredentialsProviderError",
  "CredentialsError",
  "CredentialProviderError",
]);
/** Rechazos por ritmo/cuota: el mensaje NO salió y reintentar más tarde es seguro. */
const RETRYABLE_REJECTIONS = new Set(["TooManyRequestsException", "ThrottlingException", "LimitExceededException", "Throttling"]);

interface AwsLikeError {
  name?: string;
  message?: string;
  $fault?: string;
  $metadata?: { httpStatusCode?: number };
}

export function classifySesError(err: unknown): SendOutcome {
  const e = (err ?? {}) as AwsLikeError;
  const name = e.name ?? "Error";
  const message = typeof e.message === "string" ? e.message.slice(0, 300) : "error";
  if (RETRYABLE_REJECTIONS.has(name)) return { kind: "rejected", code: name, message, retryable: true };
  if (DEFINITE_REJECTIONS.has(name)) return { kind: "rejected", code: name, message, retryable: false };
  // 4xx con respuesta del servicio y falla del cliente: el servicio no procesó el envío.
  const status = e.$metadata?.httpStatusCode;
  // 429 = límite de ritmo, aunque el SDK no haya podido tipar el error: el mensaje no salió y reintentar es seguro.
  if (status === 429) return { kind: "rejected", code: name, message, retryable: true };
  if (e.$fault === "client" && typeof status === "number" && status >= 400 && status < 500) {
    return { kind: "rejected", code: name, message, retryable: false };
  }
  // Timeouts, cortes de red, 5xx, errores desconocidos: puede que SES haya aceptado. NO se reintenta sola.
  return { kind: "unknown", code: name, message };
}

export class SesProvider implements MailProvider {
  readonly name = "ses" as const;
  private client: SESv2Client | null = null;

  private getClient(): SESv2Client {
    if (!this.client) {
      const config = loadMailConfig();
      if (!config.region) throw new Error("Falta AWS_REGION.");
      this.client = new SESv2Client({
        region: config.region,
        maxAttempts: 1, // los reintentos los decide el worker (idempotencia), no el SDK
        requestHandler: { requestTimeout: 20_000, connectionTimeout: 5_000 } as never,
      });
    }
    return this.client;
  }

  async send(message: OutboundMessage, options: { configurationSet?: string | null } = {}): Promise<SendOutcome> {
    let client: SESv2Client;
    try {
      client = this.getClient();
    } catch (err) {
      return { kind: "rejected", code: "NotConfigured", message: err instanceof Error ? err.message : "Proveedor sin configurar.", retryable: false };
    }
    try {
      const response = await client.send(
        new SendEmailCommand({
          FromEmailAddress: message.from,
          Destination: { ToAddresses: [message.to] },
          ReplyToAddresses: message.replyTo ? [message.replyTo] : undefined,
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: "UTF-8" },
              Body: { Html: { Data: message.html, Charset: "UTF-8" }, Text: { Data: message.text, Charset: "UTF-8" } },
              Headers: message.headers ? Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) : undefined,
            },
          },
          ConfigurationSetName: options.configurationSet ?? undefined,
          EmailTags: message.tags ? Object.entries(message.tags).map(([Name, Value]) => ({ Name, Value })) : undefined,
        })
      );
      if (!response.MessageId) return { kind: "unknown", code: "NoMessageId", message: "SES respondió sin MessageId." };
      return { kind: "accepted", messageId: response.MessageId };
    } catch (err) {
      return classifySesError(err);
    }
  }

  async getAccountStatus(): Promise<AccountStatus> {
    try {
      const r = await this.getClient().send(new GetAccountCommand({}));
      return {
        sandbox: r.ProductionAccessEnabled === undefined ? null : !r.ProductionAccessEnabled,
        sendingEnabled: r.SendingEnabled ?? null,
        max24HourSend: r.SendQuota?.Max24HourSend ?? null,
        maxSendRate: r.SendQuota?.MaxSendRate ?? null,
        sentLast24Hours: r.SendQuota?.SentLast24Hours ?? null,
      };
    } catch (err) {
      const e = err as AwsLikeError;
      return { sandbox: null, sendingEnabled: null, max24HourSend: null, maxSendRate: null, sentLast24Hours: null, error: `${e.name ?? "Error"}` };
    }
  }

  async getIdentityStatus(identity: string): Promise<IdentityStatus> {
    try {
      const r = await this.getClient().send(new GetEmailIdentityCommand({ EmailIdentity: identity }));
      if (r.VerifiedForSendingStatus) return "verified";
      const s = r.VerificationStatus;
      if (s === "FAILED" || s === "TEMPORARY_FAILURE") return "failed";
      if (s === "PENDING") return "pending";
      return "unknown";
    } catch (err) {
      const e = err as AwsLikeError;
      if (e.name === "NotFoundException") return "pending";
      return "unknown";
    }
  }
}
