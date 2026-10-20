import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { dateOnly } from "../db/date-only.js";
import { assertServerOnly } from "../server-only.js";
import { toJsonb } from "../db/json.js";
import { normalizeDni } from "../people/normalize.js";
import type { FormVersionSchema } from "./version-schema.js";
import { isAssociationAllowedForForm } from "./queries.js";

assertServerOnly("lib/forms/apply.ts");

/**
 * Efectos de un envío de formulario sobre `people`/`people_associations`
 * (sección de Formularios): compartido entre el procesamiento automático
 * (`submit.ts`) y la resolución manual de la bandeja de duplicados
 * (`duplicates.ts`), para no duplicar la lógica de "cómo se crea o
 * completa una persona a partir de un envío" en dos lugares.
 */

export const MISSING_DNI_MESSAGE = "El envío no trae un DNI válido (7 u 8 dígitos): no se crea una persona sin DNI. Queda en revisión.";

/** DNI canónico del envío (solo dígitos, 7 u 8) o null: sin él no se puede crear una persona. */
export function submissionDni(coreValues: Record<string, unknown>): string | null {
  return typeof coreValues.dni === "string" ? normalizeDni(coreValues.dni) : null;
}

export class FormApplyError extends Error {
  /** Persona con la que choca la identificación (DNI). Solo para MASTER_GLOBAL y auditoría; nunca en mensajes. */
  conflictPersonId?: string;
  constructor(message: string, conflictPersonId?: string) {
    super(message);
    this.conflictPersonId = conflictPersonId;
  }
}

/**
 * "Es una persona nueva" desde la bandeja de duplicados (hallazgo real de
 * los tests de integración): si lo que hizo matchear el candidato fue
 * justamente el DNI, "crear una persona nueva" con ese mismo DNI viola el
 * índice único de `people` — dos personas activas no pueden compartir DNI.
 * Se valida antes de insertar para dar un mensaje claro en vez de dejar
 * escapar el error crudo del driver.
 */
export async function createPersonFromSubmission(
  coreValues: Record<string, unknown>,
  customValues: Record<string, unknown>,
  ownerOrganizationId: string
): Promise<string> {
  const db = await getDb();

  // El DNI es obligatorio para toda persona: un envío sin DNI válido NUNCA crea `people` (la base también lo exige).
  const dni = submissionDni(coreValues);
  if (!dni) throw new FormApplyError(MISSING_DNI_MESSAGE);
  {
    const blockedBy = await db.selectFrom("people").select(["id"]).where("dni", "=", dni).where("status", "!=", "merged").executeTakeFirst();
    if (blockedBy) {
      // Mensaje genérico: no se nombra a la persona ni se confirma que exista (puede ser de otra unidad y el
      // mensaje llega a quien revisa el envío). El id queda aparte, para MASTER_GLOBAL y la auditoría.
      throw new FormApplyError("No se pudo completar el alta porque existe un conflicto de identificación. El caso requiere revisión.", blockedBy.id);
    }
  }

  const created = await db
    .insertInto("people")
    .values({
      first_name: String(coreValues.first_name ?? "").trim() || "(sin nombre)",
      last_name: String(coreValues.last_name ?? "").trim() || "(sin apellido)",
      dni,
      email: (coreValues.email as string | undefined) ?? null,
      phone: (coreValues.phone as string | undefined) ?? null,
      birth_date: dateOnly(coreValues.birth_date ? String(coreValues.birth_date).slice(0, 10) : null),
      // La persona hereda la unidad propietaria del formulario (fijada en el servidor; el visitante no la elige).
      organization_id: ownerOrganizationId,
      origin: "form",
      custom_fields: toJsonb(customValues as never),
    })
    .returning("id")
    .executeTakeFirstOrThrow()
    .catch((err: unknown) => {
      // Dos envíos simultáneos con el mismo DNI: la base deja pasar uno; el otro va a revisión como conflicto.
      if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505") {
        throw new FormApplyError("No se pudo completar el alta porque existe un conflicto de identificación. El caso requiere revisión.");
      }
      throw err;
    });
  return created.id;
}

/** Campos núcleo de la persona que un envío puede completar. NUNCA el DNI ni el nombre: son identidad. */
const APPLICABLE_CORE_KEYS = ["email", "phone", "birth_date"] as const;

export interface AppliedChange {
  key: string;
  before: unknown;
  after: unknown;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

export interface FieldChangePlan {
  changes: AppliedChange[];
  /** Columnas núcleo a escribir (ya normalizadas). */
  corePatch: Record<string, unknown>;
  /** Objeto custom_fields completo resultante, o null si no cambia ningún campo personalizado. */
  customFields: Record<string, unknown> | null;
}

/**
 * Planifica (sin escribir) qué cambios produciría aplicar un envío a una persona:
 *  - `fill_empty`: solo completa lo que la persona tiene vacío (nunca pisa);
 *  - `overwrite`: reemplaza los campos pedidos en `keys` (acto deliberado de un operador).
 * Función pura: la usan el procesamiento automático y los comandos explícitos para que las reglas sean las mismas.
 */
export function planFieldChanges(
  existing: Record<string, unknown>,
  coreValues: Record<string, unknown>,
  customValues: Record<string, unknown>,
  options: { mode: "fill_empty" | "overwrite"; keys?: readonly string[] }
): FieldChangePlan {
  const wanted = options.keys ? new Set(options.keys) : null;
  const changes: AppliedChange[] = [];
  const corePatch: Record<string, unknown> = {};

  for (const key of APPLICABLE_CORE_KEYS) {
    if (wanted && !wanted.has(key)) continue;
    const incoming = coreValues[key];
    if (isEmptyValue(incoming)) continue;
    const current = existing[key];
    if (options.mode === "fill_empty" && !isEmptyValue(current)) continue;
    const same = key === "birth_date" ? String(current ?? "").slice(0, 10) === String(incoming).slice(0, 10) : current === incoming;
    if (same) continue;
    const after = key === "birth_date" ? String(incoming).slice(0, 10) : incoming;
    changes.push({ key, before: current instanceof Date ? current.toISOString().slice(0, 10) : (current ?? null), after });
    corePatch[key] = key === "birth_date" ? dateOnly(String(incoming).slice(0, 10)) : incoming;
  }

  const existingCustom = (existing.custom_fields ?? {}) as Record<string, unknown>;
  const mergedCustom = { ...existingCustom };
  let customChanged = false;
  for (const [key, value] of Object.entries(customValues)) {
    if (wanted && !wanted.has(key)) continue;
    if (isEmptyValue(value)) continue;
    const current = existingCustom[key];
    if (options.mode === "fill_empty" && !isEmptyValue(current)) continue;
    if (JSON.stringify(current) === JSON.stringify(value)) continue;
    changes.push({ key, before: current ?? null, after: value });
    mergedCustom[key] = value;
    customChanged = true;
  }
  return { changes, corePatch, customFields: customChanged ? mergedCustom : null };
}

/** Aplica el plan a la persona con su propia conexión (camino automático). Sin cambios no escribe nada. */
export async function applyFieldsToPerson(
  personId: string,
  coreValues: Record<string, unknown>,
  customValues: Record<string, unknown>,
  options: { mode: "fill_empty" | "overwrite"; keys?: readonly string[] }
): Promise<AppliedChange[]> {
  const db = await getDb();
  const existing = await db.selectFrom("people").selectAll().where("id", "=", personId).executeTakeFirst();
  if (!existing) return [];
  const plan = planFieldChanges(existing as unknown as Record<string, unknown>, coreValues, customValues, options);
  if (plan.changes.length === 0) return [];
  const patch: Record<string, unknown> = { ...plan.corePatch, updated_at: new Date() };
  if (plan.customFields) patch.custom_fields = toJsonb(plan.customFields as never);
  await db
    .updateTable("people")
    .set({ ...patch, version: sql<number>`version + 1` } as never)
    .where("id", "=", personId)
    .execute();
  return plan.changes;
}

/** Atajo histórico: completa solo vacíos. Devuelve los cambios aplicados. */
export async function mergeEmptyFieldsOnly(personId: string, coreValues: Record<string, unknown>, customValues: Record<string, unknown>): Promise<AppliedChange[]> {
  return applyFieldsToPerson(personId, coreValues, customValues, { mode: "fill_empty" });
}

/**
 * Ejecuta las acciones del formulario. `formOwnerOrganizationId` es la unidad propietaria del FORMULARIO (la fija el servidor): fuera
 * de ella y sus dependientes no se suma a nadie a ninguna asociación, venga el id de la configuración del formulario o de un campo
 * «asociación» que completó el visitante (S2). Un id fuera de alcance, inexistente o mal formado se ignora sin error: el envío se
 * procesa igual y no se le revela al visitante qué asociaciones existen.
 */
export async function applyActions(
  schema: FormVersionSchema,
  personId: string,
  normalizedValues: Record<string, unknown>,
  formOwnerOrganizationId: string
): Promise<void> {
  for (const action of schema.actions) {
    if (action.actionType !== "add_to_association" || !action.config.associationId) continue;
    await addToAssociationIfMissing(action.config.associationId, personId, formOwnerOrganizationId);
  }

  for (const field of schema.fields.filter((f) => f.visible && f.fieldType === "association")) {
    const associationId = normalizedValues[field.key];
    if (typeof associationId === "string" && associationId) {
      await addToAssociationIfMissing(associationId, personId, formOwnerOrganizationId);
    }
  }
}

export type AddToAssociationOutcome = "added" | "already_member" | "rejected";

export async function addToAssociationIfMissing(
  associationId: string,
  personId: string,
  formOwnerOrganizationId: string
): Promise<AddToAssociationOutcome> {
  if (!(await isAssociationAllowedForForm(associationId, formOwnerOrganizationId))) return "rejected";
  const db = await getDb();

  const existing = await db
    .selectFrom("people_associations")
    .select("id")
    .where("association_id", "=", associationId)
    .where("person_id", "=", personId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (existing) return "already_member";

  await db.insertInto("people_associations").values({ association_id: associationId, person_id: personId, added_by: null }).execute();
  return "added";
}

export function splitCoreAndCustomValues(
  schema: FormVersionSchema,
  normalizedValues: Record<string, unknown>,
  isCorePersonMapping: (key: string) => boolean
): { coreValues: Record<string, unknown>; customValues: Record<string, unknown> } {
  const coreValues: Record<string, unknown> = {};
  const customValues: Record<string, unknown> = {};
  for (const field of schema.fields.filter((f) => f.visible)) {
    if (!field.personFieldMapping) continue;
    const value = normalizedValues[field.key];
    if (value === "" || value === undefined || value === null) continue;
    if (isCorePersonMapping(field.personFieldMapping)) {
      coreValues[field.personFieldMapping] = value;
    } else {
      customValues[field.personFieldMapping] = value;
    }
  }
  return { coreValues, customValues };
}
