import type { PGlite } from "@electric-sql/pglite";
import { assertServerOnly } from "../server-only.js";
import type { SutecbaEnv } from "./env.js";
import { GuardViolationError } from "./guards.js";

assertServerOnly("lib/db/pglite-bootstrap.ts");

/** Entornos donde PGlite es un motor de desarrollo/pruebas y se le puede dar compatibilidad. */
const PGLITE_COMPAT_ENVS: ReadonlyArray<SutecbaEnv["SUTECBA_ENV"]> = ["local", "test"];

/**
 * Compatibilidad PGlite ↔ Supabase, solo para que las migraciones corran.
 *
 * La migración 0019 hace REVOKE/GRANT/ALTER DEFAULT PRIVILEGES sobre los roles
 * `anon` y `authenticated`, que Supabase trae de fábrica y PGlite no. Acá se
 * crean vacíos (NOLOGIN, sin privilegios) antes de migrar.
 *
 * Esto NO convierte el entorno local en una simulación de la seguridad de
 * Supabase: en PGlite el usuario es superusuario, así que RLS y los GRANT de
 * 0019 se ejecutan pero no se hacen cumplir. Su efecto real solo se valida
 * contra PostgreSQL/Supabase.
 *
 * Se aplica únicamente cuando el backend es PGlite (sin SUTECBA_DATABASE_URL) y
 * el entorno es `local` o `test`. En staging/production, o con una URL de
 * Postgres definida, aborta: los roles de una base real los administra la base.
 * Es idempotente.
 */
export async function bootstrapSupabaseRolesForPglite(
  env: SutecbaEnv,
  client: PGlite
): Promise<void> {
  if (env.SUTECBA_DATABASE_URL) {
    throw new GuardViolationError(
      "El bootstrap de roles de compatibilidad es solo para PGlite; hay SUTECBA_DATABASE_URL definida."
    );
  }
  if (!PGLITE_COMPAT_ENVS.includes(env.SUTECBA_ENV)) {
    throw new GuardViolationError(
      `El bootstrap de roles de compatibilidad no se aplica con SUTECBA_ENV=${env.SUTECBA_ENV}.`
    );
  }

  await client.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
    END $$;
  `);
}

/** ¿Corresponde aplicar el bootstrap para este entorno? (misma condición que valida la función.) */
export function shouldBootstrapPgliteCompat(env: SutecbaEnv): boolean {
  return !env.SUTECBA_DATABASE_URL && PGLITE_COMPAT_ENVS.includes(env.SUTECBA_ENV);
}
