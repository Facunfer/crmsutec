import { canonicalIdentityDecisions, parseIdentityDecisions, type IdentityDecision, type RawDecisionRow } from "./identity-decisions.js";
import { buildPlan, type ImportPlan } from "./plan.js";
import { sha256Hex, stableStringify } from "./normalize.js";
import type { ExtractedFile } from "./types.js";

/**
 * `plan_hash`: SHA-256 estable del plan que se aprobó en el dry-run.
 *
 * Se calcula SOLO desde los archivos fuente (buildPlan sin foto de la base, sin organizaciones): así el
 * mismo juego de originales da siempre el mismo hash, antes y después de aplicar, y ninguna
 * diferencia del estado de la base lo cambia. Cubre:
 *   - el conjunto exacto de archivos (código, nombre y SHA-256 de cada original);
 *   - las decisiones por fila (estado, DNI canónico y su procedencia, CUIL, códigos de incidencia);
 *   - las personas a crear con sus valores finales y campos que quedan vacíos;
 *   - las personas bloqueadas, los conflictos, los eventos, las participaciones y las filas F03 pendientes.
 * Cambiar cualquier archivo, una regla del planificador o la política de conflictos cambia el hash y
 * obliga a repetir el dry-run. El hash es unidireccional: el informe puede mostrarlo sin exponer datos.
 */
export const PLAN_HASH_VERSION = "gabriel-plan-v2";

export function canonicalPlanPayload(plan: ImportPlan, identityDecisions?: readonly IdentityDecision[]): unknown {
  const rowKey = (r: { fileCode: string; sheet: string; rowNumber: number }) => `${r.fileCode}|${r.sheet}|${String(r.rowNumber).padStart(7, "0")}`;
  return {
    version: PLAN_HASH_VERSION,
    files: [...plan.files].sort((a, b) => a.fileCode.localeCompare(b.fileCode)).map((f) => ({ fileCode: f.fileCode, fileName: f.fileName, sha256: f.sha256 })),
    rows: plan.rows
      .map((r) => ({
        k: rowKey(r.record),
        layout: r.record.layout,
        kind: r.record.kind,
        status: r.status,
        dni: r.normalizedDni,
        dniSource: r.dniSource,
        cuil: r.normalizedCuil,
        person: r.personDni,
        issues: [...new Set(r.issues.filter((i) => i.severity !== "info").map((i) => i.code))].sort(),
      }))
      .sort((a, b) => a.k.localeCompare(b.k)),
    // Sin alias (el hash no depende de la base) la resolución de organización es siempre la misma; se omiten estos
    // campos derivados para que agregar contexto no cambie el hash del plan aprobado.
    people: [...plan.people.toCreate]
      .map(({ organizationResolution: _r, organizationStatus: _s, ...person }) => person)
      .sort((a, b) => a.dni.localeCompare(b.dni)),
    blocked: [...plan.people.blocked].sort((a, b) => a.personKey.localeCompare(b.personKey)),
    conflicts: plan.conflicts.map((c) => ({ ...c, rows: [...c.rows].sort((a, b) => rowKey(a).localeCompare(rowKey(b))) })),
    events: [...plan.events.toCreate, ...plan.events.existing].sort((a, b) => a.key.localeCompare(b.key)),
    participations: plan.participations
      .map((p) => ({ target: p.target, dni: p.dni, kind: p.kind, rows: [...p.rows].sort((a, b) => rowKey(a).localeCompare(rowKey(b))) }))
      .sort((a, b) => `${a.target.type}|${(a.target as { key: string }).key}|${a.dni}|${a.kind}`.localeCompare(`${b.target.type}|${(b.target as { key: string }).key}|${b.dni}|${b.kind}`)),
    pendingClassification: plan.pendingClassificationRows.map(rowKey).sort(),
    // Solo cuando hay decisiones humanas: sin ellas el payload (y el hash) queda exactamente igual que antes.
    ...(identityDecisions ? { identityDecisions: canonicalIdentityDecisions(identityDecisions) } : {}),
  };
}

export function computePlanHash(plan: ImportPlan, identityDecisions?: readonly IdentityDecision[]): string {
  return sha256Hex(stableStringify(canonicalPlanPayload(plan, identityDecisions)));
}

export interface PlanFromSources {
  plan: ImportPlan;
  planHash: string;
  /** Decisiones humanas validadas (undefined si no se pasaron). */
  decisions?: IdentityDecision[];
}

/**
 * Valida las decisiones humanas contra las identidades bloqueadas SOLO POR LAS FUENTES (plan sin decisiones):
 * deben ser exactamente esas, una por DNI. Cualquier inconsistencia aborta (IdentityDecisionsError).
 */
export function validateIdentityDecisions(files: ExtractedFile[], rows: readonly RawDecisionRow[]): IdentityDecision[] {
  return parseIdentityDecisions(rows, blockedDnis(buildPlan(files)));
}

/** Plan derivado solo de los archivos (sin base) y su hash. Con decisiones humanas, forman parte del JSON canónico. */
export function planFromSources(files: ExtractedFile[], options: { identityDecisionRows?: readonly RawDecisionRow[] } = {}): PlanFromSources {
  if (!options.identityDecisionRows) {
    const plan = buildPlan(files);
    return { plan, planHash: computePlanHash(plan) };
  }
  const decisions = validateIdentityDecisions(files, options.identityDecisionRows);
  const plan = buildPlan(files, { identityDecisions: decisions });
  return { plan, planHash: computePlanHash(plan, decisions), decisions };
}

/** DNI de las identidades bloqueadas del plan (para validar las decisiones humanas). */
export function blockedDnis(plan: ImportPlan): string[] {
  return [...new Set(plan.rows.filter((r) => r.issues.some((i) => i.code === "BLOCKED_IDENTITY_CONFLICT") && r.normalizedDni).map((r) => r.normalizedDni!))].sort();
}
