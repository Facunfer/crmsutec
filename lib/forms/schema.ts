import { z } from "zod";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const optionalUuid = z.string().trim().uuid("Identificador inválido.").optional().or(z.literal(""));

export const formMetaInputSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio."),
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "El slug solo puede tener minúsculas, números y guiones."),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  consentText: z.string().trim().optional().or(z.literal("")),
  successMessage: z.string().trim().optional().or(z.literal("")),
  opensAt: z.string().optional().or(z.literal("")),
  closesAt: z.string().optional().or(z.literal("")),
  matchFields: z.array(z.enum(["dni", "email", "phone"])).default([]),
  /** «never» (default): un envío sin coincidencia queda SIN VINCULAR y un operador decide. */
  personCreationPolicy: z.enum(["never", "when_valid_dni"]).default("never"),
  /** «never» (default): un envío vinculado NO completa datos de la persona; un operador los aplica explícitamente. */
  applyDataPolicy: z.enum(["never", "fill_empty_only"]).default("never"),
  /** Vínculos (0043): campaña y/o reunión destino; la jornada por defecto solo dentro de una campaña. */
  campaignId: optionalUuid,
  meetingId: optionalUuid,
  defaultMeetingId: optionalUuid,
});
export type FormMetaInput = z.infer<typeof formMetaInputSchema>;

export function parseFormMetaForm(formData: FormData): FormMetaInput {
  return formMetaInputSchema.parse({
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    description: String(formData.get("description") ?? ""),
    consentText: String(formData.get("consentText") ?? ""),
    successMessage: String(formData.get("successMessage") ?? ""),
    opensAt: String(formData.get("opensAt") ?? ""),
    closesAt: String(formData.get("closesAt") ?? ""),
    matchFields: formData.getAll("matchFields").map(String),
    personCreationPolicy: String(formData.get("personCreationPolicy") ?? "never"),
    applyDataPolicy: String(formData.get("applyDataPolicy") ?? "never"),
    campaignId: String(formData.get("campaignId") ?? ""),
    meetingId: String(formData.get("meetingId") ?? ""),
    defaultMeetingId: String(formData.get("defaultMeetingId") ?? ""),
  });
}

const fieldTypeEnum = z.enum([
  "text", "textarea", "dni", "phone", "email", "number", "date", "select", "radio", "checkbox", "association",
]);

// Límites opcionales (cadena vacía = sin límite). Solo numéricos: sin expresiones regulares.
const optionalNumberText = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .refine((v) => v === undefined || v === "" || Number.isFinite(Number(v)), "Ingresá un número.");

export const fieldInputSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]*$/, "La clave solo puede tener minúsculas, números y guion bajo, y debe empezar con una letra."),
  label: z.string().trim().min(1, "La etiqueta es obligatoria."),
  fieldType: fieldTypeEnum,
  description: z.string().trim().max(500).optional().or(z.literal("")),
  optionsText: z.string().trim().optional().or(z.literal("")),
  required: z.coerce.boolean().default(false),
  visible: z.coerce.boolean().default(true),
  personFieldMapping: z.string().trim().optional().or(z.literal("")),
  minLength: optionalNumberText,
  maxLength: optionalNumberText,
  min: optionalNumberText,
  max: optionalNumberText,
});
export type FieldInput = z.infer<typeof fieldInputSchema>;

export function parseFieldForm(formData: FormData): FieldInput {
  return fieldInputSchema.parse({
    key: String(formData.get("key") ?? ""),
    label: String(formData.get("label") ?? ""),
    fieldType: String(formData.get("fieldType") ?? ""),
    description: String(formData.get("description") ?? ""),
    optionsText: String(formData.get("optionsText") ?? ""),
    required: formData.get("required") === "true",
    visible: formData.get("visible") === "true",
    personFieldMapping: String(formData.get("personFieldMapping") ?? ""),
    minLength: String(formData.get("minLength") ?? ""),
    maxLength: String(formData.get("maxLength") ?? ""),
    min: String(formData.get("min") ?? ""),
    max: String(formData.get("max") ?? ""),
  });
}

/** Una opción por línea, "valor|etiqueta" o solo "valor" si la etiqueta es igual. */
export function parseOptionsText(text: string): { choices: Array<{ value: string; label: string }> } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    choices: lines.map((line) => {
      const [value, label] = line.split("|").map((p) => p.trim());
      return { value: value ?? line, label: label ?? value ?? line };
    }),
  };
}

/** Arma el objeto `validation` guardado en `form_fields.validation` (solo los límites que vinieron completos). */
export function buildFieldValidation(input: Pick<FieldInput, "minLength" | "maxLength" | "min" | "max">): Record<string, number> | null {
  const out: Record<string, number> = {};
  const put = (key: string, raw: string | undefined) => {
    if (raw === undefined || raw.trim() === "") return;
    const n = Number(raw);
    if (Number.isFinite(n)) out[key] = n;
  };
  put("minLength", input.minLength);
  put("maxLength", input.maxLength);
  put("min", input.min);
  put("max", input.max);
  return Object.keys(out).length > 0 ? out : null;
}

export const actionInputSchema = z.object({
  associationId: z.string().uuid("Elegí una asociación."),
});
export type ActionInput = z.infer<typeof actionInputSchema>;
