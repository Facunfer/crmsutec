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
  // Forma tolerante a propósito: un usuario sin people.view_sensitive edita con el campo deshabilitado (no viaja).
  // La OBLIGATORIEDAD la exige el dominio (normalizePersonInput / updatePerson) y PostgreSQL (NOT NULL + formato).
  dni: z.string().trim().optional().or(z.literal("")),
  email: z.string().trim().optional().or(z.literal("")),
  phone: z.string().trim().optional().or(z.literal("")),
  organizationId: z.string().uuid().optional().or(z.literal("")),
  birthDate: z.string().optional().or(z.literal("")),
  // El orden importa: si el número fuera primero, `z.coerce.number()`
  // convierte "" en 0 (Number("") === 0) y ese 0 "pasa" como edad válida
  // antes de llegar a la alternativa de cadena vacía. Pasó de verdad
  // probando el alta en el navegador: quedaba guardada una edad de 0 para
  // cualquier persona que dejara el campo en blanco.
  declaredAge: z.literal("").or(z.coerce.number().int().min(0).max(130)),
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
