import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEYS = [
  "SUTECBA_ENV",
  "SUTECBA_DATABASE_URL",
  "SUTECBA_MIGRATION_DATABASE_URL",
  "SUTECBA_PGLITE_DATA_DIR",
] as const;

const RUNTIME = "postgresql://sutecba_app.runtimeref:pw@pooler.example.test:5432/postgres";
const ADMIN = "postgresql://postgres.adminref:pw@pooler.example.test:5432/postgres";

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.SUTECBA_ENV = "test";
  vi.resetModules();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function load() {
  const env = await import("../../lib/db/env.js");
  const scriptEnv = await import("../../lib/db/script-env.js");
  const guards = await import("../../lib/db/guards.js");
  return { ...env, ...scriptEnv, ...guards };
}

describe("conexión administrativa de migrate/seed", () => {
  it("A: con ambas URLs, los scripts seleccionan la administrativa", async () => {
    process.env.SUTECBA_DATABASE_URL = RUNTIME;
    process.env.SUTECBA_MIGRATION_DATABASE_URL = ADMIN;
    const m = await load();

    expect(m.activateMigrationConnection()).toBe(true);
    expect(m.loadEnv().SUTECBA_DATABASE_URL).toBe(ADMIN);
  });

  it("B: sin activar el helper, loadEnv/getDb siguen usando la URL de runtime", async () => {
    process.env.SUTECBA_DATABASE_URL = RUNTIME;
    process.env.SUTECBA_MIGRATION_DATABASE_URL = ADMIN;
    const m = await load();

    expect(m.loadEnv().SUTECBA_DATABASE_URL).toBe(RUNTIME);
    expect(process.env.SUTECBA_DATABASE_URL).toBe(RUNTIME);
  });

  it("B2: lib/db/client.ts no referencia la URL administrativa", async () => {
    const { readFileSync } = await import("node:fs");
    const client = readFileSync("lib/db/client.ts", "utf-8");
    expect(client).not.toContain("SUTECBA_MIGRATION_DATABASE_URL");
  });

  it("C: una URL administrativa hacia un proyecto bloqueado aborta en la guarda", async () => {
    process.env.SUTECBA_DATABASE_URL = RUNTIME;
    process.env.SUTECBA_MIGRATION_DATABASE_URL =
      "postgresql://postgres.dxoarslfifotigcgokmf:pw@pooler.example.test:5432/postgres";
    const m = await load();

    m.activateMigrationConnection();
    const env = m.loadEnv();
    expect(() => m.assertNotBlockedTarget(env, m.resolvePgliteDataDir(env))).toThrow(
      m.GuardViolationError
    );
  });

  it("C2: la guarda también mira la URL administrativa aunque no se haya activado", async () => {
    process.env.SUTECBA_DATABASE_URL = RUNTIME;
    process.env.SUTECBA_MIGRATION_DATABASE_URL =
      "postgresql://postgres.aysbehxlrgtacjdwmhsp:pw@pooler.example.test:5432/postgres";
    const m = await load();

    const env = m.loadEnv();
    expect(() => m.assertNotBlockedTarget(env, m.resolvePgliteDataDir(env))).toThrow(
      m.GuardViolationError
    );
  });

  it("D: sin URL administrativa se conserva SUTECBA_DATABASE_URL", async () => {
    process.env.SUTECBA_DATABASE_URL = RUNTIME;
    const m = await load();

    expect(m.activateMigrationConnection()).toBe(false);
    expect(m.loadEnv().SUTECBA_DATABASE_URL).toBe(RUNTIME);
  });

  it("E: sin ninguna URL de Postgres se sigue usando PGlite", async () => {
    const m = await load();

    expect(m.activateMigrationConnection()).toBe(false);
    const env = m.loadEnv();
    expect(env.SUTECBA_DATABASE_URL).toBeUndefined();
    expect(m.describeTarget(env, m.resolvePgliteDataDir(env))).toMatch(/^pglite /);
  });

  it("falla cerrado si el entorno ya se cacheó con otra conexión", async () => {
    process.env.SUTECBA_DATABASE_URL = RUNTIME;
    const m = await load();
    m.loadEnv();
    process.env.SUTECBA_MIGRATION_DATABASE_URL = ADMIN;

    expect(() => m.activateMigrationConnection()).toThrow(m.GuardViolationError);
  });

  it("describeTarget no expone la contraseña", async () => {
    process.env.SUTECBA_DATABASE_URL = ADMIN;
    const m = await load();
    const env = m.loadEnv();

    expect(m.describeTarget(env, m.resolvePgliteDataDir(env))).not.toContain("pw@");
  });
});
