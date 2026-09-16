import type { PersonFieldType } from "../db/schema.js";

/**
 * Forma del snapshot inmutable que se guarda en `form_versions.schema` al
 * publicar (sección de Formularios de SUTECBA_DATABASE.md): la página
 * pública y el procesamiento de envíos leen SIEMPRE de acá, nunca de
 * `form_fields`/`form_actions` en vivo, para que editar un formulario ya
 * publicado no reinterprete respuestas viejas ni cambie la validación de
 * una versión que la gente ya tiene abierta en el navegador.
 */
export interface FormVersionField {
  key: string;
  label: string;
  fieldType: PersonFieldType;
  options: { choices?: Array<{ value: string; label: string }> };
  required: boolean;
  visible: boolean;
  sortOrder: number;
  personFieldMapping: string | null;
}

export interface FormVersionAction {
  actionType: "add_to_association";
  config: { associationId?: string };
}

export interface FormVersionSchema {
  name: string;
  consentText: string | null;
  successMessage: string | null;
  identificationPolicy: { matchFields: Array<"dni" | "email" | "phone"> };
  updatePolicy: "fill_empty_only" | "always_flag_for_review";
  fields: FormVersionField[];
  actions: FormVersionAction[];
}
