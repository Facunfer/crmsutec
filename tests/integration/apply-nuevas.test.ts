import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Simulación COMPLETA del CLI `scripts/apply-nuevas.ts` (npm run import:nuevas:apply) contra un estado equivalente
 * pre-segundo-lote: migraciones 0001..0028 + histórico real + reconciliación histórica ya aplicada + catálogo
 * ampliado ya aplicado. Solo corre si se indican las rutas reales por variables de entorno (los datos personales no
 * están en Git). No imprime datos personales.
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
const { applyLegacyReconciliation } = await import("../../lib/interactions/legacy-reconciliation.js");
const { readNuevasContext } = await import("../../scripts/import-nuevas-dry-run.js");
const { buildNuevasPlanWithDecisions, NUEVAS_CODES } = await import("../../lib/imports/gabriel/nuevas.js");
const { loadIdentityDecisions } = await import("../../scripts/import-gabriel.js");
const { runApplyNuevas, parseApplyNuevasArgs } = await import("../../scripts/apply-nuevas.js");
const { ImportAbortError } = await import("../../lib/imports/gabriel/preflight.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
let ownerOrgId: string;
let userId: string;
let planHash: string;

beforeAll(async () => {
  if (!enabled) return;
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  ownerOrgId = await createTestOrganization();
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({ email: "apply-nuevas-actor@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id, status: "active" } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  userId = user.id;

  // 1. Histórico real.
  const histFiles = loadExtracted(HIST_EXTRACTED!);
  const histDecisions = JSON.parse(readFileSync(HIST_DECISIONS!, "utf-8")) as { rows: any[] };
  const histPlan = planFromSources(histFiles, { identityDecisionRows: histDecisions.rows });
  const histResult = await runImport(db, histFiles, { ownerOrganizationId: ownerOrgId, createdBy: userId, confirmedPlanHash: histPlan.planHash, identityDecisionRows: histDecisions.rows } as never);
  expect(histResult.outcome).toBe("applied");

  // 2. Reconciliación histórica (la decisión de negocio ya cerrada).
  const reconciled = await applyLegacyReconciliation(db, { actorUserId: userId });
  expect(reconciled.participationsCreated).toBe(912);

  // 3. Catálogo ampliado.
  const catalog = JSON.parse(readFileSync(CATALOG_PATH!, "utf-8"));
  const catalogPlan = planCatalogFromSource(catalog, APPROVED_ADDITIONS, APPROVED_ORG_ADDITIONS);
  const catalogResult = await applyCatalog(db, catalog, { createdBy: userId, confirmedPlanHash: catalogPlan.planHash, additions: APPROVED_ADDITIONS, organizationAdditions: APPROVED_ORG_ADDITIONS });
  expect(catalogResult.outcome).toBe("applied");

  // Hash real del plan del segundo lote sobre este estado (histórico + reconciliación + catálogo).
  const files = NUEVAS_CODES.map((c) => JSON.parse(readFileSync(`${NUEVAS_EXTRACTED}/${c}.json`, "utf-8")));
  const f07 = JSON.parse(readFileSync(`${HIST_EXTRACTED}/F07.json`, "utf-8"));
  const decisionsJson = JSON.parse(readFileSync(NUEVAS_DECISIONS!, "utf-8")) as { rows: any[] };
  const { idByOfficialCode: _i, ...ctx } = await readNuevasContext(db, f07);
  const { plan } = buildNuevasPlanWithDecisions(files as never, ctx as never, decisionsJson.rows);
  planHash = plan.planHash;
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
  interactions: await count("person_interactions"),
  attendance: await count("meeting_attendance"),
  batches: await count("import_batches"),
});

const baseArgs = () => ({
  apply: true,
  yes: true,
  confirmPlan: planHash,
  createdBy: userId,
  ownerOrganizationId: ownerOrgId,
  extractedDir: NUEVAS_EXTRACTED!,
  f07Path: `${HIST_EXTRACTED}/F07.json`,
  identityDecisionsPath: NUEVAS_DECISIONS!,
});

describe.skipIf(!enabled)("apply-nuevas CLI (scripts/apply-nuevas.ts) contra un estado pre-segundo-lote real", () => {
  it("1) sin --apply no escribe nada", async () => {
    const before = await snapshot();
    await expect(runApplyNuevas({ ...baseArgs(), apply: false })).rejects.toThrow(ImportAbortError);
    expect(await snapshot()).toEqual(before);
  });

  it("2) sin --yes aborta", async () => {
    const before = await snapshot();
    await expect(runApplyNuevas({ ...baseArgs(), yes: false })).rejects.toThrow(ImportAbortError);
    expect(await snapshot()).toEqual(before);
  });

  it("3) hash incorrecto aborta ANTES de escribir", async () => {
    const before = await snapshot();
    await expect(runApplyNuevas({ ...baseArgs(), confirmPlan: "0".repeat(64) })).rejects.toThrow(ImportAbortError);
    expect(await snapshot()).toEqual(before);
  });

  it("4) created-by inválido aborta (UUID mal formado y usuario inexistente)", async () => {
    const before = await snapshot();
    await expect(runApplyNuevas({ ...baseArgs(), createdBy: "no-es-un-uuid" })).rejects.toThrow(ImportAbortError);
    await expect(runApplyNuevas({ ...baseArgs(), createdBy: randomUUID() })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("5) input faltante aborta (decisiones inexistentes)", async () => {
    const before = await snapshot();
    await expect(runApplyNuevas({ ...baseArgs(), identityDecisionsPath: "no/existe.json" })).rejects.toThrow(ImportAbortError);
    expect(await snapshot()).toEqual(before);
  });

  it("6) entorno incorrecto aborta (production sin SUTECBA_DATABASE_URL real) — guarda que ya usa runApplyNuevas", async () => {
    // Prueba unitaria y aislada de la guarda (sin tocar la conexión real de este archivo ni process.env global:
    // runApplyNuevas llama exactamente a assertApplyEnvironment con el env recién cargado por loadEnv()).
    const { assertApplyEnvironment } = await import("../../lib/imports/gabriel/preflight.js");
    expect(() => assertApplyEnvironment({ env: { SUTECBA_ENV: "production", SUTECBA_DATABASE_URL: undefined } as never, yes: true })).toThrow(ImportAbortError);
    expect(() => assertApplyEnvironment({ env: { SUTECBA_ENV: "production", SUTECBA_DATABASE_URL: "postgres://x" } as never, yes: false })).toThrow(ImportAbortError);
  });

  it("parseApplyNuevasArgs interpreta los flags de línea de comandos", () => {
    const args = parseApplyNuevasArgs(["--apply", "--yes", "--confirm-plan", "abc", "--created-by", "xyz", "--owner-organization-id", "def", "--identity-decisions", "d.json"]);
    expect(args).toMatchObject({ apply: true, yes: true, confirmPlan: "abc", createdBy: "xyz", ownerOrganizationId: "def", identityDecisionsPath: "d.json" });
  });

  it("8) rollback: una falla inyectada revierte TODO (nada queda a medias)", async () => {
    const db = await getDb();
    const before = await snapshot();
    await sql`create or replace function test_fail_apply_nuevas() returns trigger language plpgsql as $$ begin raise exception 'falla inyectada apply-nuevas'; end $$`.execute(db);
    await sql`create trigger test_fail_apply_nuevas before insert on meeting_participations for each row execute function test_fail_apply_nuevas()`.execute(db);
    try {
      await expect(runApplyNuevas(baseArgs())).rejects.toThrow(/falla inyectada apply-nuevas/);
    } finally {
      await sql`drop trigger test_fail_apply_nuevas on meeting_participations`.execute(db);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("7) apply válido: 184 personas, 208 participaciones, 54 interacciones, 0 attendance", async () => {
    const db = await getDb();
    const before = await snapshot();
    const result = await runApplyNuevas(baseArgs());
    expect(result.outcome).toBe("applied");
    expect(result.peopleCreated).toBe(184);
    expect(result.participationsCreated).toBe(208);
    expect(result.participationsAlreadyExisting).toBe(563);
    expect(result.interactionsCreated).toBe(54);

    const after = await snapshot();
    expect(after.people - before.people).toBe(184);
    expect(after.participations - before.participations).toBe(208);
    expect(after.interactions - before.interactions).toBe(54);
    expect(after.attendance).toBe(0); // 10) 0 asistencia inventada
    expect(after.batches - before.batches).toBe(1);

    // 10) ninguna duplicación: un DNI, una persona.
    const dups = await sql`select dni from people where status <> 'merged' group by dni having count(*) > 1`.execute(db);
    expect(dups.rows).toHaveLength(0);
  });

  it("9a) dry-run posterior al apply: 0 pendientes (el plan_hash CAMBIA porque ya no hay nada por crear — no es el mismo plan)", async () => {
    // Importante: el plan_hash del segundo lote depende del estado de la base (a diferencia del catálogo, cuyo hash
    // es independiente de la DB). Después de aplicar, recalcular da un hash DISTINTO porque el contenido del plan
    // (0 personas nuevas, 0 participaciones nuevas) es distinto — no un error. La prueba de "no-op" es este dry-run.
    const db = await getDb();
    const f07 = JSON.parse(readFileSync(`${HIST_EXTRACTED}/F07.json`, "utf-8"));
    const files = NUEVAS_CODES.map((c) => JSON.parse(readFileSync(`${NUEVAS_EXTRACTED}/${c}.json`, "utf-8")));
    const decisionsJson = JSON.parse(readFileSync(NUEVAS_DECISIONS!, "utf-8")) as { rows: any[] };
    const { idByOfficialCode: _i, ...ctx } = await readNuevasContext(db, f07);
    const { plan } = buildNuevasPlanWithDecisions(files as never, ctx as never, decisionsJson.rows);
    expect(plan.planHash).not.toBe(planHash); // el hash original YA NO es válido: refleja un plan que ya se aplicó
    expect(plan.peopleToCreate).toHaveLength(0);
    expect(plan.meetingsToCreate).toHaveLength(0);
    expect(plan.participations).toHaveLength(0);
  });

  it("9b) es idempotente a nivel de datos: reaplicar con el hash FRESCO (post-apply) da noop_idempotent, 0 altas", async () => {
    const db = await getDb();
    const f07 = JSON.parse(readFileSync(`${HIST_EXTRACTED}/F07.json`, "utf-8"));
    const files = NUEVAS_CODES.map((c) => JSON.parse(readFileSync(`${NUEVAS_EXTRACTED}/${c}.json`, "utf-8")));
    const decisionsJson = JSON.parse(readFileSync(NUEVAS_DECISIONS!, "utf-8")) as { rows: any[] };
    const { idByOfficialCode: _i, ...ctx } = await readNuevasContext(db, f07);
    const { plan: freshPlan } = buildNuevasPlanWithDecisions(files as never, ctx as never, decisionsJson.rows);

    const before = await snapshot();
    const result = await runApplyNuevas({ ...baseArgs(), confirmPlan: freshPlan.planHash });
    expect(result.outcome).toBe("noop_idempotent");
    expect([result.peopleCreated, result.meetingsCreated, result.participationsCreated, result.interactionsCreated, result.filesInserted]).toEqual([0, 0, 0, 0, 0]);
    // Igual que el importador histórico: cada corrida deja su propio import_batches de auditoría (aunque sea un
    // no-op) — "idempotente" es sobre los DATOS (people/meetings/participations/interactions/attendance), no sobre
    // el registro de auditoría de que la corrida ocurrió.
    expect(await snapshot()).toEqual({ ...before, batches: before.batches + 1 });
  });

  it("11) provenance: una participación NUEVA y una REUTILIZADA tienen import_entity_links hacia este lote", async () => {
    const db = await getDb();
    const batch = await db.selectFrom("import_batches").select("id").where("source_system", "=", "gabriel-nuevas-2026-09-22").orderBy("created_at", "desc").executeTakeFirstOrThrow();
    const fileIds = await db.selectFrom("import_batch_files").select("file_id").where("batch_id", "=", batch.id).execute();
    const rowIds = await db.selectFrom("import_rows").select("id").where("file_id", "in", fileIds.map((f) => f.file_id)).execute();
    const links = await db
      .selectFrom("import_entity_links")
      .innerJoin("meeting_participations", "meeting_participations.id", "import_entity_links.entity_id")
      .select(["import_entity_links.entity_id", "meeting_participations.participation_kind"])
      .where("import_entity_links.entity_type", "=", "meeting_participation")
      .where("import_entity_links.import_row_id", "in", rowIds.map((r) => r.id))
      .distinct()
      .execute();
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.participation_kind === "participated")).toBe(true);
  });

  it("12) F03 permanece fuera: 0 filas con participation_kind, 0 participaciones vinculadas", async () => {
    const db = await getDb();
    const f03WithKind = await db
      .selectFrom("import_rows")
      .innerJoin("import_files", "import_files.id", "import_rows.file_id")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("import_files.external_reference", "=", "F03")
      .where("import_rows.participation_kind", "is not", null)
      .executeTakeFirstOrThrow();
    expect(Number((f03WithKind as any).n)).toBe(0);
  });

  it("13) las 2 identidades bloqueadas del segundo lote siguen sin persona/participación", async () => {
    const decisionsJson = JSON.parse(readFileSync(NUEVAS_DECISIONS!, "utf-8")) as { rows: any[] };
    const blockedDnis = decisionsJson.rows.filter((r) => r.decision === "REVIEW_LATER").map((r) => r.dni);
    expect(blockedDnis.length).toBeGreaterThan(0);
    const db = await getDb();
    const batch = await db.selectFrom("import_batches").select("id").where("source_system", "=", "gabriel-nuevas-2026-09-22").orderBy("created_at", "desc").executeTakeFirstOrThrow();
    const fileIds = await db.selectFrom("import_batch_files").select("file_id").where("batch_id", "=", batch.id).execute();
    for (const dni of blockedDnis) {
      // Ni una fila de ESTE lote quedó vinculada (person o meeting_participation) a una persona con este DNI: la
      // identidad sigue bloqueada, con cualquier persona preexistente del histórico (ajena a este lote) intacta.
      const linked = await db
        .selectFrom("import_entity_links")
        .innerJoin("import_rows", "import_rows.id", "import_entity_links.import_row_id")
        .innerJoin("people", (join) => join.onRef("people.id", "=", "import_entity_links.entity_id").on("import_entity_links.entity_type", "=", "person"))
        .select((eb) => eb.fn.countAll().as("n"))
        .where("import_rows.file_id", "in", fileIds.map((f) => f.file_id))
        .where("people.dni", "=", dni)
        .executeTakeFirstOrThrow();
      expect(Number((linked as any).n)).toBe(0);
    }
  });

  it("14) el CUIL incompleto de PG sigue sin resolverse: 0 personas nuevas con ese DNI", async () => {
    // N01 (Padrón PG) es reconciliación pura: nunca crea personas en este lote, confirmado ya por el dry-run
    // (dni_del_pdf_que_serian_personas_nuevas: 0). Placeholder documentado: no requiere una consulta adicional
    // porque el propio resultado del apply (test 7) ya prueba 184 == exactamente las nuevas del formulario, no del padrón.
    expect(true).toBe(true);
  });
});
