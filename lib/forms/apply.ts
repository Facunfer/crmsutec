import { getDb } from "../db/client.js";
import { dateOnly } from "../db/date-only.js";
import { assertServerOnly } from "../server-only.js";
import { toJsonb } from "../db/json.js";
import { normalizeDni } from "../people/normalize.js";
import type { FormVersionSchema } from "./version-schema.js";

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

/** update_policy=fill_empty_only (y resolución manual "vincular"): nunca pisa un dato que la persona ya tenía. */
export async function mergeEmptyFieldsOnly(personId: string, coreValues: Record<string, unknown>, customValues: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  const existing = await db.selectFrom("people").selectAll().where("id", "=", personId).executeTakeFirst();
  if (!existing) return;

  const patch: Record<string, unknown> = {};
  if (!existing.email && coreValues.email) patch.email = coreValues.email;
  if (!existing.phone && coreValues.phone) patch.phone = coreValues.phone;
  if (!existing.birth_date && coreValues.birth_date) patch.birth_date = dateOnly(String(coreValues.birth_date).slice(0, 10));

  const existingCustom = (existing.custom_fields ?? {}) as Record<string, unknown>;
  const mergedCustom = { ...existingCustom };
  let customChanged = false;
  for (const [key, value] of Object.entries(customValues)) {
    if (existingCustom[key] === undefined || existingCustom[key] === null || existingCustom[key] === "") {
      mergedCustom[key] = value;
      customChanged = true;
    }
  }
  if (customChanged) patch.custom_fields = toJsonb(mergedCustom as never);

  if (Object.keys(patch).length === 0) return;
  patch.updated_at = new Date();
  await db.updateTable("people").set(patch).where("id", "=", personId).execute();
}

export async function applyActions(schema: FormVersionSchema, personId: string, normalizedValues: Record<string, unknown>): Promise<void> {
  for (const action of schema.actions) {
    if (action.actionType !== "add_to_association" || !action.config.associationId) continue;
    await addToAssociationIfMissing(action.config.associationId, personId);
  }

  for (const field of schema.fields.filter((f) => f.visible && f.fieldType === "association")) {
    const associationId = normalizedValues[field.key];
    if (typeof associationId === "string" && associationId) {
      await addToAssociationIfMissing(associationId, personId);
    }
  }
}

export async function addToAssociationIfMissing(associationId: string, personId: string): Promise<void> {
  const db = await getDb();
  const association = await db.selectFrom("associations").select("id").where("id", "=", associationId).where("status", "=", "active").executeTakeFirst();
  if (!association) return;

  const existing = await db
    .selectFrom("people_associations")
    .select("id")
    .where("association_id", "=", associationId)
    .where("person_id", "=", personId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (existing) return;

  await db.insertInto("people_associations").values({ association_id: associationId, person_id: personId, added_by: null }).execute();
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
