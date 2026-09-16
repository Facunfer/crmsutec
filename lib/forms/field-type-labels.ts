import type { PersonFieldType } from "../db/schema.js";

/**
 * Solo etiquetas, sin lógica de validación ni `assertServerOnly` (a
 * diferencia de `field-types.ts`) para poder importarse desde componentes
 * cliente que arman un `<select>` de tipos.
 */
export const FIELD_TYPE_LABELS: Record<PersonFieldType, string> = {
  text: "Texto corto",
  textarea: "Texto largo",
  dni: "DNI",
  phone: "Teléfono",
  email: "Email",
  number: "Número",
  date: "Fecha",
  select: "Selección única (desplegable)",
  radio: "Selección única (opciones)",
  checkbox: "Selección múltiple",
  association: "Asociación (a elegir por quien completa)",
};

export const FIELD_TYPES_WITH_CHOICES: PersonFieldType[] = ["select", "radio", "checkbox"];

export const CORE_PERSON_MAPPING_LABELS: Record<string, string> = {
  first_name: "Nombre",
  last_name: "Apellido",
  dni: "DNI",
  email: "Email",
  phone: "Teléfono",
  birth_date: "Fecha de nacimiento",
};
