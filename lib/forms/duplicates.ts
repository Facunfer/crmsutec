import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import type { SessionUser } from "../permissions/can.js";
import { isCorePersonMapping } from "./field-types.js";
import { applyActions, createPersonFromSubmission, FormApplyError, splitCoreAndCustomValues } from "./apply.js";
import { insertSubmissionEvents } from "./events.js";
import type { FormVersionSchema } from "./version-schema.js";
import { canAccessForm, canAccessPerson } from "../scope/organizations.js";
import { isMasterGlobal } from "../permissions/can.js";

assertServerOnly("lib/forms/duplicates.ts");

export class DuplicateResolutionError extends Error {}

async function loadCandidateContext(actor: SessionUser, candidateId: string) {
  const db = await getDb();
  const candidate = await db.selectFrom("person_duplicate_candidates").selectAll().where("id", "=", candidateId).executeTakeFirst();
  if (!candidate) throw new DuplicateResolutionError("El candidato no existe.");
  if (candidate.status !== "pending") throw new DuplicateResolutionError("Este candidato ya fue resuelto.");
  if (!candidate.submission_id) throw new DuplicateResolutionError("El candidato no tiene un envío asociado.");

  const submission = await db.selectFrom("form_submissions").selectAll().where("id", "=", candidate.submission_id).executeTakeFirst();
  if (!submission) throw new DuplicateResolutionError("El envío original ya no existe.");

  // El candidato pertenece a la unidad del formulario: fuera del alcance, "no existe".
  if (!(await canAccessForm(actor, submission.form_id))) throw new DuplicateResolutionError("El candidato no existe.");

  // La versión del formulario que estaba vigente CUANDO se envió, no la
  // vigente hoy: así un formulario editado/republicado después no cambia
  // cómo se interpreta un envío viejo (mismo principio de form_versions).
  const versionRow = await db
    .selectFrom("form_versions")
    .select("schema")
    .where("form_id", "=", submission.form_id)
    .where("version", "=", submission.form_version)
    .executeTakeFirst();
  if (!versionRow) throw new DuplicateResolutionError("No se encontró la versión del formulario de ese envío.");

  const schema = versionRow.schema as unknown as FormVersionSchema;
  const normalizedValues = (submission.normalized_values ?? {}) as Record<string, unknown>;
  const { coreValues, customValues } = splitCoreAndCustomValues(schema, normalizedValues, isCorePersonMapping);

  const form = await db.selectFrom("forms").select("owner_organization_id").where("id", "=", submission.form_id).executeTakeFirstOrThrow();

  return { db, candidate, submission, schema, normalizedValues, coreValues, customValues, ownerOrganizationId: form.owner_organization_id };
}

async function discardSiblingCandidates(db: Awaited<ReturnType<typeof getDb>>, submissionId: string, exceptCandidateId: string, actor: SessionUser): Promise<void> {
  await db
    .updateTable("person_duplicate_candidates")
    .set({ status: "discarded", resolved_by: actor.id, resolved_at: new Date() })
    .where("submission_id", "=", submissionId)
    .where("id", "!=", exceptCandidateId)
    .where("status", "=", "pending")
    .execute();
}

/**
 * "Sí, es esta persona": VINCULA la respuesta a la persona propuesta y ejecuta las acciones configuradas del formulario (asociaciones).
 * Desde 0043 NO completa datos de la persona: aplicar datos es una acción explícita aparte (`applySubmissionData`).
 */
export async function linkDuplicateCandidate(actor: SessionUser, candidateId: string): Promise<void> {
  assertPermission(actor, "forms.review_duplicates");
  const { db, candidate, submission, schema, normalizedValues, coreValues, customValues, ownerOrganizationId } = await loadCandidateContext(actor, candidateId);
  if (!candidate.person_id) throw new DuplicateResolutionError("Este candidato no tiene una persona propuesta para vincular.");
  // No se escribe sobre una persona de otra unidad.
  if (!(await canAccessPerson(actor, candidate.person_id))) {
    throw new DuplicateResolutionError("La persona propuesta pertenece a otra unidad; no se puede vincular desde acá.");
  }

  await applyActions(schema, candidate.person_id, normalizedValues, ownerOrganizationId);

  await db
    .updateTable("person_duplicate_candidates")
    .set({ status: "linked", resolved_by: actor.id, resolved_at: new Date() })
    .where("id", "=", candidateId)
    .execute();
  await db.updateTable("form_submissions").set({ match_result: "matched", person_id: candidate.person_id }).where("id", "=", submission.id).execute();
  await insertSubmissionEvents(db, [{ submission_id: submission.id, event_type: "linked", person_id: candidate.person_id, recorded_by: actor.id, details: { candidateId } }]);
  await discardSiblingCandidates(db, submission.id, candidateId, actor);

}

/** "No, es una persona nueva": crea una persona nueva a partir del envío, ignorando la coincidencia propuesta. */
export async function createNewFromCandidate(actor: SessionUser, candidateId: string): Promise<{ personId: string }> {
  assertPermission(actor, "forms.review_duplicates");
  const { db, submission, schema, normalizedValues, coreValues, customValues, ownerOrganizationId } = await loadCandidateContext(actor, candidateId);

  let personId: string;
  try {
    personId = await createPersonFromSubmission(coreValues, customValues, ownerOrganizationId);
  } catch (err) {
    if (err instanceof FormApplyError) {
      // Solo MASTER_GLOBAL recibe con quién choca; el resto, el mensaje genérico.
      const detail = isMasterGlobal(actor) && err.conflictPersonId ? ` (persona en conflicto: ${err.conflictPersonId})` : "";
      throw new DuplicateResolutionError(`${err.message}${detail}`);
    }
    throw err;
  }
  await applyActions(schema, personId, normalizedValues, ownerOrganizationId);

  await db
    .updateTable("person_duplicate_candidates")
    .set({ status: "created_new", resolved_by: actor.id, resolved_at: new Date() })
    .where("id", "=", candidateId)
    .execute();
  await db.updateTable("form_submissions").set({ match_result: "created", person_id: personId }).where("id", "=", submission.id).execute();
  await insertSubmissionEvents(db, [{ submission_id: submission.id, event_type: "person_created", person_id: personId, recorded_by: actor.id, details: { candidateId } }]);
  await discardSiblingCandidates(db, submission.id, candidateId, actor);


  return { personId };
}

/** Descartar: ni se vincula ni se crea nada; el envío queda igual (`needs_review`, ya revisado, sin acción automática). */
export async function discardDuplicateCandidate(actor: SessionUser, candidateId: string): Promise<void> {
  assertPermission(actor, "forms.review_duplicates");
  // Misma compuerta que resolver: existe, está pendiente y pertenece a un formulario del alcance del usuario.
  const { db, candidate } = await loadCandidateContext(actor, candidateId);

  await db
    .updateTable("person_duplicate_candidates")
    .set({ status: "discarded", resolved_by: actor.id, resolved_at: new Date() })
    .where("id", "=", candidateId)
    .execute();

  // Sin persona y sin otros candidatos pendientes: la respuesta pasa a «sin vincular» (el operador puede vincularla o crear la persona).
  if (candidate.submission_id) {
    const stillPending = await db.selectFrom("person_duplicate_candidates").select("id").where("submission_id", "=", candidate.submission_id).where("status", "=", "pending").executeTakeFirst();
    if (!stillPending) {
      await db.updateTable("form_submissions").set({ match_result: "unlinked" }).where("id", "=", candidate.submission_id).where("person_id", "is", null).where("match_result", "=", "needs_review").execute();
    }
  }
}
