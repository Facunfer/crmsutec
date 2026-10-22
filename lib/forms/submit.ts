import { z } from "zod";
import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { toJsonb } from "../db/json.js";
import { hasUnsafeText, isUnsafeText, UNSAFE_TEXT_MESSAGE } from "../security/text-safety.js";
import { consumePublicLinkAttempt, hashRateLimitIdentifier, settlePublicLinkAttempt } from "../security/public-rate-limit.js";
import { FIELD_TYPES, isCorePersonMapping } from "./field-types.js";
import { getFormBySlug, getPublishedVersionSchema } from "./queries.js";
import { applyActions, applyFieldsToPerson, createPersonFromSubmission, splitCoreAndCustomValues, submissionDni } from "./apply.js";
import { insertSubmissionEvents } from "./events.js";
import { enrollFromFormAsSystem } from "../meetings/registrations.js";
import type { FormApplyDataPolicy, FormEnrollmentMode, FormPersonCreationPolicy } from "../db/schema.js";
import { matchPerson } from "./matching.js";
import type { FormVersionField, FormVersionSchema } from "./version-schema.js";

assertServerOnly("lib/forms/submit.ts");

export type SubmitResult =
  | { kind: "ok"; successMessage: string }
  | { kind: "not_found" }
  | { kind: "not_available" }
  | { kind: "rate_limited" }
  /** Enviado demasiado rápido tras abrir el formulario: se reintenta en unos segundos (nunca se guarda). */
  | { kind: "too_fast" }
  | { kind: "validation_error"; fieldErrors: Record<string, string> };

/**
 * Señales anti-automatización que manda el navegador junto con el formulario (S3). Son FRICCIÓN contra bots simples, no una
 * frontera de seguridad: el control real son los límites atómicos por enlace, por IP y por persona (DNI) de `submitForm`.
 */
export interface SubmitSignals {
  /** Campo trampa (`__website_url`): invisible para una persona. Si trae algo, quien lo mandó es un programa. */
  honeypot?: string;
  /** Instante (ms epoch, del SERVIDOR) en que se renderizó el formulario. Ausente en páginas abiertas antes de este cambio. */
  renderedAtMs?: number;
}

/** Tope razonable para una clave de idempotencia (un UUID mide 36). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** Nadie lee y completa un formulario en menos de esto, ni siquiera con autocompletado del teléfono. */
export const MIN_FILL_MS = 1500;
/** Un mismo DNI no se envía más de N veces por formulario en la ventana (reenvíos abusivos / relleno de la bandeja). */
const SAME_PERSON_SUBMIT_LIMIT = 5;
const SAME_PERSON_WINDOW_MINUTES = 60;

function isWithinWindow(now: Date, opensAt: Date | null, closesAt: Date | null): boolean {
  if (opensAt && now < opensAt) return false;
  if (closesAt && now > closesAt) return false;
  return true;
}

function buildZodShape(fields: FormVersionField[]): z.ZodRawShape {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    if (!field.visible) continue;
    shape[field.key] = FIELD_TYPES[field.fieldType].buildSchema({ required: field.required, options: field.options, validation: field.validation });
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
  if (isUnsafeText(slug)) return { kind: "not_found" };
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
  userAgent: string | undefined,
  signals: SubmitSignals = {}
): Promise<SubmitResult> {
  // Un slug con texto que la base no guarda no puede existir: mismo resultado que cualquier formulario inexistente, sin tocar la base.
  if (isUnsafeText(slug)) return { kind: "not_found" };

  // Reserva ATÓMICA del intento (S5). Tope por formulario holgado: una inscripción a un acto puede recibir cientos de envíos en
  // minutos y bloquearlos a todos por llegar juntos sería el daño; lo que frena el abuso son el tope por IP y el de «misma persona».
  const attempt = await consumePublicLinkAttempt("form_submit", slug, ip, { perIdentifierLimit: 600, perIpLimit: 300 });
  if (!attempt.allowed) return { kind: "rate_limited" };

  // La clave de idempotencia la manda el navegador (argumento de la Server Action): no puede traer texto que la base no guarda.
  if (isUnsafeText(idempotencyKey) || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return { kind: "validation_error", fieldErrors: { __form: "Recargá la página e intentá de nuevo." } };
  }

  const form = await getFormBySlug(slug);
  if (!form) return { kind: "not_found" };
  if (form.status !== "published" || !form.publishedVersion) return { kind: "not_available" };

  const schema = await getPublishedVersionSchema(form);
  if (!schema) return { kind: "not_available" };
  if (!isWithinWindow(new Date(), form.opensAt, form.closesAt)) return { kind: "not_available" };

  const successMessage = form.successMessage?.trim() || DEFAULT_SUCCESS_MESSAGE;

  // Honeypot: a un programa que llenó el campo trampa se le contesta «gracias» (no se le avisa) y no se guarda nada.
  if (signals.honeypot && signals.honeypot.trim() !== "") return { kind: "ok", successMessage };
  // Demasiado rápido: puede ser una persona real (autocompletado), así que se pide reintentar en vez de descartar en silencio.
  // Si el instante falta o es inverosímil (futuro), no hay señal confiable y se deja pasar.
  if (signals.renderedAtMs !== undefined) {
    const elapsed = Date.now() - signals.renderedAtMs;
    if (elapsed >= 0 && elapsed < MIN_FILL_MS) return { kind: "too_fast" };
  }

  // Caracteres que la base no puede guardar (byte nulo, sustitutos sueltos): se rechaza ese campo, nunca se "limpia" ni se da error 500.
  const unsafeFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEntries)) {
    if (key.startsWith("__")) continue;
    if (hasUnsafeText(value)) unsafeFields[key] = UNSAFE_TEXT_MESSAGE;
  }
  if (Object.keys(unsafeFields).length > 0) return { kind: "validation_error", fieldErrors: unsafeFields };

  if (schema.consentText && rawEntries.__consent !== "true") {
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
    return { kind: "validation_error", fieldErrors };
  }

  const visibleFields = schema.fields.filter((f) => f.visible);
  const normalizedValues: Record<string, unknown> = {};
  for (const field of visibleFields) {
    normalizedValues[field.key] = normalizeValue(field, (parsed.data as Record<string, unknown>)[field.key]);
  }

  const db = await getDb();

  // Reintento del MISMO envío (doble toque, recarga, red lenta): ya se procesó, no consume el tope de «misma persona».
  const alreadyProcessed = await db.selectFrom("form_submissions").select("id").where("idempotency_key", "=", idempotencyKey).executeTakeFirst();
  if (alreadyProcessed) {
    await settlePublicLinkAttempt(attempt.attemptId, true);
    return { kind: "ok", successMessage };
  }

  // Misma persona (DNI) enviando una y otra vez el mismo formulario. El DNI nunca se guarda en claro en el rastro del límite: se hashea.
  const sameDni = submissionDni(splitCoreAndCustomValues(schema, normalizedValues, isCorePersonMapping).coreValues);
  if (sameDni) {
    const person = await consumePublicLinkAttempt("form_submit_person", hashRateLimitIdentifier("form_submit_person", `${form.id}:${sameDni}`), ip, {
      perIdentifierLimit: SAME_PERSON_SUBMIT_LIMIT,
      perIpLimit: Number.MAX_SAFE_INTEGER,
      windowMinutes: SAME_PERSON_WINDOW_MINUTES,
    });
    if (!person.allowed) return { kind: "rate_limited" };
  }

  const inserted = await db
    .insertInto("form_submissions")
    .values({
      form_id: form.id,
      form_version: form.publishedVersion,
      raw_payload: toJsonb(parsed.data as never),
      normalized_values: toJsonb(normalizedValues as never),
      idempotency_key: idempotencyKey,
      ip_address: ip,
      // Un User-Agent real nunca trae un byte nulo (el servidor HTTP lo rechaza); por defensa, si llegara, no se guarda.
      user_agent: userAgent && !isUnsafeText(userAgent) ? userAgent : null,
    })
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .returning("id")
    .executeTakeFirst();

  await settlePublicLinkAttempt(attempt.attemptId, true);

  if (!inserted) {
    // Reintento/doble click con el mismo idempotency_key: ya se procesó,
    // no se vuelve a crear ni a matchear una persona por esto.
    return { kind: "ok", successMessage };
  }

  try {
    await processSubmission(inserted.id, form.id, form.ownerOrganizationId, schema, normalizedValues, {
      personCreation: form.personCreationPolicy,
      applyData: form.applyDataPolicy,
      enrollment: { mode: form.enrollmentMode, meetingId: form.meetingId, campaignId: form.campaignId },
    });
  } catch (err) {
    await db
      .updateTable("form_submissions")
      .set({ match_result: "error", error_message: err instanceof Error ? err.message : String(err), processed_at: new Date() })
      .where("id", "=", inserted.id)
      .execute();
    // Con quién choca el DNI queda solo en la auditoría (MASTER_GLOBAL), no en el mensaje que ve quien revisa.
  }

  return { kind: "ok", successMessage };
}

/** Políticas vigentes del formulario al procesar el envío (se leen de `forms`, no del snapshot: cambiar una política rige para los próximos envíos). */
interface ProcessingPolicy {
  personCreation: FormPersonCreationPolicy;
  applyData: FormApplyDataPolicy;
  /** Destino de la inscripción automática (0048). Con modo «never» el envío no inscribe. */
  enrollment: { mode: FormEnrollmentMode; meetingId: string | null; campaignId: string | null };
}

/**
 * Inscripción AUTOMÁTICA (Etapa 1c): solo cuando el formulario lo pide (`enrollment_mode`) y la persona quedó vinculada o creada SIN
 * ambigüedad. Una respuesta en revisión o sin vincular NUNCA inscribe: lo decide un operador. Un fallo al inscribir no afecta a la respuesta
 * pública (ya está guardada y vinculada, y el visitante ve el mismo «ok»): el operador puede inscribirla después con «Inscribir respuestas».
 *   - single_meeting: la reunión fija del formulario.
 *   - campaign_all: todas las jornadas VIGENTES de la campaña (borrador, programada o en curso; no canceladas ni finalizadas).
 *   - campaign_selected: todavía no inscribe (necesita una pregunta de opción múltiple): queda para el operador.
 */
async function autoEnrollSubmission(policy: ProcessingPolicy, submissionId: string, formId: string, personId: string): Promise<void> {
  const { mode, meetingId, campaignId } = policy.enrollment;
  if (mode === "never" || mode === "campaign_selected") return;
  const db = await getDb();
  try {
    let meetingIds: string[] = [];
    if (mode === "single_meeting" && meetingId) {
      meetingIds = [meetingId];
    } else if (mode === "campaign_all" && campaignId) {
      const rows = await db
        .selectFrom("meetings")
        .select("id")
        .where("campaign_id", "=", campaignId)
        .where("status", "in", ["draft", "scheduled", "in_progress"])
        .orderBy("starts_at", "asc")
        .execute();
      meetingIds = rows.map((r) => r.id);
    }
    if (meetingIds.length === 0) return;
    const submission = await db.selectFrom("form_submissions").select("created_at").where("id", "=", submissionId).executeTakeFirstOrThrow();
    for (const id of meetingIds) {
      try {
        await enrollFromFormAsSystem({ submissionId, formId, personId, meetingId: id, submittedAt: submission.created_at });
      } catch (err) {
        console.warn(`[forms] inscripción automática fallida (formulario ${formId}): ${err instanceof Error ? err.name : "error"}`);
      }
    }
  } catch (err) {
    console.warn(`[forms] inscripción automática fallida (formulario ${formId}): ${err instanceof Error ? err.name : "error"}`);
  }
}

/**
 * Procesa un envío YA persistido (raw_payload inmutable). Reglas (0043):
 *  - coincidencia inequívoca (única y dentro de la unidad del formulario) → se VINCULA el envío a la persona;
 *  - NO se crea una persona salvo `person_creation_policy = when_valid_dni` (y con DNI válido);
 *  - NO se completan datos de la persona salvo `apply_data_policy = fill_empty_only` (solo campos vacíos);
 *  - sin coincidencia → «sin vincular» (match_result = 'unlinked'): un operador decide (vincular / crear / aplicar datos);
 *  - ambigua o fuera de la unidad → revisión (person_duplicate_candidates), sin modificar a nadie.
 * Completar un formulario NO crea asistencia ni contacto. Inscribe SOLO si el formulario lo pide (`enrollment_mode`, 0048; por defecto «never»)
 * y la persona quedó vinculada o creada sin ambigüedad: ver `autoEnrollSubmission`.
 */
async function processSubmission(
  submissionId: string,
  formId: string,
  ownerOrganizationId: string,
  schema: FormVersionSchema,
  normalizedValues: Record<string, unknown>,
  policy: ProcessingPolicy
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
    // Política por defecto («never»): el envío se conserva SIN VINCULAR. No se inserta nada en `people`.
    if (policy.personCreation !== "when_valid_dni" || !submissionDni(coreValues)) {
      await db.updateTable("form_submissions").set({ match_result: "unlinked", processed_at: new Date() }).where("id", "=", submissionId).execute();
      return;
    }
    const personId = await createPersonFromSubmission(coreValues, customValues, ownerOrganizationId);
    await db
      .updateTable("form_submissions")
      .set({ match_result: "created", person_id: personId, processed_at: new Date() })
      .where("id", "=", submissionId)
      .execute();
    await insertSubmissionEvents(db, [{ submission_id: submissionId, event_type: "auto_person_created", person_id: personId, recorded_by: null, details: { policy: "when_valid_dni" } }]);
    await applyActions(schema, personId, normalizedValues, ownerOrganizationId);
    await autoEnrollSubmission(policy, submissionId, formId, personId);
    return;
  }

  // Un envío público nunca vincula ni escribe sobre una persona de otra unidad: la coincidencia con
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
    // Coincidencia por email/teléfono con un DNI DISTINTO al informado: puede ser un homónimo o un contacto compartido. No se vincula sola.
    if (identity.dni) {
      const matched = await db.selectFrom("people").select(["dni"]).where("id", "=", outcome.personId).executeTakeFirst();
      if (matched?.dni && matched.dni !== identity.dni) {
        await db
          .insertInto("person_duplicate_candidates")
          .values({
            person_id: outcome.personId,
            submission_id: submissionId,
            match_reason: `Coincide por ${outcome.matchedBy.join(", ")}, pero el DNI informado no es el de la persona: puede ser otra persona. Requiere revisión.`,
          })
          .execute();
        await db.updateTable("form_submissions").set({ match_result: "needs_review", processed_at: new Date() }).where("id", "=", submissionId).execute();
        return;
      }
    }
    await db
      .updateTable("form_submissions")
      .set({ match_result: "matched", person_id: outcome.personId, processed_at: new Date() })
      .where("id", "=", submissionId)
      .execute();
    await insertSubmissionEvents(db, [{ submission_id: submissionId, event_type: "auto_linked", person_id: outcome.personId, recorded_by: null, details: { matchedBy: outcome.matchedBy } }]);
    if (policy.applyData === "fill_empty_only") {
      const changes = await applyFieldsToPerson(outcome.personId, coreValues, customValues, { mode: "fill_empty" });
      if (changes.length > 0) {
        await insertSubmissionEvents(db, [{ submission_id: submissionId, event_type: "auto_data_applied", person_id: outcome.personId, recorded_by: null, details: { mode: "fill_empty", fields: changes } }]);
      }
    }
    await applyActions(schema, outcome.personId, normalizedValues, ownerOrganizationId);
    await autoEnrollSubmission(policy, submissionId, formId, outcome.personId);
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
