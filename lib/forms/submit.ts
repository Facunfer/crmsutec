import { z } from "zod";
import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { toJsonb } from "../db/json.js";
import { checkPublicLinkRateLimit, recordPublicLinkAttempt } from "../security/public-rate-limit.js";
import { FIELD_TYPES, isCorePersonMapping } from "./field-types.js";
import { getFormBySlug, getPublishedVersionSchema } from "./queries.js";
import { applyActions, createPersonFromSubmission, FormApplyError, MISSING_DNI_MESSAGE, mergeEmptyFieldsOnly, splitCoreAndCustomValues, submissionDni } from "./apply.js";
import { matchPerson } from "./matching.js";
import type { FormVersionField, FormVersionSchema } from "./version-schema.js";

assertServerOnly("lib/forms/submit.ts");

export type SubmitResult =
  | { kind: "ok"; successMessage: string }
  | { kind: "not_found" }
  | { kind: "not_available" }
  | { kind: "rate_limited" }
  | { kind: "validation_error"; fieldErrors: Record<string, string> };

function isWithinWindow(now: Date, opensAt: Date | null, closesAt: Date | null): boolean {
  if (opensAt && now < opensAt) return false;
  if (closesAt && now > closesAt) return false;
  return true;
}

function buildZodShape(fields: FormVersionField[]): z.ZodRawShape {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    if (!field.visible) continue;
    shape[field.key] = FIELD_TYPES[field.fieldType].buildSchema({ required: field.required, options: field.options });
  }
  return shape;
}

function normalizeValue(field: FormVersionField, raw: unknown): unknown {
  const def = FIELD_TYPES[field.fieldType];
  if (def.normalize && typeof raw === "string" && raw !== "") {
    return def.normalize(raw) ?? raw;
  }
  return raw;
}

const DEFAULT_SUCCESS_MESSAGE = "¡Gracias! Recibimos tu formulario.";
const DEFAULT_NOT_AVAILABLE = "Este formulario no está disponible en este momento.";

export async function getPublicForm(
  slug: string
): Promise<{ kind: "ok"; formId: string; ownerOrganizationId: string; schema: FormVersionSchema } | { kind: "not_found" } | { kind: "not_available" }> {
  const form = await getFormBySlug(slug);
  if (!form) return { kind: "not_found" };
  if (form.status !== "published") return { kind: "not_available" };

  const schema = await getPublishedVersionSchema(form);
  if (!schema) return { kind: "not_found" };
  if (!isWithinWindow(new Date(), form.opensAt, form.closesAt)) return { kind: "not_available" };

  return { kind: "ok", formId: form.id, ownerOrganizationId: form.ownerOrganizationId, schema };
}

export async function submitForm(
  slug: string,
  rawEntries: Record<string, string | string[]>,
  idempotencyKey: string,
  ip: string,
  userAgent: string | undefined
): Promise<SubmitResult> {
  const rate = await checkPublicLinkRateLimit("form_submit", slug, ip, { perIdentifierLimit: 60, perIpLimit: 300 });
  if (!rate.allowed) return { kind: "rate_limited" };

  const form = await getFormBySlug(slug);
  if (!form) return { kind: "not_found" };
  if (form.status !== "published" || !form.publishedVersion) return { kind: "not_available" };

  const schema = await getPublishedVersionSchema(form);
  if (!schema) return { kind: "not_available" };
  if (!isWithinWindow(new Date(), form.opensAt, form.closesAt)) return { kind: "not_available" };

  if (schema.consentText && rawEntries.__consent !== "true") {
    await recordPublicLinkAttempt("form_submit", slug, ip, false);
    return { kind: "validation_error", fieldErrors: { __consent: "Tenés que aceptar para continuar." } };
  }

  const zodShape = buildZodShape(schema.fields);
  const parsed = z.object(zodShape).safeParse(rawEntries);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    await recordPublicLinkAttempt("form_submit", slug, ip, false);
    return { kind: "validation_error", fieldErrors };
  }

  const visibleFields = schema.fields.filter((f) => f.visible);
  const normalizedValues: Record<string, unknown> = {};
  for (const field of visibleFields) {
    normalizedValues[field.key] = normalizeValue(field, (parsed.data as Record<string, unknown>)[field.key]);
  }

  const db = await getDb();

  const inserted = await db
    .insertInto("form_submissions")
    .values({
      form_id: form.id,
      form_version: form.publishedVersion,
      raw_payload: toJsonb(parsed.data as never),
      normalized_values: toJsonb(normalizedValues as never),
      idempotency_key: idempotencyKey,
      ip_address: ip,
      user_agent: userAgent ?? null,
    })
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .returning("id")
    .executeTakeFirst();

  await recordPublicLinkAttempt("form_submit", slug, ip, true);

  const successMessage = form.successMessage?.trim() || DEFAULT_SUCCESS_MESSAGE;

  if (!inserted) {
    // Reintento/doble click con el mismo idempotency_key: ya se procesó,
    // no se vuelve a crear ni a matchear una persona por esto.
    return { kind: "ok", successMessage };
  }

  try {
    await processSubmission(inserted.id, form.id, form.ownerOrganizationId, schema, normalizedValues);
  } catch (err) {
    await db
      .updateTable("form_submissions")
      .set({ match_result: "error", error_message: err instanceof Error ? err.message : String(err), processed_at: new Date() })
      .where("id", "=", inserted.id)
      .execute();
    // Con quién choca el DNI queda solo en la auditoría (MASTER_GLOBAL), no en el mensaje que ve quien revisa.
    if (err instanceof FormApplyError && err.conflictPersonId) {
    }
  }

  return { kind: "ok", successMessage };
}

async function processSubmission(
  submissionId: string,
  formId: string,
  ownerOrganizationId: string,
  schema: FormVersionSchema,
  normalizedValues: Record<string, unknown>
): Promise<void> {
  const db = await getDb();
  const { coreValues, customValues } = splitCoreAndCustomValues(schema, normalizedValues, isCorePersonMapping);

  const identity = {
    dni: typeof coreValues.dni === "string" ? coreValues.dni : null,
    email: typeof coreValues.email === "string" ? coreValues.email : null,
    phone: typeof coreValues.phone === "string" ? coreValues.phone : null,
  };

  const outcome = await matchPerson(schema.identificationPolicy.matchFields, identity);

  if (outcome.kind === "none") {
    // Sin coincidencia y sin DNI válido no se puede crear una persona: el envío se conserva, queda en revisión
    // (candidato sin persona propuesta) y NO se inserta nada en `people`.
    if (!submissionDni(coreValues)) {
      await db.insertInto("person_duplicate_candidates").values({ person_id: null, submission_id: submissionId, match_reason: MISSING_DNI_MESSAGE }).execute();
      await db.updateTable("form_submissions").set({ match_result: "needs_review", processed_at: new Date() }).where("id", "=", submissionId).execute();
      return;
    }
    const personId = await createPersonFromSubmission(coreValues, customValues, ownerOrganizationId);
    await db
      .updateTable("form_submissions")
      .set({ match_result: "created", person_id: personId, processed_at: new Date() })
      .where("id", "=", submissionId)
      .execute();
    await applyActions(schema, personId, normalizedValues);
    return;
  }

  // Un envío público nunca escribe sobre una persona de otra unidad: la coincidencia con
  // alguien fuera del árbol de la unidad del formulario va a revisión, sin modificar nada.
  const outsideIds = await personIdsOutsideOrganizationTree(
    outcome.kind === "single" ? [outcome.personId] : outcome.kind === "multiple" ? outcome.personIds : [],
    ownerOrganizationId
  );
  if (outsideIds.size > 0) {
    const candidateIds = outcome.kind === "single" ? [outcome.personId] : outcome.kind === "multiple" ? outcome.personIds : [];
    for (const personId of candidateIds) {
      await db
        .insertInto("person_duplicate_candidates")
        .values({
          person_id: personId,
          submission_id: submissionId,
          match_reason: outsideIds.has(personId)
            ? "Coincide con una persona de otra unidad; no se modifica desde este formulario."
            : "Coincide con una persona de la unidad, junto a otra de otra unidad.",
        })
        .execute();
    }
    await db.updateTable("form_submissions").set({ match_result: "needs_review", processed_at: new Date() }).where("id", "=", submissionId).execute();
    return;
  }

  if (outcome.kind === "single") {
    if (schema.updatePolicy === "fill_empty_only") {
      await mergeEmptyFieldsOnly(outcome.personId, coreValues, customValues);
      await db
        .updateTable("form_submissions")
        .set({ match_result: "matched", person_id: outcome.personId, processed_at: new Date() })
        .where("id", "=", submissionId)
        .execute();
      await applyActions(schema, outcome.personId, normalizedValues);
      return;
    }

    await db
      .insertInto("person_duplicate_candidates")
      .values({ person_id: outcome.personId, submission_id: submissionId, match_reason: `Coincide por ${outcome.matchedBy.join(", ")}; la política del formulario exige revisión manual.` })
      .execute();
    await db.updateTable("form_submissions").set({ match_result: "needs_review", person_id: outcome.personId, processed_at: new Date() }).where("id", "=", submissionId).execute();
    return;
  }

  // outcome.kind === "multiple": ambigüedad real, nunca se elige sola.
  for (const personId of outcome.personIds) {
    await db
      .insertInto("person_duplicate_candidates")
      .values({ person_id: personId, submission_id: submissionId, match_reason: `Coincide por ${outcome.matchedBy[personId]!.join(", ")}, entre varias personas posibles.` })
      .execute();
  }
  await db.updateTable("form_submissions").set({ match_result: "needs_review", processed_at: new Date() }).where("id", "=", submissionId).execute();
}


/** De estos ids, los que NO pertenecen a la unidad propietaria del formulario ni a sus dependientes (una persona sin unidad también cuenta como "fuera"). */
async function personIdsOutsideOrganizationTree(personIds: string[], ownerOrganizationId: string): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const db = await getDb();
  const inside = await sql<{ id: string }>`
    select p.id
    from people p
    where p.id in (${sql.join(personIds.map((id) => sql`${id}::uuid`))})
      and p.organization_id in (select organization_id from organization_descendants(${ownerOrganizationId}::uuid))
  `.execute(db);
  const insideIds = new Set(inside.rows.map((r) => r.id));
  return new Set(personIds.filter((id) => !insideIds.has(id)));
}
