import type { PersonFieldType } from "../db/schema.js";

/**
 * Regla de publicación (dominio): un formulario puede diseñarse y guardarse como borrador sin DNI, pero
 * para publicarse (o volver a publicarse) tiene que incluir EXACTAMENTE un campo realmente mapeado a
 * `people.dni`, visible, obligatorio y de tipo `dni`. Sin DNI no se puede crear una persona, y la etiqueta
 * "DNI" de un campo no cuenta: manda `person_field_mapping`.
 */
export const DNI_REQUIRED_TO_PUBLISH_MESSAGE = "Para publicar este formulario necesitás incluir un campo DNI obligatorio.";
export const DNI_AMBIGUOUS_MESSAGE = "El formulario tiene más de un campo mapeado a DNI: dejá uno solo para poder publicarlo.";

/** Tipos compatibles con un DNI: solo `dni` (es el que lo valida y normaliza a 7-8 dígitos). */
export const DNI_COMPATIBLE_FIELD_TYPES: readonly PersonFieldType[] = ["dni"];

export interface PublishableField {
  fieldType: PersonFieldType | string;
  required: boolean;
  visible: boolean;
  personFieldMapping: string | null;
}

/** Devuelve el mensaje de error si la configuración de DNI no permite publicar, o null si es válida. */
export function dniPublishError(fields: readonly PublishableField[]): string | null {
  const mapped = fields.filter((f) => f.personFieldMapping?.trim() === "dni");
  if (mapped.length > 1) return DNI_AMBIGUOUS_MESSAGE;
  const field = mapped[0];
  if (!field || !field.visible || !field.required || !DNI_COMPATIBLE_FIELD_TYPES.includes(field.fieldType as PersonFieldType)) {
    return DNI_REQUIRED_TO_PUBLISH_MESSAGE;
  }
  return null;
}
