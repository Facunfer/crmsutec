/** Enmascarado de campos sensibles para quien no tiene people.view_sensitive (sección 9 del prompt). */

export function maskDni(dni: string | null): string | null {
  if (!dni) return dni;
  if (dni.length <= 4) return "*".repeat(dni.length);
  return `${dni.slice(0, 2)}${"*".repeat(dni.length - 4)}${dni.slice(-2)}`;
}

export function maskEmail(email: string | null): string | null {
  if (!email) return email;
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const user = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedUser = user.length <= 2 ? `${user[0]}*` : `${user[0]}${"*".repeat(user.length - 2)}${user.slice(-1)}`;
  return `${maskedUser}@${domain}`;
}

export function maskPhone(phone: string | null): string | null {
  if (!phone) return phone;
  if (phone.length <= 4) return "*".repeat(phone.length);
  return `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}

export interface MaskableFields {
  dni: string | null;
  email: string | null;
  phone: string | null;
}

export function applyMasking<T extends MaskableFields>(row: T, canSeeSensitive: boolean): T {
  if (canSeeSensitive) return row;
  return { ...row, dni: maskDni(row.dni), email: maskEmail(row.email), phone: maskPhone(row.phone) };
}
