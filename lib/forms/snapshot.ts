import type { PersonFieldType } from "../db/schema.js";
import { assertServerOnly } from "../server-only.js";
import { parseFieldOptions, parseFieldValidation } from "./field-types.js";
import type { FormVersionSchema } from "./version-schema.js";

assertServerOnly("lib/forms/snapshot.ts");

/**
 * Snapshot INMUTABLE de un formulario (la versión que se publica): la página pública y el procesamiento de envíos leen siempre de acá,
 * nunca de `form_fields`/`form_actions` en vivo. Función única para «Publicar» (lib/forms/commands.ts) y para la creación unificada de
 * actividades (lib/activities/create.ts), de modo que las dos produzcan exactamente el mismo formato.
 */
export interface SnapshotFormRow {
  name: string;
  consent_text: string | null;
  success_message: string | null;
  identification_policy: unknown;
}

export interface SnapshotFieldRow {
  key: string;
  label: string;
  field_type: PersonFieldType;
  options: unknown;
  required: boolean;
  visible: boolean;
  sort_order: number;
  person_field_mapping: string | null;
  description: string | null;
  validation: unknown;
}

export interface SnapshotActionRow {
  action_type: FormVersionSchema["actions"][number]["actionType"];
  config: unknown;
}

export function buildFormSnapshot(form: SnapshotFormRow, fields: SnapshotFieldRow[], actions: SnapshotActionRow[]): FormVersionSchema {
  const policy = (form.identification_policy ?? {}) as { matchFields?: string[] };
  return {
    name: form.name,
    consentText: form.consent_text,
    successMessage: form.success_message,
    identificationPolicy: { matchFields: (policy.matchFields ?? ["dni", "email", "phone"]) as Array<"dni" | "email" | "phone"> },
    fields: fields.map((f) => ({
      key: f.key,
      label: f.label,
      fieldType: f.field_type,
      options: parseFieldOptions(f.options),
      required: f.required,
      visible: f.visible,
      sortOrder: f.sort_order,
      personFieldMapping: f.person_field_mapping,
      description: f.description,
      validation: parseFieldValidation(f.validation),
    })),
    actions: actions.map((a) => ({ actionType: a.action_type, config: (a.config ?? {}) as { associationId?: string } })),
  };
}
