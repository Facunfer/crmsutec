import { createHash } from "node:crypto";
import { assertServerOnly } from "../server-only.js";
import { consumePublicLinkAttempt, settlePublicLinkAttempt } from "../security/public-rate-limit.js";

assertServerOnly("lib/mailing/unsubscribe-limit.ts");

/**
 * Rate limit básico del endpoint público de baja (mismo patrón y tabla `public_link_attempts` que check-in e invitaciones).
 *
 * Umbrales altos a propósito: el «un clic» de Gmail/Outlook sale de pocas IPs del proveedor y cada destinatario tiene su propio
 * enlace. Por identificador (el enlace) 30 intentos cada 10 minutos; por IP 600. Solo se registran los intentos PERMITIDOS, así
 * un bloqueo se levanta solo al pasar la ventana. No afecta la idempotencia: repetir una baja ya hecha no hace nada.
 */
const SCOPE = "unsubscribe";

/** `ip` ya viene resuelta por `resolveClientIp` (solo entradas de nuestros proxies, S4): este módulo no lee encabezados. */
export async function allowUnsubscribeAttempt(token: string, ip: string): Promise<boolean> {
  const identifier = createHash("sha256").update(token).digest("hex").slice(0, 32);
  const attempt = await consumePublicLinkAttempt(SCOPE, identifier, ip, { perIdentifierLimit: 30, perIpLimit: 600, windowMinutes: 10 });
  await settlePublicLinkAttempt(attempt.attemptId, true);
  return attempt.allowed;
}
