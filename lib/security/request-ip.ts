import { headers } from "next/headers";
import { assertServerOnly } from "../server-only.js";
import { resolveClientIp } from "./client-ip.js";

assertServerOnly("lib/security/request-ip.ts");

/** IP del cliente del pedido en curso (Server Actions y páginas). Ver `client-ip.ts` para la regla de confianza. */
export async function getRequestClientIp(): Promise<string> {
  return resolveClientIp(await headers());
}
