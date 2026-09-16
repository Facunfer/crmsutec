import { parsePhoneNumberWithError } from "libphonenumber-js";

/** Solo dígitos, 7-8 caracteres (sección 7.2 de SUTECBA_DATABASE.md). */
export function normalizeDni(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 8) return null;
  return digits;
}

export function normalizeEmail(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  // Validación simple pero real: forma básica usuario@dominio.tld
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

/** Devuelve E.164 (+54...) usando la librería especializada, asumiendo Argentina si no hay código de país. */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const parsed = parsePhoneNumberWithError(trimmed, "AR");
    if (!parsed.isValid()) return null;
    return parsed.number;
  } catch {
    return null;
  }
}
