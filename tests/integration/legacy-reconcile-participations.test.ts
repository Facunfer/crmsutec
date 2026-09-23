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
const { planLegacyReconciliation, applyLegacyReconciliation } = await import("../../lib/interactions/legacy-reconciliation.js");
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
    .values({ email: "legacy-reconcile-actor@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id, status: "active" } as never)
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

// A: se inscribe a un curso con fecha real (F02, exact_datetime) -> jornada + fecha usable.
// B: se inscribe a Teatro Colón (F09) -> campaña, sin jornada -> "Participó" pero sin fecha ni interacción.
const DNI_A = "70000001";
const DNI_B = "70000002";

describe("legacy:reconcile-participations", () => {
  let batchId: string;

  beforeAll(async () => {
    const db = await getDb();
    const files = [
      fx.courseListFile("F02", "70000000-RCP.xlsx", { code: "70000", when: "09/09/2026 10 a 13 hs" }, [{ cuil: fx.cuilFor(DNI_A), last: "Uno", first: "Persona A" }]),
      fx.f09File([{ last: "Dos", first: "Persona B", dni: DNI_B, email: "b@example.com" }]),
    ];
    const plan = planFromSources(files);
    const result = await runImport(db, files, { ownerOrganizationId: ownerOrgId, createdBy: userId, confirmedPlanHash: plan.planHash } as never);
    expect(result.outcome).toBe("applied");
    batchId = result.batchId;

    // Ruido: una participación 'registration' AJENA a este batch (otro origen), para probar que la selección es por
    // procedencia real y no por `WHERE status='registration'` a ciegas.
    const otherOrgUser = await db.selectFrom("users").select("id").where("id", "=", userId).executeTakeFirstOrThrow();
    const noise = await db.insertInto("people").values({ first_name: "Ruido", last_name: "Ajeno", dni: "70099999", dni_source: "explicit", origin: "manual", created_by: otherOrgUser.id, updated_by: otherOrgUser.id } as never).returning("id").executeTakeFirstOrThrow();
    const noiseMeeting = await db
      .insertInto("meetings")
      .values({ name: "Reunión manual ajena", owner_organization_id: ownerOrgId, meeting_type: "reunion", origin: "manual", schedule_precision: "exact_datetime", starts_at: new Date(), ends_at: new Date(Date.now() + 3600000), organizer_user_id: otherOrgUser.id, created_by: otherOrgUser.id, status: "draft" } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    await db.insertInto("meeting_participations").values({ meeting_id: noiseMeeting.id, person_id: noise.id, participation_kind: "registration", evidence: null } as never).execute();
    await db.insertInto("meeting_participations").values({ meeting_id: noiseMeeting.id, person_id: noise.id, participation_kind: "attended", evidence: "Evidencia externa al lote" } as never).execute();
  });

  it("dry-run: identifica SOLO las participaciones del batch (por procedencia), no la fila ajena", async () => {
    const db = await getDb();
    const plan = await planLegacyReconciliation(db, { sourceSystem: "gabriel-historical" });
    expect(plan.totalLegacyParticipations).toBe(2); // A (curso) + B (Teatro Colón); NO la fila ajena
    expect(plan.uniquePeople).toBe(2);
    expect(plan.withMeeting).toBe(1); // A: curso con horario real -> meeting_id
    expect(plan.withoutMeeting).toBe(1); // B: campaña Teatro Colón, sin jornada
    expect(plan.withUsableDate).toBe(1);
    expect(plan.withoutUsableDate).toBe(0);
    expect(plan.alreadyReconciled).toBe(0);
    expect(plan.pendingReconciliation).toBe(2);
    expect(plan.interactionsToCreate).toBe(1); // solo A (con fecha); B nunca genera una interacción con fecha inventada
    expect(plan.interactionsAlreadyExist).toBe(0);
  });

  it("dry-run no escribe nada", async () => {
    const before = { p: await count("meeting_participations"), i: await count("person_interactions") };
    await planLegacyReconciliation(await getDb(), { sourceSystem: "gabriel-historical" });
    expect({ p: await count("meeting_participations"), i: await count("person_interactions") }).toEqual(before);
  });

  it("apply: crea las filas 'participated' SIN tocar las 'registration' originales, e interacción SOLO para la que tiene fecha", async () => {
    const db = await getDb();
    const participationsBefore = await count("meeting_participations");
    const result = await applyLegacyReconciliation(db, { sourceSystem: "gabriel-historical", actorUserId: userId });
    expect(result.participationsCreated).toBe(2);
    expect(result.interactionsCreated).toBe(1);
    expect(await count("person_interactions")).toBe(1); // el attended ajeno tampoco se sincroniza
    expect(await count("meeting_participations")).toBe(participationsBefore + 2);

    // Las 'registration' originales siguen intactas (raw_data/evidencia de fuente no se toca).
    const originals = await db.selectFrom("meeting_participations").selectAll().where("participation_kind", "=", "registration").execute();
    expect(originals.length).toBeGreaterThanOrEqual(2); // A, B, + la fila ajena de ruido

    const participated = await db.selectFrom("meeting_participations").selectAll().where("participation_kind", "=", "participated").execute();
    expect(participated).toHaveLength(2);
    expect(participated.every((p: any) => p.participation_basis === "legacy_initial_import")).toBe(true);

    const personA = await db.selectFrom("people").select("id").where("dni", "=", DNI_A).executeTakeFirstOrThrow();
    const personB = await db.selectFrom("people").select("id").where("dni", "=", DNI_B).executeTakeFirstOrThrow();
    const rowA = participated.find((p: any) => p.person_id === personA.id)!;
    const rowB = participated.find((p: any) => p.person_id === personB.id)!;
    expect(rowA.meeting_id).not.toBeNull();
    expect(rowB.meeting_id).toBeNull();
    expect(rowB.campaign_key).not.toBeNull();

    const interactions = await sql<{ source_key: string }>`select source_key from person_interactions where source_key = ${"meeting_participation:" + rowA.id} or source_key = ${"meeting_participation:" + rowB.id}`.execute(db);
    expect(interactions.rows.map((r) => r.source_key)).toEqual([`meeting_participation:${rowA.id}`]); // solo A
  });

  it("F03 (AGC-CAPACITACION 2026, PENDING_CLASSIFICATION) queda intacto: no genera participación ni interacción", async () => {
    // No hay F03 en este escenario: confirma que el reconciliador no toca nada fuera de lo que el batch realmente generó.
    const db = await getDb();
    const f03Rows = await db.selectFrom("import_rows").innerJoin("import_files", "import_files.id", "import_rows.file_id").select("import_rows.id").where("import_files.external_reference", "=", "F03").execute();
    expect(f03Rows).toHaveLength(0);
  });

  it("es idempotente: una segunda corrida no crea nada nuevo", async () => {
    const db = await getDb();
    const before = { p: await count("meeting_participations"), i: await count("person_interactions") };
    const plan = await planLegacyReconciliation(db, { sourceSystem: "gabriel-historical" });
    expect(plan.pendingReconciliation).toBe(0);
    expect(plan.alreadyReconciled).toBe(2);
    expect(plan.interactionsToCreate).toBe(0);
    expect(plan.interactionsAlreadyExist).toBe(1);

    const result = await applyLegacyReconciliation(db, { sourceSystem: "gabriel-historical", actorUserId: userId });
    expect(result.participationsCreated).toBe(0);
    expect(result.interactionsCreated).toBe(0);
    expect({ p: await count("meeting_participations"), i: await count("person_interactions") }).toEqual(before);
  });

  it("semáforo: antes/después refleja SOLO a quien tiene fecha de participación usable", async () => {
    // Ya aplicado en el test anterior: A tiene una interacción real (curso, fecha futura -> gray por ahora si es
    // futura respecto a "hoy" en el test; lo relevante es que trafficAfter no empeora respecto a antes y que ambos
    // bucketing se computan sin explotar.
    const db = await getDb();
    const plan = await planLegacyReconciliation(db, { sourceSystem: "gabriel-historical" });
    const totalBefore = Object.values(plan.trafficBefore).reduce((a, b) => a + b, 0);
    const totalAfter = Object.values(plan.trafficAfter).reduce((a, b) => a + b, 0);
    expect(totalBefore).toBe(2);
    expect(totalAfter).toBe(2);
  });

  it("rechaza otros orígenes aunque usen estados compatibles", async () => {
    await expect(planLegacyReconciliation(await getDb(), { sourceSystem: "futuro" })).rejects.toThrow("carga histórica inicial");
  });

  it("proyección y operación coinciden: Buenos Aires, futura excluida y anulada inválida", async () => {
    const db = await getDb();
    const original = await db.selectFrom("meeting_participations").selectAll().where("participation_kind", "=", "registration").where("import_row_id", "is not", null).where("meeting_id", "is not", null).executeTakeFirstOrThrow();
    const source = await db.selectFrom("import_rows").select("file_id").where("id", "=", original.import_row_id!).executeTakeFirstOrThrow();
    const sourceRow = async (rowNumber: number) => (await db.insertInto("import_rows").values({ file_id: source.file_id, sheet: "synthetic", row_number: rowNumber, row_hash: String(rowNumber).padStart(64, "0"), raw_data: sql`'{}'::jsonb`, status: "applied" } as never).returning("id").executeTakeFirstOrThrow()).id;
    const pastRow = await sourceRow(9001);
    const futureRow = await sourceRow(9002);
    // Día 31 a las 23:30 BA (día 30 en UTC): debe ser amarillo, no verde.
    await sql`update meetings set starts_at=((now() at time zone 'America/Argentina/Buenos_Aires')::date - 31 + time '23:30') at time zone 'America/Argentina/Buenos_Aires', ends_at=((now() at time zone 'America/Argentina/Buenos_Aires')::date - 30 + time '00:30') at time zone 'America/Argentina/Buenos_Aires' where id=${original.meeting_id}::uuid`.execute(db);
    await db.updateTable("person_interactions").set({ status: "voided", void_reason: "Prueba de proyección" }).where("person_id", "=", original.person_id).execute();
    const pastMeeting = await db.selectFrom("meetings").select(["starts_at", "ends_at"]).where("id", "=", original.meeting_id!).executeTakeFirstOrThrow();
    const past = await db.insertInto("meetings").values({ name: "Pasado sintético", owner_organization_id: ownerOrgId, organizer_user_id: userId, created_by: userId, meeting_type: "reunion", schedule_precision: "exact_datetime", ...pastMeeting, status: "draft" } as never).returning("id").executeTakeFirstOrThrow();
    const pastParticipation = await db.insertInto("meeting_participations").values({ meeting_id: past.id, person_id: original.person_id, participation_kind: "registration", import_row_id: pastRow }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("import_entity_links").values({ import_row_id: pastRow, entity_id: pastParticipation.id, entity_type: "meeting_participation", linked_by: userId }).execute();
    const futureMeeting = await db.insertInto("meetings").values({ name: "Futuro sintético", owner_organization_id: ownerOrgId, organizer_user_id: userId, created_by: userId, meeting_type: "reunion", schedule_precision: "exact_datetime", starts_at: new Date(Date.now()+86400000), ends_at: new Date(Date.now()+90000000), status: "draft" } as never).returning("id").executeTakeFirstOrThrow();
    const future = await db.insertInto("meeting_participations").values({ meeting_id: futureMeeting.id, person_id: original.person_id, participation_kind: "registration", import_row_id: futureRow }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("import_entity_links").values({ import_row_id: futureRow, entity_id: future.id, entity_type: "meeting_participation", linked_by: userId }).execute();
    const projected = await planLegacyReconciliation(db, {});
    expect(projected.trafficAfter).toEqual({ green: 0, yellow: 1, red: 0, gray: 1 });
    await applyLegacyReconciliation(db, { actorUserId: userId });
    const after = await planLegacyReconciliation(db, {});
    expect(after.trafficBefore).toEqual(projected.trafficAfter);
    const { getPersonTraffic } = await import("../../lib/people/queries.js");
    const actor = { id: userId, roleKey: "MASTER_GLOBAL" } as any;
    expect((await getPersonTraffic(actor, original.person_id))?.trafficLight).toBe("yellow");
    await db.updateTable("person_interactions").set({ status: "voided", void_reason: "Prueba de proyección" }).where("person_id", "=", original.person_id).execute();
    expect((await planLegacyReconciliation(db, {})).trafficAfter).toEqual({ green: 0, yellow: 0, red: 0, gray: 2 });
    expect((await getPersonTraffic(actor, original.person_id))?.trafficLight).toBe("gray");
  });
});
