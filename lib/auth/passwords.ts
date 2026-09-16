import bcrypt from "bcryptjs";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/auth/passwords.ts");

const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Sin compatibilidad con contraseñas en texto plano (decisión D4): el
 * sistema nuevo no tiene usuarios legados, así que cualquier hash que no
 * parezca bcrypt es un error de datos, no un caso a soportar.
 */
export function looksLikeBcryptHash(value: string): boolean {
  return /^\$2[aby]\$\d{2}\$/.test(value);
}

const MIN_PASSWORD_LENGTH = 10;

export function validatePasswordStrength(plain: string): string | null {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  return null;
}
