import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql, type Kysely, type Transaction } from "kysely";
import { Pool } from "pg";
import { loadEnv, resolvePgliteDataDir, type SutecbaEnv } from "../../db/env.js";
import { assertNoForeignFootprint, assertNotBlockedTarget, GuardViolationError } from "../../db/guards.js";
import type { Database } from "../../db/schema.js";
import { FILE_CODES, type ExtractedFile } from "./types.js";

/**
 * Verificaciones previas al apply de la importación histórica. Cualquier falla ABORTA sin escribir nada.
 * Los mensajes nunca incluyen datos personales ni cadenas de conexión.
 */

export class ImportAbortError extends Error {}

const abort = (message: string): never => {
  throw new ImportAbortError(message);
};

export const REQUIRED_MIGRATION = "0021_historical_imports.sql";
export const SOURCE_SYSTEM = "gabriel-historical";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string | undefined, label: string): string {
  if (!value || !UUID.test(value)) abort(`${label} debe ser un UUID válido.`);
  return value!;
}

// ---------------------------------------------------------------- archivos originales

/** SHA-256 de cada original en `rawDir` contra el que quedó en el extracto: nada cambió desde el dry-run. */
export function verifySourceFiles(rawDir: string, files: ExtractedFile[]): void {
  const codes = files.map((f) => f.fileCode).sort();
  const expected = [...FILE_CODES].sort();
  if (codes.length !== expected.length || codes.some((c, i) => c !== expected[i])) {
    abort(`El conjunto de archivos no es el esperado (${expected.length} originales F01–F10, sin repetidos ni faltantes).`);
  }
  for (const file of files) {
    const path = join(rawDir, file.fileName);
    if (!existsSync(path)) abort(`Falta el original de ${file.fileCode} en el directorio de originales.`);
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== file.sha256) abort(`El original de ${file.fileCode} cambió desde el dry-run (SHA-256 distinto). Repetí la extracción y el dry-run.`);
  }
}

// ---------------------------------------------------------------- entorno y conexión

export interface ApplyEnvironmentInput {
  env: SutecbaEnv;
  /** Confirmación explícita (--yes). Obligatoria en production. */
  yes: boolean;
}

export function assertApplyEnvironment({ env, yes }: ApplyEnvironmentInput): void {
  try {
    assertNotBlockedTarget(env, resolvePgliteDataDir(env));
  } catch (err) {
    if (err instanceof GuardViolationError) abort(err.message);
    throw err;
  }
  const remote = env.SUTECBA_ENV === "production" || env.SUTECBA_ENV === "staging";
  if (remote && !env.SUTECBA_DATABASE_URL) {
    // Sin URL, el cliente cae a PGlite local: se escribiría en el lugar equivocado creyendo que es producción.
    abort(`SUTECBA_ENV=${env.SUTECBA_ENV} exige SUTECBA_DATABASE_URL (rol sutecba_app). No se usa PGlite local para un entorno remoto.`);
  }
  if (env.SUTECBA_ENV === "production" && !yes) abort("SUTECBA_ENV=production requiere --yes explícito, además del hash del plan.");
}

export interface RuntimeRoleInfo {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
}

/** La importación de negocio escribe con el rol runtime: en entornos remotos NO puede ser postgres/superusuario. */
export async function assertRuntimeRole(db: Kysely<Database>, env: SutecbaEnv): Promise<RuntimeRoleInfo> {
  const result = await sql<{ role: string; superuser: boolean; bypassrls: boolean }>`
    select current_user::text as role,
           coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
           coalesce((select rolbypassrls from pg_roles where rolname = current_user), false) as bypassrls
  `.execute(db);
  const row = result.rows[0]!;
  const info: RuntimeRoleInfo = { role: row.role, superuser: row.superuser, bypassRls: row.bypassrls };
  if (env.SUTECBA_ENV === "production" || env.SUTECBA_ENV === "staging") {
    if (info.role !== "sutecba_app" || info.superuser || info.bypassRls) {
      abort("La importación debe escribir con el rol runtime sutecba_app (sin superusuario ni BYPASSRLS), no con la conexión administrativa.");
    }
  }
  return info;
}

// ---------------------------------------------------------------- base: identidad, migraciones, 0021

export interface LedgerSnapshot {
  database: string;
  system: string | null;
  migrations: string[];
}
export type LedgerReader = () => Promise<LedgerSnapshot>;

/**
 * sutecba_app NO tiene permiso sobre sutecba_meta ni sutecba_migrations (reservadas al runner). Para
 * verificarlas sin ampliar ningún GRANT, la lectura (solo SELECT) usa la conexión de migración cuando
 * existe; con PGlite (tests/local) se lee por la misma conexión.
 */
export function defaultLedgerReader(db: Kysely<Database>, env: SutecbaEnv): LedgerReader {
  return async () => {
    if (env.SUTECBA_MIGRATION_DATABASE_URL) {
      const pool = new Pool({ connectionString: env.SUTECBA_MIGRATION_DATABASE_URL, max: 1 });
      try {
        const db1 = await pool.query<{ database: string }>("select current_database() as database");
        const meta = await pool.query<{ system: string }>("select system from sutecba_meta where id = true");
        const migs = await pool.query<{ filename: string }>("select filename from sutecba_migrations");
        return { database: db1.rows[0]!.database, system: meta.rows[0]?.system ?? null, migrations: migs.rows.map((r) => r.filename) };
      } finally {
        await pool.end();
      }
    }
    if (env.SUTECBA_DATABASE_URL) {
      abort("No se puede verificar sutecba_meta/sutecba_migrations: falta SUTECBA_MIGRATION_DATABASE_URL (solo lectura). sutecba_app no tiene acceso a esas tablas y no se amplían permisos.");
    }
    const database = await sql<{ database: string }>`select current_database() as database`.execute(db);
    const meta = await sql<{ system: string }>`select system from sutecba_meta where id = true`.execute(db);
    const migs = await sql<{ filename: string }>`select filename from sutecba_migrations`.execute(db);
    return { database: database.rows[0]!.database, system: meta.rows[0]?.system ?? null, migrations: migs.rows.map((r) => r.filename) };
  };
}

export function expectedMigrationFiles(dir = join(process.cwd(), "db", "migrations")): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

export async function assertDatabasePreconditions(
  db: Kysely<Database>,
  env: SutecbaEnv,
  options: { ledger?: LedgerReader; migrationsDir?: string } = {}
): Promise<{ database: string; migrations: number }> {
  try {
    await assertNoForeignFootprint(db);
  } catch (err) {
    if (err instanceof GuardViolationError) abort(err.message);
    throw err;
  }

  const ledger = await (options.ledger ?? defaultLedgerReader(db, env))();
  if (ledger.system !== "sutecba-crm") abort("sutecba_meta.system no es 'sutecba-crm': no es la base de SUTECBA.");

  const appDb = await sql<{ database: string }>`select current_database() as database`.execute(db);
  if (appDb.rows[0]!.database !== ledger.database) abort("La conexión de negocio y la de verificación apuntan a bases distintas.");

  const applied = new Set(ledger.migrations);
  const pending = expectedMigrationFiles(options.migrationsDir).filter((f) => !applied.has(f));
  if (!applied.has(REQUIRED_MIGRATION)) abort(`La migración ${REQUIRED_MIGRATION} no está aplicada.`);
  if (pending.length > 0) abort(`Hay ${pending.length} migración(es) pendiente(s): ${pending.join(", ")}.`);

  // Verificación estructural independiente del ledger (legible con sutecba_app).
  const structure = await sql<{ n: number }>`
    select count(*)::int as n from (
      select 1 from information_schema.columns where table_schema = 'public' and table_name = 'people' and column_name in ('cuil_cuit', 'dni_source')
      union all
      select 1 from information_schema.columns where table_schema = 'public' and table_name = 'meetings' and column_name in ('schedule_precision', 'source_event_key', 'event_date')
      union all
      select 1 from information_schema.columns where table_schema = 'public' and table_name = 'import_batches' and column_name in ('plan_hash', 'execution_mode', 'summary')
      union all
      select 1 from information_schema.tables where table_schema = 'public' and table_name = 'meeting_participations'
    ) t
  `.execute(db);
  if (structure.rows[0]!.n !== 9) abort("El esquema no tiene los objetos de 0021 (columnas/tablas esperadas).");

  return { database: ledger.database, migrations: ledger.migrations.length };
}

// ---------------------------------------------------------------- actor, unidad propietaria y lock (dentro de la transacción)

export const IMPORT_LOCK_KEY = "sutecba:import:gabriel";

/** Lock transaccional no bloqueante: si otro apply está corriendo, éste aborta en vez de esperar. */
export async function acquireImportLock(trx: Transaction<Database>): Promise<void> {
  const result = await sql<{ locked: boolean }>`select pg_try_advisory_xact_lock(hashtext(${IMPORT_LOCK_KEY})) as locked`.execute(trx);
  if (!result.rows[0]?.locked) abort("Hay otra importación histórica en curso (lock ocupado). No se aplica nada.");
}

export async function assertActorAndOwner(trx: Transaction<Database>, createdBy: string, ownerOrganizationId: string): Promise<void> {
  const actor = await trx
    .selectFrom("users")
    .innerJoin("roles", "roles.id", "users.role_id")
    .select(["users.id", "users.status", "roles.key as role_key"])
    .where("users.id", "=", createdBy)
    .executeTakeFirst();
  if (!actor) return abort("El usuario --created-by no existe.");
  if (actor.status !== "active") abort("El usuario --created-by no está activo.");
  if (actor.role_key !== "MASTER_GLOBAL") abort("El usuario --created-by no tiene autoridad suficiente (se requiere MASTER_GLOBAL).");
  const allowed = await sql<{ ok: boolean }>`select public.user_has_permission(${createdBy}::uuid, 'imports.run') as ok`.execute(trx);
  if (!allowed.rows[0]?.ok) abort("El usuario --created-by no tiene el permiso imports.run.");

  const owner = await trx.selectFrom("organizations").select(["id", "active", "valid_to"]).where("id", "=", ownerOrganizationId).executeTakeFirst();
  if (!owner) return abort("La unidad --owner-organization-id no existe.");
  if (!owner.active) abort("La unidad --owner-organization-id no está activa.");
  if (owner.valid_to && owner.valid_to.getTime() < Date.now()) abort("La unidad --owner-organization-id ya no está vigente.");
}

export function currentEnv(): SutecbaEnv {
  return loadEnv();
}

/** Actor MASTER_GLOBAL activo (para cargas administrativas que no necesitan una unidad propietaria). */
export async function assertMasterActor(trx: Transaction<Database>, createdBy: string): Promise<void> {
  const actor = await trx
    .selectFrom("users")
    .innerJoin("roles", "roles.id", "users.role_id")
    .select(["users.status", "roles.key as role_key"])
    .where("users.id", "=", createdBy)
    .executeTakeFirst();
  if (!actor) return abort("El usuario --created-by no existe.");
  if (actor.status !== "active") abort("El usuario --created-by no está activo.");
  if (actor.role_key !== "MASTER_GLOBAL") abort("El usuario --created-by no tiene autoridad suficiente (se requiere MASTER_GLOBAL).");
}
