import { NextResponse, type NextRequest } from "next/server";
import { loadDotEnvFile } from "@/lib/db/env";
import { applyProviderEvent } from "@/lib/mailing/events";
import { parseResendEvent, verifySvixSignature } from "@/lib/mailing/resend-webhook";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;
/** Un evento sin destinatario puede haber llegado antes de que se guarde el id del envío: se pide reintento solo dentro de esta ventana. */
const UNMATCHED_RETRY_WINDOW_MS = 10 * 60 * 1000;

const reply = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Webhook de Resend (Svix). PÚBLICO a propósito (no hay sesión): lo protege la firma, que se verifica sobre el cuerpo CRUDO antes de
 * leer o modificar nada. Nunca se loguean cabeceras, cuerpo, emails ni el secreto.
 *
 *   401 firma inválida/ausente o timestamp vencido · 413 cuerpo excesivo · 400 JSON inválido (firmado)
 *   503 sin RESEND_WEBHOOK_SECRET, o evento aún sin destinatario dentro de la ventana de reintento (Resend reintenta)
 *   200 aplicado, duplicado o ignorado (los reintentos del proveedor son idempotentes)
 */
export async function POST(request: NextRequest) {
  loadDotEnvFile();
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return reply(503, { error: "not_configured" });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return reply(413, { error: "payload_too_large" });

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return reply(413, { error: "payload_too_large" });

  const check = verifySvixSignature(
    rawBody,
    { id: request.headers.get("svix-id"), timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature") },
    secret
  );
  if (!check.ok) {
    console.warn(JSON.stringify({ at: new Date().toISOString(), worker: "resend-webhook", message: "firma rechazada", reason: check.reason }));
    return reply(401, { error: "invalid_signature" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return reply(400, { error: "invalid_json" });
  }

  const events = parseResendEvent(payload);
  if (events.length === 0) return reply(200, { status: "ignored" });

  const counts = { applied: 0, duplicate: 0, unmatched: 0, ignored: 0 };
  let retry = false;
  for (const event of events) {
    if (event.isTest) {
      counts.ignored += 1; // pruebas del CRM (envío de prueba / verificación de remitente): no corresponden a ningún destinatario
      continue;
    }
    const result = await applyProviderEvent(event);
    counts[result] += 1;
    if (result === "unmatched" && Date.now() - event.at.getTime() < UNMATCHED_RETRY_WINDOW_MS) retry = true;
  }
  if (retry) return reply(503, { status: "retry", ...counts });
  return reply(200, { status: "ok", ...counts });
}

export async function GET() {
  return reply(405, { error: "method_not_allowed" });
}
