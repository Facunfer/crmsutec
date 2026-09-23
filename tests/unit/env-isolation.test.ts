import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

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
