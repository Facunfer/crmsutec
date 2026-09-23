import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { toJsonb } from "../db/json.js";
import type { SessionUser } from "../permissions/can.js";
import type { PersonFieldType } from "../db/schema.js";

assertServerOnly("lib/people/field-definitions.ts");

export class FieldDefinitionError extends Error {}

export interface FieldDefinitionItem {
  id: string;
  key: string;
  label: string;
  fieldType: PersonFieldType;
  options: unknown;
  required: boolean;
  active: boolean;
  sensitive: boolean;
  sortOrder: number;
}

/**
 * Catálogo de campos personalizados de Personas (sección "Registro de tipos
 * compartido" de SUTECBA_ARCHITECTURE.md): el constructor de formularios
 * mapea un campo a una de estas claves para poder escribir en
 * `people.custom_fields` sin duplicar la definición del tipo.
 */
export async function listFieldDefinitions(options: { onlyActive?: boolean } = {}): Promise<FieldDefinitionItem[]> {
  const db = await getDb();
  let query = db.selectFrom("person_field_definitions").selectAll();
  if (options.onlyActive) query = query.where("active", "=", true);
  const rows = await query.orderBy("sort_order", "asc").execute();
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    fieldType: r.field_type,
    options: r.options,
    required: r.required,
    active: r.active,
    sensitive: r.sensitive,
    sortOrder: r.sort_order,
  }));
}

/**
 * Uso INTERNO (ya no hay pantalla de "campos personalizados"): una definición existe solo para que un campo de
 * Formulario pueda escribir en `people.custom_fields`. Se exige `forms.edit`.
 */
export interface FieldDefinitionInput {
  key: string;
  label: string;
  fieldType: PersonFieldType;
  options?: unknown;
  required?: boolean;
  sensitive?: boolean;
}

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export async function createFieldDefinition(actor: SessionUser, input: FieldDefinitionInput): Promise<{ id: string }> {
  assertPermission(actor, "forms.edit");

  const key = input.key.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new FieldDefinitionError("La clave solo puede tener minúsculas, números y guion bajo, y debe empezar con una letra.");
  }
  const label = input.label.trim();
  if (!label) throw new FieldDefinitionError("La etiqueta es obligatoria.");

  const db = await getDb();
  const existing = await db.selectFrom("person_field_definitions").select("id").where("key", "=", key).executeTakeFirst();
  if (existing) throw new FieldDefinitionError(`Ya existe un campo con la clave "${key}".`);

  const maxSort = await db
    .selectFrom("person_field_definitions")
    .select(({ fn }) => fn.max<number | null>("sort_order").as("max"))
    .executeTakeFirst();

  const created = await db
    .insertInto("person_field_definitions")
    .values({
      key,
      label,
      field_type: input.fieldType,
      options: toJsonb((input.options as never) ?? null),
      required: input.required ?? false,
      sensitive: input.sensitive ?? false,
      sort_order: (maxSort?.max ?? 0) + 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow();


  return { id: created.id };
}
