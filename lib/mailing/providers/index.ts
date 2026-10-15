import { assertServerOnly } from "../../server-only.js";
import { loadMailConfig } from "../config.js";
import { ResendProvider } from "./resend.js";
import { SesProvider } from "./ses.js";
import type { MailProvider } from "./types.js";

assertServerOnly("lib/mailing/providers/index.ts");

let override: MailProvider | null = null;
let ses: SesProvider | null = null;
let resend: ResendProvider | null = null;

/**
 * Proveedor activo, según MAIL_PROVIDER (por defecto «ses»). En pruebas se inyecta uno falso con `setMailProviderForTests`.
 * Un MAIL_PROVIDER inválido deja la configuración bloqueada (ver `validateMailConfig`): el worker no envía.
 */
export function getMailProvider(): MailProvider {
  if (override) return override;
  if (loadMailConfig().provider === "resend") {
    if (!resend) resend = new ResendProvider();
    return resend;
  }
  if (!ses) ses = new SesProvider();
  return ses;
}

export function setMailProviderForTests(provider: MailProvider | null): void {
  override = provider;
}

export type { AccountStatus, IdentityStatus, MailProvider, MailProviderName, OutboundMessage, SendOutcome } from "./types.js";
