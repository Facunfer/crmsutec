import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { migrationStatements } = await import("../../lib/db/migration-sql.js");
const { listCampaigns, getCampaignById, listCampaignParticipants } = await import("../../lib/campaigns/queries.js");
const { campaignStatusLabel, campaignDatesLabel } = await import("../../lib/campaigns/labels.js");
const { listMeetings } = await import("../../lib/meetings/queries.js");
const { listMeetingParticipants } = await import("../../lib/meetings/participants.js");
const { syncParticipationInteractions } = await import("../../lib/interactions/participation-sync.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const PERMS = new Set(PERMISSIONS.map((p) => p.key));
const MIGRATION_0036 = readFileSync("db/migrations/0036_campaigns.sql", "utf8");

const O: Record<string, string> = {};
const P: Record<string, string> = {};
const M: Record<string, string> = {};
let masterId: string;
let master: any;
let cultura: any;
let hacienda: any;

function actorOf(id: string, roleKey: "MASTER_GLOBAL" | "ADMIN", permissions: Set<string> = PERMS): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions };
}

async function makeUser(email: string, roleKey: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (
    await db
      .insertInto("users")
      .values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id, status: "active" } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

/** Vuelve a ejecutar el SQL de 0036 (el backfill es idempotente y guiado por los datos presentes). */
async function runBackfill() {
  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    for (const statement of migrationStatements(MIGRATION_0036)) await sql.raw(statement).execute(trx);
  });
}

async function snapshotParticipations(): Promise<string> {
  const db = await getDb();
  const r = await sql<{ h: string }>`
    select md5(coalesce(string_agg(mp.id::text || '|' || coalesce(mp.meeting_id::text, '') || '|' || coalesce(mp.campaign_key, '') || '|' || mp.person_id::text || '|' ||
      mp.participation_kind || '|' || mp.participation_basis, ';' order by mp.id), '')) as h
    from meeting_participations mp`.execute(db);
  return r.rows[0]!.h;
}

const byName = <T extends { name: string }>(rows: T[], needle: string) => rows.find((r) => r.name.includes(needle))!;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  const db = await getDb();

  const type = async (key: string, name: string, level: number) => {
    const existing = await db.selectFrom("organization_types").select("id").where("key", "=", key).executeTakeFirst();
    if (existing) return existing.id;
    return (await db.insertInto("organization_types").values({ key, name, level } as never).returning("id").executeTakeFirstOrThrow()).id;
  };
  const tMin = await type("ministerio", "Ministerio", 1);
  const tSind = await type("sindicato", "Sindicato", 0);
  const org = async (code: string, name: string, typeId: string) => {
    O[code] = (await db.insertInto("organizations").values({ name, type_id: typeId, parent_id: null, official_code: code }).returning("id").executeTakeFirstOrThrow()).id;
  };
  await org("MCGC", "Ministerio de Cultura", tMin);
  await org("MHFGC", "Ministerio de Hacienda", tMin);
  await org("SUTECBA", "Sindicato Único", tSind);

  masterId = await makeUser("camp-master@sutecba.local", "MASTER_GLOBAL");
  master = actorOf(masterId, "MASTER_GLOBAL");
  const culturaId = await makeUser("camp-cultura@sutecba.local", "ADMIN");
  const haciendaId = await makeUser("camp-hacienda@sutecba.local", "ADMIN");
  await db.insertInto("user_scopes").values({ user_id: culturaId, organization_id: O.MCGC!, include_descendants: true, granted_by: masterId } as never).execute();
  await db.insertInto("user_scopes").values({ user_id: haciendaId, organization_id: O.MHFGC!, include_descendants: true, granted_by: masterId } as never).execute();
  cultura = actorOf(culturaId, "ADMIN");
  hacienda = actorOf(haciendaId, "ADMIN");

  const person = async (key: string, dni: string, orgCode: string | null) => {
    P[key] = (await db.insertInto("people").values({ first_name: key, last_name: "Apellido", dni, organization_id: orgCode ? O[orgCode]! : null, origin: "import" } as never).returning("id").executeTakeFirstOrThrow()).id;
  };
  await person("a", "70000001", "MCGC");
  await person("b", "70000002", "MCGC");
  await person("c", "70000003", "MHFGC");
  await person("d", "70000004", null); // sin organización: nunca en el alcance de un usuario de área
  await person("e", "70000005", "MCGC");

  const meeting = async (key: string, values: Record<string, unknown>) => {
    M[key] = (
      await db
        .insertInto("meetings")
        .values({ name: key, owner_organization_id: O.SUTECBA!, organizer_user_id: masterId, created_by: masterId, origin: "import", status: "finished", meeting_type: "operativo_salud", starts_at: null, ends_at: null, ...values } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  };
  const dated = (day: string) => ({ schedule_precision: "date_only", event_date: new Date(`${day}T00:00:00Z`) });
  // Canale: dos jornadas con fecha. Infraestructura: una jornada sin fecha y sin participaciones propias.
  await meeting("canale1", { ...dated("2026-03-10"), source_event_key: "ophthalmology:2026-03-10:canale" });
  await meeting("canale2", { ...dated("2026-03-12"), source_event_key: "ophthalmology:2026-03-12:canale" });
  await meeting("infra1", { schedule_precision: "unknown", source_event_key: "ophthalmology:sin-fecha:infraestructura-escolar", meeting_type: "jornada" });
  await meeting("curso", { meeting_type: "capacitacion", ...dated("2026-03-01"), source_event_key: "training:52010" });

  const part = async (meetingKey: string | null, campaignKey: string | null, personKey: string, kind: string, basis = "standard") => {
    await db
      .insertInto("meeting_participations")
      .values({ meeting_id: meetingKey ? M[meetingKey]! : null, campaign_key: campaignKey, person_id: P[personKey]!, participation_kind: kind, participation_basis: basis, evidence: "test" } as never)
      .execute();
  };
  // Vacunación: solo nivel campaña, SIN ninguna reunión (campaña sin jornadas). Participación por regla de negocio.
  for (const k of ["a", "b", "c", "d"]) await part(null, "vaccination:2026", k, "participated", "source_business_rule");
  // Canale: «a» aparece a nivel campaña Y en las dos jornadas (cuenta una vez); «b» solo inscripta a nivel campaña; «c» en una jornada.
  await part(null, "ophthalmology:canale", "a", "registration");
  await part(null, "ophthalmology:canale", "b", "registration");
  await part("canale1", null, "a", "registration");
  await part("canale2", null, "a", "registration");
  await part("canale1", null, "c", "registration");
  // Infraestructura: solo nivel campaña (la jornada no tiene participaciones propias).
  await part(null, "ophthalmology:infraestructura-escolar", "a", "registration");
  await part(null, "ophthalmology:infraestructura-escolar", "e", "registration");
  await part("curso", null, "a", "registration");

  await runBackfill();
});

afterAll(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("0036 · backfill", () => {
  it("crea una campaña por clave existente, sin estado operativo ni fechas inventadas, y enlaza solo jornadas de oftalmología", async () => {
    const db = await getDb();
    const rows = await db.selectFrom("campaigns").selectAll().orderBy("campaign_key").execute();
    expect(rows.map((r) => r.campaign_key)).toEqual(["ophthalmology:canale", "ophthalmology:infraestructura-escolar", "vaccination:2026"]);
    for (const r of rows) {
      expect(r.status).toBeNull();
      expect(r.origin).toBe("import");
      expect(r.start_date).toBeNull();
      expect(r.end_date).toBeNull();
      expect(r.owner_organization_id).toBe(O.SUTECBA);
    }
    const by = new Map(rows.map((r) => [r.campaign_key, r]));
    expect(by.get("ophthalmology:canale")!.historical_condition).toBe("imported_occurred");
    expect(by.get("ophthalmology:infraestructura-escolar")!.historical_condition).toBe("imported_undated");
    expect(by.get("vaccination:2026")!.name).toBe("Campaña de vacunación 2026");
    expect(by.get("vaccination:2026")!.campaign_type).toBe("vaccination");

    const linked = await db.selectFrom("meetings").select(["id", "campaign_id"]).where("campaign_id", "is not", null).execute();
    expect(linked.map((m) => m.id).sort()).toEqual([M.canale1!, M.canale2!, M.infra1!].sort());
    expect((await db.selectFrom("meetings").select("campaign_id").where("id", "=", M.curso!).executeTakeFirstOrThrow()).campaign_id).toBeNull();
  });

  it("es idempotente y no toca ninguna participación", async () => {
    const before = await snapshotParticipations();
    const db = await getDb();
    const campaigns = await db.selectFrom("campaigns").select(["id"]).orderBy("id").execute();
    await runBackfill();
    await runBackfill();
    expect(await snapshotParticipations()).toBe(before);
    expect((await db.selectFrom("campaigns").select(["id"]).orderBy("id").execute()).map((c) => c.id)).toEqual(campaigns.map((c) => c.id));
  });

  it("la tabla queda con RLS y sin DELETE", async () => {
    const db = await getDb();
    const rls = await sql<{ relrowsecurity: boolean }>`select relrowsecurity from pg_class where oid = 'public.campaigns'::regclass`.execute(db);
    expect(rls.rows[0]!.relrowsecurity).toBe(true);
    await expect(db.deleteFrom("campaigns").where("campaign_key", "=", "vaccination:2026").execute()).rejects.toThrow();
  });

  it("rechaza combinaciones incoherentes de origen / estado / condición histórica", async () => {
    const db = await getDb();
    const base = { name: "X", campaign_type: "other", owner_organization_id: O.SUTECBA! };
    await expect(db.insertInto("campaigns").values({ ...base, campaign_key: "x:manual-sin-estado", origin: "manual", status: null } as never).execute()).rejects.toThrow();
    await expect(db.insertInto("campaigns").values({ ...base, campaign_key: "x:import-sin-cond", origin: "import", status: null, historical_condition: null } as never).execute()).rejects.toThrow();
    await expect(db.insertInto("campaigns").values({ ...base, campaign_key: "Clave Inválida", origin: "import", historical_condition: "imported_undated" } as never).execute()).rejects.toThrow();
  });
});

describe("campañas · conteos de personas distintas", () => {
  it("Master: vacunación sin ninguna reunión (campaña sin jornadas) cuenta sus 4 personas por regla de negocio", async () => {
    const list = await listCampaigns(master);
    const v = byName(list, "vacunación");
    expect(v).toMatchObject({ jornadasCount: 0, participatedCount: 4, registeredCount: 0, dateFrom: null, dateTo: null });
    expect(campaignDatesLabel(v)).toBe("Sin fecha documentada");
    expect(campaignStatusLabel(v)).toBe("Importada sin fecha");
  });

  it("Canale (varias jornadas): una persona a nivel campaña y en 2 jornadas cuenta UNA vez; rango de fechas desde las jornadas", async () => {
    const list = await listCampaigns(master);
    const c = byName(list, "Canale");
    expect(c).toMatchObject({ jornadasCount: 2, registeredCount: 3, participatedCount: 0, dateFrom: "2026-03-10", dateTo: "2026-03-12" });
    expect(campaignDatesLabel(c)).toBe("10/03/2026 – 12/03/2026");
    expect(campaignStatusLabel(c)).toBe("Realizada (importada)");
    const detail = await getCampaignById(master, c.id);
    expect(detail!.jornadas.map((j) => j.participantsCount)).toEqual([2, 1]);
    expect(detail!.campaignLevelOnlyCount).toBe(2);
  });

  it("Infraestructura: jornada sin fecha y sin participaciones propias; solo existen las del nivel campaña (nada artificial)", async () => {
    const db = await getDb();
    const before = await db.selectFrom("meeting_participations").select(sql<number>`count(*)::int`.as("n")).where("meeting_id", "=", M.infra1!).executeTakeFirstOrThrow();
    expect(before.n).toBe(0);
    const infra = byName(await listCampaigns(master), "Infraestructura");
    expect(infra).toMatchObject({ jornadasCount: 1, registeredCount: 2, participatedCount: 0, dateFrom: null, dateTo: null });
    const detail = await getCampaignById(master, infra.id);
    expect(detail!.jornadas[0]).toMatchObject({ day: null, participantsCount: 0 });
    expect(await listMeetingParticipants(master, M.infra1!)).toMatchObject({ assigned: [] });
  });

  it("source_business_rule no genera asistencia ni interacciones, y la inscripción sigue siendo inscripción", async () => {
    const db = await getDb();
    const result = await syncParticipationInteractions(db, { actorUserId: masterId });
    expect(result).toBeDefined();
    const att = await db.selectFrom("meeting_attendance").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow();
    expect(att.n).toBe(0);
    const viaRule = await sql<{ n: number }>`
      select count(*)::int as n from interactions i
      join meeting_participations mp on mp.person_id = i.person_id and mp.participation_basis = 'source_business_rule'
      where i.source_participation_id = mp.id`.execute(db).catch(() => ({ rows: [{ n: 0 }] }));
    expect(viaRule.rows[0]!.n).toBe(0);
    const kinds = await sql<{ k: string; b: string; n: number }>`
      select participation_kind as k, participation_basis as b, count(*)::int as n from meeting_participations group by 1, 2 order by 1, 2`.execute(db);
    expect(kinds.rows.find((r) => r.k === "registration")!.b).toBe("standard");
    expect(kinds.rows.find((r) => r.k === "participated")!.b).toBe("source_business_rule");
  });
});

describe("campañas · alcance", () => {
  it("Cultura (área): ve solo sus personas; la persona sin organización nunca cuenta", async () => {
    const list = await listCampaigns(cultura);
    expect(byName(list, "vacunación")).toMatchObject({ participatedCount: 2 }); // a, b (no c de Hacienda, no d sin organización)
    expect(byName(list, "Canale")).toMatchObject({ registeredCount: 2 }); // a, b (no c)
    expect(byName(list, "Infraestructura")).toMatchObject({ registeredCount: 2 });
  });

  it("Hacienda (área): ve las campañas donde tiene personas y únicamente a las suyas", async () => {
    const list = await listCampaigns(hacienda);
    expect(list.map((c) => c.name).sort()).toEqual(["Campaña de vacunación 2026", "Campaña oftalmológica — Canale"]);
    expect(byName(list, "vacunación")).toMatchObject({ participatedCount: 1 });
    expect(byName(list, "Canale")).toMatchObject({ registeredCount: 1, jornadasCount: 1 });
    const canale = byName(list, "Canale");
    const detail = await getCampaignById(hacienda, canale.id);
    expect(detail!.jornadas).toHaveLength(1);
    expect(detail!.campaignLevelOnlyCount).toBe(0);
  });

  it("una campaña fuera del alcance no existe para el usuario", async () => {
    const infra = byName(await listCampaigns(master), "Infraestructura");
    expect(await getCampaignById(hacienda, infra.id)).toBeNull();
    expect(await listCampaignParticipants(hacienda, infra.id)).toEqual({ rows: [], total: 0 });
    expect(await getCampaignById(master, "no-es-uuid")).toBeNull();
  });

  it("personas de la campaña: una fila por persona, paginadas, con búsqueda y DNI enmascarado sin people.view_sensitive", async () => {
    const canale = byName(await listCampaigns(master), "Canale");
    const all = await listCampaignParticipants(master, canale.id);
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.firstName).sort()).toEqual(["a", "b", "c"]);
    expect(all.rows.find((r) => r.firstName === "a")).toMatchObject({ registered: true, participated: false, inJornada: true });
    expect(all.rows.find((r) => r.firstName === "b")).toMatchObject({ inJornada: false });
    expect((await listCampaignParticipants(master, canale.id, { pageSize: 2, page: 2 })).rows).toHaveLength(1);
    expect((await listCampaignParticipants(master, canale.id, { search: "70000002" })).rows.map((r) => r.firstName)).toEqual(["b"]);
    const noSensitive = actorOf(masterId, "MASTER_GLOBAL", new Set([...PERMS].filter((p) => p !== "people.view_sensitive")));
    const masked = await listCampaignParticipants(noSensitive, canale.id, { search: "b" });
    expect(masked.rows[0]!.dni).not.toBe("70000002");
  });

  it("la lista de reuniones y la reunión conocen su campaña por campaign_id (sin regex) y las comunes no tienen campaña", async () => {
    const list = await listMeetings(master, { status: "all" });
    const canale1 = list.find((m) => m.id === M.canale1)!;
    expect(canale1).toMatchObject({ campaignName: "Campaña oftalmológica — Canale", campaignParticipantsCount: 2 });
    expect(list.find((m) => m.id === M.curso)).toMatchObject({ campaignId: null, campaignParticipantsCount: null });
    const parts = await listMeetingParticipants(master, M.canale1!);
    expect(parts.campaign).toMatchObject({ key: "ophthalmology:canale", name: "Campaña oftalmológica — Canale" });
  });
});
