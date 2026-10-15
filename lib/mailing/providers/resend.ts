import { assertServerOnly } from "../../server-only.js";
import { loadMailConfig } from "../config.js";
import type { AccountStatus, IdentityCheck, IdentityStatus, MailProvider, OutboundMessage, SendOutcome } from "./types.js";

assertServerOnly("lib/mailing/providers/resend.ts");

const API_BASE = "https://api.resend.com";
const REQUEST_TIMEOUT_MS = 20_000;
/** Dirección de prueba oficial de Resend: acepta el envío y simula una entrega; no llega a ninguna persona real. */
const VERIFY_RECIPIENT = "delivered@resend.dev";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

interface ResendErrorBody {
  name?: string;
  message?: string;
  statusCode?: number;
}

function parseBody(text: string): Record<string, unknown> & ResendErrorBody {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown> & ResendErrorBody) : {};
  } catch {
    return {};
  }
}

const short = (v: unknown, max = 300): string => (typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, max) : "error");

/**
 * Traduce una respuesta HTTP de Resend a `SendOutcome`. Pura (testeable). LA DISTINCIÓN CRÍTICA sigue siendo rejected vs unknown:
 *  - 2xx con id               → accepted.
 *  - 400/401/403/404/422      → Resend respondió que NO envió y reintentar igual no sirve → rejected definitivo.
 *  - 429 rate_limit_exceeded  → NO envió; reintentar con espera es seguro → rejected retryable.
 *  - 429 daily/monthly quota  → NO envió, pero afecta a toda la cuenta (el worker pausa la campaña).
 *  - 409 / 5xx / sin respuesta / cualquier otro → puede que haya salido: unknown (NUNCA se reintenta sola).
 */
export function classifyResendResponse(status: number, bodyText: string): SendOutcome {
  const body = parseBody(bodyText);
  const name = typeof body.name === "string" ? body.name : null;
  const message = short(body.message);

  if (status >= 200 && status < 300) {
    const id = typeof body.id === "string" && body.id.length > 0 ? body.id : null;
    return id ? { kind: "accepted", messageId: id } : { kind: "unknown", code: "NoMessageId", message: "Resend respondió sin id de mensaje." };
  }
  if (status === 429) {
    const code = name ?? "rate_limit_exceeded";
    if (code === "daily_quota_exceeded" || code === "monthly_quota_exceeded") return { kind: "rejected", code, message, retryable: false };
    return { kind: "rejected", code, message, retryable: true };
  }
  // 403 con `validation_error`: el dominio del remitente no está verificado (o la cuenta solo puede enviar a su propia dirección).
  // Afecta a todo envío con ese remitente, así que se informa con un código de cuenta y no destinatario por destinatario.
  if (status === 403 && (name === "validation_error" || name === null)) return { kind: "rejected", code: "domain_not_verified", message, retryable: false };
  if ([400, 401, 403, 404, 405, 422].includes(status)) return { kind: "rejected", code: name ?? `http_${status}`, message, retryable: false };
  return { kind: "unknown", code: name ?? `http_${status}`, message };
}

/** Interpreta el resultado del envío de prueba a `delivered@resend.dev` como estado de la identidad (sin pedir permisos extra). */
export function classifyResendIdentityResponse(identity: string, status: number, bodyText: string): IdentityCheck {
  const base = { identity, region: null as string | null };
  const body = parseBody(bodyText);
  const name = typeof body.name === "string" ? body.name : null;
  const detail = short(body.message, 160);
  if (status >= 200 && status < 300) {
    return { ...base, outcome: "verified", message: `«${identity}» puede enviar por Resend: el dominio está verificado.` };
  }
  if (status === 403 && (name === "validation_error" || name === null)) {
    return { ...base, outcome: "pending", code: name ?? "http_403", message: `Resend no tiene verificado el dominio de «${identity}» (${detail}). Verificá el dominio en el panel de Resend.` };
  }
  if (status === 401 || status === 403) {
    return { ...base, outcome: "error", code: name ?? `http_${status}`, message: `Resend rechazó la clave (${name ?? status}): ${detail}. Revisá RESEND_API_KEY y que tenga permiso de envío.` };
  }
  if (status === 429) {
    return { ...base, outcome: "error", code: name ?? "http_429", message: `Resend limitó la consulta (${name ?? "429"}). Probá de nuevo en unos minutos.` };
  }
  return { ...base, outcome: "error", code: name ?? `http_${status}`, message: `No se pudo consultar a Resend (${name ?? status}): ${detail}` };
}

export class ResendProvider implements MailProvider {
  readonly name = "resend" as const;

  constructor(private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  private apiKey(): string | null {
    loadMailConfig(); // carga el .env como el resto del módulo
    const key = process.env.RESEND_API_KEY?.trim();
    return key ? key : null;
  }

  private async post(path: string, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<{ status: number; text: string } | { error: "timeout" | "network" }> {
    const key = this.apiKey();
    if (!key) throw new Error("Falta RESEND_API_KEY.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${API_BASE}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "sutecba-crm/mailing", ...extraHeaders },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return { status: response.status, text: await response.text() };
    } catch (err) {
      return { error: (err as { name?: string }).name === "AbortError" ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    if (!this.apiKey()) {
      return { kind: "rejected", code: "NotConfigured", message: "Falta RESEND_API_KEY.", retryable: false };
    }
    const payload: Record<string, unknown> = {
      from: message.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    };
    if (message.replyTo) payload.reply_to = [message.replyTo];
    if (message.headers) payload.headers = message.headers;
    if (message.tags) payload.tags = Object.entries(message.tags).map(([name, value]) => ({ name, value }));

    const headers: Record<string, string> = {};
    if (message.idempotencyKey) headers["Idempotency-Key"] = message.idempotencyKey.slice(0, 256);

    const r = await this.post("/emails", payload, headers);
    if ("error" in r) {
      // Timeout o corte de red: puede que Resend haya aceptado. NO se reintenta sola.
      return { kind: "unknown", code: r.error === "timeout" ? "Timeout" : "NetworkError", message: "Sin respuesta de Resend." };
    }
    return classifyResendResponse(r.status, r.text);
  }

  /** Resend no expone sandbox ni cuota por API a una clave de solo envío: no hay nada que consultar (y nada que bloquee el lanzamiento). */
  async getAccountStatus(): Promise<AccountStatus> {
    if (!this.apiKey()) {
      return { sandbox: null, sendingEnabled: null, max24HourSend: null, maxSendRate: null, sentLast24Hours: null, error: "Sin RESEND_API_KEY" };
    }
    return { sandbox: null, sendingEnabled: null, max24HourSend: null, maxSendRate: null, sentLast24Hours: null };
  }

  /**
   * Una clave `Sending access` no puede leer los dominios (Resend responde `restricted_api_key`). La identidad se COMPRUEBA con un
   * envío de prueba a la dirección de test oficial `delivered@resend.dev`: Resend lo acepta solo si el dominio del remitente está
   * verificado. Nunca se marca «verificada» sin esa respuesta. Cuenta contra la cuota, pero no llega a ninguna persona.
   */
  async checkIdentity(identity: string): Promise<IdentityCheck> {
    const value = identity.trim();
    const from = value.includes("@") ? value : `verificacion@${value}`;
    if (!this.apiKey()) {
      return { identity: value, region: null, outcome: "error", code: "NotConfigured", message: "El CRM no tiene RESEND_API_KEY." };
    }
    const r = await this.post("/emails", {
      from,
      to: [VERIFY_RECIPIENT],
      subject: "Verificación de remitente SUTECBA",
      text: "Comprobación automática del remitente. No requiere ninguna acción.",
      tags: [{ name: "kind", value: "verify" }],
    });
    if ("error" in r) {
      return { identity: value, region: null, outcome: "error", code: r.error === "timeout" ? "Timeout" : "NetworkError", message: "No se pudo contactar a Resend." };
    }
    return classifyResendIdentityResponse(value, r.status, r.text);
  }

  async getIdentityStatus(identity: string): Promise<IdentityStatus> {
    const c = await this.checkIdentity(identity);
    return c.outcome === "error" ? "unknown" : c.outcome;
  }
}
