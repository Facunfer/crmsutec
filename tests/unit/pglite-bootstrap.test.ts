import { describe, expect, it, vi } from "vitest";
import { bootstrapSupabaseRolesForPglite, shouldBootstrapPgliteCompat } from "../../lib/db/pglite-bootstrap.js";
import { GuardViolationError } from "../../lib/db/guards.js";
import type { SutecbaEnv } from "../../lib/db/env.js";

function env(overrides: Partial<SutecbaEnv>): SutecbaEnv {
  return { SUTECBA_ENV: "local", SUTECBA_TZ: "America/Argentina/Buenos_Aires", ...overrides } as SutecbaEnv;
}

// Cliente simulado: estos tests no abren ninguna base.
function fakeClient() {
  return { exec: vi.fn(async () => []) } as unknown as import("@electric-sql/pglite").PGlite & {
    exec: ReturnType<typeof vi.fn>;
  };
}

describe("bootstrap de compatibilidad PGlite (roles anon/authenticated)", () => {
  it("se aplica con PGlite en local y en test, y es idempotente (IF NOT EXISTS)", async () => {
    for (const name of ["local", "test"] as const) {
      const client = fakeClient();
      const e = env({ SUTECBA_ENV: name });
      expect(shouldBootstrapPgliteCompat(e)).toBe(true);
      await bootstrapSupabaseRolesForPglite(e, client);
      expect(client.exec).toHaveBeenCalledTimes(1);
      const sql = String(client.exec.mock.calls[0]?.[0]);
      expect(sql).toContain("IF NOT EXISTS");
      expect(sql).toContain("CREATE ROLE anon");
      expect(sql).toContain("CREATE ROLE authenticated");
    }
  });

  it("nunca en staging ni en production", async () => {
    for (const name of ["staging", "production"] as const) {
      const client = fakeClient();
      const e = env({ SUTECBA_ENV: name });
      expect(shouldBootstrapPgliteCompat(e)).toBe(false);
      await expect(bootstrapSupabaseRolesForPglite(e, client)).rejects.toThrow(GuardViolationError);
      expect(client.exec).not.toHaveBeenCalled();
    }
  });

  it("nunca si hay SUTECBA_DATABASE_URL (Postgres real), aunque el entorno sea local o test", async () => {
    for (const name of ["local", "test"] as const) {
      const client = fakeClient();
      const e = env({ SUTECBA_ENV: name, SUTECBA_DATABASE_URL: "postgresql://x:y@db.invalid:5432/postgres" });
      expect(shouldBootstrapPgliteCompat(e)).toBe(false);
      await expect(bootstrapSupabaseRolesForPglite(e, client)).rejects.toThrow(GuardViolationError);
      expect(client.exec).not.toHaveBeenCalled();
    }
  });
});
