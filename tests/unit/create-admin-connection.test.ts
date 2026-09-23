import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Ejecuta el script real en un proceso aparte, con SUTECBA_ENV=test (no lee
// .env) y URLs falsas hacia hosts inexistentes. Los casos abortan en las
// guardas ANTES de abrir ninguna conexión, así que nunca se toca una base.
const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const BLOCKED_REF = "dxoarslfifotigcgokmf";

function runCreateAdmin(extraEnv: Record<string, string>) {
  const env: NodeJS.ProcessEnv = { ...process.env, SUTECBA_ENV: "test", ...extraEnv };
  for (const k of ["SUTECBA_DATABASE_URL", "SUTECBA_MIGRATION_DATABASE_URL"]) {
    if (!(k in extraEnv)) delete env[k];
  }
  const r = spawnSync(
    process.execPath,
    [TSX, "scripts/create-admin.ts", "--email=x@example.test", "--name=X", "--password=Abcdef123456!"],
    { env, encoding: "utf-8", timeout: 60000 }
  );
  return { out: `${r.stdout}\n${r.stderr}`, status: r.status };
}

describe("create-admin usa la conexión administrativa", () => {
  it("A: con runtime + migration, selecciona la administrativa", () => {
    const { out } = runCreateAdmin({
      SUTECBA_DATABASE_URL: "postgresql://sutecba_app.ok:pw@runtime.invalid:5432/postgres",
      SUTECBA_MIGRATION_DATABASE_URL: `postgresql://postgres.${BLOCKED_REF}:pw@admin.invalid:5432/postgres`,
    });
    expect(out).toContain("host=admin.invalid");
    expect(out).not.toContain("runtime.invalid");
    expect(out).toContain("ABORTADO por guarda");
    expect(out).not.toContain("pw@");
  });

  it("B: sin migration URL conserva SUTECBA_DATABASE_URL", () => {
    const { out } = runCreateAdmin({
      SUTECBA_DATABASE_URL: `postgresql://sutecba_app.${BLOCKED_REF}:pw@runtime.invalid:5432/postgres`,
    });
    expect(out).toContain("host=runtime.invalid");
    expect(out).not.toContain("(conexión de migraciones)");
    expect(out).toContain("ABORTADO por guarda");
  });

  it("C: una URL administrativa de un proyecto bloqueado la rechazan las guardas", () => {
    const { out, status } = runCreateAdmin({
      SUTECBA_DATABASE_URL: "postgresql://sutecba_app.ok:pw@runtime.invalid:5432/postgres",
      SUTECBA_MIGRATION_DATABASE_URL: "postgresql://postgres.aysbehxlrgtacjdwmhsp:pw@admin.invalid:5432/postgres",
    });
    expect(out).toContain("ABORTADO por guarda");
    expect(status).not.toBe(0);
  });
});
