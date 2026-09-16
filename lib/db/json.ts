import type { Json } from "./schema.js";

/**
 * Kysely tipa las columnas jsonb como texto en insert/update (ver JsonColumn
 * en schema.ts): esto centraliza el `JSON.stringify` para no repetirlo
 * suelto en cada módulo.
 */
export function toJsonb(value: Json): string;
export function toJsonb(value: Json | null | undefined): string | null;
export function toJsonb(value: Json | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}
