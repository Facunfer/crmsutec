import { z } from "zod";
import { assertServerOnly } from "../server-only.js";
import { normalizeDni, normalizeEmail, normalizePhone } from "../people/normalize.js";
import type { PersonFieldType } from "../db/schema.js";
import { CORE_PERSON_MAPPING_LABELS, FIELD_TYPE_LABELS } from "./field-type-labels.js";

assertServerOnly("lib/forms/field-types.ts");

/**
 * Catálogo compartido tipo -> validación -> normalización (decisión D17 de
 * SUTECBA_ARCHITECTURE.md): lo usa el constructor/renderizador de
 * Formularios y, cuando un campo mapea a `person_field_definitions`, la
 * misma noción de tipo que ya existe para los campos personalizados de
 * Personas. Un solo lugar para no repetir la lista de tipos ni las reglas de
 * cada uno.
 */

export interface FieldChoice {
  value: string;
  label: string;
}

export interface FieldOptions {
  choices?: FieldChoice[];
}

export function parseFieldOptions(raw: unknown): FieldOptions {
  if (!raw || typeof raw !== "object") return {};
  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return {};
  return {
    choices: choices
      .filter((c): c is { value: unknown; label: unknown } => !!c && typeof c === "object")
      .map((c) => ({ value: String(c.value ?? ""), label: String(c.label ?? c.value ?? "") }))
      .filter((c) => c.value !== ""),
  };
}

export interface FieldTypeDef {
  key: PersonFieldType;
  label: string;
  /** "single" = un input de texto/fecha/número; "choice" = una lista de opciones; "multi" = varias opciones marcables. */
  kind: "text" | "textarea" | "number" | "date" | "choice-single" | "choice-multi";
  hasChoices: boolean;
  normalize?: (raw: string) => string | null;
  buildSchema: (params: { required: boolean; options: FieldOptions }) => z.ZodTypeAny;
}

function choiceValues(options: FieldOptions): [string, ...string[]] {
  const values = (options.choices ?? []).map((c) => c.value);
  return values.length > 0 ? (values as [string, ...string[]]) : (["__sin_opciones__"] as [string]);
}

export const FIELD_TYPES: Record<PersonFieldType, FieldTypeDef> = {
  text: {
    key: "text",
    label: FIELD_TYPE_LABELS.text,
    kind: "text",
    hasChoices: false,
    buildSchema: ({ required }) => {
      const base = z.string().trim().max(500);
      return required ? base.min(1, "Este campo es obligatorio.") : base.optional().or(z.literal(""));
    },
  },
  textarea: {
    key: "textarea",
    label: FIELD_TYPE_LABELS.textarea,
    kind: "textarea",
    hasChoices: false,
    buildSchema: ({ required }) => {
      const base = z.string().trim().max(5000);
      return required ? base.min(1, "Este campo es obligatorio.") : base.optional().or(z.literal(""));
    },
  },
  dni: {
    key: "dni",
    label: FIELD_TYPE_LABELS.dni,
    kind: "text",
    hasChoices: false,
    normalize: normalizeDni,
    buildSchema: ({ required }) => {
      const base = z.string().trim().refine((v) => v === "" || normalizeDni(v) !== null, "DNI inválido.");
      return required ? base.min(1, "El DNI es obligatorio.") : base.optional().or(z.literal(""));
    },
  },
  phone: {
    key: "phone",
    label: FIELD_TYPE_LABELS.phone,
    kind: "text",
    hasChoices: false,
    normalize: normalizePhone,
    buildSchema: ({ required }) => {
      const base = z.string().trim().refine((v) => v === "" || normalizePhone(v) !== null, "Teléfono inválido.");
      return required ? base.min(1, "El teléfono es obligatorio.") : base.optional().or(z.literal(""));
    },
  },
  email: {
    key: "email",
    label: FIELD_TYPE_LABELS.email,
    kind: "text",
    hasChoices: false,
    normalize: normalizeEmail,
    buildSchema: ({ required }) => {
      const base = z.string().trim().refine((v) => v === "" || normalizeEmail(v) !== null, "Email inválido.");
      return required ? base.min(1, "El email es obligatorio.") : base.optional().or(z.literal(""));
    },
  },
  number: {
    key: "number",
    label: FIELD_TYPE_LABELS.number,
    kind: "number",
    hasChoices: false,
    buildSchema: ({ required }) => {
      // Ojo (mismo caso que declaredAge en lib/people/schema.ts): si se
      // coerciona primero, Number("") da 0 y una cadena vacía "pasa" como
      // número válido. Acá se rechaza la cadena vacía antes de coercionar.
      if (required) {
        return z
          .string()
          .trim()
          .min(1, "Este campo es obligatorio.")
          .pipe(z.coerce.number({ message: "Ingresá un número." }));
      }
      return z.literal("").transform(() => null).or(z.coerce.number());
    },
  },
  date: {
    key: "date",
    label: FIELD_TYPE_LABELS.date,
    kind: "date",
    hasChoices: false,
    buildSchema: ({ required }) => {
      const base = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida.");
      return required ? base : base.optional().or(z.literal(""));
    },
  },
  select: {
    key: "select",
    label: FIELD_TYPE_LABELS.select,
    kind: "choice-single",
    hasChoices: true,
    buildSchema: ({ required, options }) => {
      const base = z.enum(choiceValues(options)).or(z.literal(""));
      return required ? base.refine((v) => v !== "", "Elegí una opción.") : base;
    },
  },
  radio: {
    key: "radio",
    label: FIELD_TYPE_LABELS.radio,
    kind: "choice-single",
    hasChoices: true,
    buildSchema: ({ required, options }) => {
      const base = z.enum(choiceValues(options)).or(z.literal(""));
      return required ? base.refine((v) => v !== "", "Elegí una opción.") : base;
    },
  },
  checkbox: {
    key: "checkbox",
    label: FIELD_TYPE_LABELS.checkbox,
    kind: "choice-multi",
    hasChoices: true,
    buildSchema: ({ required, options }) => {
      const base = z.array(z.enum(choiceValues(options)));
      return required ? base.min(1, "Elegí al menos una opción.") : base;
    },
  },
  association: {
    key: "association",
    label: FIELD_TYPE_LABELS.association,
    kind: "choice-single",
    hasChoices: false, // las opciones son las asociaciones activas, no una lista fija del campo
    buildSchema: ({ required }) => {
      const base = z.string().trim();
      return required ? base.min(1, "Elegí una opción.") : base.optional().or(z.literal(""));
    },
  },
};

export const CORE_PERSON_MAPPING_KEYS = Object.keys(CORE_PERSON_MAPPING_LABELS) as Array<keyof typeof CORE_PERSON_MAPPING_LABELS>;
export type CorePersonMappingKey = (typeof CORE_PERSON_MAPPING_KEYS)[number];

export function isCorePersonMapping(key: string): key is CorePersonMappingKey {
  return (CORE_PERSON_MAPPING_KEYS as readonly string[]).includes(key);
}
