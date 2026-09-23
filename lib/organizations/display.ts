import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.js";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/organizations/display.ts");

/**
 * PRESENTACIÓN del nombre de una unidad organizativa (no cambia ningún dato).
 *
 * Hay unidades con nombre homónimo en jurisdicciones distintas (p. ej. una «Dirección General Técnica, Administrativa y
 * Legal» por ministerio): en pantalla, sola, no dice de cuál se trata. Cuando el nombre NO es único se muestra
 * `Nombre oficial (CÓDIGO)`; si es inequívoco, solo el nombre. La comparación ignora tildes, mayúsculas y puntuación, así
 * «Técnica Administrativa» y «Técnica, Administrativa» cuentan como el mismo nombre.
 *
 * `organization_id`, los nombres oficiales y `official_code` no se tocan.
 */
export function normalizeOrgName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Los códigos «slug:…» son identificadores técnicos de respaldo, no algo que mostrar. */
const isShowableCode = (code: string | null): code is string => Boolean(code) && !code!.startsWith("slug:");

export interface OrgNameRow {
  id: string;
  name: string;
  official_code: string | null;
}

/** id → texto a mostrar. Funciones puras separadas para poder probarlas sin base. */
export function buildDisplayNames(rows: readonly OrgNameRow[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = normalizeOrgName(r.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map(rows.map((r) => [r.id, (counts.get(normalizeOrgName(r.name)) ?? 0) > 1 && isShowableCode(r.official_code) ? `${r.name} (${r.official_code})` : r.name]));
}

type Db = Kysely<Database> | Transaction<Database>;

/** Nombres a mostrar de TODAS las unidades (147 filas: una consulta barata por pantalla). */
export async function loadOrgDisplayNames(db?: Db): Promise<Map<string, string>> {
  const conn = db ?? (await getDb());
  const rows = await conn.selectFrom("organizations").select(["id", "name", "official_code"]).execute();
  return buildDisplayNames(rows);
}

export function displayOf(names: ReadonlyMap<string, string>, id: string | null | undefined, fallback: string | null): string | null {
  if (!id) return fallback;
  return names.get(id) ?? fallback;
}
