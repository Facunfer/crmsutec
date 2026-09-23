import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
process.env.SUTECBA_ENV = "test";
const dir = resolve(`.data/pglite-test-${randomUUID()}`);
process.env.SUTECBA_PGLITE_DATA_DIR = dir;
const { getDb, closeDb } = await import("../../lib/db/client.js");
const { applyMigration, applyMigrations } = await import("../../scripts/migrate.js");
const { migrationStatements } = await import("../../lib/db/migration-sql.js");
beforeAll(async () => { await applyMigrations({ yes: false, allowDestructive: true }); });
afterAll(async () => { await closeDb(); await new Promise((resolve) => setTimeout(resolve, 100)); if (!dir.startsWith(resolve(".data") + "/") && !dir.startsWith(resolve(".data") + "\\")) throw new Error("Invalid test path"); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
async function state(name: string) {
  const db = await getDb();
  return { table: (await sql<{ t: string | null }>`select to_regclass(${name})::text t`.execute(db)).rows[0]!.t,
    ledger: await db.selectFrom("sutecba_migrations").select("filename").where("filename", "=", name).execute() };
}
it("commits SQL and ledger together; explicit BEGIN/COMMIT and dollar bodies work", async () => {
  const db = await getDb();
  await applyMigration(db, "atomic_ok", "-- outer\nBEGIN; CREATE TABLE atomic_ok (value text); DO $$ BEGIN INSERT INTO atomic_ok VALUES ('BEGIN; COMMIT;'); END $$; COMMIT;", false);
  expect(await state("atomic_ok")).toEqual({ table: "atomic_ok", ledger: [{ filename: "atomic_ok" }] });
  await applyMigration(db, "atomic_ok", "select no_such_function()", false);
});
it("rolls back SQL on a failure before ledger", async () => {
  await expect(applyMigration(await getDb(), "atomic_sql_fail", "CREATE TABLE atomic_sql_fail(id int); SELECT missing_atomic_function();", false)).rejects.toThrow();
  expect(await state("atomic_sql_fail")).toEqual({ table: null, ledger: [] });
});
it("rolls back executed SQL when ledger INSERT fails", async () => {
  const text = `BEGIN; CREATE TABLE atomic_ledger_fail(id int);
    CREATE FUNCTION atomic_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger failure'; END $$;
    CREATE TRIGGER atomic_fail BEFORE INSERT ON sutecba_migrations FOR EACH ROW EXECUTE FUNCTION atomic_fail(); COMMIT;`;
  await expect(applyMigration(await getDb(), "atomic_ledger_fail", text, false)).rejects.toThrow("ledger failure");
  expect(await state("atomic_ledger_fail")).toEqual({ table: null, ledger: [] });
});
it("rolls back both even when failure occurs at commit after ledger INSERT", async () => {
  const text = `CREATE TABLE atomic_commit_fail(id int);
    CREATE FUNCTION atomic_deferred_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit failure'; END $$;
    CREATE CONSTRAINT TRIGGER atomic_deferred_fail AFTER INSERT ON sutecba_migrations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION atomic_deferred_fail();`;
  await expect(applyMigration(await getDb(), "atomic_commit_fail", text, false)).rejects.toThrow("commit failure");
  expect(await state("atomic_commit_fail")).toEqual({ table: null, ledger: [] });
});
it("rejects destructive migration without flag before changing anything", async () => {
  await expect(applyMigration(await getDb(), "atomic_drop", "DROP TABLE atomic_ok", false)).rejects.toThrow("allow-destructive");
  expect((await state("atomic_ok")).table).toBe("atomic_ok");
  expect((await state("atomic_drop")).ledger).toEqual([]);
});
it("rejects unsafe transaction structures, preserves comments/strings/function semantics", () => {
  for (const text of ["COMMIT; SELECT 1", "BEGIN; SELECT 1; COMMIT; BEGIN; SELECT 2; COMMIT", "BEGIN; SELECT 1", "ROLLBACK", "SET TRANSACTION READ ONLY"]) expect(() => migrationStatements(text)).toThrow();
  expect(migrationStatements("/* a /* nested */ comment */ SELECT ';'; -- COMMIT\n SELECT $$COMMIT;$$;")).toHaveLength(2);
});
it("missing --yes in production aborts before PGlite or ledger creation", () => {
  const absent = resolve(`.data/pglite-test-${randomUUID()}`);
  const env: NodeJS.ProcessEnv = { ...process.env, SUTECBA_ENV: "production", SUTECBA_ENV_FILE: resolve(".data/nonexistent-env"), SUTECBA_PGLITE_DATA_DIR: absent };
  delete env.SUTECBA_DATABASE_URL; delete env.SUTECBA_MIGRATION_DATABASE_URL;
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], { env, encoding: "utf8" });
  expect(child.status).toBe(1);
  expect(child.stderr).toContain("--yes");
  expect(existsSync(absent)).toBe(false);
});
