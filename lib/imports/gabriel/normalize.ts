import { createHash } from "node:crypto";
import { normalizeEmail, normalizePhone } from "../../people/normalize.js";
import type { Cell } from "./types.js";

/**
 * Normalización de identidad para el importador. Reglas (GABRIEL_IMPORT_MAP.md):
 *  - DNI: solo dígitos, 7 u 8. Es el identificador canónico único.
 *  - CUIL/CUIT: exactamente 11 dígitos con dígito verificador válido. Es una columna aparte; NUNCA
 *    identifica por sí mismo.
 *  - Si no hay DNI explícito y hay un CUIL válido, se deriva el DNI que contiene (posiciones 3–10,
 *    quitando el 0 de relleno de los DNI de 7 dígitos) y se guarda su procedencia.
 */

export function cellToText(cell: Cell | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "object") return "$date" in cell ? cell.$date : cell.$datetime;
  if (typeof cell === "number") return Number.isInteger(cell) ? String(cell) : String(cell);
  const text = String(cell).replace(/ /g, " ").trim();
  return text === "" ? null : text;
}

export function digitsOnly(value: string | null): string {
  return value ? value.replace(/\D/g, "") : "";
}

/** DNI de 7–8 dígitos, o null. Acepta puntos/espacios ("12.345.678"). */
export function normalizeDniValue(raw: string | null): string | null {
  if (!raw) return null;
  // Un valor con letras o separadores raros no es un DNI limpio.
  if (!/^[\d.\s]+$/.test(raw)) return null;
  const digits = digitsOnly(raw);
  return digits.length === 7 || digits.length === 8 ? digits : null;
}

const CUIL_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

export function cuilChecksumValid(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  const sum = digits
    .slice(0, 10)
    .split("")
    .reduce((acc, d, i) => acc + Number(d) * CUIL_WEIGHTS[i]!, 0);
  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? 0 : remainder === 10 ? 9 : remainder;
  return Number(digits[10]) === expected;
}

/** Dígito verificador que corresponde a los 10 primeros dígitos (útil para armar CUIL de prueba). */
export function cuilCheckDigit(first10: string): number {
  const sum = first10.split("").reduce((acc, d, i) => acc + Number(d) * CUIL_WEIGHTS[i]!, 0);
  const remainder = 11 - (sum % 11);
  return remainder === 11 ? 0 : remainder === 10 ? 9 : remainder;
}

export interface NormalizedCuil {
  /** 11 dígitos si el valor tiene esa forma. */
  digits: string | null;
  valid: boolean;
}

export function normalizeCuilValue(raw: string | null): NormalizedCuil {
  if (!raw) return { digits: null, valid: false };
  const digits = digitsOnly(raw);
  if (digits.length !== 11) return { digits: null, valid: false };
  return { digits, valid: cuilChecksumValid(digits) };
}

export function deriveDniFromCuil(cuilDigits: string): string | null {
  if (!/^\d{11}$/.test(cuilDigits)) return null;
  const middle = cuilDigits.slice(2, 10);
  const dni = middle.startsWith("0") ? middle.replace(/^0+/, "") : middle;
  return dni.length === 7 || dni.length === 8 ? dni : null;
}

export interface ResolvedIdentity {
  dni: string | null;
  dniSource: "explicit" | "derived_from_cuil" | null;
  cuil: string | null;
  cuilValid: boolean;
  /** DNI explícito presente pero con formato inválido. */
  invalidDni: boolean;
  /** DNI explícito y DNI contenido en un CUIL válido de la misma fila que no coinciden. */
  dniCuilMismatch: boolean;
}

export function resolveIdentity(dniRaw: string | null, cuilRaw: string | null): ResolvedIdentity {
  const explicit = normalizeDniValue(dniRaw);
  const cuil = normalizeCuilValue(cuilRaw);
  const derived = cuil.valid && cuil.digits ? deriveDniFromCuil(cuil.digits) : null;

  const invalidDni = Boolean(dniRaw) && explicit === null;
  const dniCuilMismatch = explicit !== null && derived !== null && explicit !== derived;

  if (explicit && !dniCuilMismatch) {
    return { dni: explicit, dniSource: "explicit", cuil: cuil.digits, cuilValid: cuil.valid, invalidDni, dniCuilMismatch };
  }
  if (!explicit && derived) {
    return { dni: derived, dniSource: "derived_from_cuil", cuil: cuil.digits, cuilValid: cuil.valid, invalidDni, dniCuilMismatch };
  }
  // Sin DNI resoluble, o con contradicción DNI ≠ CUIL: no se elige ninguno.
  return { dni: null, dniSource: null, cuil: cuil.digits, cuilValid: cuil.valid, invalidDni, dniCuilMismatch };
}

// ---------------------------------------------------------------- huellas

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** JSON con claves ordenadas: la misma fila da siempre el mismo texto. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Huella estable de fila: hash del archivo + hoja/página + número de fila + contenido normalizado. */
export function fingerprintRow(fileSha256: string, sheet: string, rowNumber: number, rawData: unknown): string {
  return sha256Hex(`${fileSha256}|${sheet}|${rowNumber}|${stableStringify(rawData)}`);
}

// ---------------------------------------------------------------- texto y contacto

/** Minúsculas, sin acentos, solo letras/números y espacios simples. */
export function comparableText(value: string | null): string {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Dos textos son compatibles si son iguales o uno es prefijo del otro (por palabras). */
export function textsCompatible(a: string | null, b: string | null): boolean {
  const x = comparableText(a);
  const y = comparableText(b);
  if (!x || !y) return true;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return long === short || long.startsWith(`${short} `);
}

/** Palabras significativas de un nombre (sin acentos, mayúsculas, puntuación ni espacios de más). */
export function nameTokens(value: string | null): string[] {
  const text = comparableText(value);
  return text ? [...new Set(text.split(" "))] : [];
}

/**
 * Dos nombres son compatibles si las palabras de uno están todas en el otro (segundo nombre omitido,
 * apellido/nombre invertidos, mayúsculas, tildes, puntuación). Si cada uno tiene palabras que el otro
 * no, es un conflicto de identidad material: el normalizador NO elige.
 */
export function nameTokensCompatible(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const sa = new Set(a);
  const sb = new Set(b);
  return a.every((t) => sb.has(t)) || b.every((t) => sa.has(t));
}

/**
 * Clave comparable de un teléfono argentino: solo dígitos, sin prefijo país (54/549) ni 0 troncal,
 * últimos 10 dígitos. "+5491155551111", "011 5555-1111" y "1155551111" comparten clave.
 */
export function phoneKey(value: string | null): string {
  let digits = digitsOnly(value);
  if (digits.startsWith("549")) digits = digits.slice(3);
  else if (digits.startsWith("54")) digits = digits.slice(2);
  digits = digits.replace(/^0+/, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function normalizeContactEmail(raw: string | null): string | null {
  return raw ? normalizeEmail(raw) : null;
}

/** E.164 si es válido; si no, solo los dígitos (para poder comparar sin perder el dato). */
export function normalizeContactPhone(raw: string | null): string | null {
  if (!raw) return null;
  const e164 = normalizePhone(raw);
  if (e164) return e164;
  const digits = digitsOnly(raw);
  return digits.length >= 6 ? digits : null;
}

/** "AAAA-MM-DD" desde una celda fecha o un texto dd/mm/aaaa; null si no se puede interpretar. */
export function cellToIsoDate(cell: Cell | undefined): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "object") return "$date" in cell ? cell.$date : cell.$datetime.slice(0, 10);
  const text = String(cell).trim();
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(text);
  if (!match) return null;
  const [, d, m, y] = match;
  const iso = `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** "09/09/2026 10 a 13 hs" → fecha y franja horaria. Sin franja reconocible, solo la fecha. */
export function parseDateAndTimeRange(text: string | null): { date: string | null; start: string | null; end: string | null } {
  if (!text) return { date: null, start: null, end: null };
  const date = cellToIsoDate(text.replace(/\s+/g, " "));
  const range = /(\d{1,2})(?::(\d{2}))?\s*(?:a|-|–)\s*(\d{1,2})(?::(\d{2}))?\s*hs?/i.exec(text.replace(/^\s*\d{1,2}[/-]\d{1,2}[/-]\d{4}/, ""));
  if (!range) return { date, start: null, end: null };
  const pad = (h: string, m?: string) => `${h.padStart(2, "0")}:${m ?? "00"}`;
  return { date, start: pad(range[1]!, range[2]), end: pad(range[3]!, range[4]) };
}
