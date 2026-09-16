import { mkdirSync } from "node:fs";
import { Kysely, PostgresDialect, type Dialect } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { Pool } from "pg";
import { assertServerOnly } from "../server-only.js";
import { loadEnv, resolvePgliteDataDir } from "./env.js";
import type { Database } from "./schema.js";

assertServerOnly("lib/db/client.ts");

/**
 * Next.js compila el código de servidor en varias "capas" separadas (RSC,
 * SSR, Server Actions, middleware), cada una con su propio grafo de
 * módulos: un `let` a nivel de módulo NO es un singleton real ahí, cada
 * capa termina abriendo su propia instancia. Con PGlite (motor embebido,
 * no un servidor de red) eso es grave: dos instancias abiertas contra el
 * mismo directorio no se sincronizan entre sí y los datos escritos por una
 * quedan invisibles para la otra. `globalThis` sí es compartido entre
 * capas dentro del mismo proceso de Node, así que el cache va ahí.
 */
interface SutecbaDbGlobal {
  __sutecbaDbConnection?: Promise<{
    kysely: Kysely<Database>;
    pglite: KyselyPGlite | null;
  }>;
  __sutecbaShutdownHookRegistered?: boolean;
}

const globalForDb = globalThis as unknown as SutecbaDbGlobal;

/**
 * PGlite es un motor embebido: si el proceso muere sin pasar por
 * `pglite.close()` (p. ej. `kill -9`/`Stop-Process -Force`, sin
 * oportunidad de flushear), el directorio de datos puede quedar corrupto
 * — nos pasó de verdad, ver el addendum de la Etapa 5 en
 * SUTECBA_ARCHITECTURE.md. Esto es best-effort: ayuda ante un SIGTERM
 * normal (systemd/PM2 al reiniciar), pero un `-Force`/`kill -9` sigue sin
 * poder atraparse en Node. Por eso `.data/pglite-local` se trata siempre
 * como descartable, nunca como la única copia de algo importante.
 */
function registerShutdownHookOnce(): void {
  if (globalForDb.__sutecbaShutdownHookRegistered) return;
  globalForDb.__sutecbaShutdownHookRegistered = true;

  const shutdown = () => {
    closeDb()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function buildConnection(): Promise<{
  kysely: Kysely<Database>;
  pglite: KyselyPGlite | null;
}> {
  const env = loadEnv();

  if (env.SUTECBA_DATABASE_URL) {
    // Postgres real (staging/producción, o un local que el usuario levantó
    // por su cuenta). No probado en Etapa 2/3 por falta de instancia; el
    // contrato de lib/db es el mismo para ambos casos (decisión D2).
    const dialect: Dialect = new PostgresDialect({
      pool: new Pool({ connectionString: env.SUTECBA_DATABASE_URL }),
    });
    return { kysely: new Kysely<Database>({ dialect }), pglite: null };
  }

  const dataDir = resolvePgliteDataDir(env);
  mkdirSync(dataDir, { recursive: true });
  // pg_trgm/unaccent no vienen precargados en PGlite: hay que pasarlos como
  // "extensions" al crear la instancia para poder hacer CREATE EXTENSION
  // (búsqueda de personas sin distinguir acentos, sección 7.2 de SUTECBA_DATABASE.md).
  const pglite = await KyselyPGlite.create(dataDir, { extensions: { pg_trgm, unaccent } });
  return { kysely: new Kysely<Database>({ dialect: pglite.dialect }), pglite };
}

function connection() {
  if (!globalForDb.__sutecbaDbConnection) {
    registerShutdownHookOnce();
    globalForDb.__sutecbaDbConnection = buildConnection();
  }
  return globalForDb.__sutecbaDbConnection;
}

/** Único punto de acceso a la base. Todo lo demás importa esto, nunca `pg`/PGlite directo. */
export async function getDb(): Promise<Kysely<Database>> {
  const { kysely } = await connection();
  return kysely;
}

/**
 * Ejecuta SQL crudo con múltiples sentencias (los archivos de migración).
 * Kysely no garantiza multi-statement en un solo `sql` template, así que las
 * migraciones se aplican con el cliente subyacente. Fuera de scripts/migrate.ts
 * nada debería llamar a esto.
 */
export async function execRawSql(sqlText: string): Promise<void> {
  const env = loadEnv();
  const { pglite } = await connection();

  if (pglite) {
    await pglite.client.exec(sqlText);
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
  if (globalForDb.__sutecbaDbConnection) {
    const { kysely } = await globalForDb.__sutecbaDbConnection;
    await kysely.destroy();
    globalForDb.__sutecbaDbConnection = undefined;
  }
}
