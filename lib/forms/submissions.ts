import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import type { SessionUser } from "../permissions/can.js";
import { isMasterGlobal } from "../permissions/can.js";
import { canAccessForm, canAccessMeeting, canAccessPerson, isUuid } from "../scope/organizations.js";
import { isCorePersonMapping } from "./field-types.js";
import { applyActions, createPersonFromSubmission, FormApplyError, planFieldChanges, splitCoreAndCustomValues, type AppliedChange } from "./apply.js";
import { toJsonb } from "../db/json.js";
import { insertSubmissionEvents } from "./events.js";
import type { FormVersionSchema } from "./version-schema.js";
import { enrollPerson, RegistrationError, type EnrollmentWhen } from "../meetings/registrations.js";

assertServerOnly("lib/forms/submissions.ts");

/**
 * ACCIONES EXPLÍCITAS DE UN OPERADOR SOBRE UNA RESPUESTA (0043). Completar un formulario no vincula, no crea personas, no aplica datos
 * ni inscribe por sí solo (salvo las políticas por formulario, todas «never» por defecto): estos comandos son los únicos caminos y cada
 * uno deja su evento auditable (quién, cuándo, por qué, qué cambió) en la misma transacción.
 *
 * Inscripción: reutiliza `enrollPerson` de B4 (canal `form`, clase A: operador + canal). La fila canónica es `meeting_participations`;
 * `form_submission_events.enrolled` solo referencia esa fila como provenance. Nunca se guarda estado de inscripción acá.
 */
export class SubmissionCommandError extends Error {}

interface LoadedSubmission {
  id: string;
  formId: string;
  formVersion: number;
  personId: string | null;
  matchResult: string;
  createdAt: Date;
  schema: FormVersionSchema;
  normalizedValues: Record<string, unknown>;
  form: { ownerOrganizationId: string; campaignId: string | null; meetingId: string | null; defaultMeetingId: string | null };
}

async function loadSubmission(actor: SessionUser, submissionId: string): Promise<LoadedSubmission> {
  if (!isUuid(submissionId)) throw new SubmissionCommandError("La respuesta no existe.");
  const db = await getDb();
  const sub = await db.selectFrom("form_submissions").selectAll().where("id", "=", submissionId).executeTakeFirst();
  // Fuera del alcance del formulario = inexistente.
  if (!sub || !(await canAccessForm(actor, sub.form_id))) throw new SubmissionCommandError("La respuesta no existe.");
  const form = await db.selectFrom("forms").select(["owner_organization_id", "campaign_id", "meeting_id", "default_meeting_id"]).where("id", "=", sub.form_id).executeTakeFirstOrThrow();
  const version = await db.selectFrom("form_versions").select("schema").where("form_id", "=", sub.form_id).where("version", "=", sub.form_version).executeTakeFirst();
  if (!version) throw new SubmissionCommandError("No se encontró la versión del formulario de esa respuesta.");
  return {
    id: sub.id,
    formId: sub.form_id,
    formVersion: sub.form_version,
    personId: sub.person_id,
    matchResult: sub.match_result,
    createdAt: sub.created_at,
    schema: version.schema as unknown as FormVersionSchema,
    normalizedValues: (sub.normalized_values ?? {}) as Record<string, unknown>,
    form: { ownerOrganizationId: form.owner_organization_id, campaignId: form.campaign_id, meetingId: form.meeting_id, defaultMeetingId: form.default_meeting_id },
  };
}

function splitValues(sub: LoadedSubmission) {
  return splitCoreAndCustomValues(sub.schema, sub.normalizedValues, isCorePersonMapping);
}

/** Cierra los candidatos pendientes de la respuesta cuando un operador la resuelve por otra vía (bandeja de duplicados coherente). */
async function resolvePendingCandidates(trx: Awaited<ReturnType<typeof getDb>>, submissionId: string, actorId: string, linkedPersonId: string | null, createdNew: boolean): Promise<void> {
  const resolvedAt = new Date();
  if (linkedPersonId) {
    await trx
      .updateTable("person_duplicate_candidates")
      .set({ status: createdNew ? "created_new" : "linked", resolved_by: actorId, resolved_at: resolvedAt })
      .where("submission_id", "=", submissionId)
      .where("person_id", "=", linkedPersonId)
      .where("status", "=", "pending")
      .execute();
  }
  await trx
    .updateTable("person_duplicate_candidates")
    .set({ status: "discarded", resolved_by: actorId, resolved_at: resolvedAt })
    .where("submission_id", "=", submissionId)
    .where("status", "=", "pending")
    .execute();
}

// -------------------------------------------------------------------------------------------------------------------
// Vincular
// -------------------------------------------------------------------------------------------------------------------
/**
 * Vincula una respuesta a una persona existente. Solo vincula: NO completa datos (eso es `applySubmissionData`). Idempotente: vincular
 * de nuevo a la MISMA persona es un no-op; una respuesta ya vinculada a OTRA persona no se reasigna sola.
 */
export async function linkSubmissionToPerson(actor: SessionUser, input: { submissionId: string; personId: string; reason?: string }): Promise<{ changed: boolean }> {
  assertPermission(actor, "forms.review_duplicates");
  const sub = await loadSubmission(actor, input.submissionId);
  if (!isUuid(input.personId) || !(await canAccessPerson(actor, input.personId))) throw new SubmissionCommandError("La persona no existe.");

  const db = await getDb();
  const person = await db.selectFrom("people").select(["id", "status"]).where("id", "=", input.personId).executeTakeFirst();
  if (!person || person.status === "merged") throw new SubmissionCommandError("La persona no existe.");
  if (sub.personId === input.personId) return { changed: false };
  if (sub.personId) throw new SubmissionCommandError("La respuesta ya está vinculada a otra persona.");

  return db.transaction().execute(async (trx) => {
    // El UPDATE condicional (person_id IS NULL) serializa dos operadores simultáneos: gana uno, el otro ve changed=false/conflicto.
    const updated = await trx
      .updateTable("form_submissions")
      .set({ person_id: input.personId, match_result: "matched", processed_at: new Date() })
      .where("id", "=", sub.id)
      .where("person_id", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) {
      const now = await trx.selectFrom("form_submissions").select("person_id").where("id", "=", sub.id).executeTakeFirstOrThrow();
      if (now.person_id === input.personId) return { changed: false };
      throw new SubmissionCommandError("La respuesta ya fue vinculada a otra persona.");
    }
    await insertSubmissionEvents(trx, [{ submission_id: sub.id, event_type: "linked", person_id: input.personId, recorded_by: actor.id, reason: input.reason?.trim() || null }]);
    await resolvePendingCandidates(trx as never, sub.id, actor.id, input.personId, false);
    return { changed: true };
  }).then(async (r) => {
    if (r.changed) await applyActions(sub.schema, input.personId, sub.normalizedValues);
    return r;
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Crear persona (explícito)
// -------------------------------------------------------------------------------------------------------------------
/**
 * Crea una persona a partir de una respuesta SIN vincular, por decisión de un operador (independiente de `person_creation_policy`).
 * Exige DNI válido y no choca con una persona existente (la base lo impide). La persona hereda la unidad del formulario.
 */
export async function createPersonFromUnlinkedSubmission(actor: SessionUser, input: { submissionId: string; reason?: string }): Promise<{ personId: string }> {
  assertPermission(actor, "forms.review_duplicates");
  assertPermission(actor, "people.create");
  const sub = await loadSubmission(actor, input.submissionId);
  if (sub.personId) throw new SubmissionCommandError("La respuesta ya está vinculada a una persona.");
  const { coreValues, customValues } = splitValues(sub);

  let personId: string;
  try {
    personId = await createPersonFromSubmission(coreValues, customValues, sub.form.ownerOrganizationId);
  } catch (err) {
    if (err instanceof FormApplyError) {
      const detail = isMasterGlobal(actor) && err.conflictPersonId ? ` (persona en conflicto: ${err.conflictPersonId})` : "";
      throw new SubmissionCommandError(`${err.message}${detail}`);
    }
    throw err;
  }

  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("form_submissions").set({ person_id: personId, match_result: "created", processed_at: new Date() }).where("id", "=", sub.id).execute();
    await insertSubmissionEvents(trx, [{ submission_id: sub.id, event_type: "person_created", person_id: personId, recorded_by: actor.id, reason: input.reason?.trim() || null }]);
    await resolvePendingCandidates(trx as never, sub.id, actor.id, null, true);
  });
  await applyActions(sub.schema, personId, sub.normalizedValues);
  return { personId };
}

// -------------------------------------------------------------------------------------------------------------------
// Aplicar datos (explícito)
// -------------------------------------------------------------------------------------------------------------------
export interface ApplyDataResult {
  changed: boolean;
  fields: AppliedChange[];
}

/**
 * Aplica los datos del formulario (email, teléfono, fecha de nacimiento y campos personalizados) a la persona vinculada. Por defecto
 * completa solo VACÍOS; `overwrite` reemplaza los campos pedidos en `keys` (acto deliberado, requiere `people.edit`). Nunca toca DNI
 * ni nombre. El evento guarda cada campo con su valor anterior y posterior.
 */
export async function applySubmissionData(
  actor: SessionUser,
  input: { submissionId: string; mode?: "fill_empty" | "overwrite"; keys?: string[]; reason?: string }
): Promise<ApplyDataResult> {
  assertPermission(actor, "forms.review_duplicates");
  assertPermission(actor, "people.edit");
  const mode = input.mode ?? "fill_empty";
  if (mode === "overwrite" && (!input.keys || input.keys.length === 0)) {
    throw new SubmissionCommandError("Para reemplazar datos hay que indicar explícitamente qué campos.");
  }
  const sub = await loadSubmission(actor, input.submissionId);
  if (!sub.personId) throw new SubmissionCommandError("Primero vinculá la respuesta a una persona.");
  if (!(await canAccessPerson(actor, sub.personId))) throw new SubmissionCommandError("La persona no existe.");

  const { coreValues, customValues } = splitValues(sub);
  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    // Bloquea a la persona: dos «aplicar» simultáneos no se pisan ni duplican el evento.
    await sql`select 1 from people where id = ${sub.personId}::uuid for update`.execute(trx);
    const existing = await trx.selectFrom("people").selectAll().where("id", "=", sub.personId!).executeTakeFirstOrThrow();
    const plan = planFieldChanges(existing as unknown as Record<string, unknown>, coreValues, customValues, { mode, keys: input.keys });
    if (plan.changes.length === 0) return { changed: false, fields: [] };
    const patch: Record<string, unknown> = { ...plan.corePatch, updated_at: new Date() };
    if (plan.customFields) patch.custom_fields = toJsonb(plan.customFields as never);
    await trx
      .updateTable("people")
      .set({ ...patch, version: sql<number>`version + 1` } as never)
      .where("id", "=", sub.personId!)
      .execute();
    await insertSubmissionEvents(trx, [
      { submission_id: sub.id, event_type: "data_applied", person_id: sub.personId!, recorded_by: actor.id, reason: input.reason?.trim() || null, details: { mode, fields: plan.changes } },
    ]);
    return { changed: true, fields: plan.changes };
  });
}

// -------------------------------------------------------------------------------------------------------------------
// Inscribir (explícito, reutiliza B4)
// -------------------------------------------------------------------------------------------------------------------
export type EnrollSubmissionStatus = "enrolled" | "already_registered" | "already_enrolled_from_submission" | "unlinked" | "error";

export interface EnrollSubmissionResult {
  submissionId: string;
  status: EnrollSubmissionStatus;
  message?: string;
  participationId?: string;
  capacityWarning?: { capacity: number; registered: number };
}

/**
 * Resuelve a qué reunión va la inscripción. Un formulario con campaña NUNCA decide solo entre varias jornadas: o tiene una jornada por
 * defecto configurada, o el operador la elige. Con reunión fija, solo esa. La jornada elegida debe pertenecer a la campaña del formulario.
 */
async function resolveTargetMeeting(actor: SessionUser, form: LoadedSubmission["form"], requested: string | undefined | null): Promise<string> {
  const db = await getDb();
  let target = requested?.trim() || null;
  if (form.meetingId) {
    if (target && target !== form.meetingId) throw new SubmissionCommandError("Este formulario está vinculado a otra reunión.");
    target = form.meetingId;
  } else if (!target && form.defaultMeetingId) {
    target = form.defaultMeetingId;
  }
  if (!target) {
    throw new SubmissionCommandError(form.campaignId ? "Elegí la jornada de la campaña en la que se inscribe: el formulario no define una por defecto." : "Elegí la reunión en la que se inscribe.");
  }
  if (!isUuid(target) || !(await canAccessMeeting(actor, target))) throw new SubmissionCommandError("La reunión no existe.");
  if (form.campaignId) {
    const m = await db.selectFrom("meetings").select(["campaign_id"]).where("id", "=", target).executeTakeFirst();
    if (!m || m.campaign_id !== form.campaignId) throw new SubmissionCommandError("La reunión no pertenece a la campaña del formulario.");
  }
  return target;
}

/**
 * «Inscribir respuestas seleccionadas»: por cada respuesta VINCULADA, crea la inscripción canónica con las reglas de B4 (estados, fecha,
 * scope, idempotencia) y deja `enrolled` como provenance en la MISMA transacción. La inscripción queda con `registered_at` = momento en
 * que la persona envió el formulario y `recorded_by` = el operador. Repetir la acción es no-op (UNIQUE por respuesta y reunión).
 */
export async function enrollSubmissions(
  actor: SessionUser,
  input: { submissionIds: string[]; meetingId?: string; when?: EnrollmentWhen; reason?: string }
): Promise<EnrollSubmissionResult[]> {
  assertPermission(actor, "meetings.manage_invitations");
  assertPermission(actor, "forms.view");
  if (input.submissionIds.length === 0) return [];
  if (input.submissionIds.length > 500) throw new SubmissionCommandError("Se pueden inscribir hasta 500 respuestas por vez.");

  const results: EnrollSubmissionResult[] = [];
  const db = await getDb();
  let meetingCache = new Map<string, string>();

  for (const submissionId of [...new Set(input.submissionIds)]) {
    try {
      const sub = await loadSubmission(actor, submissionId);
      const cacheKey = `${sub.formId}`;
      let meetingId = meetingCache.get(cacheKey);
      if (!meetingId) {
        meetingId = await resolveTargetMeeting(actor, sub.form, input.meetingId);
        meetingCache.set(cacheKey, meetingId);
      }
      if (!sub.personId) {
        results.push({ submissionId, status: "unlinked", message: "La respuesta no está vinculada a una persona: vinculala primero." });
        continue;
      }
      const prior = await db
        .selectFrom("form_submission_events")
        .select(["participation_id"])
        .where("submission_id", "=", submissionId)
        .where("meeting_id", "=", meetingId)
        .where("event_type", "=", "enrolled")
        .executeTakeFirst();
      if (prior) {
        results.push({ submissionId, status: "already_enrolled_from_submission", participationId: prior.participation_id ?? undefined });
        continue;
      }

      const when: EnrollmentWhen = input.when ?? { kind: "exact", at: sub.createdAt };
      const personId = sub.personId;
      const enrolled = await enrollPerson(
        actor,
        { meetingId, personId, channel: "form", when, reason: input.reason },
        {
          fromFormSubmission: true,
          afterEnroll: async (trx, r) => {
            await insertSubmissionEvents(trx, [
              {
                submission_id: submissionId,
                event_type: "enrolled",
                person_id: personId,
                meeting_id: meetingId,
                participation_id: r.participationId,
                recorded_by: actor.id,
                details: { formId: sub.formId, registrationCreated: r.changed },
              },
            ]);
          },
        }
      );
      results.push({
        submissionId,
        status: enrolled.changed ? "enrolled" : "already_registered",
        participationId: enrolled.participationId,
        capacityWarning: enrolled.capacityWarning,
      });
    } catch (err) {
      if (err instanceof SubmissionCommandError || err instanceof RegistrationError) {
        results.push({ submissionId, status: "error", message: err.message });
        continue;
      }
      throw err;
    }
  }
  return results;
}
