/**
 * Texto que PostgreSQL no puede guardar (hallazgo adicional de F0). Un byte nulo (`U+0000`) hace fallar tanto una columna `text`
 * («invalid byte sequence for encoding UTF8: 0x00») como un `jsonb` («unsupported Unicode escape sequence»), y un sustituto UTF-16
 * suelto (mitad de un par) rompe `jsonb`. En un endpoint público eso era un error 500 provocable con un solo pedido.
 *
 * Política: NO se "limpia" en silencio. Quitar un NUL de «4011\0 1222» fabricaría un valor que la persona no escribió; se rechaza
 * ese valor con un mensaje de validación (o, donde no hay campo que mostrar, con la misma respuesta que cualquier dato inexistente).
 * Ninguna respuesta legítima contiene estos caracteres: los acentos, la ñ, los emojis (pares de sustitutos completos) y el resto de
 * los caracteres de control comunes (tab, salto de línea) NO se tocan.
 */
const UNSAFE_TEXT = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function isUnsafeText(value: string): boolean {
  return UNSAFE_TEXT.test(value);
}

/** Acepta lo que llega de un formulario: texto, lista de textos (casillas) o nada. */
export function hasUnsafeText(value: string | readonly string[] | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return typeof value === "string" ? isUnsafeText(value) : value.some(isUnsafeText);
}

export const UNSAFE_TEXT_MESSAGE = "Contiene caracteres no válidos.";
