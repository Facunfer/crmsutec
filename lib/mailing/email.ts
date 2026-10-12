/**
 * Normalización y validación canónica de emails del Mailing. NUNCA se modifica `people.email`: el snapshot guarda el valor
 * original y el normalizado.
 */
export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const EMAIL_RE = new RegExp(`^[a-z0-9.!#$%&'*+/=?^_\`{|}~-]+@${LABEL}(?:\\.${LABEL})+$`);

export function isValidEmail(normalized: string): boolean {
  if (normalized.length === 0 || normalized.length > 254) return false;
  const at = normalized.indexOf("@");
  if (at < 1 || at > 64) return false;
  return EMAIL_RE.test(normalized);
}

/** Quita saltos de línea y caracteres de control: todo valor que vaya a una cabecera pasa por acá (inyección de cabeceras). */
export function headerSafe(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
}

/** `"Nombre" <mail>` seguro para cabecera From. El nombre se entrecomilla y se escapa. */
export function formatAddress(name: string, email: string): string {
  const safeName = headerSafe(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return safeName ? `"${safeName}" <${headerSafe(email)}>` : headerSafe(email);
}

/** Enmascara un email para quien no tiene people.view_sensitive: m****e@example.com */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  if (at < 1) return "••••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const first = local[0] ?? "";
  const last = local.length > 1 ? local[local.length - 1] : "";
  return `${first}${"*".repeat(Math.max(1, Math.min(local.length - 2, 6)))}${last}@${domain}`;
}
