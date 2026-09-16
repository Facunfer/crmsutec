import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { writeAuditLog } from "../audit/log.js";
import type { SessionUser } from "../permissions/can.js";
import { isCorePersonMapping } from "./field-types.js";
import { applyActions, createPersonFromSubmission, FormApplyError, mergeEmptyFieldsOnly, splitCoreAndCustomValues } from "./apply.js";
import type { FormVersionSchema } from "./version-schema.js";

assertServerOnly("lib/forms/duplicates.ts");

export class DuplicateResolutionError extends Error {}

async function loadCandidateContext(candidateId: string) {
  const db = await getDb();
  const candidate = await db.selectFrom("person_duplicate_candidates").selectAll().where("id", "=", candidateId).executeTakeFirst();
  if (!candidate) throw new DuplicateResolutionError("El candidato no existe.");
  if (candidate.status !== "pending") throw new DuplicateResolutionError("Este candidato ya fue resuelto.");
  if (!candidate.submission_id) throw new DuplicateResolutionError("El candidato no tiene un envío asociado.");

  const submission = await db.selectFrom("form_submissions").selectAll().where("id", "=", candidate.submission_id).executeTakeFirst();
  if (!submission) throw new DuplicateResolutionError("El envío original ya no existe.");

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

  return { db, candidate, submission, schema, normalizedValues, coreValues, customValues };
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

/** "Sí, es esta persona": aplica fill-empty-only y las acciones, igual que un match automático confirmado a mano. */
export async function linkDuplicateCandidate(actor: SessionUser, candidateId: string): Promise<void> {
  assertPermission(actor, "forms.review_duplicates");
  const { db, candidate, submission, schema, normalizedValues, coreValues, customValues } = await loadCandidateContext(candidateId);
  if (!candidate.person_id) throw new DuplicateResolutionError("Este candidato no tiene una persona propuesta para vincular.");

  await mergeEmptyFieldsOnly(candidate.person_id, coreValues, customValues);
  await applyActions(schema, candidate.person_id, normalizedValues);

  await db
    .updateTable("person_duplicate_candidates")
    .set({ status: "linked", resolved_by: actor.id, resolved_at: new Date() })
    .where("id", "=", candidateId)
    .execute();
  await db.updateTable("form_submissions").set({ match_result: "matched", person_id: candidate.person_id }).where("id", "=", submission.id).execute();
  await discardSiblingCandidates(db, submission.id, candidateId, actor);

  await writeAuditLog({
    actorUserId: actor.id,
    action: "FORM_DUPLICATE_LINKED",
    entityType: "person",
    entityId: candidate.person_id,
    metadata: { submission_id: submission.id, candidate_id: candidateId },
  });
}

/** "No, es una persona nueva": crea una persona nueva a partir del envío, ignorando la coincidencia propuesta. */
export async function createNewFromCandidate(actor: SessionUser, candidateId: string): Promise<{ personId: string }> {
  assertPermission(actor, "forms.review_duplicates");
  const { db, submission, schema, normalizedValues, coreValues, customValues } = await loadCandidateContext(candidateId);

  let personId: string;
  try {
    personId = await createPersonFromSubmission(coreValues, customValues);
  } catch (err) {
    if (err instanceof FormApplyError) throw new DuplicateResolutionError(err.message);
    throw err;
  }
  await applyActions(schema, personId, normalizedValues);

  await db
    .updateTable("person_duplicate_candidates")
    .set({ status: "created_new", resolved_by: actor.id, resolved_at: new Date() })
    .where("id", "=", candidateId)
    .execute();
  await db.updateTable("form_submissions").set({ match_result: "created", person_id: personId }).where("id", "=", submission.id).execute();
  await discardSiblingCandidates(db, submission.id, candidateId, actor);

  await writeAuditLog({
    actorUserId: actor.id,
    action: "FORM_DUPLICATE_CREATED_NEW",
    entityType: "person",
    entityId: personId,
    metadata: { submission_id: submission.id, candidate_id: candidateId },
  });

  return { personId };
}

/** Descartar: ni se vincula ni se crea nada; el envío queda igual (`needs_review`, ya revisado, sin acción automática). */
export async function discardDuplicateCandidate(actor: SessionUser, candidateId: string): Promise<void> {
  assertPermission(actor, "forms.review_duplicates");
  const db = await getDb();
  const candidate = await db.selectFrom("person_duplicate_candidates").select(["id", "status"]).where("id", "=", candidateId).executeTakeFirst();
  if (!candidate) throw new DuplicateResolutionError("El candidato no existe.");
  if (candidate.status !== "pending") throw new DuplicateResolutionError("Este candidato ya fue resuelto.");

  await db
    .updateTable("person_duplicate_candidates")
    .set({ status: "discarded", resolved_by: actor.id, resolved_at: new Date() })
    .where("id", "=", candidateId)
    .execute();

  await writeAuditLog({ actorUserId: actor.id, action: "FORM_DUPLICATE_DISCARDED", entityType: "person_duplicate_candidate", entityId: candidateId });
}
