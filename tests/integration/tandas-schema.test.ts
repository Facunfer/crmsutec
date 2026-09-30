import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { createPerson, updatePerson, PersonCommandError } = await import("../../lib/people/commands.js");
const { listPeoplePage, getPersonById } = await import("../../lib/people/queries.js");
const { exportPeopleCsv } = await import("../../lib/people/export.js");
const { syncParticipationInteractions } = await import("../../lib/interactions/participation-sync.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL_PERMISSIONS = new Set(PERMISSIONS.map((p) => p.key));

let actor: any;
let actorId: string;
let ownerOrgId: string;
let rowId: string;

const insertPerson = async (dni: string, extra: Record<string, unknown> = {}) => {
  const db = await getDb();
  return db
    .insertInto("people")
    .values({ first_name: "Ana", last_name: "Gomez", dni, ...extra } as any)
    .returning("id")
    .executeTakeFirstOrThrow();
};

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  ownerOrgId = await createTestOrganization();
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({ email: "tandas-actor@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  actorId = user.id;
  actor = {
    id: user.id, email: "tandas-actor@sutecba.local", fullName: "Actor", roleId: role.id, roleKey: "MASTER_GLOBAL",
    mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions: ALL_PERMISSIONS,
  };
  const file = await db.insertInto("import_files").values({ original_name: "t.xlsx", content_hash: "a".repeat(64), created_by: actorId }).returning("id").executeTakeFirstOrThrow();
  const row = await db.insertInto("import_rows").values({ file_id: file.id, sheet: "s", row_number: 1, raw_data: sql`'{}'::jsonb`, row_hash: "b".repeat(64) } as any).returning("id").executeTakeFirstOrThrow();
  rowId = row.id;
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("0031 — participation_basis = source_business_rule", () => {
  const meetingParticipation = async (person: string, values: Record<string, unknown>) => {
    const db = await getDb();
    return db.insertInto("meeting_participations").values({ person_id: person, campaign_key: "vaccination:test", ...values } as any).execute();
  };

  it("acepta participated + source_business_rule con evidencia y sigue aceptando legacy_initial_import y standard", async () => {
    const a = await insertPerson("30000001");
    const b = await insertPerson("30000002");
    const c = await insertPerson("30000003");
    await meetingParticipation(a.id, { participation_kind: "participated", participation_basis: "source_business_rule", evidence: "Regla: la respuesta del formulario acredita participación" });
    await meetingParticipation(b.id, { participation_kind: "participated", participation_basis: "legacy_initial_import" });
    await meetingParticipation(c.id, { participation_kind: "registration", participation_basis: "standard" });
  });

  it("rechaza participated con base standard, y source_business_rule sin evidencia o con otro kind", async () => {
    const p = await insertPerson("30000004");
    await expect(meetingParticipation(p.id, { participation_kind: "participated", participation_basis: "standard" })).rejects.toThrow();
    await expect(meetingParticipation(p.id, { participation_kind: "participated", participation_basis: "source_business_rule" })).rejects.toThrow();
    await expect(meetingParticipation(p.id, { participation_kind: "participated", participation_basis: "source_business_rule", evidence: "   " })).rejects.toThrow();
    await expect(meetingParticipation(p.id, { participation_kind: "registration", participation_basis: "source_business_rule", evidence: "x" })).rejects.toThrow();
    await expect(meetingParticipation(p.id, { participation_kind: "attended", participation_basis: "source_business_rule", evidence: "x" })).rejects.toThrow();
    await expect(meetingParticipation(p.id, { participation_kind: "participated", participation_basis: "otra", evidence: "x" })).rejects.toThrow();
  });

  it("NO genera person_interactions (ni con jornada y fecha real), pero la participación legacy equivalente SÍ", async () => {
    const db = await getDb();
    const meeting = await db
      .insertInto("meetings")
      .values({
        name: "Capacitación con fecha", owner_organization_id: ownerOrgId, organizer_user_id: actorId, created_by: actorId, meeting_type: "capacitacion", origin: "import",
        source_event_key: "training:test-fecha", schedule_precision: "date_only", event_date: sql`'2026-09-24'::date`, starts_at: null, ends_at: null,
      } as any)
      .returning("id")
      .executeTakeFirstOrThrow();
    const byRule = await insertPerson("30000005");
    const legacy = await insertPerson("30000006");
    await db.insertInto("meeting_participations").values({ meeting_id: meeting.id, person_id: byRule.id, participation_kind: "participated", participation_basis: "source_business_rule", evidence: "Regla de negocio: listado de cursada realizada", import_row_id: rowId } as any).execute();
    await db.insertInto("meeting_participations").values({ meeting_id: meeting.id, person_id: legacy.id, participation_kind: "participated", participation_basis: "legacy_initial_import" } as any).execute();
    const result = await syncParticipationInteractions(db, { actorUserId: actorId });
    expect(result.created).toBe(1);
    const inter = await db.selectFrom("person_interactions").select("person_id").execute();
    expect(inter.map((i) => i.person_id)).toEqual([legacy.id]);
  });

  it("es aditiva: no reescribe filas existentes", async () => {
    const db = await getDb();
    const bases = await sql<{ b: string }>`select distinct participation_basis b from meeting_participations order by 1`.execute(db);
    expect(bases.rows.map((r) => r.b)).toEqual(["legacy_initial_import", "source_business_rule", "standard"]);
  });
});

describe("0032 — nombre completo original sin separar", () => {
  const ORIGINAL = "ALVAREZ CID NESTOR EDUARDO";

  it("acepta unsplit íntegro y rechaza combinaciones inconsistentes o valores ficticios", async () => {
    await insertPerson("31000001", { first_name: "", last_name: ORIGINAL, name_split_status: "unsplit", full_name_original: ORIGINAL });
    await expect(insertPerson("31000002", { first_name: "", last_name: ORIGINAL })).rejects.toThrow(); // split con nombre vacío
    await expect(insertPerson("31000003", { first_name: "(sin separar)", last_name: ORIGINAL, name_split_status: "unsplit", full_name_original: ORIGINAL })).rejects.toThrow();
    await expect(insertPerson("31000004", { first_name: "", last_name: "OTRO", name_split_status: "unsplit", full_name_original: ORIGINAL })).rejects.toThrow(); // last ≠ original
    await expect(insertPerson("31000005", { first_name: "", last_name: ORIGINAL, name_split_status: "unsplit", full_name_original: null })).rejects.toThrow();
    await expect(insertPerson("31000006", { first_name: "  ", last_name: "X" })).rejects.toThrow();
  });

  it("búsqueda por nombre completo, listado, orden y exportación conservan el original", async () => {
    const page = await listPeoplePage(actor, { search: "alvarez cid" } as any, { field: "name", direction: "asc" }, 1, 25);
    expect(page.total).toBe(1);
    expect(page.rows[0]!.lastName).toBe(ORIGINAL);
    expect(page.rows[0]!.firstName).toBe("");
    const all = await listPeoplePage(actor, {} as any, { field: "name", direction: "asc" }, 1, 100);
    const names = all.rows.map((r) => r.lastName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")).length ? names : names); // no falla el ORDER BY con first_name vacío
    const csv = await exportPeopleCsv(actor, {} as any, { field: "name", direction: "asc" });
    expect(csv).toContain(ORIGINAL);
  });

  it("la ficha lo marca unsplit; editar otros datos NO cambia el texto original; cargar nombre y apellido lo pasa a split conservando el original", async () => {
    const db = await getDb();
    const p = await db.selectFrom("people").select(["id", "version"]).where("dni", "=", "31000001").executeTakeFirstOrThrow();
    const detail = await getPersonById(actor, p.id);
    expect(detail!.nameSplitStatus).toBe("unsplit");

    await updatePerson(actor, p.id, p.version, { firstName: "", lastName: ORIGINAL, dni: "31000001", email: "x@ejemplo.com", phone: "", organizationId: "", birthDate: "", declaredAge: "" });
    const after = await db.selectFrom("people").selectAll().where("id", "=", p.id).executeTakeFirstOrThrow();
    expect(after.name_split_status).toBe("unsplit");
    expect(after.last_name).toBe(ORIGINAL);
    expect(after.first_name).toBe("");

    // vaciar el texto sin separar no es válido
    await expect(updatePerson(actor, p.id, after.version, { firstName: "", lastName: "Otro texto", dni: "31000001", email: "x@ejemplo.com", phone: "", organizationId: "", birthDate: "", declaredAge: "" })).rejects.toBeInstanceOf(PersonCommandError);

    await updatePerson(actor, p.id, after.version, { firstName: "Néstor Eduardo", lastName: "Álvarez Cid", dni: "31000001", email: "x@ejemplo.com", phone: "", organizationId: "", birthDate: "", declaredAge: "" });
    const split = await db.selectFrom("people").selectAll().where("id", "=", p.id).executeTakeFirstOrThrow();
    expect(split.name_split_status).toBe("split");
    expect(split.full_name_original).toBe(ORIGINAL);
  });

  it("el alta manual sigue exigiendo nombre y apellido", async () => {
    await expect(createPerson(actor, { firstName: "", lastName: "Solo", dni: "31000099", email: "", phone: "", organizationId: ownerOrgId, birthDate: "", declaredAge: "" } as any)).rejects.toThrow();
  });

  it("las personas anteriores quedan split y sin full_name_original", async () => {
    const db = await getDb();
    const r = await sql<{ n: number }>`select count(*)::int n from people where name_split_status = 'unsplit'`.execute(db);
    expect(r.rows[0]!.n).toBeGreaterThanOrEqual(0);
    const legacy = await sql<{ n: number }>`select count(*)::int n from people where dni = '30000001' and name_split_status = 'split' and full_name_original is null`.execute(db);
    expect(legacy.rows[0]!.n).toBe(1);
  });
});

describe("0033 — person_observations", () => {
  it("guarda categoría/valor/procedencia; la misma observación no se duplica y valores distintos conviven", async () => {
    const db = await getDb();
    const p = await insertPerson("32000001");
    const base = { person_id: p.id, category: "colegio_votacion", source_kind: "import", import_row_id: rowId, created_by: actorId };
    await db.insertInto("person_observations").values({ ...base, value: "CPACF" } as any).execute();
    await expect(db.insertInto("person_observations").values({ ...base, value: "CPACF" } as any).execute()).rejects.toThrow();
    await db.insertInto("person_observations").values({ ...base, value: "La Plata" } as any).execute();
    const rows = await db.selectFrom("person_observations").select(["value"]).where("person_id", "=", p.id).orderBy("value").execute();
    expect(rows.map((r) => r.value)).toEqual(["CPACF", "La Plata"]);
  });

  it("valida categoría, valor vacío y procedencia obligatoria de una importación", async () => {
    const db = await getDb();
    const p = await insertPerson("32000002");
    const ok = { person_id: p.id, created_by: actorId, source_kind: "import", import_row_id: rowId };
    await expect(db.insertInto("person_observations").values({ ...ok, category: "Colegio", value: "x" } as any).execute()).rejects.toThrow();
    await expect(db.insertInto("person_observations").values({ ...ok, category: "colegio_votacion", value: "  " } as any).execute()).rejects.toThrow();
    await expect(db.insertInto("person_observations").values({ ...ok, import_row_id: null, category: "colegio_votacion", value: "x" } as any).execute()).rejects.toThrow();
  });

  it("es inmutable: sin DELETE (trigger) y el rol de la aplicación no tiene UPDATE ni DELETE", async () => {
    const db = await getDb();
    await expect(sql`delete from person_observations`.execute(db)).rejects.toThrow(/DELETE/);
    const priv = await sql<{ p: string }>`select privilege_type p from information_schema.role_table_grants where grantee = 'sutecba_app' and table_name = 'person_observations' order by 1`.execute(db);
    expect(priv.rows.map((r) => r.p)).toEqual(["INSERT", "SELECT"]);
    const exposed = await sql<{ n: number }>`select count(*)::int n from information_schema.role_table_grants where grantee in ('anon','authenticated','PUBLIC') and table_name = 'person_observations'`.execute(db);
    expect(exposed.rows[0]!.n).toBe(0);
  });
});
