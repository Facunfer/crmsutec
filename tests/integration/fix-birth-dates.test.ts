import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { runFixBirthDates } = await import("../../scripts/fix-birth-dates.js");
const { BirthDateDecisionsError } = await import("../../lib/people/birth-date-decisions.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
let userId: string;
let dniConfirm: string;
let dniNull: string;
let dniAmbiguous: string;

const dni = () => String(10000000 + Math.floor(Math.random() * 89999999)).slice(0, 8);

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({ email: "birthfix-actor@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id, status: "active" } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  userId = user.id;

  dniConfirm = dni();
  dniNull = dni();
  dniAmbiguous = dni();
  await db
    .insertInto("people")
    .values([
      { first_name: "Confirm", last_name: "Case", dni: dniConfirm, dni_source: "explicit", origin: "import", birth_date: sql`'2073-04-18'::date`, created_by: userId, updated_by: userId } as never,
      { first_name: "Null", last_name: "Case", dni: dniNull, dni_source: "explicit", origin: "import", birth_date: sql`'2026-10-10'::date`, created_by: userId, updated_by: userId } as never,
      { first_name: "Ambiguous", last_name: "Case", dni: dniAmbiguous, dni_source: "explicit", origin: "import", birth_date: sql`'0064-03-12'::date`, created_by: userId, updated_by: userId } as never,
    ])
    .execute();
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const decisionsFile = (overrides?: Partial<{ confirmExpected: string; nullExpected: string }>) => ({
  source_file: "birth_dates_historicas_revision.xlsx",
  source_sha256: "a".repeat(64),
  rows: [
    { dni: dniConfirm, birth_date_actual_supabase: overrides?.confirmExpected ?? "2073-04-18", fecha_candidata: "1973-04-18", decision: "SOURCE_CONFIRMS_CORRECTION", notas: "test" },
    { dni: dniNull, birth_date_actual_supabase: overrides?.nullExpected ?? "2026-10-10", fecha_candidata: "", decision: "INVALID_SOURCE", notas: "test" },
    { dni: dniAmbiguous, birth_date_actual_supabase: "0064-03-12", fecha_candidata: "", decision: "AMBIGUOUS_SOURCE", notas: "test" },
  ],
});

const writeDecisions = async (payload: unknown) => {
  const { writeFileSync } = await import("node:fs");
  const path = `${dataDir}-decisions.json`;
  writeFileSync(path, JSON.stringify(payload), "utf-8");
  return path;
};

const currentBirthDates = async () => {
  const db = await getDb();
  const rows = await sql<{ dni: string; b: string | null }>`select dni, to_char(birth_date, 'YYYY-MM-DD') as b from people where dni in (${sql.join([dniConfirm, dniNull, dniAmbiguous])})`.execute(db);
  return Object.fromEntries(rows.rows.map((r) => [r.dni, r.b]));
};

describe("fix-birth-dates (dry-run por defecto, transaccional, idempotente)", () => {
  it("dry-run: no escribe nada, informa los 3 casos y no genera reporte", async () => {
    const path = await writeDecisions(decisionsFile());
    const before = await currentBirthDates();
    const result = await runFixBirthDates({ decisionsPath: path, apply: false, yes: false });
    expect(result.mode).toBe("dry_run");
    expect(result.total).toBe(3);
    expect(result.toCorrect).toBe(1);
    expect(result.toNull).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(2); // se hubieran actualizado 2 (confirm + null), sin contar el ambiguo
    expect(result.reportPath).toBeNull();
    expect(await currentBirthDates()).toEqual(before);
  });

  it("--apply sin --yes se aborta", async () => {
    const path = await writeDecisions(decisionsFile());
    await expect(runFixBirthDates({ decisionsPath: path, apply: true, yes: false, createdBy: userId })).rejects.toThrow();
  });

  it("--apply sin --created-by se aborta", async () => {
    const path = await writeDecisions(decisionsFile());
    await expect(runFixBirthDates({ decisionsPath: path, apply: true, yes: true })).rejects.toThrow();
  });

  it("aborta TODO si una fila cambió desde la revisión (no aplica nada, ni siquiera las demás filas)", async () => {
    const path = await writeDecisions(decisionsFile({ confirmExpected: "1999-01-01" })); // valor esperado incorrecto a propósito
    const before = await currentBirthDates();
    await expect(runFixBirthDates({ decisionsPath: path, apply: true, yes: true, createdBy: userId })).rejects.toThrow();
    expect(await currentBirthDates()).toEqual(before); // ni siquiera el caso INVALID_SOURCE (correcto) se aplicó
  });

  it("apply: corrige SOURCE_CONFIRMS_CORRECTION, pone NULL en INVALID_SOURCE, y no toca AMBIGUOUS_SOURCE", async () => {
    const path = await writeDecisions(decisionsFile());
    const result = await runFixBirthDates({ decisionsPath: path, apply: true, yes: true, createdBy: userId });
    expect(result.mode).toBe("apply");
    expect(result.updated).toBe(2);
    expect(result.reportPath).not.toBeNull();

    const after = await currentBirthDates();
    expect(String(after[dniConfirm]).slice(0, 10)).toBe("1973-04-18");
    expect(after[dniNull]).toBeNull();
    expect(String(after[dniAmbiguous]).slice(0, 10)).toBe("0064-03-12"); // AMBIGUOUS_SOURCE: nunca se toca
  });

  it("es idempotente: una segunda corrida no vuelve a tocar nada (already_applied)", async () => {
    const path = await writeDecisions(decisionsFile({ confirmExpected: "1973-04-18" })); // ya corregido: el "esperado" ahora es el nuevo valor
    const before = await currentBirthDates();
    const result = await runFixBirthDates({ decisionsPath: path, apply: true, yes: true, createdBy: userId });
    expect(result.updated).toBe(0);
    expect(await currentBirthDates()).toEqual(before);
  });

  it("rechaza un archivo de decisiones con un DNI que no existe en people", async () => {
    const path = await writeDecisions({
      source_file: "x",
      source_sha256: "a".repeat(64),
      rows: [{ dni: "99999999", birth_date_actual_supabase: "0064-01-01", fecha_candidata: "", decision: "INVALID_SOURCE" }],
    });
    const before = await currentBirthDates();
    await expect(runFixBirthDates({ decisionsPath: path, apply: true, yes: true, createdBy: userId })).rejects.toThrow();
    expect(await currentBirthDates()).toEqual(before);
  });

  it("rechaza un archivo de decisiones malformado (formato de fila inválido)", async () => {
    const path = await writeDecisions({ source_file: "x", source_sha256: "a".repeat(64), rows: [{ dni: dniConfirm, birth_date_actual_supabase: "1973-04-18", fecha_candidata: "", decision: "NO_ES_UNA_DECISION" }] });
    await expect(runFixBirthDates({ decisionsPath: path, apply: false, yes: false })).rejects.toThrow(BirthDateDecisionsError);
  });
});
