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
const { planLegacyReferenceInteractions, applyLegacyReferenceInteractions, LEGACY_REFERENCE_DATE } = await import(
  "../../lib/interactions/legacy-reference-interactions.js"
);

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
    .values({ email: "legacy-ref-actor@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id, status: "active" } as never)
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

/** Provenance real (import_batches -> ... -> import_entity_links), mismo patrón que el importador. `applied=false`
 * simula un batch NO aplicado (para el caso "sin procedencia verificable"). `noRow` simula import_row_id nulo. */
async function makeProvenance(opts: { entityId: string; applied?: boolean; rawData?: string; noRow?: boolean }): Promise<string | null> {
  if (opts.noRow) return null;
  const db = await getDb();
  const file = await db
    .insertInto("import_files")
    .values({ original_name: "test.xlsx", content_hash: (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 64), created_by: userId } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  const batch = await db
    .insertInto("import_batches")
    .values({
      owner_organization_id: ownerOrgId,
      responsible_user_id: userId,
      created_by: userId,
      status: opts.applied === false ? "processing" : "applied",
      execution_mode: opts.applied === false ? "dry_run" : "apply",
      source_system: "gabriel-historical",
      plan_hash: opts.applied === false ? null : (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 64),
      applied_at: opts.applied === false ? null : new Date(),
      summary: opts.applied === false ? null : sql`'{}'::jsonb`,
    } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.insertInto("import_batch_files").values({ batch_id: batch.id, file_id: file.id, linked_by: userId }).execute();
  const row = await db
    .insertInto("import_rows")
    .values({ file_id: file.id, row_number: 1, row_hash: randomUUID().replace(/-/g, "").padEnd(64, "0"), raw_data: sql`${opts.rawData ?? "{}"}::jsonb`, status: "applied" } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.insertInto("import_entity_links").values({ import_row_id: row.id, entity_id: opts.entityId, entity_type: "meeting_participation", linked_by: userId }).execute();
  return row.id;
}

async function makePerson(dni: string) {
  const db = await getDb();
  return (
    await db
      .insertInto("people")
      .values({ first_name: "Persona", last_name: dni, dni, dni_source: "explicit", origin: "manual", created_by: userId, updated_by: userId } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

describe("legacy:reconcile-interactions", () => {
  let meetingUnknownId: string;
  let repMeetingId: string;
  let participationUnknown: string; // meeting_id set, schedule_precision='unknown'
  let participationCampaign: string; // meeting_id null, campaign_key set, con procedencia
  let participationNoProvenance: string; // misma campaña, sin import_row_id
  let participationStandardNoise: string; // participation_basis='standard', nunca debe tocarse

  beforeAll(async () => {
    const db = await getDb();

    // 1) Reunión con jornada conocida pero SIN fecha (operativo histórico registrado sin agenda usable).
    meetingUnknownId = (
      await db
        .insertInto("meetings")
        .values({
          name: "Operativo histórico sin fecha",
          owner_organization_id: ownerOrgId,
          meeting_type: "operativo_salud",
          origin: "import",
          schedule_precision: "unknown",
          organizer_user_id: userId,
          created_by: userId,
          status: "draft",
          source_event_key: "operativo_salud:historico-sin-fecha",
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const personUnknown = await makePerson("70100001");
    participationUnknown = (
      await db
        .insertInto("meeting_participations")
        .values({ meeting_id: meetingUnknownId, person_id: personUnknown, participation_kind: "participated", participation_basis: "legacy_initial_import", evidence: null } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const rowUnknown = await makeProvenance({ entityId: participationUnknown });
    await db.updateTable("meeting_participations").set({ import_row_id: rowUnknown }).where("id", "=", participationUnknown).execute();

    // 2) Campaña real (Teatro Colón), con una reunión "agenda" representativa ya cargada (jornada real conocida en
    //    otra fuente) y una participación de campaña sin jornada propia, con procedencia verificada.
    repMeetingId = (
      await db
        .insertInto("meetings")
        .values({
          name: "Oftalmología - Teatro Colón",
          owner_organization_id: ownerOrgId,
          meeting_type: "operativo_salud",
          origin: "import",
          schedule_precision: "date_only",
          event_date: sql`'2026-04-21'::date`,
          organizer_user_id: userId,
          created_by: userId,
          status: "draft",
          source_event_key: "ophthalmology:2026-04-21:teatro-colon",
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const personCampaign = await makePerson("70100002");
    participationCampaign = (
      await db
        .insertInto("meeting_participations")
        .values({ meeting_id: null, campaign_key: "ophthalmology:teatro-colon", person_id: personCampaign, participation_kind: "participated", participation_basis: "legacy_initial_import", evidence: null } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const rowCampaign = await makeProvenance({ entityId: participationCampaign });
    await db.updateTable("meeting_participations").set({ import_row_id: rowCampaign }).where("id", "=", participationCampaign).execute();

    // 3) Misma campaña, pero SIN procedencia verificable (import_row_id nulo): debe quedar como caso AMBIGUO, nunca
    //    procesarse, aunque su participation_basis diga legacy_initial_import.
    const personNoProvenance = await makePerson("70100003");
    participationNoProvenance = (
      await db
        .insertInto("meeting_participations")
        .values({ meeting_id: null, campaign_key: "ophthalmology:teatro-colon", person_id: personNoProvenance, participation_kind: "participated", participation_basis: "legacy_initial_import", evidence: null } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;

    // 4) Ruido: participación 'standard' (flujo normal, NO histórico) vinculada a una reunión sin fecha. Nunca debe
    //    ser candidata aunque su reunión también tenga schedule_precision='unknown'.
    const personStandard = await makePerson("70100004");
    participationStandardNoise = (
      await db
        .insertInto("meeting_participations")
        .values({ meeting_id: meetingUnknownId, person_id: personStandard, participation_kind: "invited", participation_basis: "standard", evidence: null } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  });

  it("dry-run: detecta las dos candidatas con procedencia y deja la sin-procedencia como ambigua", async () => {
    const db = await getDb();
    const plan = await planLegacyReferenceInteractions(db);
    expect(plan.totalCandidates).toBe(3); // unknown-precision + campaña con procedencia + campaña sin procedencia
    expect(plan.withMeetingUnknownPrecision).toBe(1);
    expect(plan.campaignWithoutMeeting).toBe(2);
    expect(plan.provenanceVerified).toBe(2);
    expect(plan.ambiguousNoProvenance).toBe(1);
    expect(plan.ambiguousNoRepresentativeMeeting).toBe(0);
    expect(plan.readyToCreate).toBe(2);
    expect(plan.activitiesAffected).toBe(1);
    expect(plan.campaignsAffected).toBe(1);
  });

  it("REGRESIÓN 2026-09-24: un import_row vinculado a DOS import_batches aplicados no duplica la candidata (hallazgo real de producción: reaplicación de gabriel-historical dejó el mismo archivo enlazado a 2 batches applied+apply)", async () => {
    const db = await getDb();

    // Mismo file_id que ya trae participationUnknown (vía su import_row_id), vinculado a un SEGUNDO batch
    // applied+apply — reproduce exactamente lo encontrado en producción (import_batch_files con 2 filas para el
    // mismo file_id, cada una apuntando a un import_batches 'applied').
    const existingRow = await db.selectFrom("meeting_participations").select("import_row_id").where("id", "=", participationUnknown).executeTakeFirstOrThrow();
    const existingFileId = (await db.selectFrom("import_rows").select("file_id").where("id", "=", existingRow.import_row_id!).executeTakeFirstOrThrow()).file_id;
    const secondBatch = await db
      .insertInto("import_batches")
      .values({
        owner_organization_id: ownerOrgId,
        responsible_user_id: userId,
        created_by: userId,
        status: "applied",
        execution_mode: "apply",
        source_system: "gabriel-historical",
        plan_hash: (randomUUID() + randomUUID()).replace(/-/g, "").slice(0, 64),
        applied_at: new Date(),
        summary: sql`'{}'::jsonb`,
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    await db.insertInto("import_batch_files").values({ batch_id: secondBatch.id, file_id: existingFileId, linked_by: userId }).execute();

    const plan = await planLegacyReferenceInteractions(db);
    // Mismos números que el test anterior: el segundo batch aplicado sobre el MISMO archivo no debe sumar una
    // segunda vez la candidata de meetingUnknownId ni cambiar readyToCreate/uniquePeople.
    expect(plan.totalCandidates).toBe(3);
    expect(plan.withMeetingUnknownPrecision).toBe(1);
    expect(plan.readyToCreate).toBe(2);
    expect(plan.uniquePeople).toBe(3);
  });

  it("dry-run no escribe nada", async () => {
    const before = { p: await count("meeting_participations"), i: await count("person_interactions") };
    await planLegacyReferenceInteractions(await getDb());
    expect({ p: await count("meeting_participations"), i: await count("person_interactions") }).toEqual(before);
  });

  it("rollback: una falla inyectada a mitad de camino revierte TODO (nada queda a medias)", async () => {
    const db = await getDb();
    const before = { p: await count("meeting_participations"), i: await count("person_interactions") };

    await sql`create or replace function test_fail_legacy_reference() returns trigger language plpgsql as $$ begin raise exception 'falla inyectada legacy-reference-interactions'; end $$`.execute(db);
    await sql`create trigger test_fail_legacy_reference before insert on person_interactions for each row execute function test_fail_legacy_reference()`.execute(db);
    try {
      await expect(applyLegacyReferenceInteractions(db, { actorUserId: userId })).rejects.toThrow(/falla inyectada/);
    } finally {
      await sql`drop trigger test_fail_legacy_reference on person_interactions`.execute(db);
      await sql`drop function test_fail_legacy_reference()`.execute(db);
    }

    // Nada quedó a medias: ni la primera interacción (de las 2 candidatas) se guardó.
    expect({ p: await count("meeting_participations"), i: await count("person_interactions") }).toEqual(before);
    const plan = await planLegacyReferenceInteractions(db);
    expect(plan.readyToCreate).toBe(2); // las 2 candidatas siguen pendientes, ninguna a medio crear
  });

  it("apply: crea SOLO las 2 interacciones listas, con date_basis='legacy_reference' y la fecha técnica en BA", async () => {
    const db = await getDb();
    const before = await count("person_interactions");
    const result = await applyLegacyReferenceInteractions(db, { actorUserId: userId });
    expect(result.interactionsCreated).toBe(2);
    expect(await count("person_interactions")).toBe(before + 2);

    const created = await db
      .selectFrom("person_interactions")
      .selectAll()
      .where("source_key", "in", [`meeting_participation:${participationUnknown}`, `meeting_participation:${participationCampaign}`])
      .execute();
    expect(created).toHaveLength(2);
    for (const row of created as any[]) {
      expect(row.date_basis).toBe("legacy_reference");
      expect(row.occurred_precision).toBe("date_only");
    }
    const meetingLinked = (created as any[]).find((r) => r.source_key.endsWith(participationUnknown));
    const campaignLinked = (created as any[]).find((r) => r.source_key.endsWith(participationCampaign));
    expect(meetingLinked.meeting_id).toBe(meetingUnknownId);
    expect(campaignLinked.meeting_id).toBeNull(); // nunca se inventa una jornada para la campaña
    expect(campaignLinked.subject).toContain("jornada no determinada");

    const checkDate = await sql<{ ba_date: string }>`select to_char(occurred_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD') as ba_date from person_interactions where id = ${meetingLinked.id}::uuid`.execute(db);
    expect(checkDate.rows[0]!.ba_date).toBe(LEGACY_REFERENCE_DATE);

    // La participación sin procedencia sigue sin interacción.
    const noProv = await db.selectFrom("person_interactions").selectAll().where("source_key", "=", `meeting_participation:${participationNoProvenance}`).execute();
    expect(noProv).toHaveLength(0);
    // El ruido 'standard' tampoco generó nada.
    const noise = await db.selectFrom("person_interactions").selectAll().where("source_key", "=", `meeting_participation:${participationStandardNoise}`).execute();
    expect(noise).toHaveLength(0);
  });

  it("es idempotente: una segunda corrida no crea nada nuevo", async () => {
    const db = await getDb();
    const before = { p: await count("meeting_participations"), i: await count("person_interactions") };
    const plan = await planLegacyReferenceInteractions(db);
    expect(plan.readyToCreate).toBe(0); // las 2 ya tienen interacción; la sin-procedencia sigue sin contar como lista
    const result = await applyLegacyReferenceInteractions(db, { actorUserId: userId });
    expect(result.interactionsCreated).toBe(0);
    expect({ p: await count("meeting_participations"), i: await count("person_interactions") }).toEqual(before);
  });

  it("una interacción real posterior prevalece: la persona pasa de solo-referencial a real, y el semáforo la sigue", async () => {
    const db = await getDb();
    const before = await planLegacyReferenceInteractions(db);
    expect(before.peopleWithOnlyReferentialLastInteraction).toBeGreaterThanOrEqual(2);

    // La persona de la campaña ahora tiene una interacción REAL reciente (p. ej. la reconciliación cargó su
    // jornada real más adelante, o tuvo una interacción nueva del CRM). La fecha 2026-01-01 nunca se sobrescribe:
    // se agrega una fila nueva, como en todo el resto del sistema (append-only).
    const personCampaign = await db.selectFrom("meeting_participations").select("person_id").where("id", "=", participationCampaign).executeTakeFirstOrThrow();
    const typeRow = await sql<{ id: string }>`select id from interaction_types where key='participation'`.execute(db);
    await db
      .insertInto("person_interactions")
      .values({
        person_id: personCampaign.person_id,
        owner_organization_id: ownerOrgId,
        occurred_at: new Date(),
        occurred_precision: "exact_datetime",
        date_basis: "actual",
        interaction_type_id: typeRow.rows[0]!.id,
        subject: "Interacción real posterior",
        status: "completed",
        created_by: userId,
      } as never)
      .execute();

    const after = await planLegacyReferenceInteractions(db);
    // La fila legacy_reference de esta persona sigue existiendo (no se tocó), pero su ÚLTIMA interacción ahora es real.
    const stillThere = await db.selectFrom("person_interactions").selectAll().where("source_key", "=", `meeting_participation:${participationCampaign}`).execute();
    expect(stillThere).toHaveLength(1);
    expect((stillThere[0] as any).date_basis).toBe("legacy_reference"); // no se reescribió
    expect(after.peopleWithOnlyReferentialLastInteraction).toBe(before.peopleWithOnlyReferentialLastInteraction - 1);
    expect(after.peopleWithRealLastInteraction).toBe(before.peopleWithRealLastInteraction + 1);

    const { getPersonTraffic } = await import("../../lib/people/queries.js");
    const actor = { id: userId, roleKey: "MASTER_GLOBAL" } as any;
    const trafficNow = await getPersonTraffic(actor, personCampaign.person_id);
    expect(trafficNow?.trafficLight).toBe("green");
    // La interacción REAL más reciente manda: la ficha ya no debe rotular la fecha como referencial.
    expect(trafficNow?.lastInteractionBasis).toBe("actual");
  });

  it("PUNTO 6 (ficha/grilla/export): una persona con SOLO una interacción referencial nunca se muestra como si tuviera una fecha real comprobada", async () => {
    const db = await getDb();
    const { getPersonTraffic, listPeoplePage } = await import("../../lib/people/queries.js");
    const { exportPeopleCsv } = await import("../../lib/people/export.js");
    const actor = { id: userId, roleKey: "MASTER_GLOBAL", permissions: new Set(["people.export"]) } as any;

    // participationUnknown (persona B) solo tiene la interacción referencial creada en el test de "apply" de arriba.
    const personUnknown = await db.selectFrom("meeting_participations").select("person_id").where("id", "=", participationUnknown).executeTakeFirstOrThrow();

    const traffic = await getPersonTraffic(actor, personUnknown.person_id);
    expect(traffic?.lastInteractionDate).toBe(LEGACY_REFERENCE_DATE);
    expect(traffic?.lastInteractionBasis).toBe("legacy_reference"); // NUNCA "actual" para esta persona

    const page = await listPeoplePage(actor, { status: "all" }, { field: "name", direction: "asc" }, 1, 200);
    const row = page.rows.find((r) => r.id === personUnknown.person_id);
    expect(row?.lastInteractionBasis).toBe("legacy_reference");

    const csv = await exportPeopleCsv(actor, { status: "all" }, { field: "name", direction: "asc" });
    expect(csv).toContain("referencial, no comprobada"); // el export tampoco la presenta como fecha real
  });

  it("una participación efectiva tiene como máximo UNA interacción activa: el índice único de source_key lo garantiza a nivel de base, no solo por ON CONFLICT de la app", async () => {
    const db = await getDb();
    const typeRow = await sql<{ id: string }>`select id from interaction_types where key='participation'`.execute(db);
    const personCampaign = await db.selectFrom("meeting_participations").select("person_id").where("id", "=", participationCampaign).executeTakeFirstOrThrow();
    // participationCampaign ya tiene su interacción (test "apply" de arriba). Un segundo INSERT manual con el MISMO
    // source_key (sin pasar por el ON CONFLICT DO NOTHING de la app) debe chocar contra el índice único de 0024.
    await expect(
      db
        .insertInto("person_interactions")
        .values({
          person_id: personCampaign.person_id,
          owner_organization_id: ownerOrgId,
          occurred_at: sql`('2026-01-01'::date::timestamp at time zone 'America/Argentina/Buenos_Aires')` as unknown as Date,
          occurred_precision: "date_only",
          date_basis: "legacy_reference",
          interaction_type_id: typeRow.rows[0]!.id,
          subject: "Intento de segunda interacción para la misma participación",
          status: "completed",
          created_by: userId,
          source_key: `meeting_participation:${participationCampaign}`,
        } as never)
        .execute()
    ).rejects.toThrow();
  });

  it("CHECK: rechaza date_basis='legacy_reference' con una precisión u ocurrencia distinta de la fecha técnica", async () => {
    const db = await getDb();
    const typeRow = await sql<{ id: string }>`select id from interaction_types where key='participation'`.execute(db);
    await expect(
      db
        .insertInto("person_interactions")
        .values({
          person_id: (await db.selectFrom("meeting_participations").select("person_id").where("id", "=", participationUnknown).executeTakeFirstOrThrow()).person_id,
          owner_organization_id: ownerOrgId,
          occurred_at: new Date(), // fecha real de "ahora", no la de referencia: debe rechazarse
          occurred_precision: "date_only",
          date_basis: "legacy_reference",
          interaction_type_id: typeRow.rows[0]!.id,
          subject: "Intento inválido",
          status: "completed",
          created_by: userId,
        } as never)
        .execute()
    ).rejects.toThrow();
  });

  it("TRIGGER: rechaza date_basis='legacy_reference' cuando la participación de origen no es legacy_initial_import", async () => {
    const db = await getDb();
    const typeRow = await sql<{ id: string }>`select id from interaction_types where key='participation'`.execute(db);
    await expect(
      db
        .insertInto("person_interactions")
        .values({
          person_id: (await db.selectFrom("meeting_participations").select("person_id").where("id", "=", participationStandardNoise).executeTakeFirstOrThrow()).person_id,
          owner_organization_id: ownerOrgId,
          occurred_at: sql`('2026-01-01'::date::timestamp at time zone 'America/Argentina/Buenos_Aires')` as unknown as Date,
          occurred_precision: "date_only",
          date_basis: "legacy_reference",
          interaction_type_id: typeRow.rows[0]!.id,
          subject: "Intento inválido: participación estándar",
          status: "completed",
          created_by: userId,
          source_key: `meeting_participation:${participationStandardNoise}`,
        } as never)
        .execute()
    ).rejects.toThrow(/legacy_initial_import/);
  });
});
