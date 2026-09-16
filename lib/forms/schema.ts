import { z } from "zod";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const formMetaInputSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio."),
  slug: z.string().trim().toLowerCase().regex(SLUG_PATTERN, "El slug solo puede tener minúsculas, números y guiones."),
  consentText: z.string().trim().optional().or(z.literal("")),
  successMessage: z.string().trim().optional().or(z.literal("")),
  opensAt: z.string().optional().or(z.literal("")),
  closesAt: z.string().optional().or(z.literal("")),
  matchFields: z.array(z.enum(["dni", "email", "phone"])).default([]),
  updatePolicy: z.enum(["fill_empty_only", "always_flag_for_review"]).default("fill_empty_only"),
});
export type FormMetaInput = z.infer<typeof formMetaInputSchema>;

export function parseFormMetaForm(formData: FormData): FormMetaInput {
  return formMetaInputSchema.parse({
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    consentText: String(formData.get("consentText") ?? ""),
    successMessage: String(formData.get("successMessage") ?? ""),
    opensAt: String(formData.get("opensAt") ?? ""),
    closesAt: String(formData.get("closesAt") ?? ""),
    matchFields: formData.getAll("matchFields").map(String),
    updatePolicy: String(formData.get("updatePolicy") ?? "fill_empty_only"),
  });
}

const fieldTypeEnum = z.enum([
  "text", "textarea", "dni", "phone", "email", "number", "date", "select", "radio", "checkbox", "association",
]);

export const fieldInputSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]*$/, "La clave solo puede tener minúsculas, números y guion bajo, y debe empezar con una letra."),
  label: z.string().trim().min(1, "La etiqueta es obligatoria."),
  fieldType: fieldTypeEnum,
  optionsText: z.string().trim().optional().or(z.literal("")),
  required: z.coerce.boolean().default(false),
  visible: z.coerce.boolean().default(true),
  personFieldMapping: z.string().trim().optional().or(z.literal("")),
});
export type FieldInput = z.infer<typeof fieldInputSchema>;

export function parseFieldForm(formData: FormData): FieldInput {
  return fieldInputSchema.parse({
    key: String(formData.get("key") ?? ""),
    label: String(formData.get("label") ?? ""),
    fieldType: String(formData.get("fieldType") ?? ""),
    optionsText: String(formData.get("optionsText") ?? ""),
    required: formData.get("required") === "true",
    visible: formData.get("visible") === "true",
    personFieldMapping: String(formData.get("personFieldMapping") ?? ""),
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

export const actionInputSchema = z.object({
  associationId: z.string().uuid("Elegí una asociación."),
});
export type ActionInput = z.infer<typeof actionInputSchema>;
