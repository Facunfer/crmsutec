import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { runImport } = await import("../../lib/imports/gabriel/apply.js");
const { planFromSources } = await import("../../lib/imports/gabriel/plan-hash.js");
const { IdentityDecisionsError } = await import("../../lib/imports/gabriel/identity-decisions.js");
const { expectedInserts } = await import("../../scripts/import-gabriel.js");
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
  const user = await db
    .insertInto("users")
    .values({ email: "decisions-actor@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id, status: "active" } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  userId = user.id;
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const count = async (table: string) => {
  const db = await getDb();
  return Number(((await (db as any).selectFrom(table).select((eb: any) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()) as any).n);
};
const snapshot = async () => ({
  people: await count("people"),
  meetings: await count("meetings"),
  participations: await count("meeting_participations"),
  rows: await count("import_rows"),
  issues: await count("import_issues"),
  files: await count("import_files"),
  batches: await count("import_batches"),
});

const dec = (dni: string, decision: string, extra: Record<string, unknown> = {}) => ({ dni, decision, canonical_first_name: null, canonical_last_name: null, notes: null, ...extra });

/**
 * 4 identidades bloqueadas por nombres incompatibles (F09 vs F07) + 1 persona normal.
 * A y B se unifican; C se mantiene bloqueada; D queda para revisar. A además se inscribe a un curso (F02).
 */
function scenario(base: number) {
  const d = (n: number) => String(base + n);
  const [A, B, C, D, N] = [d(1), d(2), d(3), d(4), d(5)];
  const files = [
    fx.f09File([
      { last: "Vega", first: "Elena", dni: A, email: "a@example.com" },
      { last: "Paz", first: "Ana", dni: B, email: "b@example.com" },
      { last: "Rios", first: "Carla", dni: C, email: "c@example.com" },
      { last: "Sosa", first: "Diana", dni: D, email: "d@example.com" },
      { last: "Normal", first: "Nora", dni: N, email: "n@example.com" },
    ]),
    fx.f07File([
      { last: "Otro", first: "Nombre", cuil: fx.cuilFor(A) },
      { last: "Distinto", first: "Persona", cuil: fx.cuilFor(B) },
      { last: "Lopez", first: "Carmen", cuil: fx.cuilFor(C) },
      { last: "Gomez", first: "Dora", cuil: fx.cuilFor(D) },
    ]),
    fx.courseListFile("F02", `${base}-RCP.xlsx`, { code: String(base).slice(-5), when: "09/09/2026 10 a 13 hs" }, [{ cuil: fx.cuilFor(A), last: "Vega", first: "Elena M" }]),
  ];
  const rows = [
    dec(A, "MERGE_SAME_PERSON", { canonical_first_name: "Elena María", canonical_last_name: "Vega" }),
    dec(B, "MERGE_SAME_PERSON", { canonical_first_name: "Rosa", canonical_last_name: "Ledesma" }),
    dec(C, "KEEP_BLOCKED"),
    dec(D, "REVIEW_LATER", { notes: "ver con el afiliado" }),
  ];
  return { files, rows, A, B, C, D, N };
}

const apply = async (files: any[], rows: any[] | undefined, overrides: Record<string, unknown> = {}) => {
  const db = await getDb();
  return runImport(db, files, {
    ownerOrganizationId: ownerOrgId,
    createdBy: userId,
    confirmedPlanHash: planFromSources(files, { identityDecisionRows: rows }).planHash,
    identityDecisionRows: rows,
    identityDecisionSource: { fileName: "decisiones.xlsx", sha256: "a".repeat(64) },
    ...overrides,
  } as never);
};

describe("decisiones humanas en el plan", () => {
  const s = scenario(60000000);

  it("sin decisiones las 4 identidades están bloqueadas; con decisiones el plan_hash CAMBIA", () => {
    const without = planFromSources(s.files);
    const withDecisions = planFromSources(s.files, { identityDecisionRows: s.rows });
    expect(without.plan.people.blocked).toHaveLength(4);
    expect(withDecisions.planHash).not.toBe(without.planHash);
    expect(withDecisions.plan.people.blocked).toHaveLength(2);
    expect(withDecisions.plan.counts).toMatchObject({ identidades_canonicas_totales: 5, people_insert_reales: 3, personas_unificadas_por_decision_humana: 2 });
    // insertables + bloqueadas = identidades canónicas
    expect(withDecisions.plan.counts.people_insert_reales + withDecisions.plan.people.blocked.length).toBe(withDecisions.plan.counts.identidades_canonicas_totales);
  });

  it("MERGE usa el nombre canónico EXACTO (no el 'más completo'), una persona por DNI; KEEP/REVIEW no crean", () => {
    const { plan } = planFromSources(s.files, { identityDecisionRows: s.rows });
    const person = (dni: string) => plan.people.toCreate.find((p) => p.dni === dni);
    expect(person(s.A)).toMatchObject({ firstName: "Elena María", lastName: "Vega" });
    expect(person(s.B)).toMatchObject({ firstName: "Rosa", lastName: "Ledesma" });
    expect(person(s.C)).toBeUndefined();
    expect(person(s.D)).toBeUndefined();
    expect(plan.people.blocked.map((b) => b.decision).sort()).toEqual(["KEEP_BLOCKED", "REVIEW_LATER"]);
    expect(plan.identityDecisionResults.map((r) => [r.decision, r.outcome]).sort()).toEqual([
      ["KEEP_BLOCKED", "no_person_created"],
      ["MERGE_SAME_PERSON", "person_created"],
      ["MERGE_SAME_PERSON", "person_created"],
      ["REVIEW_LATER", "no_person_created"],
    ]);
    // La participación de A (F02) queda vinculada a la persona unificada.
    expect(plan.participations.some((p) => p.dni === s.A)).toBe(true);
    // Los bloqueados no reciben participaciones ni personDni.
    expect(plan.rows.filter((r) => r.normalizedDni === s.C || r.normalizedDni === s.D).every((r) => r.status === "in_review" && r.personDni === null)).toBe(true);
  });

  it("SOURCE_ERROR sigue soportado: no crea persona y deja las filas en revisión", () => {
    const rows = [s.rows[0]!, s.rows[1]!, dec(s.C, "SOURCE_ERROR"), s.rows[3]!];
    const { plan } = planFromSources(s.files, { identityDecisionRows: rows });
    expect(plan.people.toCreate.find((p) => p.dni === s.C)).toBeUndefined();
    expect(plan.people.blocked.map((b) => b.decision)).toContain("SOURCE_ERROR");
  });

  it("archivo inconsistente ABORTA el plan: DNI faltante, extra, repetido, valor inválido, MERGE sin nombres", () => {
    const [a, b, c, d] = s.rows as [any, any, any, any];
    const bad: any[][] = [
      [a, b, c], // falta D
      [a, b, c, d, dec(s.N, "KEEP_BLOCKED")], // N no está bloqueada
      [a, b, c, d, dec(s.C, "KEEP_BLOCKED")], // repetido
      [a, b, c, dec(s.D, "merge")], // valor inválido
      [dec(s.A, "MERGE_SAME_PERSON"), b, c, d], // sin nombres canónicos
    ];
    for (const rows of bad) expect(() => planFromSources(s.files, { identityDecisionRows: rows })).toThrow(IdentityDecisionsError);
  });

  it("cada decisión distinta cambia el plan_hash (la decisión es parte del JSON canónico)", () => {
    const base = planFromSources(s.files, { identityDecisionRows: s.rows }).planHash;
    const other = planFromSources(s.files, { identityDecisionRows: [s.rows[0]!, s.rows[1]!, dec(s.C, "REVIEW_LATER"), s.rows[3]!] }).planHash;
    const rename = planFromSources(s.files, { identityDecisionRows: [dec(s.A, "MERGE_SAME_PERSON", { canonical_first_name: "Elena Maria", canonical_last_name: "Vega" }), ...s.rows.slice(1)] }).planHash;
    expect(new Set([base, other, rename]).size).toBe(3);
  });
});

describe("apply con decisiones (PGlite)", () => {
  const s = scenario(61000000);

  it("aplicar SIN las decisiones cuando el hash aprobado las incluía aborta sin escribir", async () => {
    const before = await snapshot();
    const approved = planFromSources(s.files, { identityDecisionRows: s.rows }).planHash;
    await expect(apply(s.files, undefined, { confirmedPlanHash: approved })).rejects.toThrow(/hash del plan/);
    expect(await snapshot()).toEqual(before);
  });

  it("crea 3 personas (2 unificadas + 1 normal); las 2 bloqueadas no existen; sin duplicados de DNI", async () => {
    const before = await snapshot();
    const result = await apply(s.files, s.rows);
    expect(result.outcome).toBe("applied");
    expect(result.peopleCreated).toBe(3);
    const db = await getDb();
    const people = await db.selectFrom("people").select(["dni", "first_name", "last_name"]).where("dni", "in", [s.A, s.B, s.C, s.D, s.N]).orderBy("dni").execute();
    expect(people.map((p) => p.dni)).toEqual([s.A, s.B, s.N]);
    expect(people.find((p) => p.dni === s.A)).toMatchObject({ first_name: "Elena María", last_name: "Vega" });
    expect(people.find((p) => p.dni === s.B)).toMatchObject({ first_name: "Rosa", last_name: "Ledesma" });
    const dups = await sql`select dni from people where status <> 'merged' group by dni having count(*) > 1`.execute(db);
    expect(dups.rows).toHaveLength(0);
    expect((await snapshot()).people).toBe(before.people + 3);
  });

  it("todas las filas fuente del DNI unificado apuntan a la MISMA persona y conservan sus variantes originales", async () => {
    const db = await getDb();
    for (const dni of [s.A, s.B]) {
      const rows = await db.selectFrom("import_rows").select(["person_id", "raw_data", "status", "normalized_data"]).where("normalized_dni", "=", dni).execute();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(new Set(rows.map((r) => r.person_id)).size).toBe(1);
      expect(rows[0]!.person_id).not.toBeNull();
      expect(rows.every((r) => r.status === "applied")).toBe(true);
      expect(rows.every((r) => (r.normalized_data as any).identity_decision === "MERGE_SAME_PERSON")).toBe(true);
      // Trazabilidad: los nombres originales distintos siguen en raw_data.
      expect(new Set(rows.map((r) => JSON.stringify(r.raw_data))).size).toBe(rows.length);
    }
  });

  it("las identidades KEEP_BLOCKED / REVIEW_LATER quedan en staging/revisión, sin persona ni participación", async () => {
    const db = await getDb();
    for (const dni of [s.C, s.D]) {
      const rows = await db.selectFrom("import_rows").select(["person_id", "status"]).where("normalized_dni", "=", dni).execute();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((r) => r.person_id === null && r.status === "in_review")).toBe(true);
    }
  });

  it("el lote registra las decisiones (archivo, SHA-256, conteos, resultado) sin DNI ni nombres", async () => {
    const db = await getDb();
    const batch = (await db.selectFrom("import_batches").select("summary").where("plan_hash", "=", planFromSources(s.files, { identityDecisionRows: s.rows }).planHash).executeTakeFirstOrThrow()) as any;
    const d = batch.summary.identity_decisions;
    expect(d).toMatchObject({ total: 4, by_decision: { MERGE_SAME_PERSON: 2, KEEP_BLOCKED: 1, REVIEW_LATER: 1 }, source_file: { fileName: "decisiones.xlsx", sha256: "a".repeat(64) } });
    expect(d.results).toHaveLength(4);
    const text = JSON.stringify(batch.summary);
    for (const secret of [s.A, s.B, s.C, s.D, "Vega", "Ledesma", "Elena"]) expect(text).not.toContain(secret);
  });

  it("los INSERT esperados por tabla coinciden con lo realmente escrito", async () => {
    // Otro escenario limpio para poder contar solo lo de este apply.
    const t = scenario(62000000);
    const before = await snapshot();
    const beforeLinks = await count("import_entity_links");
    const beforeBatchFiles = await count("import_batch_files");
    const result = await apply(t.files, t.rows);
    const expected = expectedInserts(result.plan, t.files.length);
    const after = await snapshot();
    expect({
      import_files: after.files - before.files,
      import_batches: after.batches - before.batches,
      import_rows: after.rows - before.rows,
      import_issues: after.issues - before.issues,
      people: after.people - before.people,
      meetings: after.meetings - before.meetings,
      meeting_participations: after.participations - before.participations,
    }).toEqual({
      import_files: expected.import_files,
      import_batches: 1,
      import_rows: expected.import_rows,
      import_issues: expected.import_issues,
      people: expected.people,
      meetings: expected.meetings,
      meeting_participations: expected.meeting_participations,
    });
    expect((await count("import_entity_links")) - beforeLinks).toBe(expected.import_entity_links);
    expect((await count("import_batch_files")) - beforeBatchFiles).toBe(expected.import_batch_files);
    expect(expected.people).toBe(3);
  });

  // B tiene un nombre canónico incompatible con TODAS sus variantes de fuente: la segunda corrida no debe bloquearla.
  it("segunda corrida idéntica: noop_idempotent, 0 personas / reuniones / participaciones nuevas", async () => {
    const before = await snapshot();
    const second = await apply(s.files, s.rows);
    expect(second.outcome).toBe("noop_idempotent");
    expect([second.peopleCreated, second.meetingsCreated, second.participationsCreated, second.rowsInserted, second.issuesInserted]).toEqual([0, 0, 0, 0, 0]);
    const after = await snapshot();
    expect({ ...after, batches: before.batches }).toEqual(before);
  });

  it("una falla tardía revierte TODO, también con decisiones; sin la falla el mismo plan se aplica completo", async () => {
    const r = scenario(63000000);
    const db = await getDb();
    const before = await snapshot();
    await sql`create or replace function test_fail_participation() returns trigger language plpgsql as $$ begin raise exception 'falla inyectada'; end $$`.execute(db);
    await sql`create trigger test_fail_participation before insert on meeting_participations for each row execute function test_fail_participation()`.execute(db);
    try {
      await expect(apply(r.files, r.rows)).rejects.toThrow(/falla inyectada/);
    } finally {
      await sql`drop trigger test_fail_participation on meeting_participations`.execute(db);
    }
    expect(await snapshot()).toEqual(before);
    expect(await db.selectFrom("people").select("id").where("dni", "in", [r.A, r.B, r.C, r.D, r.N]).execute()).toHaveLength(0);
    const ok = await apply(r.files, r.rows);
    expect(ok.outcome).toBe("applied");
    expect(ok.peopleCreated).toBe(3);
  });
});
