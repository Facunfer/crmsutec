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

export function loadEnv(): SutecbaEnv {
  if (cached) return cached;

  // `next dev`/`build`/`start` cargan `.env` solos (vía @next/env), pero los
  // scripts sueltos (`tsx scripts/migrate.ts`, etc.) no — nada en el proyecto
  // los hacía leer el archivo, así que dependían de que la shell ya tuviera
  // las variables exportadas. Se detectó en despliegue: con SUTECBA_ENV=production
  // en `.env`, `migrate`/`seed`/`create-admin` seguían reportando `env=local`
  // porque nunca llegaban a leer el archivo. `process.loadEnvFile()` (Node
  // 20.6+) no pisa una variable que la shell ya haya exportado (mismo criterio
  // que dotenv), así que es seguro llamarlo también desde la app de Next.
  try {
    process.loadEnvFile();
  } catch {
    // Sin .env (tests, o entorno que ya trae todo por variables de shell) — se sigue con lo que haya en process.env.
  }

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
