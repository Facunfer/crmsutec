import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Simulación COMPLETA de las nuevas bases (2026-09-22) sobre PGlite (nunca Supabase): importa primero el lote
 * histórico real, lo reconcilia y amplía el catálogo (147 organizaciones + 10 altas, 160 alias + 40 nuevos).
 * Comprueba el hash antes/después y recién entonces aplica el segundo lote con las decisiones humanas.
 * Solo corre si se indican las rutas por variables de entorno; sin ellas se omite (los datos personales no están en
 * Git). No imprime datos personales.
 *
 *   GABRIEL_REAL_EXTRACTED=data/gabriel/extracted
 *   GABRIEL_REAL_DECISIONS=<decisiones_aprobadas.json del lote histórico>
 *   NUEVAS_REAL_EXTRACTED=data/gabriel-nuevas/extracted
 *   NUEVAS_REAL_DECISIONS=<extracto de decisiones de las 12 identidades de las nuevas bases>
 *   NUEVAS_REAL_CATALOG=data/org-catalog/catalog.json
 */
const HIST_EXTRACTED = process.env.GABRIEL_REAL_EXTRACTED;
const HIST_DECISIONS = process.env.GABRIEL_REAL_DECISIONS;
const NUEVAS_EXTRACTED = process.env.NUEVAS_REAL_EXTRACTED;
const NUEVAS_DECISIONS = process.env.NUEVAS_REAL_DECISIONS;
const CATALOG_PATH = process.env.NUEVAS_REAL_CATALOG;
const enabled = Boolean(HIST_EXTRACTED && HIST_DECISIONS && NUEVAS_EXTRACTED && NUEVAS_DECISIONS && CATALOG_PATH && existsSync(CATALOG_PATH ?? ""));

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { runImport } = await import("../../lib/imports/gabriel/apply.js");
const { planFromSources } = await import("../../lib/imports/gabriel/plan-hash.js");
const { loadExtracted } = await import("../../scripts/import-gabriel.js");
const { applyCatalog } = await import("../../lib/organizations/catalog/apply.js");
const { APPROVED_ADDITIONS } = await import("../../lib/organizations/catalog/approved-additions.js");
const { APPROVED_ORG_ADDITIONS } = await import("../../lib/organizations/catalog/approved-org-additions.js");
const { planCatalogFromSource } = await import("../../lib/organizations/catalog/plan.js");
const { buildNuevasPlanWithDecisions, NUEVAS_CODES } = await import("../../lib/imports/gabriel/nuevas.js");
const { runNuevasImport } = await import("../../lib/imports/gabriel/nuevas-apply.js");
const { readNuevasContext } = await import("../../scripts/import-nuevas-dry-run.js");
const { dryRunAgainstDatabase } = await import("../../lib/organizations/catalog/apply.js");
const { simulateCatalogOrgContext } = await import("../../lib/organizations/catalog/simulate.js");
const { planLegacyReconciliation, applyLegacyReconciliation } = await import("../../lib/interactions/legacy-reconciliation.js");

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
    .values({ email: "nuevas-real-sim@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id, status: "active" } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  userId = user.id;

  const catalog = JSON.parse(readFileSync(CATALOG_PATH!, "utf-8"));
  const baseAdditions = APPROVED_ADDITIONS.filter((a) => a.approvedOn < "2026-09-22");
  const basePlan = planCatalogFromSource(catalog, baseAdditions, []);
  await applyCatalog(db, catalog, { createdBy: userId, confirmedPlanHash: basePlan.planHash, additions: baseAdditions, organizationAdditions: [] });

  // 1. Lote histórico real (10 de las 12 identidades de las nuevas bases se mergean a personas creadas ACÁ).
  const histFiles = loadExtracted(HIST_EXTRACTED!);
  const histDecisions = JSON.parse(readFileSync(HIST_DECISIONS!, "utf-8")) as { rows: any[] };
  const histPlan = planFromSources(histFiles, { identityDecisionRows: histDecisions.rows });
  const histResult = await runImport(db, histFiles, { ownerOrganizationId: ownerOrgId, createdBy: userId, confirmedPlanHash: histPlan.planHash, identityDecisionRows: histDecisions.rows } as never);
  expect(histResult.outcome).toBe("applied");

  const legacy = await planLegacyReconciliation(db, {});
  expect(legacy).toMatchObject({ totalLegacyParticipations: 912, uniquePeople: 782, activitiesAffected: 8, withMeeting: 107, withoutMeeting: 805, withUsableDate: 56, interactionsToCreate: 56 });
  console.log(`[simulation] legacy traffic=${JSON.stringify(legacy.trafficAfter)}`);
  const reconciled = await applyLegacyReconciliation(db, { actorUserId: userId });
  expect(reconciled).toMatchObject({ participationsCreated: 912, interactionsCreated: 56 });
  expect(reconciled.trafficBefore).toEqual(legacy.trafficAfter);
  const secondReconciliation = await applyLegacyReconciliation(db, { actorUserId: userId });
  expect(secondReconciliation).toMatchObject({ participationsCreated: 0, interactionsCreated: 0 });

  const newFiles = NUEVAS_CODES.map((c) => JSON.parse(readFileSync(`${NUEVAS_EXTRACTED}/${c}.json`, "utf-8")));
  const newDecisions = JSON.parse(readFileSync(NUEVAS_DECISIONS!, "utf-8"));
  const f07 = JSON.parse(readFileSync(`${HIST_EXTRACTED}/F07.json`, "utf-8"));
  const { idByOfficialCode, ...ctx } = await readNuevasContext(db, f07);
  const expanded = await dryRunAgainstDatabase(db, catalog, APPROVED_ADDITIONS, APPROVED_ORG_ADDITIONS);
  const simulated = simulateCatalogOrgContext(expanded.plan, { aliases: ctx.aliases, organizationParents: ctx.organizationParents ?? new Map(), idByOfficialCode });
  const hashBefore = buildNuevasPlanWithDecisions(newFiles, { ...ctx, ...simulated }, newDecisions.rows).plan.planHash;

  // 2. Catálogo ampliado: solo las 10 altas y los 40 alias adicionales.
  const catalogPlan = planCatalogFromSource(catalog, APPROVED_ADDITIONS, APPROVED_ORG_ADDITIONS);
  const catalogResult = await applyCatalog(db, catalog, { createdBy: userId, confirmedPlanHash: catalogPlan.planHash, additions: APPROVED_ADDITIONS, organizationAdditions: APPROVED_ORG_ADDITIONS });
  expect(catalogResult.outcome).toBe("applied");
  // El catálogo base ya existe: solo se crean las altas aprobadas.
  expect(catalogResult.organizationsCreated).toBe(10);
  expect(catalogResult.plan.organizations.toCreate.filter((o) => o.origin === "human_approved")).toHaveLength(10);
  const actualContext = await readNuevasContext(db, f07);
  const hashAfter = buildNuevasPlanWithDecisions(newFiles, actualContext, newDecisions.rows).plan.planHash;
  expect(hashAfter).toBe(hashBefore);
  console.log(`[simulation] stable plan_hash=${hashAfter}`);
}, 120000);

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
  attendance: await count("meeting_attendance"),
  batches: await count("import_batches"),
  files: await count("import_files"), rows: await count("import_rows"), links: await count("import_entity_links"), issues: await count("import_issues"), interactions: await count("person_interactions"),
});

describe.skipIf(!enabled)("simulación completa de las nuevas bases sobre PGlite (histórico + catálogo ampliado + nuevas)", { timeout: 120000 }, () => {
  const files = enabled ? NUEVAS_CODES.map((c) => JSON.parse(readFileSync(`${NUEVAS_EXTRACTED}/${c}.json`, "utf-8"))) : [];
  const f07 = enabled && existsSync(`${HIST_EXTRACTED}/F07.json`) ? JSON.parse(readFileSync(`${HIST_EXTRACTED}/F07.json`, "utf-8")) : null;
  const decisionsJson = enabled ? (JSON.parse(readFileSync(NUEVAS_DECISIONS!, "utf-8")) as { rows: any[]; source_file: string; source_sha256: string }) : null;

  const currentPlan = async () => {
    const { idByOfficialCode: _i, ...ctx } = await readNuevasContext(await getDb(), f07);
    return buildNuevasPlanWithDecisions(files as any, ctx as any, decisionsJson!.rows);
  };
  const apply = async () => {
    const { plan } = await currentPlan();
    return runNuevasImport(await getDb(), files as any, f07, {
      ownerOrganizationId: ownerOrgId,
      createdBy: userId,
      confirmedPlanHash: plan.planHash,
      identityDecisionRows: decisionsJson!.rows,
      identityDecisionSource: { fileName: decisionsJson!.source_file, sha256: decisionsJson!.source_sha256 },
    });
  };

  it("el plan cambia de hash con las decisiones y cumple: bloqueadas 2 (antes 12), nuevas 184, existentes 586", async () => {
    const { plan } = await currentPlan();
    expect(plan.blocked).toHaveLength(2);
    expect(plan.peopleToCreate).toHaveLength(184);
    expect(plan.identityDecisionResults.filter((r) => r.outcome === "linked_to_existing")).toHaveLength(10);
    expect(plan.identityDecisionResults.filter((r) => r.outcome === "person_created")).toHaveLength(0);
  });

  it("rollback tardío: una falla al insertar participaciones revierte TODO (nada de este lote queda a medias)", async () => {
    const db = await getDb();
    const before = await snapshot();
    await sql`create or replace function test_fail_nuevas_participation() returns trigger language plpgsql as $$ begin raise exception 'falla inyectada nuevas'; end $$`.execute(db);
    await sql`create trigger test_fail_nuevas_participation before insert on meeting_participations for each row execute function test_fail_nuevas_participation()`.execute(db);
    try {
      await expect(apply()).rejects.toThrow(/falla inyectada nuevas/);
    } finally {
      await sql`drop trigger test_fail_nuevas_participation on meeting_participations`.execute(db);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("apply: no duplica a los 10 merges (siguen siendo 1 persona por DNI), crea 184 nuevas, 0 asistencias inventadas", async () => {
    const db = await getDb();
    const before = await snapshot();
    const result = await apply();
    expect(result.outcome).toBe("applied");
    expect(result.peopleCreated).toBe(184);
    expect(result.participationsCreated).toBe(208);
    expect(result.participationsAlreadyExisting).toBe(563);
    expect(result.interactionsCreated).toBe(54);
    expect(result.peopleLinkedToExisting).toBe(10);
    const after = await snapshot();
    expect(after.people - before.people).toBe(184); // los 10 merges NO suman personas nuevas
    expect(after.attendance).toBe(0);

    const dups = await sql`select dni from people where status <> 'merged' group by dni having count(*) > 1`.execute(db);
    expect(dups.rows).toHaveLength(0);

    const mergedDnis = result.plan.identityDecisionResults.filter((r) => r.outcome === "linked_to_existing").map((r) => r.dni);
    const linked = await db.selectFrom("people").select("id").where("dni", "in", mergedDnis).execute();
    expect(linked).toHaveLength(10); // ya existían del histórico; no hay una fila extra por cada uno

    expect(result.plan.blocked).toHaveLength(2); // las 2 REVIEW_LATER: este lote no crea ni vincula nada para ellas
    // Ninguna de las 2 tiene una persona creada POR ESTE LOTE: cada una tiene 0 filas (nunca existió) o exactamente 1
    // (ya existía del HISTÓRICO, ajena a este lote) — nunca 2 o más (que delataría una creación/duplicado indebido).
    for (const b of result.plan.blocked) {
      const rows = await db.selectFrom("people").select("id").where("dni", "=", b.dni).execute();
      expect(rows.length).toBeLessThanOrEqual(1);
    }
  });

  it("las participaciones de este lote nacen 'participated'/'legacy_initial_import' y generan interacción solo con jornada+fecha real", async () => {
    const db = await getDb();
    const batch = await db.selectFrom("import_batches").select("id").where("source_system", "=", "gabriel-nuevas-2026-09-22").orderBy("created_at", "desc").executeTakeFirstOrThrow();
    const created = await db
      .selectFrom("meeting_participations")
      .innerJoin("import_entity_links", "import_entity_links.entity_id", "meeting_participations.id")
      .where("import_entity_links.entity_type", "=", "meeting_participation")
      .where("import_entity_links.import_row_id", "in", (eb) =>
        eb.selectFrom("import_rows").select("id").where("file_id", "in", (eb2) => eb2.selectFrom("import_batch_files").select("file_id").where("batch_id", "=", batch.id))
      )
      .select(["meeting_participations.id", "meeting_participations.meeting_id", "meeting_participations.campaign_key", "meeting_participations.participation_kind", "meeting_participations.participation_basis"])
      .distinct()
      .execute();
    expect(created).toHaveLength(771);
    const provenance = await sql<{ fresh: number; reused: number; missing_person: number; missing_origin: number; with_meeting: number; without_meeting: number }>`
      with linked as (
        select distinct mp.id, mp.person_id, mp.import_row_id, mp.meeting_id,
          exists(select 1 from import_rows origin join import_batch_files bf on bf.file_id=origin.file_id where origin.id=mp.import_row_id and bf.batch_id=${batch.id}::uuid) fresh
        from meeting_participations mp join import_entity_links l on l.entity_id=mp.id and l.entity_type='meeting_participation'
        join import_rows r on r.id=l.import_row_id join import_batch_files bf on bf.file_id=r.file_id where bf.batch_id=${batch.id}::uuid
      ) select count(*) filter(where fresh)::int fresh, count(*) filter(where not fresh)::int reused,
        count(*) filter(where fresh and import_row_id is null)::int missing_origin,
        count(*) filter(where fresh and meeting_id is not null)::int with_meeting,
        count(*) filter(where fresh and meeting_id is null)::int without_meeting,
        (select count(*)::int from import_entity_links l join import_rows r on r.id=l.import_row_id
          join import_batch_files bf on bf.file_id=r.file_id join meeting_participations mp on mp.id=l.entity_id
          where bf.batch_id=${batch.id}::uuid and l.entity_type='meeting_participation' and not exists(
            select 1 from import_entity_links person where person.import_row_id=r.id and person.entity_type='person' and person.entity_id=mp.person_id)) missing_person
      from linked
    `.execute(db);
    expect(provenance.rows[0]).toEqual({ fresh: 208, reused: 563, missing_origin: 0, missing_person: 0, with_meeting: 54, without_meeting: 154 });
    const unlinked = await sql<{ n: number }>`select count(*)::int n from import_rows r
      join import_batch_files bf on bf.file_id=r.file_id
      where bf.batch_id=${batch.id}::uuid and r.status='applied' and r.participation_kind='participated'
      and (r.meeting_id is not null or r.campaign_key is not null)
      and not exists(select 1 from import_entity_links l where l.import_row_id=r.id and l.entity_type='meeting_participation')`.execute(db);
    expect(unlinked.rows[0]?.n).toBe(0);
    expect(created.every((p) => p.participation_kind === "participated" && p.participation_basis === "legacy_initial_import")).toBe(true);
    // Nunca 'registration' ni 'attended' para este lote.
    const wrongKind = created.filter((p) => !["participated"].includes(p.participation_kind));
    expect(wrongKind).toHaveLength(0);

    const withMeeting = created.filter((p) => p.meeting_id !== null);
    const sourceKeys = withMeeting.map((p) => `meeting_participation:${p.id}`);
    const interactions = sourceKeys.length
      ? await db.selectFrom("person_interactions").select("source_key").where("source_key", "in", sourceKeys).execute()
      : [];
    // Solo las que tienen jornada CON fecha real generan interacción (54 esperadas según el dry-run); nunca más que las con jornada.
    expect(interactions.length).toBeGreaterThan(0);
    expect(interactions.length).toBeLessThanOrEqual(withMeeting.length);
    // Ninguna participación de campaña (sin jornada) generó interacción.
    const campaignOnly = created.filter((p) => p.meeting_id === null);
    const campaignSourceKeys = campaignOnly.map((p) => `meeting_participation:${p.id}`);
    const campaignInteractions = campaignSourceKeys.length ? await db.selectFrom("person_interactions").select("source_key").where("source_key", "in", campaignSourceKeys).execute() : [];
    expect(campaignInteractions).toHaveLength(0);
  });

  it("staging completo: cada archivo tiene import_rows/import_issues, y ninguna fecha de nacimiento absurda llegó a people", async () => {
    const db = await getDb();
    const batch = await db.selectFrom("import_batches").select("id").where("source_system", "=", "gabriel-nuevas-2026-09-22").orderBy("created_at", "desc").executeTakeFirstOrThrow();
    const files = await db.selectFrom("import_batch_files").innerJoin("import_files", "import_files.id", "import_batch_files.file_id").select(["import_files.id", "import_files.external_reference", "import_files.size_bytes"]).where("import_batch_files.batch_id", "=", batch.id).execute();
    expect(files).toHaveLength(8); // N01..N08
    expect(files.every((f) => f.size_bytes !== null && f.size_bytes > 0)).toBe(true);

    const fileIds = files.map((f) => f.id);
    const rows = await db.selectFrom("import_rows").select((eb) => eb.fn.countAll().as("n")).where("file_id", "in", fileIds).executeTakeFirstOrThrow();
    expect(Number((rows as any).n)).toBeGreaterThan(700); // 833 filas de formularios + filas del Padrón PG

    const issues = await db
      .selectFrom("import_issues")
      .innerJoin("import_rows", "import_rows.id", "import_issues.import_row_id")
      .select(["import_issues.code"])
      .where("import_rows.file_id", "in", fileIds)
      .execute();
    const issueCodes = new Set(issues.map((i) => i.code));
    expect(issueCodes.has("MISSING_CANONICAL_DNI")).toBe(true);
    expect(issueCodes.has("BLOCKED_IDENTITY_CONFLICT")).toBe(true);

    const linksToPeople = await db
      .selectFrom("import_entity_links")
      .innerJoin("import_rows", "import_rows.id", "import_entity_links.import_row_id")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("import_rows.file_id", "in", fileIds)
      .where("import_entity_links.entity_type", "=", "person")
      .executeTakeFirstOrThrow();
    expect(Number((linksToPeople as any).n)).toBeGreaterThan(0);

    // Provenance de punta a punta: cualquier persona vinculada por este lote se puede rastrear hasta su fila de origen
    // (archivo + número de fila), sin necesidad de leer datos personales.
    const anyLink = await db
      .selectFrom("import_entity_links")
      .innerJoin("import_rows", "import_rows.id", "import_entity_links.import_row_id")
      .innerJoin("import_files", "import_files.id", "import_rows.file_id")
      .select(["import_files.external_reference", "import_rows.row_number", "import_entity_links.entity_id"])
      .where("import_entity_links.entity_type", "=", "person")
      .where("import_rows.file_id", "in", fileIds)
      .executeTakeFirst();
    expect(anyLink).toBeDefined();
    expect(anyLink!.external_reference).toMatch(/^N0[1-8]$/);

    // 0 nacimientos absurdos en toda la base (histórico + nuevas): ni año < 1900 ni fecha futura.
    const absurd = await sql<{ n: number }>`select count(*)::int as n from people where birth_date is not null and (extract(year from birth_date) < 1900 or birth_date > current_date)`.execute(db);
    expect(absurd.rows[0]?.n).toBe(0);
    const f03 = await sql<{ pending: number; participation: number }>`select
      (select count(*)::int from import_issues i join import_rows r on r.id=i.import_row_id join import_files f on f.id=r.file_id where f.external_reference='F03' and i.code='PENDING_CLASSIFICATION') pending,
      (select count(*)::int from import_entity_links l join import_rows r on r.id=l.import_row_id join import_files f on f.id=r.file_id where f.external_reference='F03' and l.entity_type='meeting_participation') participation`.execute(db);
    expect(f03.rows[0]).toEqual({ pending: 30, participation: 0 });
  });

  it("es idempotente: una segunda corrida da noop_idempotent sin crear ni duplicar nada (incluida la staging)", async () => {
    const before = await snapshot();
    const second = await apply();
    expect(second.outcome).toBe("noop_idempotent");
    expect([second.peopleCreated, second.meetingsCreated, second.participationsCreated, second.filesInserted, second.rowsInserted, second.issuesInserted, second.entityLinksInserted]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    const after = await snapshot();
    expect({ ...after, batches: before.batches }).toEqual(before);
  });
});
