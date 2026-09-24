import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assertNoDevServerAgainstProduction, GuardViolationError } from "../../lib/db/guards.js";
import type { SutecbaEnv } from "../../lib/db/env.js";

// Un `.env` de desarrollo con URLs de una base real no puede colarse en los
// tests: con SUTECBA_ENV=test loadEnv/activateMigrationConnection no lo leen.
const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const ENV_MODULE = pathToFileURL(resolve("lib/db/env.ts")).href;
const dir = mkdtempSync(join(tmpdir(), "sutecba-env-"));

writeFileSync(
  join(dir, ".env"),
  [
    "SUTECBA_DATABASE_URL=postgresql://sentinel:pw@sentinel.invalid:5432/postgres",
    "SUTECBA_MIGRATION_DATABASE_URL=postgresql://sentinel:pw@sentinel-admin.invalid:5432/postgres",
    "",
  ].join("\n")
);
writeFileSync(
  join(dir, "probe.mts"),
  `import { loadEnv } from ${JSON.stringify(ENV_MODULE)};
const e = loadEnv();
console.log(JSON.stringify({ db: e.SUTECBA_DATABASE_URL ?? null, mig: e.SUTECBA_MIGRATION_DATABASE_URL ?? null }));
`
);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function probe(sutecbaEnv: string, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, SUTECBA_ENV: sutecbaEnv, ...extraEnv };
  delete env.SUTECBA_DATABASE_URL;
  delete env.SUTECBA_MIGRATION_DATABASE_URL;
  const r = spawnSync(process.execPath, [TSX, join(dir, "probe.mts")], {
    cwd: dir,
    env,
    encoding: "utf-8",
    timeout: 60000,
  });
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as { db: string | null; mig: string | null };
}

describe("aislamiento del .env en tests", () => {
  it("con SUTECBA_ENV=test no se lee el .env", () => {
    expect(probe("test")).toEqual({ db: null, mig: null });
  });

  it("control: con SUTECBA_ENV=local el mismo .env sí se lee", () => {
    const r = probe("local");
    expect(r.db).toContain("sentinel.invalid");
    expect(r.mig).toContain("sentinel-admin.invalid");
  });

  it("SUTECBA_ENV_FILE apuntando a un archivo inexistente evita leer el .env aun en local", () => {
    expect(probe("local", { SUTECBA_ENV_FILE: join(dir, "no-existe.env") })).toEqual({ db: null, mig: null });
  });
});

// Guarda 6 de lib/db/guards.ts (incidente 2026-09-24: next dev terminó conectado a producción). Unit puro, con
// `process.env.NODE_ENV` fabricado y restaurado en cada caso (nunca async con estado compartido — mismo criterio
// que ya se usa para assertApplyEnvironment en tests/unit/gabriel-apply-guards.test.ts).
describe("assertNoDevServerAgainstProduction (guarda 6): next dev nunca contra producción", () => {
  const env = (over: Partial<SutecbaEnv>): SutecbaEnv => ({ SUTECBA_ENV: "local", SUTECBA_TZ: "America/Argentina/Buenos_Aires", ...over });

  function withNodeEnv<T>(value: string | undefined, run: () => T): T {
    const mutableEnv = process.env as Record<string, string | undefined>;
    const original = mutableEnv.NODE_ENV;
    if (value === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = value;
    try {
      return run();
    } finally {
      if (original === undefined) delete mutableEnv.NODE_ENV;
      else mutableEnv.NODE_ENV = original;
    }
  }

  it("RECHAZADO: next dev (NODE_ENV=development) resolviendo SUTECBA_ENV=production", () => {
    withNodeEnv("development", () => {
      expect(() => assertNoDevServerAgainstProduction(env({ SUTECBA_ENV: "production", SUTECBA_DATABASE_URL: "postgresql://sutecba_app@db.example/postgres" }))).toThrow(GuardViolationError);
      expect(() => assertNoDevServerAgainstProduction(env({ SUTECBA_ENV: "production", SUTECBA_DATABASE_URL: "postgresql://sutecba_app@db.example/postgres" }))).toThrow(/next dev/i);
    });
  });

  it("PERMITIDO: next dev con SUTECBA_ENV=local (desarrollo normal)", () => {
    withNodeEnv("development", () => {
      expect(() => assertNoDevServerAgainstProduction(env({ SUTECBA_ENV: "local" }))).not.toThrow();
    });
  });

  it("PERMITIDO: next dev con SUTECBA_ENV=test (aislado, aunque no debería pasar por acá en la práctica)", () => {
    withNodeEnv("development", () => {
      expect(() => assertNoDevServerAgainstProduction(env({ SUTECBA_ENV: "test" }))).not.toThrow();
    });
  });

  it("PERMITIDO: next build / next start (NODE_ENV=production) resolviendo SUTECBA_ENV=production — el despliegue real", () => {
    withNodeEnv("production", () => {
      expect(() => assertNoDevServerAgainstProduction(env({ SUTECBA_ENV: "production", SUTECBA_DATABASE_URL: "postgresql://sutecba_app@db.example/postgres" }))).not.toThrow();
    });
  });

  it("PERMITIDO: scripts sueltos (sin NODE_ENV=development) resolviendo SUTECBA_ENV=production — tienen su propia guarda (--yes)", () => {
    withNodeEnv(undefined, () => {
      expect(() => assertNoDevServerAgainstProduction(env({ SUTECBA_ENV: "production", SUTECBA_DATABASE_URL: "postgresql://sutecba_app@db.example/postgres" }))).not.toThrow();
    });
    withNodeEnv("test", () => {
      expect(() => assertNoDevServerAgainstProduction(env({ SUTECBA_ENV: "production", SUTECBA_DATABASE_URL: "postgresql://sutecba_app@db.example/postgres" }))).not.toThrow();
    });
  });
});

// Prueba de integración real (proceso separado, como next dev de verdad): getDb() debe rechazar la conexión ANTES
// de abrir nada, con la combinación exacta del incidente — sin esto, un CI que solo probara la unidad podría no
// detectar que la guarda quedó desconectada de lib/db/client.ts.
describe("assertNoDevServerAgainstProduction conectada a getDb() (integración, proceso separado)", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "sutecba-dev-guard-"));
  const CLIENT_MODULE = pathToFileURL(resolve("lib/db/client.ts")).href;
  writeFileSync(
    join(dir2, "probe-client.mts"),
    `import { getDb } from ${JSON.stringify(CLIENT_MODULE)};
try { await getDb(); console.log(JSON.stringify({ threw: false })); }
catch (err) { console.log(JSON.stringify({ threw: true, message: String(err.message ?? err) })); }
`
  );
  afterAll(() => rmSync(dir2, { recursive: true, force: true }));

  it("getDb() rechaza ANTES de conectar cuando NODE_ENV=development + SUTECBA_ENV=production (nunca intenta abrir el pool real)", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "development",
      SUTECBA_ENV: "production",
      SUTECBA_DATABASE_URL: "postgresql://sentinel:pw@sentinel-nunca-se-usa.invalid:5432/postgres",
      SUTECBA_ENV_FILE: join(dir2, "no-existe.env"),
    };
    const r = spawnSync(process.execPath, [TSX, join(dir2, "probe-client.mts")], { cwd: dir2, env, encoding: "utf-8", timeout: 15000 });
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!) as { threw: boolean; message?: string };
    expect(out.threw).toBe(true);
    expect(out.message).toMatch(/next dev/i);
  });
});
