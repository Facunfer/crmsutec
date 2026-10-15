import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { assertServerOnly } from "../server-only.js";
import type { ParsedProviderEvent, ProviderEventType } from "./events.js";

assertServerOnly("lib/mailing/resend-webhook.ts");

/**
 * Webhooks de Resend (firmados con Svix). Dos funciones puras, sin acceso a la base:
 *   1. `verifySvixSignature` — comprueba la firma sobre el cuerpo CRUDO antes de tocar nada.
 *   2. `parseResendEvent`    — del evento verificado a eventos normalizados (mismos tipos que SES) con CLAVE determinista.
 *
 * Esquema de firma (documentación oficial de Svix): contenido firmado = `${svix-id}.${svix-timestamp}.${cuerpo crudo}`,
 * HMAC-SHA256 con la clave decodificada en base64 de lo que sigue a `whsec_`, firma en base64; `svix-signature` es una lista
 * separada por espacios de `v1,<firma>`. Se compara en tiempo constante y se rechaza un timestamp fuera de tolerancia (replay).
 */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type SignatureCheck = { ok: true } | { ok: false; reason: "missing_headers" | "bad_secret" | "stale_timestamp" | "bad_signature" };

export function verifySvixSignature(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  now: Date = new Date(),
  toleranceSeconds: number = SVIX_TOLERANCE_SECONDS
): SignatureCheck {
  if (!headers.id || !headers.timestamp || !headers.signature) return { ok: false, reason: "missing_headers" };
  if (!secret.startsWith("whsec_")) return { ok: false, reason: "bad_secret" };
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  if (key.length === 0) return { ok: false, reason: "bad_secret" };

  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "stale_timestamp" };
  if (Math.abs(Math.floor(now.getTime() / 1000) - ts) > toleranceSeconds) return { ok: false, reason: "stale_timestamp" };

  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest();
  const candidates = headers.signature
    .split(" ")
    .map((part) => part.split(","))
    .filter((p): p is [string, string] => p.length === 2 && p[0] === "v1")
    .map(([, sig]) => Buffer.from(sig, "base64"));
  const valid = candidates.some((sig) => sig.length === expected.length && timingSafeEqual(sig, expected));
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}

const short = (v: unknown, max = 120): string | null => (typeof v === "string" ? v.slice(0, max) : null);

function asDate(value: unknown, fallback: Date): Date {
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

/**
 * Evento verificado de Resend → eventos normalizados. Devuelve [] para lo que no es un evento de correo con `email_id`
 * (dominios, contactos, `email.received`, `email.scheduled`…): se responde 200 y se ignora.
 *
 * Mapeo explícito (no se asume que coincida con SES):
 *   email.sent             → send              email.delivered        → delivery
 *   email.delivery_delayed → delivery_delay    email.opened           → open
 *   email.clicked          → click             email.complained       → complaint (suprime)
 *   email.bounced          → bounce (type=Permanent, suprime) | soft_bounce (Temporary u otro: nunca suprime ante la duda)
 *   email.failed           → reject (el envío no se pudo realizar)
 *   email.suppressed       → reject con reason «suppressed» (Resend lo descartó por su propia lista de supresión)
 *
 * La clave de idempotencia sale del CONTENIDO (id de correo, tipo, instante y enlace), no solo de svix-id: así un reintento
 * del proveedor y una repetición manual desde su panel colapsan en el mismo evento.
 */
export function parseResendEvent(payload: unknown, now: Date = new Date()): ParsedProviderEvent[] {
  if (!payload || typeof payload !== "object") return [];
  const event = payload as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : null;
  const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : null;
  const emailId = data ? short(data.email_id, 200) : null;
  if (!type || !type.startsWith("email.") || !data || !emailId) return [];

  const tags = (data.tags && typeof data.tags === "object" ? data.tags : {}) as Record<string, unknown>;
  const isTest = tags.kind === "test" || tags.kind === "verify";
  const envelopeAt = asDate(event.created_at, now);

  const make = (
    mapped: ProviderEventType,
    at: Date,
    discriminator: string,
    safe: ParsedProviderEvent["safe"],
    permanent?: boolean
  ): ParsedProviderEvent[] => [
    {
      key: `resend:${emailId}:${mapped}:${createHash("sha256").update(discriminator).digest("hex").slice(0, 24)}`,
      messageId: emailId,
      type: mapped,
      at,
      safe,
      permanent,
      isTest,
      source: "resend_event",
      provider: "resend",
    },
  ];

  switch (type) {
    case "email.sent":
      return make("send", envelopeAt, `sent:${envelopeAt.toISOString()}`, {});
    case "email.delivered":
      return make("delivery", envelopeAt, `delivered:${envelopeAt.toISOString()}`, {});
    case "email.delivery_delayed":
      return make("delivery_delay", envelopeAt, `delayed:${envelopeAt.toISOString()}`, {});
    case "email.bounced": {
      const b = (data.bounce && typeof data.bounce === "object" ? data.bounce : {}) as Record<string, unknown>;
      const permanent = b.type === "Permanent";
      return make(
        permanent ? "bounce" : "soft_bounce",
        envelopeAt,
        `bounced:${envelopeAt.toISOString()}:${short(b.type, 30) ?? ""}:${short(b.subType, 40) ?? ""}`,
        { bounceType: short(b.type, 30), bounceSubType: short(b.subType, 40) },
        permanent
      );
    }
    case "email.complained":
      return make("complaint", envelopeAt, `complained:${envelopeAt.toISOString()}`, {});
    case "email.opened": {
      const o = (data.open && typeof data.open === "object" ? data.open : {}) as Record<string, unknown>;
      const at = asDate(o.timestamp, envelopeAt);
      return make("open", at, `opened:${at.toISOString()}`, {});
    }
    case "email.clicked": {
      const c = (data.click && typeof data.click === "object" ? data.click : {}) as Record<string, unknown>;
      const at = asDate(c.timestamp, envelopeAt);
      const link = short(c.link, 300);
      return make("click", at, `clicked:${at.toISOString()}:${link ?? ""}`, { link });
    }
    case "email.failed": {
      const f = (data.failed && typeof data.failed === "object" ? data.failed : {}) as Record<string, unknown>;
      return make("reject", envelopeAt, `failed:${envelopeAt.toISOString()}`, { reason: short(f.reason, 120) ?? "failed" });
    }
    case "email.suppressed":
      return make("reject", envelopeAt, `suppressed:${envelopeAt.toISOString()}`, { reason: "suppressed" });
    default:
      return [];
  }
}
