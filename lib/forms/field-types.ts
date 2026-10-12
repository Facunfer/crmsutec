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

/** Validación acotada por campo (0043). Solo límites numéricos: nada de expresiones regulares ni código arbitrario. */
export interface FieldValidation {
  /** text/textarea: largo mínimo / máximo. */
  minLength?: number;
  maxLength?: number;
  /** number: valor mínimo / máximo. */
  min?: number;
  max?: number;
}

export function parseFieldValidation(raw: unknown): FieldValidation {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const out: FieldValidation = {};
  const minLength = num(r.minLength);
  const maxLength = num(r.maxLength);
  const min = num(r.min);
  const max = num(r.max);
  if (minLength !== undefined && minLength >= 0) out.minLength = Math.trunc(minLength);
  if (maxLength !== undefined && maxLength > 0) out.maxLength = Math.trunc(maxLength);
  if (min !== undefined) out.min = min;
  if (max !== undefined) out.max = max;
  return out;
}

export interface FieldTypeDef {
  key: PersonFieldType;
  label: string;
  /** "single" = un input de texto/fecha/número; "choice" = una lista de opciones; "multi" = varias opciones marcables. */
  kind: "text" | "textarea" | "number" | "date" | "choice-single" | "choice-multi";
  hasChoices: boolean;
  normalize?: (raw: string) => string | null;
  buildSchema: (params: { required: boolean; options: FieldOptions; validation?: FieldValidation }) => z.ZodTypeAny;
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
    buildSchema: ({ required, validation }) => {
      const max = Math.min(validation?.maxLength ?? 500, 500);
      const minLength = validation?.minLength ?? 0;
      const base = z.string().trim().max(max, `Máximo ${max} caracteres.`);
      if (required) return base.min(Math.max(minLength, 1), minLength > 1 ? `Mínimo ${minLength} caracteres.` : "Este campo es obligatorio.");
      // Opcional: vacío es válido; si se completa, respeta el mínimo.
      return base.refine((v) => v === "" || v.length >= minLength, `Mínimo ${minLength} caracteres.`).optional().or(z.literal(""));
    },
  },
  textarea: {
    key: "textarea",
    label: FIELD_TYPE_LABELS.textarea,
    kind: "textarea",
    hasChoices: false,
    buildSchema: ({ required, validation }) => {
      const max = Math.min(validation?.maxLength ?? 5000, 5000);
      const minLength = validation?.minLength ?? 0;
      const base = z.string().trim().max(max, `Máximo ${max} caracteres.`);
      if (required) return base.min(Math.max(minLength, 1), minLength > 1 ? `Mínimo ${minLength} caracteres.` : "Este campo es obligatorio.");
      return base.refine((v) => v === "" || v.length >= minLength, `Mínimo ${minLength} caracteres.`).optional().or(z.literal(""));
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
    buildSchema: ({ required, validation }) => {
      const inRange = (v: unknown) => v === null || typeof v !== "number" || ((validation?.min === undefined || v >= validation.min) && (validation?.max === undefined || v <= validation.max));
      const rangeMessage = validation?.min !== undefined && validation?.max !== undefined ? `Ingresá un número entre ${validation.min} y ${validation.max}.` : validation?.min !== undefined ? `Ingresá un número mayor o igual a ${validation.min}.` : `Ingresá un número menor o igual a ${validation?.max}.`;
      // Ojo (mismo caso que declaredAge en lib/people/schema.ts): si se
      // coerciona primero, Number("") da 0 y una cadena vacía "pasa" como
      // número válido. Acá se rechaza la cadena vacía antes de coercionar.
      if (required) {
        return z
          .string()
          .trim()
          .min(1, "Este campo es obligatorio.")
          .pipe(z.coerce.number({ message: "Ingresá un número." }))
          .refine(inRange, rangeMessage);
      }
      return z.literal("").transform(() => null).or(z.coerce.number()).refine(inRange, rangeMessage);
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
