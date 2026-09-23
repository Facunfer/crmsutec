import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Simulación del apply COMPLETO con los datos reales extraídos y las decisiones humanas aprobadas, sobre PGlite
 * (nunca Supabase). Solo corre si se indican las rutas por variables de entorno; sin ellas se omite (los datos
 * personales no están en Git). No imprime datos personales.
 *
 *   GABRIEL_REAL_EXTRACTED=data/gabriel/extracted
 *   GABRIEL_REAL_DECISIONS=<decisiones_aprobadas.json>
 */
const EXTRACTED = process.env.GABRIEL_REAL_EXTRACTED;
const DECISIONS = process.env.GABRIEL_REAL_DECISIONS;
const enabled = Boolean(EXTRACTED && DECISIONS);

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { runImport } = await import("../../lib/imports/gabriel/apply.js");
const { planFromSources } = await import("../../lib/imports/gabriel/plan-hash.js");
const { loadExtracted, expectedInserts } = await import("../../scripts/import-gabriel.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
let ownerOrgId: string;
let userId: string;

beforeAll(async () => {
  if (!enabled) return;
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  ownerOrgId = await createTestOrganization();
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({ email: "real-sim@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id, status: "active" } as never)
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
  links: await count("import_entity_links"),
  attendance: await count("meeting_attendance"),
});

describe.skipIf(!enabled)("simulación del apply completo con datos reales sobre PGlite", { timeout: 120000 }, () => {
  const files = enabled ? loadExtracted(EXTRACTED!) : [];
  const decisionsJson = enabled ? (JSON.parse(readFileSync(DECISIONS!, "utf-8")) as { rows: any[]; source_file: string; source_sha256: string }) : null;
  const rows = decisionsJson?.rows ?? [];
  const approved = () => planFromSources(files, { identityDecisionRows: rows });
  const apply = async () =>
    runImport(await getDb(), files, {
      ownerOrganizationId: ownerOrgId,
      createdBy: userId,
      confirmedPlanHash: approved().planHash,
      identityDecisionRows: rows,
      identityDecisionSource: { fileName: decisionsJson!.source_file, sha256: decisionsJson!.source_sha256 },
    } as never);

  it("el plan cambia de hash respecto del sin decisiones y cumple las igualdades esperadas", () => {
    const without = planFromSources(files);
    const withDecisions = approved();
    expect(withDecisions.planHash).not.toBe(without.planHash);
    const c = withDecisions.plan.counts;
    expect(c.identidades_canonicas_totales).toBe(2014);
    expect(c.people_insert_reales).toBe(2011);
    expect(withDecisions.plan.people.blocked).toHaveLength(3);
    expect(c.people_insert_reales + withDecisions.plan.people.blocked.length).toBe(c.identidades_canonicas_totales);
    expect(c.personas_unificadas_por_decision_humana).toBe(11);
    expect(withDecisions.plan.pendingClassificationRows).toHaveLength(30);
  });

  it("rollback tardío con datos reales: una falla inyectada al insertar participaciones revierte TODO", async () => {
    const db = await getDb();
    const before = await snapshot();
    expect(before.people).toBe(0);
    await sql`create or replace function test_fail_participation() returns trigger language plpgsql as $$ begin raise exception 'falla inyectada'; end $$`.execute(db);
    await sql`create trigger test_fail_participation before insert on meeting_participations for each row execute function test_fail_participation()`.execute(db);
    try {
      await expect(apply()).rejects.toThrow(/falla inyectada/);
    } finally {
      await sql`drop trigger test_fail_participation on meeting_participations`.execute(db);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("apply: 2.011 personas (11 unificadas = 11 personas, no 22), 3 bloqueadas sin persona, sin duplicados de DNI", async () => {
    const before = await snapshot();
    const result = await apply();
    expect(result.outcome).toBe("applied");
    expect(result.peopleCreated).toBe(2011);
    const after = await snapshot();
    expect(after.people - before.people).toBe(2011);
    expect(after.attendance).toBe(0);

    const db = await getDb();
    const plan = result.plan;
    const merged = plan.identityDecisionResults.filter((r) => r.outcome === "person_created");
    expect(merged).toHaveLength(11);
    // Cada DNI unificado tiene exactamente UNA persona y todas sus filas fuente apuntan a ella.
    const mergedDnis = plan.people.toCreate.filter((p) => plan.rows.some((r) => r.normalizedDni === p.dni && r.identityDecision === "MERGE_SAME_PERSON")).map((p) => p.dni);
    expect(mergedDnis).toHaveLength(11);
    const stored = await db.selectFrom("people").select(["dni"]).where("dni", "in", mergedDnis).execute();
    expect(stored).toHaveLength(11);
    const linked = await db.selectFrom("import_rows").select(["normalized_dni", "person_id"]).where("normalized_dni", "in", mergedDnis).execute();
    expect(linked.length).toBeGreaterThan(11);
    expect(linked.every((r) => r.person_id !== null)).toBe(true);
    expect(new Set(linked.map((r) => r.person_id)).size).toBe(11);

    // Los 3 bloqueados: sin persona, filas en revisión.
    const blockedDnis = plan.rows.filter((r) => r.identityDecision && r.identityDecision !== "MERGE_SAME_PERSON").map((r) => r.normalizedDni!);
    const blocked = [...new Set(blockedDnis)];
    expect(blocked).toHaveLength(3);
    expect(await db.selectFrom("people").select("id").where("dni", "in", blocked).execute()).toHaveLength(0);
    const blockedRows = await db.selectFrom("import_rows").select(["person_id", "status"]).where("normalized_dni", "in", blocked).execute();
    expect(blockedRows.every((r) => r.person_id === null && r.status === "in_review")).toBe(true);

    const dups = await sql`select dni from people where status <> 'merged' group by dni having count(*) > 1`.execute(db);
    expect(dups.rows).toHaveLength(0);

    // INSERT reales = INSERT esperados (por tabla).
    const expected = expectedInserts(plan, files.length);
    expect(after.files - before.files).toBe(expected.import_files);
    expect(after.rows - before.rows).toBe(expected.import_rows);
    expect(after.issues - before.issues).toBe(expected.import_issues);
    expect(after.meetings - before.meetings).toBe(expected.meetings);
    expect(after.participations - before.participations).toBe(expected.meeting_participations);
    expect(after.links - before.links).toBe(expected.import_entity_links);
    expect(after.batches - before.batches).toBe(1);
    // Sin datos personales en el resumen del lote.
    const summaryText = JSON.stringify(result.summary);
    for (const p of plan.people.toCreate.slice(0, 200)) expect(summaryText).not.toContain(p.dni);
    console.log(JSON.stringify({ apply_pglite: { people: expected.people, ...Object.fromEntries(Object.entries(expected)) } }));
  });

  it("segunda corrida idéntica: noop_idempotent y nada de negocio nuevo", async () => {
    const before = await snapshot();
    const second = await apply();
    expect(second.outcome).toBe("noop_idempotent");
    expect([second.peopleCreated, second.meetingsCreated, second.participationsCreated, second.rowsInserted, second.issuesInserted]).toEqual([0, 0, 0, 0, 0]);
    const after = await snapshot();
    expect({ ...after, batches: before.batches }).toEqual(before);
  });
});
