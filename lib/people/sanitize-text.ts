/**
 * Sanitización de TEXTO LIBRE para el timeline de una persona (B5). Sin `people.view_sensitive` no puede filtrarse un DNI completo,
 * un teléfono ni un email que alguien haya escrito dentro de un motivo, un asunto o una nota. Es un módulo puro (sin base).
 *
 * Es una defensa en profundidad: los títulos del timeline NUNCA se arman concatenando texto libre; lo único libre que se muestra
 * (asuntos/notas de interacciones, motivos de anulación, nombres de actividades) pasa por acá.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// DNI argentino con o sin puntos (12.345.678 / 12345678). Antes que el teléfono para no partirlo.
const DNI = /(?<![\d.])\d{1,2}\.?\d{3}\.?\d{3}(?![\d.])/g;
// Teléfonos: 8 a 13 dígitos con separadores opcionales (+54 9 11 1234-5678, (011) 4444 5555).
const PHONE = /(?<![\d])\+?\d[\d\s().-]{6,}\d(?![\d])/g;

export const SANITIZED_PLACEHOLDER = { email: "[email oculto]", dni: "[DNI oculto]", phone: "[teléfono oculto]" } as const;

export function sanitizeFreeText(text: string | null | undefined, canSeeSensitive: boolean): string | null {
  if (text === null || text === undefined) return null;
  if (canSeeSensitive) return text;
  return text
    .replace(EMAIL, SANITIZED_PLACEHOLDER.email)
    .replace(DNI, SANITIZED_PLACEHOLDER.dni)
    .replace(PHONE, SANITIZED_PLACEHOLDER.phone);
}
