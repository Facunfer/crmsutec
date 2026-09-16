import { sql, type Kysely } from "kysely";
import { assertServerOnly } from "../server-only.js";
import type { SutecbaEnv } from "./env.js";
import type { Database } from "./schema.js";

assertServerOnly("lib/db/guards.ts");

/**
 * Guardas del runner de migraciones/seeds (sección 7.1 del prompt maestro).
 * Se corren SIEMPRE antes de tocar el esquema, tanto en `migrate` como en
 * `seed`. Ninguna de estas funciones asume que la base es la correcta:
 * lo verifican.
 */

// Proyectos de Supabase de otros clientes que nunca deben recibir una
// migración/seed de SUTECBA, aunque alguien pegue mal una connection string.
const BLOCKED_TARGET_PATTERNS = ["dxoarslfifotigcgokmf", "aysbehxlrgtacjdwmhsp"];

// Nombres de tablas "huella" de otros sistemas (CRM de referencia, consola
// territorial, etc.). Si aparecen en la base destino, no es la base de SUTECBA.
const FOOTPRINT_EXACT_TABLES = [
  "personas",
  "usuarios",
  "sesiones",
  "interacciones_personas",
  "usuarios_asignaciones",
];
const FOOTPRINT_PREFIXES = ["wa_", "formulario_", "email_"];

export class GuardViolationError extends Error {}

export function describeTarget(env: SutecbaEnv, pgliteDataDir: string): string {
  if (env.SUTECBA_DATABASE_URL) {
    try {
      const url = new URL(env.SUTECBA_DATABASE_URL);
      return `postgres host=${url.hostname} db=${url.pathname.replace("/", "")} env=${env.SUTECBA_ENV}`;
    } catch {
      return `postgres (URL no parseable) env=${env.SUTECBA_ENV}`;
    }
  }
  return `pglite dir=${pgliteDataDir} env=${env.SUTECBA_ENV}`;
}

/** Guarda 1: rechaza por nombre de host/base/directorio bloqueado. */
export function assertNotBlockedTarget(env: SutecbaEnv, pgliteDataDir: string): void {
  const target = `${env.SUTECBA_DATABASE_URL ?? ""} ${pgliteDataDir}`.toLowerCase();
  for (const pattern of BLOCKED_TARGET_PATTERNS) {
    if (target.includes(pattern.toLowerCase())) {
      throw new GuardViolationError(
        `El destino contiene "${pattern}", que corresponde a un proyecto bloqueado ` +
          `(otro cliente). Abortado antes de tocar nada.`
      );
    }
  }
}

async function listPublicTables(db: Kysely<Database>): Promise<string[]> {
  const rows = await sql<{ table_name: string }>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  `.execute(db);
  return rows.rows.map((r) => r.table_name);
}

/** Guarda 2: rechaza si hay tablas de otros sistemas en la base destino. */
export async function assertNoForeignFootprint(db: Kysely<Database>): Promise<void> {
  const tables = await listPublicTables(db);
  const found = tables.filter(
    (t) =>
      FOOTPRINT_EXACT_TABLES.includes(t) || FOOTPRINT_PREFIXES.some((p) => t.startsWith(p))
  );
  if (found.length > 0) {
    throw new GuardViolationError(
      `La base destino tiene tablas de otro sistema (${found.join(", ")}). ` +
        `No es la base de SUTECBA. Abortado.`
    );
  }
}

/**
 * Guarda 3: exige una marca de identidad (`sutecba_meta`). En una base
 * vacía la crea (primer bootstrap); en una base con tablas pero sin la
 * marca, aborta.
 */
export async function assertOrBootstrapSystemIdentity(db: Kysely<Database>): Promise<void> {
  const tables = await listPublicTables(db);
  const hasMeta = tables.includes("sutecba_meta");

  if (!hasMeta) {
    const nonBootstrapTables = tables.filter((t) => t !== "sutecba_migrations");
    if (nonBootstrapTables.length > 0) {
      throw new GuardViolationError(
        `La base tiene tablas (${nonBootstrapTables.join(", ")}) pero no la marca ` +
          `sutecba_meta. No se puede confirmar que sea la base de SUTECBA. Abortado.`
      );
    }
    await sql`
      create table sutecba_meta (
        id boolean primary key default true check (id),
        system text not null,
        created_at timestamptz not null default now()
      )
    `.execute(db);
    await sql`insert into sutecba_meta (id, system) values (true, 'sutecba-crm')`.execute(db);
    return;
  }

  const rows = await sql<{ system: string }>`
    select system from sutecba_meta where id = true
  `.execute(db);
  const system = rows.rows[0]?.system;
  if (system !== "sutecba-crm") {
    throw new GuardViolationError(
      `sutecba_meta.system = "${system}" (esperado "sutecba-crm"). Abortado.`
    );
  }
}

/** Guarda 4: en producción, exige confirmación explícita por flag. */
export function assertProductionConfirmed(env: SutecbaEnv, confirmed: boolean): void {
  if (env.SUTECBA_ENV === "production" && !confirmed) {
    throw new GuardViolationError(
      `SUTECBA_ENV=production requiere el flag --yes explícito para aplicar cambios.`
    );
  }
}

const DESTRUCTIVE_PATTERN = /\b(drop\s+table|drop\s+column|truncate|alter\s+column\s+\w+\s+type)\b/i;

/** Guarda 5: ninguna migración destructiva sin flag explícito. */
export function assertNoDestructiveWithoutFlag(
  filename: string,
  sqlText: string,
  allowDestructive: boolean
): void {
  if (DESTRUCTIVE_PATTERN.test(sqlText) && !allowDestructive) {
    throw new GuardViolationError(
      `${filename} contiene una operación destructiva (DROP/TRUNCATE/cambio de tipo). ` +
        `Requiere el flag --allow-destructive y debe quedar documentada.`
    );
  }
}

/** Solo para tests de integración: la base debe estar marcada como de test. */
export function assertTestEnvironment(env: SutecbaEnv): void {
  if (env.SUTECBA_ENV !== "test") {
    throw new GuardViolationError(
      `Los tests de integración solo corren con SUTECBA_ENV=test (actual: ${env.SUTECBA_ENV}).`
    );
  }
}
