import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import { closeDb, execRawSql, getDb } from "../lib/db/client.js";
import { loadEnv, resolvePgliteDataDir } from "../lib/db/env.js";
import {
  assertNoDestructiveWithoutFlag,
  assertNoForeignFootprint,
  assertNotBlockedTarget,
  assertOrBootstrapSystemIdentity,
  assertProductionConfirmed,
  describeTarget,
  GuardViolationError,
} from "../lib/db/guards.js";

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

export function parseFlags(argv: string[]) {
  return {
    yes: argv.includes("--yes"),
    allowDestructive: argv.includes("--allow-destructive"),
  };
}

async function ensureMigrationsTable(): Promise<void> {
  const db = await getDb();
  await sql`
    create table if not exists sutecba_migrations (
      id serial primary key,
      filename text not null unique,
      applied_at timestamptz not null default now()
    )
  `.execute(db);
}

/** Reutilizable desde el CLI y desde tests de integración. No cierra la conexión. */
export async function applyMigrations(flags: { yes: boolean; allowDestructive: boolean }) {
  const env = loadEnv();
  const pgliteDataDir = resolvePgliteDataDir(env);

  console.log(`[migrate] destino: ${describeTarget(env, pgliteDataDir)}`);

  assertNotBlockedTarget(env, pgliteDataDir);

  const db = await getDb();
  await ensureMigrationsTable();
  await assertNoForeignFootprint(db);
  await assertOrBootstrapSystemIdentity(db);
  assertProductionConfirmed(env, flags.yes);

  const appliedRows = await db.selectFrom("sutecba_migrations").select("filename").execute();
  const applied = new Set(appliedRows.map((r) => r.filename));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log("[migrate] no hay migraciones pendientes.");
    return;
  }

  for (const filename of pending) {
    const filePath = join(MIGRATIONS_DIR, filename);
    const sqlText = readFileSync(filePath, "utf-8");

    assertNoDestructiveWithoutFlag(filename, sqlText, flags.allowDestructive);

    const escapedFilename = filename.replace(/'/g, "''");
    const transactional = `begin;\n${sqlText}\ninsert into sutecba_migrations (filename) values ('${escapedFilename}');\ncommit;`;

    console.log(`[migrate] aplicando ${filename}...`);
    await execRawSql(transactional);
    console.log(`[migrate] ${filename} OK`);
  }

  console.log(`[migrate] listo. ${pending.length} migración(es) aplicada(s).`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  await applyMigrations(flags);
  await closeDb();
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    if (err instanceof GuardViolationError) {
      console.error(`[migrate] ABORTADO por guarda: ${err.message}`);
    } else {
      console.error("[migrate] error:", err);
    }
    process.exitCode = 1;
  });
}
