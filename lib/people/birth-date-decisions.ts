import { validateBirthDate } from "./birth-date.js";

/**
 * Lector de las DECISIONES HUMANAS sobre `birth_date` absurdas del histórico
 * (`birth_dates_historicas_revision.xlsx`, hoja «birth_dates_revision», ya pasada a JSON por
 * `tools/birth-date-decisions-extract.py`). Consumido por `scripts/fix-birth-dates.ts`.
 *
 * Es estricto a propósito: cualquier valor inválido o inconsistente ABORTA (no se corrige ni se adivina nada). En
 * particular, NUNCA reinterpreta un año de 2 dígitos: la fecha candidata debe venir ya completa en el archivo de
 * decisiones (que a su vez debe justificarla con evidencia de la fuente, no con una transformación genérica).
 */

export const BIRTH_DATE_DECISION_VALUES = ["SOURCE_CONFIRMS_CORRECTION", "AMBIGUOUS_SOURCE", "INVALID_SOURCE", "REVIEW_LATER"] as const;
export type BirthDateDecisionValue = (typeof BIRTH_DATE_DECISION_VALUES)[number];

export interface BirthDateDecision {
  dni: string;
  decision: BirthDateDecisionValue;
  /** Lo que estaba en people.birth_date cuando se revisó (control de concurrencia: si cambió, se aborta). */
  expectedCurrentBirthDate: string;
  /** Solo con SOURCE_CONFIRMS_CORRECTION. */
  candidateBirthDate: string | null;
  notes: string | null;
}

export class BirthDateDecisionsError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Decisiones de birth_date inválidas (${problems.length}): ${problems.join(" | ")}`);
    this.problems = problems;
  }
}

export type RawBirthDateDecisionRow = Record<string, unknown>;

const masked = (dni: string) => (dni.length >= 3 ? `***${dni.slice(-3)}` : "***");
const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valida cada fila del archivo de decisiones (formato, decisión permitida, reglas de fecha_candidata) y rechaza DNI
 * repetidos dentro del mismo archivo. NO exige cobertura exacta contra un estado "actualmente absurdo" de la base:
 * es una herramienta repetible (una segunda corrida, después de aplicar algunas correcciones, debe poder reusar el
 * mismo archivo sin que las filas ya corregidas dejen de "calificar"). La existencia del DNI y si su `birth_date`
 * sigue coincidiendo con lo revisado se comprueban en la transacción de `scripts/fix-birth-dates.ts`.
 */
export function parseBirthDateDecisions(rows: readonly RawBirthDateDecisionRow[]): BirthDateDecision[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const out: BirthDateDecision[] = [];

  for (const [index, row] of rows.entries()) {
    const dni = text(row.dni).replace(/\.0$/, "");
    const label = dni ? masked(dni) : `fila ${index + 1}`;
    if (!/^[0-9]{7,8}$/.test(dni)) {
      problems.push(`${label}: DNI inválido (solo dígitos, 7 u 8)`);
      continue;
    }
    if (seen.has(dni)) {
      problems.push(`${label}: DNI repetido en el archivo`);
      continue;
    }
    seen.add(dni);

    const decision = text(row.decision);
    if (!decision) {
      problems.push(`${label}: falta la decisión`);
      continue;
    }
    if (!(BIRTH_DATE_DECISION_VALUES as readonly string[]).includes(decision)) {
      problems.push(`${label}: decisión inválida «${decision}» (solo ${BIRTH_DATE_DECISION_VALUES.join(", ")})`);
      continue;
    }

    const expectedCurrent = text(row.birth_date_actual_supabase);
    if (!ISO_DATE.test(expectedCurrent)) {
      problems.push(`${label}: birth_date_actual_supabase inválido o ausente (se necesita para no pisar una fila que cambió)`);
      continue;
    }

    const candidateRaw = text(row.fecha_candidata);
    if (decision === "SOURCE_CONFIRMS_CORRECTION") {
      if (!candidateRaw) {
        problems.push(`${label}: SOURCE_CONFIRMS_CORRECTION exige fecha_candidata`);
        continue;
      }
      if (!ISO_DATE.test(candidateRaw)) {
        problems.push(`${label}: fecha_candidata «${candidateRaw}» no tiene formato AAAA-MM-DD`);
        continue;
      }
      const check = validateBirthDate(candidateRaw);
      if (!check.ok) {
        problems.push(`${label}: fecha_candidata «${candidateRaw}» no es una fecha de nacimiento plausible (${check.issue})`);
        continue;
      }
    } else if (candidateRaw) {
      problems.push(`${label}: ${decision} no admite fecha_candidata (solo SOURCE_CONFIRMS_CORRECTION)`);
      continue;
    }

    out.push({
      dni,
      decision: decision as BirthDateDecisionValue,
      expectedCurrentBirthDate: expectedCurrent,
      candidateBirthDate: decision === "SOURCE_CONFIRMS_CORRECTION" ? candidateRaw : null,
      notes: text(row.notas) || null,
    });
  }

  if (problems.length > 0) throw new BirthDateDecisionsError(problems);
  return out.sort((a, b) => a.dni.localeCompare(b.dni));
}
