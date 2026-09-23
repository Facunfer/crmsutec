/**
 * Lector de las DECISIONES HUMANAS sobre las identidades bloqueadas (`gabriel_identidades_bloqueadas.xlsx`, hoja
 * «Identidades», ya pasada a JSON por `tools/identity-decisions-extract.py`).
 *
 * Las decisiones validadas forman parte del JSON canónico del plan y cambian el `plan_hash`.
 *
 * Es estricto a propósito: cualquier valor inválido o inconsistente ABORTA (no se corrige ni se adivina nada).
 */

export const IDENTITY_DECISION_VALUES = ["MERGE_SAME_PERSON", "KEEP_BLOCKED", "SOURCE_ERROR", "REVIEW_LATER"] as const;
export type IdentityDecisionValue = (typeof IDENTITY_DECISION_VALUES)[number];

export interface IdentityDecision {
  dni: string;
  decision: IdentityDecisionValue;
  /** Solo con MERGE_SAME_PERSON. */
  canonicalFirstName: string | null;
  canonicalLastName: string | null;
  notes: string | null;
}

export class IdentityDecisionsError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Decisiones de identidad inválidas (${problems.length}): ${problems.join(" | ")}`);
    this.problems = problems;
  }
}

/** Fila cruda del extracto: las claves son los encabezados del Excel. */
export type RawDecisionRow = Record<string, unknown>;

/** Los mensajes nunca llevan el DNI completo. */
const masked = (dni: string) => (dni.length >= 3 ? `***${dni.slice(-3)}` : "***");
const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());
const NAME = /^[\p{L}][\p{L}'’.\- ]*$/u;

/**
 * Valida el conjunto completo contra los DNI que hoy están bloqueados. Exige una decisión válida y única para CADA
 * identidad bloqueada, y ninguna para DNI que no lo estén. Devuelve las decisiones ordenadas por DNI.
 */
export function parseIdentityDecisions(rows: readonly RawDecisionRow[], blockedDnis: readonly string[]): IdentityDecision[] {
  const problems: string[] = [];
  const blocked = new Set(blockedDnis);
  const seen = new Set<string>();
  const out: IdentityDecision[] = [];

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
    if (!blocked.has(dni)) {
      problems.push(`${label}: no es una identidad bloqueada del plan actual`);
      continue;
    }

    const decision = text(row.decision);
    if (!decision) {
      problems.push(`${label}: falta la decisión`);
      continue;
    }
    if (!(IDENTITY_DECISION_VALUES as readonly string[]).includes(decision)) {
      problems.push(`${label}: decisión inválida (solo ${IDENTITY_DECISION_VALUES.join(", ")})`);
      continue;
    }

    const first = text(row.canonical_first_name);
    const last = text(row.canonical_last_name);
    if (decision === "MERGE_SAME_PERSON") {
      if (!first || !last) {
        problems.push(`${label}: MERGE_SAME_PERSON exige canonical_first_name y canonical_last_name`);
        continue;
      }
      if (!NAME.test(first) || !NAME.test(last) || first.length < 2 || last.length < 2) {
        problems.push(`${label}: el nombre o apellido canónico no es válido (solo letras, espacios, apóstrofes, puntos y guiones; mínimo 2 caracteres)`);
        continue;
      }
    } else if (first || last) {
      problems.push(`${label}: ${decision} no admite nombre/apellido canónico (solo MERGE_SAME_PERSON)`);
      continue;
    }
    out.push({
      dni,
      decision: decision as IdentityDecisionValue,
      canonicalFirstName: decision === "MERGE_SAME_PERSON" ? first : null,
      canonicalLastName: decision === "MERGE_SAME_PERSON" ? last : null,
      notes: text(row.notes) || null,
    });
  }

  for (const dni of blocked) if (!seen.has(dni)) problems.push(`${masked(dni)}: identidad bloqueada sin decisión en el archivo`);
  if (problems.length > 0) throw new IdentityDecisionsError(problems);
  return out.sort((a, b) => a.dni.localeCompare(b.dni));
}

/** Forma canónica para el hash del plan (las notas son texto libre y no cambian el resultado del plan). */
export function canonicalIdentityDecisions(decisions: readonly IdentityDecision[]) {
  return [...decisions]
    .sort((a, b) => a.dni.localeCompare(b.dni))
    .map((d) => ({ dni: d.dni, decision: d.decision, first: d.canonicalFirstName, last: d.canonicalLastName }));
}
