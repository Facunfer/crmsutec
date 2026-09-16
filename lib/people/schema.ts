import { z } from "zod";

/**
 * Esquema compartido cliente/servidor (sección 9 del prompt). Hoy se usa
 * como validación autoritativa en las Server Actions; el formulario usa
 * atributos HTML básicos para feedback inmediato, pero la fuente de verdad
 * de "qué es válido" es este esquema.
 */
export const personInputSchema = z.object({
  firstName: z.string().trim().min(1, "El nombre es obligatorio."),
  lastName: z.string().trim().min(1, "El apellido es obligatorio."),
  dni: z.string().trim().optional().or(z.literal("")),
  email: z.string().trim().optional().or(z.literal("")),
  phone: z.string().trim().optional().or(z.literal("")),
  organizationId: z.string().uuid().optional().or(z.literal("")),
  birthDate: z.string().optional().or(z.literal("")),
  declaredAge: z.coerce.number().int().min(0).max(130).optional().or(z.literal("")),
});

export type PersonInput = z.infer<typeof personInputSchema>;

export function parsePersonForm(formData: FormData): PersonInput {
  const raw = {
    firstName: String(formData.get("firstName") ?? ""),
    lastName: String(formData.get("lastName") ?? ""),
    dni: String(formData.get("dni") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    organizationId: String(formData.get("organizationId") ?? ""),
    birthDate: String(formData.get("birthDate") ?? ""),
    declaredAge: String(formData.get("declaredAge") ?? ""),
  };
  return personInputSchema.parse(raw);
}
