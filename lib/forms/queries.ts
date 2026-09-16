import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import type { FormStatus, PersonFieldType } from "../db/schema.js";
import type { FormVersionSchema } from "./version-schema.js";

assertServerOnly("lib/forms/queries.ts");

export interface FormListItem {
  id: string;
  slug: string;
  name: string;
  status: FormStatus;
  publishedVersion: number | null;
  submissionCount: number;
  pendingReviewCount: number;
  createdAt: Date;
}

export async function listForms(): Promise<FormListItem[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("forms")
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

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    publishedVersion: r.published_version,
    submissionCount: Number(r.submission_count),
    pendingReviewCount: pendingByForm.get(r.id) ?? 0,
    createdAt: r.created_at,
  }));
}

export interface FormDetail {
  id: string;
  slug: string;
  name: string;
  status: FormStatus;
  successMessage: string | null;
  consentText: string | null;
  opensAt: Date | null;
  closesAt: Date | null;
  identificationPolicy: { matchFields?: string[] };
  updatePolicy: "fill_empty_only" | "always_flag_for_review";
  publishedVersion: number | null;
}

export async function getFormById(id: string): Promise<FormDetail | null> {
  const db = await getDb();
  const row = await db.selectFrom("forms").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
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
  };
}

export async function getFormBySlug(slug: string): Promise<FormDetail | null> {
  const db = await getDb();
  const row = await db.selectFrom("forms").selectAll().where("slug", "=", slug).executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
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
}

export async function listFormFields(formId: string): Promise<FormFieldRow[]> {
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
  }));
}

export interface FormActionRow {
  id: string;
  actionType: "add_to_association";
  config: { associationId?: string };
}

export async function listFormActions(formId: string): Promise<FormActionRow[]> {
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
  matchResult: "pending" | "created" | "matched" | "needs_review" | "error";
  personId: string | null;
  personName: string | null;
  rawPayload: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: Date;
}

export async function listSubmissions(formId: string): Promise<FormSubmissionRow[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("form_submissions")
    .leftJoin("people", "people.id", "form_submissions.person_id")
    .select([
      "form_submissions.id",
      "form_submissions.form_version",
      "form_submissions.match_result",
      "form_submissions.person_id",
      "form_submissions.raw_payload",
      "form_submissions.error_message",
      "form_submissions.created_at",
      "people.first_name",
      "people.last_name",
    ])
    .where("form_submissions.form_id", "=", formId)
    .orderBy("form_submissions.created_at", "desc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    formVersion: r.form_version,
    matchResult: r.match_result,
    personId: r.person_id,
    personName: r.first_name ? `${r.first_name} ${r.last_name}` : null,
    rawPayload: (r.raw_payload ?? {}) as Record<string, unknown>,
    errorMessage: r.error_message,
    createdAt: r.created_at,
  }));
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
export async function listPendingDuplicateCandidates(canSeeSensitive: boolean): Promise<DuplicateCandidateRow[]> {
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
    ])
    .where("person_duplicate_candidates.status", "=", "pending")
    .orderBy("person_duplicate_candidates.created_at", "asc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    personId: r.person_id,
    personName: r.first_name ? `${r.first_name} ${r.last_name}` : null,
    submissionId: r.submission_id,
    formId: r.form_id,
    formName: r.form_name,
    matchReason: r.match_reason,
    status: r.status,
    rawPayload: canSeeSensitive ? ((r.raw_payload ?? null) as Record<string, unknown> | null) : null,
    createdAt: r.created_at,
  }));
}
