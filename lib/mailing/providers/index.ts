import { assertServerOnly } from "../../server-only.js";
import { SesProvider } from "./ses.js";
import type { MailProvider } from "./types.js";

assertServerOnly("lib/mailing/providers/index.ts");

let override: MailProvider | null = null;
let ses: SesProvider | null = null;

/** Proveedor activo. En pruebas se inyecta uno falso con `setMailProviderForTests`; en producción siempre es Amazon SES. */
export function getMailProvider(): MailProvider {
  if (override) return override;
  if (!ses) ses = new SesProvider();
  return ses;
}

export function setMailProviderForTests(provider: MailProvider | null): void {
  override = provider;
}

export type { AccountStatus, IdentityStatus, MailProvider, OutboundMessage, SendOutcome } from "./types.js";
