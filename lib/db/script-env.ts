import { assertServerOnly } from "../server-only.js";
import { loadDotEnvFile, peekLoadedEnv } from "./env.js";
import { GuardViolationError } from "./guards.js";

assertServerOnly("lib/db/script-env.ts");

/**
 * Selección de la conexión administrativa para `migrate` y `seed`.
 *
 * La app (Next.js) y `lib/db/client.ts` solo conocen SUTECBA_DATABASE_URL, que
 * en producción es el rol limitado `sutecba_app`. Las migraciones necesitan
 * DDL, así que corren con SUTECBA_MIGRATION_DATABASE_URL (rol postgres). En vez
 * de pasar conexiones por parámetro, este helper la copia a
 * SUTECBA_DATABASE_URL dentro del proceso del script, ANTES del primer
 * `loadEnv()`/`getDb()` (ambos cachean). Así las guardas de guards.ts —que
 * leen SUTECBA_DATABASE_URL— inspeccionan exactamente el destino administrativo.
 *
 * Solo modifica `process.env` de este proceso, nunca el archivo `.env`. No
 * imprime la URL. Sin SUTECBA_MIGRATION_DATABASE_URL no hace nada (tests,
 * PGlite y despliegues anteriores siguen igual).
 *
 * Devuelve true si se activó la conexión administrativa.
 */
export function activateMigrationConnection(): boolean {
  loadDotEnvFile();

  const migrationUrl = process.env.SUTECBA_MIGRATION_DATABASE_URL;
  if (!migrationUrl) return false;

  const loaded = peekLoadedEnv();
  if (loaded && loaded.SUTECBA_DATABASE_URL !== migrationUrl) {
    // El entorno ya se cacheó con otra conexión: sustituir ahora no tendría
    // efecto y el script correría con la conexión equivocada. Se falla cerrado.
    throw new GuardViolationError(
      "La configuración de entorno ya estaba cargada con otra conexión; no se puede " +
        "activar SUTECBA_MIGRATION_DATABASE_URL. Ejecutá migrate/seed en un proceso nuevo."
    );
  }

  process.env.SUTECBA_DATABASE_URL = migrationUrl;
  return true;
}
