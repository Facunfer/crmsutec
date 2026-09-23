import { z } from "zod";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/db/env.ts");

/**
 * Nunca leer como fallback SUPABASE_URL, SUPABASE_ANON_KEY, DATABASE_URL
 * ni ninguna variable del CRM de referencia (regla R1 del proyecto).
 */
const envSchema = z.object({
  SUTECBA_ENV: z.enum(["local", "test", "staging", "production"]).default("local"),
  // Postgres real (staging/production, o local si el usuario levanta uno).
  SUTECBA_DATABASE_URL: z.string().url().optional(),
  // Conexión administrativa (rol postgres): la leen SOLO migrate/seed vía
  // lib/db/script-env.ts. La app y lib/db/client.ts nunca la usan.
  SUTECBA_MIGRATION_DATABASE_URL: z.string().url().optional(),
  // PGlite embebido: se usa cuando no hay SUTECBA_DATABASE_URL.
  SUTECBA_PGLITE_DATA_DIR: z.string().optional(),
  SUTECBA_TZ: z.string().default("America/Argentina/Buenos_Aires"),
  SUTECBA_SESSION_SECRET: z.string().min(32).optional(),
  SUTECBA_TOKEN_SECRET: z.string().min(32).optional(),
  SUTECBA_QR_SECRET: z.string().min(32).optional(),
  SUTECBA_PUBLIC_BASE_URL: z.string().url().optional(),
});

export type SutecbaEnv = z.infer<typeof envSchema>;

let cached: SutecbaEnv | null = null;

/** Devuelve el entorno ya cacheado sin leerlo; `null` si `loadEnv()` todavía no corrió. */
export function peekLoadedEnv(): SutecbaEnv | null {
  return cached;
}

/**
 * `next dev`/`build`/`start` cargan `.env` solos (vía @next/env), pero los
 * scripts sueltos (`tsx scripts/migrate.ts`, etc.) no; despliegue real: con
 * SUTECBA_ENV=production en `.env`, `migrate`/`seed`/`create-admin` seguían
 * reportando `env=local`. `process.loadEnvFile()` (Node 20.6+) no pisa una
 * variable ya exportada por la shell (mismo criterio que dotenv).
 *
 * Con SUTECBA_ENV=test NO se lee el archivo: los tests fijan su entorno a
 * mano (PGlite descartable) y un `.env` de desarrollo con la URL de una base
 * real no debe colarse en ellos.
 */
export function loadDotEnvFile(): void {
  if (process.env.SUTECBA_ENV === "test") return;
  try {
    // SUTECBA_ENV_FILE permite apuntar a otro archivo (o a uno inexistente, para
    // correr un script sin leer el `.env` real, p. ej. una prueba local aislada).
    process.loadEnvFile(process.env.SUTECBA_ENV_FILE || undefined);
  } catch {
    // Sin .env (o entorno que ya trae todo por variables de shell).
  }
}

export function loadEnv(): SutecbaEnv {
  if (cached) return cached;

  loadDotEnvFile();

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `Configuración de entorno inválida o incompleta. Revisá: ${missing}. ` +
        `No se imprime ningún valor por seguridad.`
    );
  }

  cached = parsed.data;
  return cached;
}

/** Directorio de datos de PGlite según el entorno, para no mezclar dev y test. */
export function resolvePgliteDataDir(env: SutecbaEnv): string {
  if (env.SUTECBA_PGLITE_DATA_DIR) return env.SUTECBA_PGLITE_DATA_DIR;
  return env.SUTECBA_ENV === "test" ? ".data/pglite-test" : ".data/pglite-local";
}
