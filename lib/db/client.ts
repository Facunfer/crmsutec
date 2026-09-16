import { mkdirSync } from "node:fs";
import { Kysely, PostgresDialect, type Dialect } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { Pool } from "pg";
import { assertServerOnly } from "../server-only.js";
import { loadEnv, resolvePgliteDataDir } from "./env.js";
import type { Database } from "./schema.js";

assertServerOnly("lib/db/client.ts");

let kyselyInstance: Kysely<Database> | null = null;
let pgliteHandle: KyselyPGlite | null = null;

async function buildDialect(): Promise<Dialect> {
  const env = loadEnv();

  if (env.SUTECBA_DATABASE_URL) {
    // Postgres real (staging/producción, o un local que el usuario levantó
    // por su cuenta). No probado en Etapa 2 por falta de instancia; el
    // contrato de lib/db es el mismo para ambos casos (decisión D2).
    return new PostgresDialect({
      pool: new Pool({ connectionString: env.SUTECBA_DATABASE_URL }),
    });
  }

  const dataDir = resolvePgliteDataDir(env);
  mkdirSync(dataDir, { recursive: true });
  pgliteHandle = await KyselyPGlite.create(dataDir);
  return pgliteHandle.dialect;
}

/** Único punto de acceso a la base. Todo lo demás importa esto, nunca `pg`/PGlite directo. */
export async function getDb(): Promise<Kysely<Database>> {
  if (!kyselyInstance) {
    const dialect = await buildDialect();
    kyselyInstance = new Kysely<Database>({ dialect });
  }
  return kyselyInstance;
}

/**
 * Ejecuta SQL crudo con múltiples sentencias (los archivos de migración).
 * Kysely no garantiza multi-statement en un solo `sql` template, así que las
 * migraciones se aplican con el cliente subyacente. Fuera de scripts/migrate.ts
 * nada debería llamar a esto.
 */
export async function execRawSql(sqlText: string): Promise<void> {
  const env = loadEnv();
  await getDb();

  if (pgliteHandle) {
    await pgliteHandle.client.exec(sqlText);
    return;
  }

  if (env.SUTECBA_DATABASE_URL) {
    const client = new Pool({ connectionString: env.SUTECBA_DATABASE_URL });
    try {
      await client.query(sqlText);
    } finally {
      await client.end();
    }
    return;
  }

  throw new Error("execRawSql: no hay backend de base inicializado.");
}

export async function closeDb(): Promise<void> {
  if (kyselyInstance) {
    await kyselyInstance.destroy();
    kyselyInstance = null;
    pgliteHandle = null;
  }
}
