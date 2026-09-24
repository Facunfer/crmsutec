import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Instalación local limpia: PGlite en un directorio temporal, SUTECBA_ENV=local
// y SIN leer el `.env` real (SUTECBA_ENV_FILE apunta a un archivo inexistente),
// para que nunca pueda tomar la URL de una base real. Cada paso corre como el
// CLI de verdad, en su propio proceso.
const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const workDir = mkdtempSync(join(tmpdir(), "sutecba-local-"));
const dataDir = join(workDir, "pglite");

function run(script: string, args: string[] = []) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SUTECBA_ENV: "local",
    SUTECBA_PGLITE_DATA_DIR: dataDir,
    SUTECBA_ENV_FILE: join(workDir, "no-existe.env"),
  };
  delete env.SUTECBA_DATABASE_URL;
  delete env.SUTECBA_MIGRATION_DATABASE_URL;
  const r = spawnSync(process.execPath, [TSX, script, ...args], { env, encoding: "utf-8", timeout: 240000 });
  return { out: `${r.stdout}\n${r.stderr}`, status: r.status };
}

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("PGlite local limpio (SUTECBA_ENV=local)", () => {
  it("14) migra sin intervención hasta 0024 y se detiene en 0025 (destructiva) mientras no se apruebe con --allow-destructive", () => {
    const { out, status } = run("scripts/migrate.ts");
    expect(out).toContain("destino: pglite");
    expect(out).toContain("env=local");
    expect(out).toContain("0019_supabase_security.sql OK");
    expect(out).toContain("0020_keep_last_user_scope.sql OK");
    expect(out).toContain("0024_area_reparticion_and_participation_interactions.sql OK");
    expect(out).toContain("0025_drop_audit_logs_and_retired_permissions.sql contiene una operación destructiva");
    expect(out).not.toContain("0025_drop_audit_logs_and_retired_permissions.sql OK");
    expect(status).not.toBe(0);
  }, 300000);

  it("con --allow-destructive aplica 0025 (elimina audit_logs) y el resto de las migraciones pendientes", () => {
    const { out, status } = run("scripts/migrate.ts", ["--allow-destructive"]);
    expect(out).toContain("0025_drop_audit_logs_and_retired_permissions.sql OK");
    expect(out).toContain("0026_revoke_public_meeting_participation_privileges.sql OK");
    expect(out).toContain("0027_import_files_size_and_metadata.sql OK");
    expect(out).toContain("0028_participation_basis_legacy_initial_import.sql OK");
    expect(out).toContain("0029_legacy_reference_date_basis.sql OK");
    expect(out).toContain("0030_transfer_person_destination_scope.sql OK");
    expect(out).toContain("6 migración(es) aplicada(s)");
    expect(status).toBe(0);
  }, 300000);

  it("volver a migrar no tiene nada pendiente", () => {
    const { out, status } = run("scripts/migrate.ts");
    expect(out).toContain("no hay migraciones pendientes");
    expect(status).toBe(0);
  }, 300000);

  it("15) ejecuta el seed actualizado después de migrar, y es idempotente", () => {
    const first = run("scripts/seed.ts");
    expect(first.out).toContain("10 módulos");
    expect(first.out).toContain("40 permisos");
    expect(first.status).toBe(0);

    const second = run("scripts/seed.ts");
    expect(second.status).toBe(0);
  }, 300000);

  it("create-admin crea el primer MASTER_GLOBAL sobre esa base", () => {
    const { out, status } = run("scripts/create-admin.ts", [
      "--email=admin-local@sutecba.local",
      "--name=Admin Local",
      `--password=${randomUUID()}-Aa1`,
    ]);
    expect(out).toContain("usuario MASTER_GLOBAL creado");
    expect(status).toBe(0);
  }, 300000);
});
