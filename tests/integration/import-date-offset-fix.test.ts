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
const { createTestOrganization } = await import("../helpers/organization.js");
const { runImport } = await import("../../lib/imports/gabriel/apply.js");
const { planFromSources } = await import("../../lib/imports/gabriel/plan-hash.js");
const { applyDateOffsetFix, findDateOffset } = await import("../../lib/imports/gabriel/fix-date-offset.js");
const { dateOnly } = await import("../../lib/db/date-only.js");
const fx = await import("../helpers/gabriel-fixtures.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
let ownerOrgId: string;
let userId: string;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  ownerOrgId = await createTestOrganization();
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  userId = (await db.insertInto("users").values({ email: "fix-dates@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "A", role_id: role.id, status: "active" } as never).returning("id").executeTakeFirstOrThrow()).id;
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("fechas sin hora: independientes de la zona horaria del proceso", () => {
  it("dateOnly escribe el texto AAAA-MM-DD con ::date (nunca un Date) y valida", async () => {
    const db = await getDb();
    const compiled = dateOnly("2026-03-10")!.compile(db);
    expect(compiled.sql).toBe("$1::date");
    expect(compiled.parameters).toEqual(["2026-03-10"]);
    expect(dateOnly(null)).toBeNull();
    expect(() => dateOnly("10/03/2026")).toThrow();
    expect(() => dateOnly("2026-02-30")).toThrow();
  });
});

describe("corrección del desfase de un día del primer import", () => {
  const files = [fx.f09File([{ last: "Uno", first: "Ana", dni: "70000001", email: "u1@example.com", birth: "1985-06-15" }, { last: "Dos", first: "Bea", dni: "70000002", email: "u2@example.com", birth: "1990-01-01" }]), fx.agendaFile([["martes", "2026-03-10", "educacion 1"], ["miercoles", "2026-03-11", "canale"]])];
  const { plan } = planFromSources(files);

  it("importa y simula el desfase de producción (-1 día); el dry-run lo detecta y no escribe", async () => {
    const db = await getDb();
    const result = await runImport(db, files, { ownerOrganizationId: ownerOrgId, createdBy: userId, confirmedPlanHash: planFromSources(files).planHash } as never);
    expect(result.outcome).toBe("applied");
    // Con la corrección de código, el import ya escribe la fecha correcta:
    const ok = await sql<{ b: string }>`select to_char(birth_date, 'YYYY-MM-DD') b from people where dni = '70000001'`.execute(db);
    expect(ok.rows[0]!.b).toBe("1985-06-15");
    const meet = await sql<{ d: string }>`select to_char(event_date, 'YYYY-MM-DD') d from meetings where source_event_key like '%2026-03-10%'`.execute(db);
    expect(meet.rows[0]!.d).toBe("2026-03-10");

    // Se reproduce el estado real de producción: todo un día antes.
    await sql`update people set birth_date = birth_date - 1 where origin = 'import' and dni in ('70000001', '70000002')`.execute(db);
    await sql`update meetings set event_date = event_date - 1 where origin = 'import'`.execute(db);
    const before = await sql<{ b: string }>`select to_char(birth_date, 'YYYY-MM-DD') b from people where dni = '70000001'`.execute(db);
    expect(before.rows[0]!.b).toBe("1985-06-14");

    const found = await findDateOffset(db, plan);
    expect(found.people).toEqual({ expected: 2, toFix: 2, alreadyCorrect: 0, other: 0 });
    expect(found.meetings.toFix).toBe(found.meetings.expected);
    const stillWrong = await sql<{ b: string }>`select to_char(birth_date, 'YYYY-MM-DD') b from people where dni = '70000001'`.execute(db);
    expect(stillWrong.rows[0]!.b).toBe("1985-06-14"); // el dry-run no escribió
  });

  it("aborta si la cantidad no es la esperada (no corrige de más ni de menos)", async () => {
    const db = await getDb();
    await expect(applyDateOffsetFix(db, plan, { createdBy: userId, expectPeople: 3 })).rejects.toThrow(/Se esperaban 3/);
    const still = await sql<{ b: string }>`select to_char(birth_date, 'YYYY-MM-DD') b from people where dni = '70000001'`.execute(db);
    expect(still.rows[0]!.b).toBe("1985-06-14");
  });

  it("corrige SOLO lo que está exactamente un día antes; una fila editada por otra razón no se toca; es idempotente", async () => {
    const db = await getDb();
    // 70000002 fue editada a mano a otra fecha distinta del desfase: no debe pisarse.
    await sql`update people set birth_date = '1991-05-05'::date where dni = '70000002'`.execute(db);
    const result = await applyDateOffsetFix(db, plan, { createdBy: userId, expectPeople: 1 });
    expect(result).toMatchObject({ fixedPeople: 1, people: { toFix: 1, other: 1 } });
    const rows = await sql<{ dni: string; b: string }>`select dni, to_char(birth_date, 'YYYY-MM-DD') b from people where dni in ('70000001', '70000002') order by dni`.execute(db);
    expect(rows.rows).toEqual([{ dni: "70000001", b: "1985-06-15" }, { dni: "70000002", b: "1991-05-05" }]);
    const meetings = await sql<{ k: string; d: string }>`select source_event_key k, to_char(event_date, 'YYYY-MM-DD') d from meetings where origin = 'import' order by 1`.execute(db);
    expect(meetings.rows.map((m) => m.d).sort()).toEqual(["2026-03-10", "2026-03-11"]);

    const again = await applyDateOffsetFix(db, plan, { createdBy: userId });
    expect(again).toMatchObject({ fixedPeople: 0, fixedMeetings: 0 });
  });

  it("exige un MASTER_GLOBAL activo como actor", async () => {
    const db = await getDb();
    await expect(applyDateOffsetFix(db, plan, { createdBy: randomUUID() })).rejects.toThrow(/no existe/);
  });
});
