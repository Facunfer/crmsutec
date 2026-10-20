import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import type { FormApplyDataPolicy, FormPersonCreationPolicy, FormStatus, FormSubmissionEventType, PersonFieldType, SubmissionMatchResult, SubmissionSource } from "../db/schema.js";
import { parseFieldValidation, type FieldValidation } from "./field-types.js";
import type { FormVersionSchema } from "./version-schema.js";
import type { SessionUser } from "../permissions/can.js";
import { canAccessForm, isUuid, orgScope } from "../scope/organizations.js";
import { can } from "../permissions/can.js";
import { maskSubmissionPayload } from "./sensitive.js";

assertServerOnly("lib/forms/queries.ts");

export interface FormListItem {
  id: string;
  slug: string;
  name: string;
  status: FormStatus;
  publishedVersion: number | null;
  submissionCount: number;
  pendingReviewCount: number;
  /** Respuestas sin persona vinculada (sin vincular, en revisión o con error). */
  unlinkedCount: number;
  createdAt: Date;
}

/** Solo formularios cuya unidad propietaria está dentro del alcance del usuario. */
export async function listForms(actor: SessionUser): Promise<FormListItem[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("forms")
    .where(orgScope(actor, "forms.owner_organization_id"))
    .leftJoin("form_submissions", "form_submissions.form_id", "forms.id")
    .select([
      "forms.id",
      "forms.slug",
      "forms.name",
      "forms.status",
      "forms.published_version",
      "forms.created_at",
      ({ fn }) => fn.count<number>("form_submissions.id").as("submission_count"),
    ])
    .groupBy(["forms.id", "forms.slug", "forms.name", "forms.status", "forms.published_version", "forms.created_at"])
    .orderBy("forms.created_at", "desc")
    .execute();

  const pending = await db
    .selectFrom("person_duplicate_candidates")
    .innerJoin("form_submissions", "form_submissions.id", "person_duplicate_candidates.submission_id")
    .select(["form_submissions.form_id", ({ fn }) => fn.count<number>("person_duplicate_candidates.id").as("count")])
    .where("person_duplicate_candidates.status", "=", "pending")
    .groupBy("form_submissions.form_id")
    .execute();
  const pendingByForm = new Map(pending.map((p) => [p.form_id, Number(p.count)]));
  const unlinked = await db
    .selectFrom("form_submissions")
    .select(["form_id", ({ fn }) => fn.count<number>("id").as("count")])
    .where("person_id", "is", null)
    .where("match_result", "in", ["unlinked", "needs_review", "error"])
    .groupBy("form_id")
    .execute();
  const unlinkedByForm = new Map(unlinked.map((u) => [u.form_id, Number(u.count)]));

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    publishedVersion: r.published_version,
    submissionCount: Number(r.submission_count),
    pendingReviewCount: pendingByForm.get(r.id) ?? 0,
    unlinkedCount: unlinkedByForm.get(r.id) ?? 0,
    createdAt: r.created_at,
  }));
}

export interface FormDetail {
  id: string;
  ownerOrganizationId: string;
  slug: string;
  name: string;
  status: FormStatus;
  successMessage: string | null;
  consentText: string | null;
  opensAt: Date | null;
  closesAt: Date | null;
  identificationPolicy: { matchFields?: string[] };
  /** DEPRECADA (0043): ya no se lee. */
  updatePolicy: "fill_empty_only" | "always_flag_for_review";
  publishedVersion: number | null;
  // 0043
  description: string | null;
  campaignId: string | null;
  meetingId: string | null;
  defaultMeetingId: string | null;
  personCreationPolicy: FormPersonCreationPolicy;
  applyDataPolicy: FormApplyDataPolicy;
}

/** null si no existe O está fuera del alcance del usuario (no se distingue). */
export async function getFormById(actor: SessionUser, id: string): Promise<FormDetail | null> {
  if (!(await canAccessForm(actor, id))) return null;

  const db = await getDb();
  const row = await db.selectFrom("forms").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    ownerOrganizationId: row.owner_organization_id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    successMessage: row.success_message,
    consentText: row.consent_text,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    identificationPolicy: (row.identification_policy ?? {}) as { matchFields?: string[] },
    updatePolicy: row.update_policy,
    publishedVersion: row.published_version,
    description: row.description,
    campaignId: row.campaign_id,
    meetingId: row.meeting_id,
    defaultMeetingId: row.default_meeting_id,
    personCreationPolicy: row.person_creation_policy,
    applyDataPolicy: row.apply_data_policy,
  };
}

/** Flujo público (`/f/[slug]`): sin sesión ni alcance; el visitante nunca elige ni ve la unidad. */
export async function getFormBySlug(slug: string): Promise<FormDetail | null> {
  const db = await getDb();
  const row = await db.selectFrom("forms").selectAll().where("slug", "=", slug).executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    ownerOrganizationId: row.owner_organization_id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    successMessage: row.success_message,
    consentText: row.consent_text,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    identificationPolicy: (row.identification_policy ?? {}) as { matchFields?: string[] },
    updatePolicy: row.update_policy,
    publishedVersion: row.published_version,
    description: row.description,
    campaignId: row.campaign_id,
    meetingId: row.meeting_id,
    defaultMeetingId: row.default_meeting_id,
    personCreationPolicy: row.person_creation_policy,
    applyDataPolicy: row.apply_data_policy,
  };
}

export interface FormFieldRow {
  id: string;
  key: string;
  label: string;
  fieldType: PersonFieldType;
  options: unknown;
  required: boolean;
  visible: boolean;
  sortOrder: number;
  personFieldMapping: string | null;
  description: string | null;
  validation: FieldValidation;
}

export async function listFormFields(actor: SessionUser, formId: string): Promise<FormFieldRow[]> {
  if (!(await canAccessForm(actor, formId))) return [];

  const db = await getDb();
  const rows = await db.selectFrom("form_fields").selectAll().where("form_id", "=", formId).orderBy("sort_order", "asc").execute();
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    fieldType: r.field_type,
    options: r.options,
    required: r.required,
    visible: r.visible,
    sortOrder: r.sort_order,
    personFieldMapping: r.person_field_mapping,
    description: r.description,
    validation: parseFieldValidation(r.validation),
  }));
}

export interface FormActionRow {
  id: string;
  actionType: "add_to_association";
  config: { associationId?: string };
}

export async function listFormActions(actor: SessionUser, formId: string): Promise<FormActionRow[]> {
  if (!(await canAccessForm(actor, formId))) return [];

  const db = await getDb();
  const rows = await db.selectFrom("form_actions").selectAll().where("form_id", "=", formId).orderBy("sort_order", "asc").execute();
  return rows.map((r) => ({ id: r.id, actionType: r.action_type, config: (r.config ?? {}) as { associationId?: string } }));
}

export async function getPublishedVersionSchema(form: FormDetail): Promise<FormVersionSchema | null> {
  if (!form.publishedVersion) return null;
  const db = await getDb();
  const row = await db
    .selectFrom("form_versions")
    .select("schema")
    .where("form_id", "=", form.id)
    .where("version", "=", form.publishedVersion)
    .executeTakeFirst();
  if (!row) return null;
  return row.schema as unknown as FormVersionSchema;
}

export interface FormSubmissionRow {
  id: string;
  formVersion: number;
  matchResult: SubmissionMatchResult;
  source: SubmissionSource;
  personId: string | null;
  personName: string | null;
  rawPayload: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: Date;
}

/**
 * Respuestas de un formulario del alcance del usuario. Sin `people.view_sensitive`,
 * el payload sale ya enmascarado (DNI, email, teléfono y campos sensibles): la UI, el
 * CSV y cualquier endpoint que use esto reciben solo valores enmascarados.
 */
export async function listSubmissions(actor: SessionUser, formId: string): Promise<FormSubmissionRow[]> {
  if (!(await canAccessForm(actor, formId))) return [];

  const db = await getDb();
  const canSeeSensitive = can(actor, "people.view_sensitive");
  const rows = await db
    .selectFrom("form_submissions")
    .leftJoin("people", "people.id", "form_submissions.person_id")
    .select([
      "form_submissions.id",
      "form_submissions.form_version",
      "form_submissions.match_result",
      "form_submissions.source",
      "form_submissions.person_id",
      "form_submissions.raw_payload",
      "form_submissions.error_message",
      "form_submissions.created_at",
      "people.first_name",
      "people.last_name",
      orgScope(actor, "people.organization_id").as("person_visible"),
    ])
    .where("form_submissions.form_id", "=", formId)
    .orderBy("form_submissions.created_at", "desc")
    .execute();

  // Para enmascarar hace falta el esquema de la versión con que se envió cada respuesta.
  let schemaByVersion = new Map<number, FormVersionSchema>();
  let sensitiveCustomKeys = new Set<string>();
  if (!canSeeSensitive && rows.length > 0) {
    const versions = await db.selectFrom("form_versions").select(["version", "schema"]).where("form_id", "=", formId).execute();
    schemaByVersion = new Map(versions.map((v) => [v.version, v.schema as unknown as FormVersionSchema]));
    const definitions = await db.selectFrom("person_field_definitions").select("key").where("sensitive", "=", true).execute();
    sensitiveCustomKeys = new Set(definitions.map((d) => d.key));
  }

  return rows.map((r) => ({
    id: r.id,
    formVersion: r.form_version,
    matchResult: r.match_result,
    source: r.source,
    // Si la persona vinculada ya no está en el alcance del usuario (p. ej. se la trasladó), no se muestra.
    personId: r.person_visible ? r.person_id : null,
    personName: r.person_visible && r.last_name ? `${r.first_name} ${r.last_name}`.trim() : null,
    rawPayload: canSeeSensitive
      ? ((r.raw_payload ?? {}) as Record<string, unknown>)
      : maskSubmissionPayload(
          (r.raw_payload ?? {}) as Record<string, unknown>,
          schemaByVersion.get(r.form_version) ?? null,
          sensitiveCustomKeys
        ),
    errorMessage: r.error_message,
    createdAt: r.created_at,
  }));
}

export interface UnlinkedSubmissionRow {
  id: string;
  formId: string;
  formName: string;
  formVersion: number;
  matchResult: SubmissionMatchResult;
  source: SubmissionSource;
  /** Candidatos de persona propuestos (revisión): solo la cantidad; el detalle está en la bandeja de duplicados. */
  candidateCount: number;
  /** Payload ya enmascarado si el usuario no tiene people.view_sensitive. */
  rawPayload: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: Date;
}

/**
 * Bandeja «Respuestas sin vincular» (0043): respuestas SIN persona (sin coincidencia, en revisión por ambigüedad o con error) de los
 * formularios cuya unidad propietaria está en el alcance del usuario. No inventa personas: el operador decide (vincular / crear / aplicar).
 */
export async function listUnlinkedSubmissions(
  actor: SessionUser,
  options: { formId?: string; limit?: number; offset?: number } = {}
): Promise<{ rows: UnlinkedSubmissionRow[]; total: number }> {
  const db = await getDb();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const canSeeSensitive = can(actor, "people.view_sensitive");
  const base = db
    .selectFrom("form_submissions")
    .innerJoin("forms", "forms.id", "form_submissions.form_id")
    .where(orgScope(actor, "forms.owner_organization_id"))
    .where("form_submissions.person_id", "is", null)
    .where("form_submissions.match_result", "in", ["unlinked", "needs_review", "error"]);
  const filtered = options.formId ? base.where("form_submissions.form_id", "=", options.formId) : base;

  const [rows, totalRow] = await Promise.all([
    filtered
      .select([
        "form_submissions.id",
        "form_submissions.form_id",
        "form_submissions.form_version",
        "form_submissions.match_result",
        "form_submissions.source",
        "form_submissions.raw_payload",
        "form_submissions.error_message",
        "form_submissions.created_at",
        "forms.name as form_name",
        sql<number>`(select count(*)::int from person_duplicate_candidates c where c.submission_id = form_submissions.id and c.status = 'pending')`.as("candidate_count"),
      ])
      .orderBy("form_submissions.created_at", "desc")
      .orderBy("form_submissions.id", "asc")
      .limit(limit)
      .offset(offset)
      .execute(),
    filtered.select(({ fn }) => fn.count<number>("form_submissions.id").as("n")).executeTakeFirstOrThrow(),
  ]);

  let schemaByKey = new Map<string, FormVersionSchema>();
  let sensitiveCustomKeys = new Set<string>();
  if (!canSeeSensitive && rows.length > 0) {
    const formIds = [...new Set(rows.map((r) => r.form_id))];
    const versions = await db.selectFrom("form_versions").select(["form_id", "version", "schema"]).where("form_id", "in", formIds).execute();
    schemaByKey = new Map(versions.map((v) => [`${v.form_id}:${v.version}`, v.schema as unknown as FormVersionSchema]));
    const definitions = await db.selectFrom("person_field_definitions").select("key").where("sensitive", "=", true).execute();
    sensitiveCustomKeys = new Set(definitions.map((d) => d.key));
  }

  return {
    total: Number(totalRow.n),
    rows: rows.map((r) => ({
      id: r.id,
      formId: r.form_id,
      formName: r.form_name,
      formVersion: r.form_version,
      matchResult: r.match_result,
      source: r.source,
      candidateCount: Number(r.candidate_count),
      rawPayload: canSeeSensitive
        ? ((r.raw_payload ?? {}) as Record<string, unknown>)
        : maskSubmissionPayload((r.raw_payload ?? {}) as Record<string, unknown>, schemaByKey.get(`${r.form_id}:${r.form_version}`) ?? null, sensitiveCustomKeys),
      errorMessage: r.error_message,
      createdAt: r.created_at,
    })),
  };
}

export interface SubmissionEventRow {
  id: string;
  eventType: FormSubmissionEventType;
  occurredAt: Date;
  /** Quién (nombre); null en los eventos automáticos. */
  recordedByName: string | null;
  automatic: boolean;
  personId: string;
  meetingId: string | null;
  meetingName: string | null;
  /** Fila canónica de la inscripción (provenance; el estado vive en meeting_participations). */
  participationId: string | null;
  reason: string | null;
  /** Detalle auditable; los valores de campos sensibles salen enmascarados sin people.view_sensitive. */
  details: Record<string, unknown>;
}

/** Provenance de una respuesta: quién la vinculó, creó la persona, aplicó datos o la inscribió, y cuándo. null si no es visible. */
export async function listSubmissionEvents(actor: SessionUser, submissionId: string): Promise<SubmissionEventRow[] | null> {
  const db = await getDb();
  const sub = await db.selectFrom("form_submissions").select(["form_id"]).where("id", "=", submissionId).executeTakeFirst();
  if (!sub || !(await canAccessForm(actor, sub.form_id))) return null;
  const canSeeSensitive = can(actor, "people.view_sensitive");
  const rows = await db
    .selectFrom("form_submission_events as e")
    .leftJoin("users as u", "u.id", "e.recorded_by")
    .leftJoin("meetings as m", "m.id", "e.meeting_id")
    .select(["e.id", "e.event_type", "e.occurred_at", "u.full_name as recorder", "e.recorded_by", "e.person_id", "e.meeting_id", "m.name as meeting_name", "e.participation_id", "e.reason", "e.details"])
    .where("e.submission_id", "=", submissionId)
    .orderBy("e.seq", "asc")
    .execute();
  const SENSITIVE = new Set(["email", "phone", "birth_date"]);
  return rows.map((r) => {
    const details = (r.details ?? {}) as Record<string, unknown>;
    let safe = details;
    if (!canSeeSensitive && Array.isArray(details.fields)) {
      safe = {
        ...details,
        fields: (details.fields as Array<{ key: string; before: unknown; after: unknown }>).map((f) =>
          SENSITIVE.has(f.key) || f.key.startsWith("custom_") ? { key: f.key, before: f.before === null ? null : "[oculto]", after: "[oculto]" } : f
        ),
      };
    }
    return {
      id: r.id,
      eventType: r.event_type,
      occurredAt: r.occurred_at,
      recordedByName: r.recorded_by ? r.recorder : null,
      automatic: r.recorded_by === null,
      personId: r.person_id,
      meetingId: r.meeting_id,
      meetingName: r.meeting_name,
      participationId: r.participation_id,
      reason: r.reason,
      details: safe,
    };
  });
}

export interface DuplicateCandidateRow {
  id: string;
  personId: string | null;
  personName: string | null;
  submissionId: string | null;
  formId: string | null;
  formName: string | null;
  matchReason: string;
  status: "pending" | "linked" | "created_new" | "discarded";
  rawPayload: Record<string, unknown> | null;
  createdAt: Date;
}

/**
 * El payload de un envío suele traer DNI/email/teléfono en claro — sin
 * `people.view_sensitive` no se lo manda al cliente (`canSeeSensitive`),
 * mismo criterio que el resto de la app: enmascarar es cosa del servidor,
 * nunca del componente (hallazgo real de la Etapa 10).
 */
export async function listPendingDuplicateCandidates(actor: SessionUser, canSeeSensitive: boolean): Promise<DuplicateCandidateRow[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("person_duplicate_candidates")
    .leftJoin("people", "people.id", "person_duplicate_candidates.person_id")
    .leftJoin("form_submissions", "form_submissions.id", "person_duplicate_candidates.submission_id")
    .leftJoin("forms", "forms.id", "form_submissions.form_id")
    .select([
      "person_duplicate_candidates.id",
      "person_duplicate_candidates.person_id",
      "person_duplicate_candidates.submission_id",
      "person_duplicate_candidates.match_reason",
      "person_duplicate_candidates.status",
      "person_duplicate_candidates.created_at",
      "people.first_name",
      "people.last_name",
      "form_submissions.raw_payload",
      "forms.id as form_id",
      "forms.name as form_name",
      orgScope(actor, "people.organization_id").as("person_visible"),
    ])
    .where("person_duplicate_candidates.status", "=", "pending")
    // El candidato pertenece a la unidad del formulario que recibió el envío.
    .where(orgScope(actor, "forms.owner_organization_id"))
    .orderBy("person_duplicate_candidates.created_at", "asc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    // La persona propuesta puede ser de otra unidad: no se revela quién es.
    personId: r.person_visible ? r.person_id : null,
    personName: r.person_visible && r.last_name ? `${r.first_name} ${r.last_name}`.trim() : null,
    submissionId: r.submission_id,
    formId: r.form_id,
    formName: r.form_name,
    matchReason: r.match_reason,
    status: r.status,
    rawPayload: canSeeSensitive ? ((r.raw_payload ?? null) as Record<string, unknown> | null) : null,
    createdAt: r.created_at,
  }));
}

/**
 * Asociaciones que un formulario público puede ofrecer en un campo "asociación":
 * solo las activas de la unidad propietaria del formulario y sus dependientes.
 * El visitante no tiene sesión ni alcance, así que el alcance lo fija la
 * unidad del formulario (configurada en el servidor), nunca lo que envíe.
 */
/**
 * ¿Puede un formulario de esta unidad sumar personas a esta asociación? MISMA regla que `listAssociationsForPublicForm` (activa y de
 * la unidad del formulario o sus dependientes), pero para UN id. Es la compuerta del SERVIDOR (S2): lo que el visitante manda en un
 * campo «asociación» es un UUID cualquiera, y ocultar opciones en pantalla no impide que alguien arme el pedido a mano.
 */
export async function isAssociationAllowedForForm(associationId: string, ownerOrganizationId: string): Promise<boolean> {
  if (!isUuid(associationId) || !isUuid(ownerOrganizationId)) return false;
  const db = await getDb();
  const result = await sql<{ ok: boolean }>`
    select exists (
      select 1 from associations a
      where a.id = ${associationId}::uuid
        and a.status = 'active'
        and a.owner_organization_id in (select organization_id from organization_descendants(${ownerOrganizationId}::uuid))
    ) as ok
  `.execute(db);
  return result.rows[0]?.ok === true;
}

export async function listAssociationsForPublicForm(
  ownerOrganizationId: string
): Promise<Array<{ id: string; name: string }>> {
  const db = await getDb();
  const result = await sql<{ id: string; name: string }>`
    select a.id, a.name
    from associations a
    where a.status = 'active'
      and a.owner_organization_id in (select organization_id from organization_descendants(${ownerOrganizationId}::uuid))
    order by a.name
  `.execute(db);
  return result.rows;
}
