/**
 * Plausibilidad de `people.birth_date` (dominio), separado de `lib/db/date-only.ts` (técnico).
 *
 * `dateOnly()` solo valida que una fecha AAAA-MM-DD exista en el calendario (día válido del mes, bisiestos):
 * es correcto que acepte "0064-08-12", porque como fecha de calendario esa fecha existe. Ese validador NUNCA debe
 * ganar reglas de dominio (quedaría inservible para columnas `date` que no son nacimientos, como `event_date`).
 *
 * Este módulo es el que decide si una fecha de calendario válida es además un nacimiento PLAUSIBLE para una persona
 * viva del CRM. Un año de 0 a 99 (p. ej. "0064", "0070", "0077") nunca se interpreta acá como 19xx/20xx: eso sería
 * adivinar sin evidencia. Si una FUENTE concreta sabe que su formato es "dd/mm/aa" con una regla de siglo explícita
 * (p. ej. un formulario que declara "años de 2 dígitos: 00-30 → 20xx, 31-99 → 19xx"), la expansión la hace el parser
 * de esa fuente con `expandTwoDigitYear()` ANTES de llegar acá — nunca este módulo ni `dateOnly()` por su cuenta.
 */

export const MIN_PLAUSIBLE_BIRTH_YEAR = 1900;

export type BirthDateRejection = "AMBIGUOUS_BIRTH_YEAR" | "INVALID_BIRTH_DATE";

export type BirthDateValidation = { ok: true } | { ok: false; issue: BirthDateRejection };

/** `today` en AAAA-MM-DD; por defecto la fecha real (parámetro solo para tests deterministas). */
export function validateBirthDate(iso: string, today: string = new Date().toISOString().slice(0, 10)): BirthDateValidation {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { ok: false, issue: "INVALID_BIRTH_DATE" };
  const year = Number(iso.slice(0, 4));
  // 0-99: indistinguible de un año de 2 dígitos mal reinterpretado (el caso real: "0064"/"0070"/"0077" en el
  // histórico). Nunca se asume el siglo acá.
  if (year < 100) return { ok: false, issue: "AMBIGUOUS_BIRTH_YEAR" };
  if (year < MIN_PLAUSIBLE_BIRTH_YEAR) return { ok: false, issue: "INVALID_BIRTH_DATE" };
  if (iso > today) return { ok: false, issue: "INVALID_BIRTH_DATE" };
  return { ok: true };
}

/**
 * Expande "d/m/aa" a AAAA-MM-DD con una regla de siglo EXPLÍCITA que declara el parser de una fuente concreta.
 * No la usa nadie por defecto: sin este llamado explícito, un texto con año de 2 dígitos simplemente no se
 * interpreta como fecha (null). `pivotYear` es el corte: años de 2 dígitos <= pivotYear van a 20xx; el resto, a 19xx.
 */
export function expandTwoDigitYear(text: string, rule: { pivotYear: number }): string | null {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [, d, mo, yy] = m;
  const century = Number(yy) <= rule.pivotYear ? 2000 : 1900;
  const iso = `${century + Number(yy)}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso ? null : iso;
}
