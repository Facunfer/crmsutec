import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { assertServerOnly } from "../server-only.js";
import { checkPublicLinkRateLimit, recordPublicLinkAttempt } from "../security/public-rate-limit.js";

assertServerOnly("lib/mailing/unsubscribe-limit.ts");

/**
 * Rate limit básico del endpoint público de baja (mismo patrón y tabla `public_link_attempts` que check-in e invitaciones).
 *
 * Umbrales altos a propósito: el «un clic» de Gmail/Outlook sale de pocas IPs del proveedor y cada destinatario tiene su propio
 * enlace. Por identificador (el enlace) 30 intentos cada 10 minutos; por IP 600. Solo se registran los intentos PERMITIDOS, así
 * un bloqueo se levanta solo al pasar la ventana. No afecta la idempotencia: repetir una baja ya hecha no hace nada.
 */
const SCOPE = "unsubscribe";

export function normalizeClientIp(raw: string | null | undefined): string {
  const first = raw?.split(",")[0]?.trim() ?? "";
  return isIP(first) ? first : "127.0.0.1";
}

export async function allowUnsubscribeAttempt(token: string, rawIp: string | null | undefined): Promise<boolean> {
  const ip = normalizeClientIp(rawIp);
  const identifier = createHash("sha256").update(token).digest("hex").slice(0, 32);
  const { allowed } = await checkPublicLinkRateLimit(SCOPE, identifier, ip, { perIdentifierLimit: 30, perIpLimit: 600, windowMinutes: 10 });
  if (allowed) await recordPublicLinkAttempt(SCOPE, identifier, ip, true);
  return allowed;
}
