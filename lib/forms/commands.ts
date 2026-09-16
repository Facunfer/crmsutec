import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { writeAuditLog } from "../audit/log.js";
import { toJsonb } from "../db/json.js";
import type { SessionUser } from "../permissions/can.js";
import type { FormStatus } from "../db/schema.js";
import { FIELD_TYPES, isCorePersonMapping, parseFieldOptions } from "./field-types.js";
import { parseOptionsText, type FieldInput, type FormMetaInput } from "./schema.js";
import type { FormVersionSchema } from "./version-schema.js";

assertServerOnly("lib/forms/commands.ts");

export class FormCommandError extends Error {}

export async function createForm(actor: SessionUser, input: { name: string; slug: string }): Promise<{ id: string }> {
  assertPermission(actor, "forms.create");

  const name = input.name.trim();
  const slug = input.slug.trim().toLowerCase();
  if (!name) throw new FormCommandError("El nombre es obligatorio.");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new FormCommandError("El slug solo puede tener minúsculas, números y guiones.");
  }

  const db = await getDb();
  const existing = await db.selectFrom("forms").select("id").where("slug", "=", slug).executeTakeFirst();
  if (existing) throw new FormCommandError(`Ya existe un formulario con el slug "${slug}".`);

  const created = await db
    .insertInto("forms")
    .values({ name, slug, created_by: actor.id, identification_policy: toJsonb({ matchFields: ["dni", "email", "phone"] }) })
    .returning("id")
    .executeTakeFirstOrThrow();

  await writeAuditLog({ actorUserId: actor.id, action: "FORM_CREATED", entityType: "form", entityId: created.id, after: { name, slug } });

  return { id: created.id };
}

function toDateOrNull(value: string | undefined | null): Date | null {
  return value ? new Date(value) : null;
}

async function requireEditableForm(formId: string): Promise<{ id: string; status: FormStatus }> {
  const db = await getDb();
  const form = await db.selectFrom("forms").select(["id", "status"]).where("id", "=", formId).executeTakeFirst();
  if (!form) throw new FormCommandError("El formulario no existe.");
  if (form.status === "archived") throw new FormCommandError("Un formulario archivado no se puede editar.");
  return form;
}

export async function updateFormMeta(actor: SessionUser, formId: string, input: FormMetaInput): Promise<void> {
  assertPermission(actor, "forms.edit");
  await requireEditableForm(formId);

  const db = await getDb();
  const slug = input.slug.trim().toLowerCase();
  const existingSlug = await db.selectFrom("forms").select("id").where("slug", "=", slug).where("id", "!=", formId).executeTakeFirst();
  if (existingSlug) throw new FormCommandError(`Ya existe otro formulario con el slug "${slug}".`);

  await db
    .updateTable("forms")
    .set({
      name: input.name.trim(),
      slug,
      consent_text: input.consentText?.trim() || null,
      success_message: input.successMessage?.trim() || null,
      opens_at: toDateOrNull(input.opensAt),
      closes_at: toDateOrNull(input.closesAt),
      identification_policy: toJsonb({ matchFields: input.matchFields }),
      update_policy: input.updatePolicy,
      updated_at: new Date(),
    })
    .where("id", "=", formId)
    .execute();

  await writeAuditLog({ actorUserId: actor.id, action: "FORM_UPDATED", entityType: "form", entityId: formId, after: { name: input.name, slug } });
}

export async function upsertField(actor: SessionUser, formId: string, fieldId: string | null, input: FieldInput): Promise<{ id: string }> {
  assertPermission(actor, "forms.edit");
  await requireEditableForm(formId);

  if (input.personFieldMapping) {
    const mapping = input.personFieldMapping.trim();
    if (!isCorePersonMapping(mapping)) {
      const db = await getDb();
      const def = await db.selectFrom("person_field_definitions").select("id").where("key", "=", mapping).where("active", "=", true).executeTakeFirst();
      if (!def) throw new FormCommandError(`"${mapping}" no es un campo núcleo ni un campo personalizado activo.`);
    }
  }

  const db = await getDb();
  const options = toJsonb(parseOptionsText(input.optionsText ?? "") as never);

  if (fieldId) {
    const updated = await db
      .updateTable("form_fields")
      .set({
        key: input.key,
        label: input.label,
        field_type: input.fieldType,
        options: FIELD_TYPES[input.fieldType].hasChoices ? options : null,
        required: input.required,
        visible: input.visible,
        person_field_mapping: input.personFieldMapping?.trim() || null,
      })
      .where("id", "=", fieldId)
      .where("form_id", "=", formId)
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw new FormCommandError("El campo no existe.");
    return { id: updated.id };
  }

  const existing = await db.selectFrom("form_fields").select("id").where("form_id", "=", formId).where("key", "=", input.key).executeTakeFirst();
  if (existing) throw new FormCommandError(`Ya existe un campo con la clave "${input.key}" en este formulario.`);

  const maxSort = await db
    .selectFrom("form_fields")
    .select(({ fn }) => fn.max<number | null>("sort_order").as("max"))
    .where("form_id", "=", formId)
    .executeTakeFirst();

  const created = await db
    .insertInto("form_fields")
    .values({
      form_id: formId,
      key: input.key,
      label: input.label,
      field_type: input.fieldType,
      options: FIELD_TYPES[input.fieldType].hasChoices ? options : null,
      required: input.required,
      visible: input.visible,
      sort_order: (maxSort?.max ?? 0) + 1,
      person_field_mapping: input.personFieldMapping?.trim() || null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { id: created.id };
}

export async function removeField(actor: SessionUser, formId: string, fieldId: string): Promise<void> {
  assertPermission(actor, "forms.edit");
  await requireEditableForm(formId);

  const db = await getDb();
  await db.deleteFrom("form_fields").where("id", "=", fieldId).where("form_id", "=", formId).execute();
}

export async function reorderFields(actor: SessionUser, formId: string, orderedFieldIds: string[]): Promise<void> {
  assertPermission(actor, "forms.edit");
  await requireEditableForm(formId);

  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    for (let i = 0; i < orderedFieldIds.length; i += 1) {
      await trx.updateTable("form_fields").set({ sort_order: i + 1 }).where("id", "=", orderedFieldIds[i]!).where("form_id", "=", formId).execute();
    }
  });
}

export async function addAssociationAction(actor: SessionUser, formId: string, associationId: string): Promise<{ id: string }> {
  assertPermission(actor, "forms.edit");
  await requireEditableForm(formId);

  const db = await getDb();
  const maxSort = await db
    .selectFrom("form_actions")
    .select(({ fn }) => fn.max<number | null>("sort_order").as("max"))
    .where("form_id", "=", formId)
    .executeTakeFirst();

  const created = await db
    .insertInto("form_actions")
    .values({ form_id: formId, action_type: "add_to_association", config: toJsonb({ associationId }), sort_order: (maxSort?.max ?? 0) + 1 })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { id: created.id };
}

export async function removeAction(actor: SessionUser, formId: string, actionId: string): Promise<void> {
  assertPermission(actor, "forms.edit");
  await requireEditableForm(formId);

  const db = await getDb();
  await db.deleteFrom("form_actions").where("id", "=", actionId).where("form_id", "=", formId).execute();
}

/**
 * Publicar (sección de Formularios): arma el snapshot inmutable a partir del
 * estado editable actual y lo guarda como una versión nueva. La página
 * pública y el procesamiento de envíos siempre leen de este snapshot, nunca
 * de `form_fields`/`form_actions` en vivo — así seguir editando el
 * formulario después de publicarlo no reinterpreta respuestas ya recibidas.
 */
export async function publishForm(actor: SessionUser, formId: string): Promise<{ version: number }> {
  assertPermission(actor, "forms.publish");

  const db = await getDb();
  const form = await db.selectFrom("forms").selectAll().where("id", "=", formId).executeTakeFirst();
  if (!form) throw new FormCommandError("El formulario no existe.");
  if (form.status === "archived") throw new FormCommandError("Un formulario archivado no se puede publicar.");

  const fields = await db.selectFrom("form_fields").selectAll().where("form_id", "=", formId).orderBy("sort_order", "asc").execute();
  if (fields.length === 0) throw new FormCommandError("El formulario necesita al menos un campo antes de publicarse.");

  const mappedKeys = new Set(fields.map((f) => f.person_field_mapping).filter((m): m is string => !!m));
  if (!mappedKeys.has("first_name") || !mappedKeys.has("last_name")) {
    throw new FormCommandError("El formulario necesita un campo mapeado a Nombre y otro a Apellido antes de publicarse.");
  }

  const actions = await db.selectFrom("form_actions").selectAll().where("form_id", "=", formId).orderBy("sort_order", "asc").execute();

  const policy = (form.identification_policy ?? {}) as { matchFields?: string[] };
  const snapshot: FormVersionSchema = {
    name: form.name,
    consentText: form.consent_text,
    successMessage: form.success_message,
    identificationPolicy: { matchFields: (policy.matchFields ?? ["dni", "email", "phone"]) as Array<"dni" | "email" | "phone"> },
    updatePolicy: form.update_policy,
    fields: fields.map((f) => ({
      key: f.key,
      label: f.label,
      fieldType: f.field_type,
      options: parseFieldOptions(f.options),
      required: f.required,
      visible: f.visible,
      sortOrder: f.sort_order,
      personFieldMapping: f.person_field_mapping,
    })),
    actions: actions.map((a) => ({ actionType: a.action_type, config: (a.config ?? {}) as { associationId?: string } })),
  };

  const maxVersion = await db
    .selectFrom("form_versions")
    .select(({ fn }) => fn.max<number | null>("version").as("max"))
    .where("form_id", "=", formId)
    .executeTakeFirst();
  const nextVersion = (maxVersion?.max ?? 0) + 1;

  await db.transaction().execute(async (trx) => {
    await trx.insertInto("form_versions").values({ form_id: formId, version: nextVersion, schema: toJsonb(snapshot as never) }).execute();
    await trx.updateTable("forms").set({ status: "published", published_version: nextVersion, updated_at: new Date() }).where("id", "=", formId).execute();
  });

  await writeAuditLog({ actorUserId: actor.id, action: "FORM_PUBLISHED", entityType: "form", entityId: formId, after: { version: nextVersion } });

  return { version: nextVersion };
}

export async function changeFormStatus(actor: SessionUser, formId: string, target: "unpublished" | "published" | "archived"): Promise<void> {
  assertPermission(actor, "forms.publish");

  const db = await getDb();
  const form = await db.selectFrom("forms").select(["status", "published_version"]).where("id", "=", formId).executeTakeFirst();
  if (!form) throw new FormCommandError("El formulario no existe.");

  if (target === "archived") {
    if (form.status === "archived") return;
  } else if (target === "unpublished") {
    if (form.status !== "published") throw new FormCommandError("Solo se puede despublicar un formulario publicado.");
  } else if (target === "published") {
    if (form.status !== "unpublished" || !form.published_version) {
      throw new FormCommandError("Solo se puede volver a publicar un formulario despublicado que ya tuvo una versión publicada. Usá \"Publicar\" para la primera vez.");
    }
  }

  await db.updateTable("forms").set({ status: target, updated_at: new Date() }).where("id", "=", formId).execute();

  await writeAuditLog({ actorUserId: actor.id, action: "FORM_STATUS_CHANGED", entityType: "form", entityId: formId, before: { status: form.status }, after: { status: target } });
}
