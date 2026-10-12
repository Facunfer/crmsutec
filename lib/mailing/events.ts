import { createHash } from "node:crypto";
import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { suppressEmail } from "./suppressions.js";

assertServerOnly("lib/mailing/events.ts");

/**
 * Eventos de Amazon SES (Configuration Set → SNS → SQS). Dos pasos separados y puros:
 *   1. `parseSesNotification` — del cuerpo (sobre SNS o evento crudo) a eventos normalizados con CLAVE determinista.
 *   2. `applyProviderEvent`   — transacción: inserta el evento (UNIQUE provider_event_key) y, solo si es nuevo, mueve el estado.
 *
 * Reglas:
 *  - Idempotente: un evento repetido (misma clave) no vuelve a modificar nada.
 *  - Fuera de orden: el estado nunca retrocede (delivered no pisa bounced/complained/unsubscribed; sent no pisa delivered).
 *  - Ningún evento de mailing es contacto real ni escribe interacciones de la persona (B5).
 *  - Solo se guarda un resumen seguro del payload, jamás el bruto.
 */
export type ProviderEventType = "send" | "delivery" | "bounce" | "soft_bounce" | "complaint" | "reject" | "open" | "click" | "delivery_delay" | "rendering_failure";

export interface ParsedProviderEvent {
  key: string;
  messageId: string;
  type: ProviderEventType;
  at: Date;
  safe: Record<string, string | number | boolean | null>;
  /** Solo para bounce: true si es permanente. */
  permanent?: boolean;
  isTest: boolean;
}

function asDate(value: unknown, fallback: Date): Date {
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

const short = (v: unknown, max = 120): string | null => (typeof v === "string" ? v.slice(0, max) : null);

/** Parsea el cuerpo de un mensaje de SQS (sobre de SNS con `Message` como texto, o el evento crudo). Devuelve [] si no es un evento SES. */
export function parseSesNotification(body: string, now: Date = new Date()): ParsedProviderEvent[] {
  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return [];
  }
  let event: Record<string, unknown> = outer;
  if (typeof outer.Message === "string") {
    try {
      event = JSON.parse(outer.Message) as Record<string, unknown>;
    } catch {
      return [];
    }
  }
  const kindRaw = (event.eventType ?? event.notificationType) as unknown;
  const mail = event.mail as Record<string, unknown> | undefined;
  const messageId = short(mail?.messageId, 200);
  if (typeof kindRaw !== "string" || !messageId) return [];
  const tags = (mail?.tags ?? {}) as Record<string, unknown>;
  const isTest = Array.isArray(tags.kind) ? tags.kind.includes("test") : tags.kind === "test";
  const mailAt = asDate(mail?.timestamp, now);
  const base = (type: ProviderEventType, at: Date, discriminator: string, safe: ParsedProviderEvent["safe"], permanent?: boolean): ParsedProviderEvent => ({
    key: `ses:${messageId}:${type}:${createHash("sha256").update(discriminator).digest("hex").slice(0, 24)}`,
    messageId,
    type,
    at,
    safe,
    permanent,
    isTest,
  });

  switch (kindRaw.toLowerCase()) {
    case "send":
      return [base("send", mailAt, "send", {})];
    case "delivery": {
      const d = (event.delivery ?? {}) as Record<string, unknown>;
      const at = asDate(d.timestamp, now);
      return [base("delivery", at, `delivery:${at.toISOString()}`, { smtpResponse: short(d.smtpResponse, 200), processingTimeMillis: typeof d.processingTimeMillis === "number" ? d.processingTimeMillis : null })];
    }
    case "bounce": {
      const b = (event.bounce ?? {}) as Record<string, unknown>;
      const at = asDate(b.timestamp, now);
      const permanent = b.bounceType === "Permanent";
      return [
        base(permanent ? "bounce" : "soft_bounce", at, `bounce:${at.toISOString()}:${short(b.feedbackId, 80) ?? ""}`, { bounceType: short(b.bounceType, 30), bounceSubType: short(b.bounceSubType, 40) }, permanent),
      ];
    }
    case "complaint": {
      const c = (event.complaint ?? {}) as Record<string, unknown>;
      const at = asDate(c.timestamp, now);
      return [base("complaint", at, `complaint:${at.toISOString()}:${short(c.feedbackId, 80) ?? ""}`, { feedbackType: short(c.complaintFeedbackType, 40) })];
    }
    case "reject": {
      const r = (event.reject ?? {}) as Record<string, unknown>;
      return [base("reject", mailAt, "reject", { reason: short(r.reason, 120) })];
    }
    case "open": {
      const o = (event.open ?? {}) as Record<string, unknown>;
      const at = asDate(o.timestamp, now);
      return [base("open", at, `open:${at.toISOString()}`, {})];
    }
    case "click": {
      const c = (event.click ?? {}) as Record<string, unknown>;
      const at = asDate(c.timestamp, now);
      return [base("click", at, `click:${at.toISOString()}:${short(c.link, 300) ?? ""}`, { link: short(c.link, 300) })];
    }
    case "deliverydelay": {
      const d = (event.deliveryDelay ?? {}) as Record<string, unknown>;
      const at = asDate(d.timestamp, now);
      return [base("delivery_delay", at, `delay:${at.toISOString()}`, { delayType: short(d.delayType, 40) })];
    }
    case "rendering failure":
    case "renderingfailure": {
      const f = (event.failure ?? {}) as Record<string, unknown>;
      return [base("rendering_failure", mailAt, "render", { errorMessage: short(f.errorMessage, 160) })];
    }
    default:
      return [];
  }
}

export type ApplyResult = "applied" | "duplicate" | "unmatched";

/** Estados desde los que una entrega puede marcarse `delivered` (nunca desde bounced/complained/unsubscribed/failed/suppressed). */
const DELIVERABLE = ["sending", "send_unknown", "sent"];

export async function applyProviderEvent(event: ParsedProviderEvent): Promise<ApplyResult> {
  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const found = await sql<{ id: string; campaign_id: string; normalized_email: string; status: string }>`
      select id, campaign_id, normalized_email, status from mailing_campaign_recipients
      where provider_message_id = ${event.messageId} for update`.execute(trx);
    const recipient = found.rows[0];
    if (!recipient) return "unmatched" as const;

    const inserted = await sql<{ id: string }>`
      insert into mailing_events (campaign_id, recipient_id, provider_event_key, provider_message_id, event_type, event_at, payload_safe)
      values (${recipient.campaign_id}::uuid, ${recipient.id}::uuid, ${event.key}, ${event.messageId}, ${event.type}, ${event.at}, ${JSON.stringify(event.safe)}::jsonb)
      on conflict (provider_event_key) do nothing returning id`.execute(trx);
    if (inserted.rows.length === 0) return "duplicate" as const;

    const id = recipient.id;
    switch (event.type) {
      case "delivery":
        await sql`
          update mailing_campaign_recipients
             set delivered_at = coalesce(delivered_at, ${event.at}),
                 status = case when status = any(${DELIVERABLE}::text[]) then 'delivered' else status end, updated_at = now()
           where id = ${id}::uuid`.execute(trx);
        break;
      case "bounce":
        await sql`
          update mailing_campaign_recipients
             set bounced_at = coalesce(bounced_at, ${event.at}),
                 status = case when status in ('complained') then status else 'bounced' end, updated_at = now()
           where id = ${id}::uuid`.execute(trx);
        await suppressEmail(trx, { email: recipient.normalized_email, reason: "hard_bounce", source: "ses_event", campaignId: recipient.campaign_id, providerEventId: event.key });
        break;
      case "soft_bounce":
        await sql`update mailing_campaign_recipients set soft_bounce_count = soft_bounce_count + 1, updated_at = now() where id = ${id}::uuid`.execute(trx);
        break;
      case "complaint":
        await sql`
          update mailing_campaign_recipients
             set complained_at = coalesce(complained_at, ${event.at}), status = 'complained', updated_at = now()
           where id = ${id}::uuid`.execute(trx);
        await suppressEmail(trx, { email: recipient.normalized_email, reason: "complaint", source: "ses_event", campaignId: recipient.campaign_id, providerEventId: event.key });
        break;
      case "reject":
      case "rendering_failure":
        await sql`
          update mailing_campaign_recipients
             set failed_at = coalesce(failed_at, ${event.at}), last_error = ${event.type},
                 status = case when status in ('bounced', 'complained', 'unsubscribed') then status else 'failed' end, updated_at = now()
           where id = ${id}::uuid`.execute(trx);
        break;
      case "open":
        await sql`update mailing_campaign_recipients set opened_at = coalesce(opened_at, ${event.at}), open_count = open_count + 1, updated_at = now() where id = ${id}::uuid`.execute(trx);
        break;
      case "click":
        await sql`update mailing_campaign_recipients set clicked_at = coalesce(clicked_at, ${event.at}), click_count = click_count + 1, updated_at = now() where id = ${id}::uuid`.execute(trx);
        break;
      default:
        break; // send / delivery_delay: solo registro
    }
    return "applied" as const;
  });
}
