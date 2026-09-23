import { maskDni, maskEmail, maskPhone } from "../people/masking.js";
import type { FormVersionField, FormVersionSchema } from "./version-schema.js";

/**
 * Enmascarado de las respuestas de un formulario para quien no tiene
 * `people.view_sensitive`. Se aplica en el servidor, sobre el payload, ANTES de
 * que salga de `listSubmissions` — así vale igual para la UI, el CSV y
 * cualquier endpoint que lo use; ocultarlo en React no alcanza.
 *
 * Es sensible el campo que:
 *  - es de tipo dni/email/teléfono, o se mapea a esos datos de la persona; o
 *  - se mapea a un campo personalizado marcado como sensible
 *    (`person_field_definitions.sensitive`).
 * Una clave del payload que no figura en el esquema de su versión (no debería
 * existir) se trata como sensible: ante la duda, se enmascara.
 */

export const MASK_PLACEHOLDER = "••••";

const CORE_SENSITIVE = new Set(["dni", "email", "phone"]);

function kindOf(field: FormVersionField): "dni" | "email" | "phone" | null {
  for (const candidate of [field.fieldType, field.personFieldMapping]) {
    if (candidate === "dni" || candidate === "email" || candidate === "phone") return candidate;
  }
  return null;
}

export function isSensitiveField(field: FormVersionField, sensitiveCustomKeys: ReadonlySet<string>): boolean {
  if (CORE_SENSITIVE.has(field.fieldType)) return true;
  if (field.personFieldMapping && CORE_SENSITIVE.has(field.personFieldMapping)) return true;
  return field.personFieldMapping ? sensitiveCustomKeys.has(field.personFieldMapping) : false;
}

function maskValue(value: unknown, kind: "dni" | "email" | "phone" | null): unknown {
  if (value === null || value === undefined || value === "") return value;
  if (Array.isArray(value)) return value.map(() => MASK_PLACEHOLDER);
  const text = String(value);
  if (kind === "dni") return maskDni(text);
  if (kind === "email") return maskEmail(text);
  if (kind === "phone") return maskPhone(text);
  return MASK_PLACEHOLDER;
}

export function maskSubmissionPayload(
  payload: Record<string, unknown>,
  schema: FormVersionSchema | null,
  sensitiveCustomKeys: ReadonlySet<string>
): Record<string, unknown> {
  const fieldsByKey = new Map((schema?.fields ?? []).map((f) => [f.key, f]));
  const masked: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    const field = fieldsByKey.get(key);
    if (!field) {
      masked[key] = maskValue(value, null);
    } else if (isSensitiveField(field, sensitiveCustomKeys)) {
      masked[key] = maskValue(value, kindOf(field));
    } else {
      masked[key] = value;
    }
  }
  return masked;
}
