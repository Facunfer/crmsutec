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
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { countPeople, getPersonTraffic, getTrafficKpis, listPeoplePage } = await import("../../lib/people/queries.js");
const { listAreaOptions, listOrgTreeOptions, describeOrganization } = await import("../../lib/organizations/areas.js");
const { listMeetings, getMeetingById } = await import("../../lib/meetings/queries.js");
const { listMeetingParticipants, campaignKeyOfMeeting } = await import("../../lib/meetings/participants.js");
const { canAccessMeeting, canViewMeeting } = await import("../../lib/scope/organizations.js");
const { syncParticipationInteractions } = await import("../../lib/interactions/participation-sync.js");
const { createPerson } = await import("../../lib/people/commands.js");
const { createUser, setUserPrimaryOrganization } = await import("../../lib/users/commands.js");
const { trafficLightOf } = await import("../../lib/people/traffic.js");
const { getPersonMeetingActivity } = await import("../../lib/people/queries.js");
const { exportPeopleCsv } = await import("../../lib/people/export.js");
const { getDashboardCounts } = await import("../../lib/analytics/queries.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const PERMS = new Set(PERMISSIONS.map((p) => p.key));

const O: Record<string, string> = {};
const P: Record<string, string> = {};
let masterId: string;
let master: any;
let cultura: any;
let hacienda: any;
let sutecbaOwner: string;
const M: Record<string, string> = {};

function actorOf(id: string, roleKey: "MASTER_GLOBAL" | "ADMIN"): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions: PERMS };
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

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);

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
  const tDg = await type("direccion_general", "Dirección General", 4);
  const tEnte = await type("ente_autarquico", "Ente Autárquico", 1);
  const tSind = await type("sindicato", "Sindicato", 0);
  const org = async (code: string, name: string, typeId: string, parent: string | null) => {
    O[code] = (await db.insertInto("organizations").values({ name, type_id: typeId, parent_id: parent, official_code: code }).returning("id").executeTakeFirstOrThrow()).id;
  };
  await org("MCGC", "Ministerio de Cultura", tMin, null);
  await org("EATC", "Ente Autárquico Teatro Colón", tEnte, O.MCGC!);
  await org("DGTALMC", "DGTAL Cultura", tDg, O.MCGC!);
  await org("MHFGC", "Ministerio de Hacienda y Finanzas", tMin, null);
  await org("DGTALMHF", "DGTAL Hacienda", tDg, O.MHFGC!);
  await org("PG", "Procuración General", tMin, null);
  await org("MJGGC", "Jefatura de Gabinete", tMin, null);
  await org("IDECBA", "IDECBA", tEnte, O.MJGGC!);
  await org("SUTECBA", "Sindicato Único", tSind, null);
  sutecbaOwner = O.SUTECBA!;

  masterId = await makeUser("area-master@sutecba.local", "MASTER_GLOBAL");
  master = actorOf(masterId, "MASTER_GLOBAL");
  const culturaId = await makeUser("cultura.test@sutecba.local", "ADMIN");
  const haciendaId = await makeUser("hacienda.test@sutecba.local", "ADMIN");
  await db.insertInto("user_scopes").values({ user_id: culturaId, organization_id: O.MCGC!, include_descendants: true, granted_by: masterId } as never).execute();
  await db.insertInto("user_scopes").values({ user_id: haciendaId, organization_id: O.MHFGC!, include_descendants: true, granted_by: masterId } as never).execute();
  cultura = actorOf(culturaId, "ADMIN");
  hacienda = actorOf(haciendaId, "ADMIN");

  const person = async (key: string, dni: string, orgCode: string | null) => {
    P[key] = (await db.insertInto("people").values({ first_name: key, last_name: "Apellido", dni, organization_id: orgCode ? O[orgCode]! : null, origin: "import" } as never).returning("id").executeTakeFirstOrThrow()).id;
  };
  await person("cRaiz", "60000001", "MCGC"); // solo se conoce el Área
  await person("cTeatro1", "60000002", "EATC");
  await person("cTeatro2", "60000003", "EATC");
  await person("hDgtal", "60000004", "DGTALMHF");
  await person("hRaiz", "60000005", "MHFGC");
  await person("pg1", "60000006", "PG");
  await person("idecba1", "60000007", "IDECBA");
  await person("sinOrg", "60000008", null);

  const interactionType = (await db.selectFrom("interaction_types").select("id").where("key", "=", "llamada").executeTakeFirstOrThrow()).id;
  const interact = async (personKey: string, occurredAt: Date, extra: Record<string, unknown> = {}) => {
    const p = await db.selectFrom("people").select("organization_id").where("id", "=", P[personKey]!).executeTakeFirstOrThrow();
    await db
      .insertInto("person_interactions")
      .values({ person_id: P[personKey]!, owner_organization_id: p.organization_id ?? sutecbaOwner, occurred_at: occurredAt, interaction_type_id: interactionType, subject: "Llamada", status: "completed", created_by: masterId, ...extra } as never)
      .execute();
  };
  await interact("cRaiz", daysAgo(3)); // verde
  await interact("cTeatro1", daysAgo(45)); // amarillo
  await interact("cTeatro2", daysAgo(200)); // rojo
  await interact("hDgtal", daysAgo(10)); // verde
  await interact("hRaiz", daysAgo(5), { status: "voided", void_reason: "error" }); // anulada: no cuenta
  await interact("pg1", daysAgo(-5)); // futura: no cuenta
  // idecba1 y sinOrg: nunca → gris

  // Reuniones históricas de SUTECBA con participantes de varias áreas.
  const meeting = async (key: string, values: Record<string, unknown>) => {
    M[key] = (
      await db
        .insertInto("meetings")
        .values({ name: key, owner_organization_id: sutecbaOwner, organizer_user_id: masterId, created_by: masterId, origin: "import", status: "finished", ...values } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  };
  await meeting("cursoRCP", { meeting_type: "capacitacion", schedule_precision: "date_only", event_date: new Date("2026-03-10T00:00:00Z"), source_event_key: "training:52010", starts_at: null, ends_at: null });
  await meeting("canale", { meeting_type: "operativo_salud", schedule_precision: "date_only", event_date: new Date("2026-03-11T00:00:00Z"), source_event_key: "ophthalmology:2026-03-11:canale", starts_at: null, ends_at: null });
  await meeting("sinFecha", { meeting_type: "jornada", schedule_precision: "unknown", source_event_key: "ophthalmology:x:sin", starts_at: null, ends_at: null });
  await meeting("soloHacienda", { source_event_key: "reunion:solo-hacienda", meeting_type: "reunion", schedule_precision: "date_only", event_date: new Date("2026-03-12T00:00:00Z"), starts_at: null, ends_at: null });
  const part = async (meetingKey: string | null, personKey: string, kind: string, extra: Record<string, unknown> = {}) => {
    await db.insertInto("meeting_participations").values({ meeting_id: meetingKey ? M[meetingKey]! : null, person_id: P[personKey]!, participation_kind: kind, ...extra } as never).execute();
  };
  // Operativo cuyos únicos inscriptos de Cultura están a nivel de CAMPAÑA (sin jornada): la reunión debe verse igual.
  await meeting("soloCampana", { meeting_type: "operativo_salud", schedule_precision: "date_only", event_date: new Date("2026-03-13T00:00:00Z"), source_event_key: "ophthalmology:2026-03-13:tc", starts_at: null, ends_at: null });
  await db.insertInto("meeting_participations").values({ meeting_id: null, campaign_key: "ophthalmology:tc", person_id: P.cTeatro2!, participation_kind: "registration" } as never).execute();
  await db.insertInto("meeting_participations").values({ meeting_id: null, campaign_key: "ophthalmology:tc", person_id: P.pg1!, participation_kind: "registration" } as never).execute();
  await part("cursoRCP", "cTeatro1", "registration");
  await part("cursoRCP", "cTeatro2", "attended", { evidence: "planilla firmada" });
  await part("cursoRCP", "hDgtal", "attended", { evidence: "planilla firmada" });
  await part("cursoRCP", "pg1", "registration");
  await part("canale", "cRaiz", "registration");
  await part("soloHacienda", "hRaiz", "registration");
  await part("sinFecha", "cRaiz", "attended", { evidence: "lista" });
  // campaña sin jornada (Canale): no se asigna a ninguna reunión
  await db.insertInto("meeting_participations").values({ meeting_id: null, campaign_key: "ophthalmology:canale", person_id: P.cTeatro1!, participation_kind: "registration" } as never).execute();
  await db.insertInto("meeting_participations").values({ meeting_id: null, campaign_key: "ophthalmology:canale", person_id: P.hDgtal!, participation_kind: "registration" } as never).execute();
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("Área y Repartición (derivadas, sin duplicar la estructura)", () => {
  it("el Área de una unidad es su ancestro raíz; una raíz es su propia Área", async () => {
    const db = await getDb();
    const area = async (code: string) => (await sql<{ a: string | null }>`select public.organization_area_id(${O[code]!}::uuid) as a`.execute(db)).rows[0]!.a;
    expect(await area("EATC")).toBe(O.MCGC);
    expect(await area("DGTALMHF")).toBe(O.MHFGC);
    expect(await area("MCGC")).toBe(O.MCGC);
    expect(await area("IDECBA")).toBe(O.MJGGC);
    expect((await sql<{ a: string | null }>`select public.organization_area_id(${randomUUID()}::uuid) as a`.execute(db)).rows[0]!.a).toBeNull();
  });

  it("describeOrganization: Repartición = la unidad; null cuando solo se conoce el Área", async () => {
    expect(await describeOrganization(O.EATC!)).toMatchObject({ area: { name: "Ministerio de Cultura" }, reparticion: { name: "Ente Autárquico Teatro Colón" } });
    expect(await describeOrganization(O.MCGC!)).toMatchObject({ area: { name: "Ministerio de Cultura" }, reparticion: null });
    expect(await describeOrganization(null)).toEqual({ area: null, reparticion: null });
  });

  it("las opciones excluyen a SUTECBA; el usuario de área ve solo su Área y sus unidades", async () => {
    const all = await listOrgTreeOptions(master);
    expect(all.some((o) => o.id === O.SUTECBA)).toBe(false);
    expect(all.filter((o) => o.depth === 0).map((o) => o.officialCode).sort()).toEqual(["MCGC", "MHFGC", "MJGGC", "PG"]);
    const culturaTree = await listOrgTreeOptions(cultura);
    expect(culturaTree.map((o) => o.officialCode).sort()).toEqual(["DGTALMC", "EATC", "MCGC"]);
    const areas = await listAreaOptions(cultura, culturaTree);
    expect(areas.map((a) => a.name)).toEqual(["Ministerio de Cultura"]);
    expect(areas[0]!.selectable).toBe(true);
  });

  it("una persona no puede tener a SUTECBA como Área/Repartición laboral", async () => {
    await expect(createPerson(master, { firstName: "Ana", lastName: "Sind", dni: "60999999", email: "", phone: "", organizationId: O.SUTECBA!, birthDate: "", declaredAge: "" } as any)).rejects.toThrow(/SUTECBA/);
  });
});

describe("Usuario Cultura: alcance por scope, no por SUTECBA", () => {
  it("ve Cultura y sus descendientes; no ve Hacienda, Procuración, IDECBA ni personas sin unidad", async () => {
    const page = await listPeoplePage(cultura, {}, { field: "name", direction: "asc" }, 1, 50);
    expect(page.rows.map((r) => r.firstName).sort()).toEqual(["cRaiz", "cTeatro1", "cTeatro2"]);
    expect(page.total).toBe(3);
  });

  it("MASTER sigue viendo todo, incluidas las personas sin unidad", async () => {
    expect(await countPeople(master, {})).toBe(8);
  });

  it("los filtros Área/Repartición son server-side y no amplían el alcance", async () => {
    expect(await countPeople(master, { areaId: O.MCGC! })).toBe(3);
    expect(await countPeople(master, { areaId: O.MCGC!, reparticionId: O.EATC! })).toBe(2);
    expect(await countPeople(master, { reparticionId: O.DGTALMHF! })).toBe(1);
    // Un usuario de Cultura que fuerza el Área de Hacienda no ve nada (y no revela que existe).
    expect(await countPeople(cultura, { areaId: O.MHFGC! })).toBe(0);
    expect(await countPeople(cultura, { areaId: "no-es-uuid" })).toBe(0);
  });

  it("la grilla informa Área y Repartición derivadas", async () => {
    const page = await listPeoplePage(master, {}, { field: "name", direction: "asc" }, 1, 50);
    const byName = new Map(page.rows.map((r) => [r.firstName, r]));
    expect(byName.get("cRaiz")).toMatchObject({ areaName: "Ministerio de Cultura", reparticionName: null });
    expect(byName.get("cTeatro1")).toMatchObject({ areaName: "Ministerio de Cultura", reparticionName: "Ente Autárquico Teatro Colón" });
    expect(byName.get("hDgtal")).toMatchObject({ areaName: "Ministerio de Hacienda y Finanzas", reparticionName: "DGTAL Hacienda" });
    expect(byName.get("sinOrg")).toMatchObject({ areaName: null, reparticionName: null });
  });
});

describe("Semáforo y KPIs (desde la última interacción real)", () => {
  it("buckets: verde 0–30, amarillo 31–60, rojo >60, gris nunca", () => {
    expect([0, 30, 31, 60, 61, null].map((d) => trafficLightOf(d as number | null))).toEqual(["green", "green", "yellow", "yellow", "red", "gray"]);
  });

  it("cada persona cae en su bucket; una interacción anulada o futura NO cuenta", async () => {
    const page = await listPeoplePage(master, {}, { field: "name", direction: "asc" }, 1, 50);
    const light = new Map(page.rows.map((r) => [r.firstName, r.trafficLight]));
    expect(Object.fromEntries(light)).toEqual({ cRaiz: "green", cTeatro1: "yellow", cTeatro2: "red", hDgtal: "green", hRaiz: "gray", pg1: "gray", idecba1: "gray", sinOrg: "gray" });
    const detail = await getPersonTraffic(master, P.cTeatro1!);
    expect(detail).toMatchObject({ trafficLight: "yellow", daysSinceInteraction: 45 });
  });

  it("los KPIs cuentan PERSONAS y responden a los filtros y al alcance", async () => {
    expect(await getTrafficKpis(master, {})).toEqual({ green: 2, yellow: 1, red: 1, gray: 4, total: 8 });
    expect(await getTrafficKpis(master, { areaId: O.MCGC! })).toEqual({ green: 1, yellow: 1, red: 1, gray: 0, total: 3 });
    expect(await getTrafficKpis(cultura, {})).toEqual({ green: 1, yellow: 1, red: 1, gray: 0, total: 3 });
    expect(await getTrafficKpis(hacienda, {})).toEqual({ green: 1, yellow: 0, red: 0, gray: 1, total: 2 });
    // El filtro de semáforo no altera los KPIs (muestran cómo se reparte el resto de los filtros).
    expect(await getTrafficKpis(master, { trafficLight: "red" })).toEqual({ green: 2, yellow: 1, red: 1, gray: 4, total: 8 });
  });

  it("el filtro por semáforo y por fecha de última interacción es server-side", async () => {
    expect(await countPeople(master, { trafficLight: "green" })).toBe(2);
    expect(await countPeople(master, { trafficLight: "gray" })).toBe(4);
    expect(await countPeople(cultura, { trafficLight: "red" })).toBe(1);
    expect(await countPeople(master, { areaId: O.MCGC!, trafficLight: "yellow" })).toBe(1);
    const from = daysAgo(50).toISOString().slice(0, 10);
    expect(await countPeople(master, { lastInteractionFrom: from })).toBe(3); // cRaiz, cTeatro1, hDgtal
    expect(await countPeople(master, { lastInteractionFrom: "no-es-fecha" })).toBe(0);
  });
});

describe("Reuniones de SUTECBA vistas por un usuario de área", () => {
  it("el usuario ve la reunión si tiene participantes suyos; no la ve si no los tiene; MASTER ve todas", async () => {
    const ids = async (actor: any) => (await listMeetings(actor, { status: "all" })).map((m) => m.name).sort();
    expect(await ids(master)).toEqual(["canale", "cursoRCP", "sinFecha", "soloCampana", "soloHacienda"]);
    expect(await ids(cultura)).toEqual(["canale", "cursoRCP", "sinFecha", "soloCampana"]); // soloHacienda: sin participantes de Cultura
    expect(await ids(hacienda)).toEqual(["canale", "cursoRCP", "soloHacienda"]); // canale: hDgtal está inscripto a nivel de campaña; soloCampana: no hay inscriptos de Hacienda
  });

  it("dar visibilidad NO da control: solo el alcance propietario opera; y acceder sigue siendo por id (IDOR)", async () => {
    expect(await canViewMeeting(cultura, M.cursoRCP!)).toBe(true);
    expect(await canAccessMeeting(cultura, M.cursoRCP!)).toBe(false);
    expect(await canViewMeeting(cultura, M.soloHacienda!)).toBe(false);
    expect((await getMeetingById(cultura, M.cursoRCP!))?.accessLevel).toBe("participants");
    expect(await getMeetingById(cultura, M.soloHacienda!)).toBeNull();
    expect((await getMeetingById(master, M.cursoRCP!))?.accessLevel).toBe("owner");
  });

  it("los conteos y participantes respetan el alcance: Cultura no ve a los de Hacienda ni a los de Procuración", async () => {
    const rcpMaster = (await listMeetings(master, { status: "all" })).find((m) => m.name === "cursoRCP")!;
    const rcpCultura = (await listMeetings(cultura, { status: "all" })).find((m) => m.name === "cursoRCP")!;
    expect(rcpMaster.participantsCount).toBe(4);
    expect(rcpCultura.participantsCount).toBe(2);

    const forCultura = await listMeetingParticipants(cultura, M.cursoRCP!);
    expect(forCultura.assigned.map((p) => p.firstName).sort()).toEqual(["cTeatro1", "cTeatro2"]);
    const forMaster = await listMeetingParticipants(master, M.cursoRCP!);
    expect(forMaster.assigned.map((p) => p.firstName).sort()).toEqual(["cTeatro1", "cTeatro2", "hDgtal", "pg1"]);
  });

  it("inscripto ≠ participó: estados, origen, Área/Repartición y fecha (date_only solo con día)", async () => {
    const { assigned } = await listMeetingParticipants(master, M.cursoRCP!);
    const by = new Map(assigned.map((p) => [p.firstName, p]));
    expect(by.get("cTeatro1")).toMatchObject({ status: "registered", areaName: "Ministerio de Cultura", reparticionName: "Ente Autárquico Teatro Colón", date: null });
    expect(by.get("cTeatro2")).toMatchObject({ status: "attended", datePrecision: "date_only" });
    expect(by.get("cTeatro2")!.date).not.toBeNull();
    expect(by.get("cTeatro2")!.statusLabel).toMatch(/Participó/);
    expect(by.get("cTeatro1")!.statusLabel).toMatch(/no implica asistencia/);
  });

  it("las participaciones de campaña sin jornada NO se asignan a la reunión: van aparte, filtradas por alcance", async () => {
    expect(campaignKeyOfMeeting("ophthalmology:2026-03-11:canale")).toBe("ophthalmology:canale");
    expect(campaignKeyOfMeeting("training:52010")).toBeNull();
    const master_ = await listMeetingParticipants(master, M.canale!);
    expect(master_.assigned.map((p) => p.firstName)).toEqual(["cRaiz"]);
    expect(master_.campaign?.participants.map((p) => p.firstName).sort()).toEqual(["cTeatro1", "hDgtal"]);
    const c = await listMeetingParticipants(cultura, M.canale!);
    expect(c.campaign?.participants.map((p) => p.firstName)).toEqual(["cTeatro1"]);
    // Ninguna quedó asignada a una jornada por descarte.
    expect(master_.assigned.some((p) => p.firstName === "cTeatro1")).toBe(false);
  });

  it("una reunión cuyos únicos inscriptos del usuario están a nivel de campaña se ve, y ahí aparecen SIN jornada asignada (solo los de su alcance)", async () => {
    const c = await listMeetingParticipants(cultura, M.soloCampana!);
    expect(c.assigned).toEqual([]);
    expect(c.campaign?.participants.map((p) => p.firstName)).toEqual(["cTeatro2"]);
    const m = await listMeetingParticipants(master, M.soloCampana!);
    expect(m.campaign?.participants.map((p) => p.firstName).sort()).toEqual(["cTeatro2", "pg1"]);
    expect((await getMeetingById(cultura, M.soloCampana!))?.accessLevel).toBe("participants");
    expect(await canAccessMeeting(cultura, M.soloCampana!)).toBe(false);
  });

  it("sin people.view_sensitive el DNI de los participantes sale enmascarado", async () => {
    const limited = { ...cultura, permissions: new Set([...PERMS].filter((p) => p !== "people.view_sensitive")) };
    const { assigned } = await listMeetingParticipants(limited, M.cursoRCP!);
    expect(assigned.every((p) => p.dni?.includes("*"))).toBe(true);
    const { assigned: full } = await listMeetingParticipants(cultura, M.cursoRCP!);
    expect(full.every((p) => !p.dni?.includes("*"))).toBe(true);
  });
});

describe("Interacción automática por participación real (idempotente)", () => {
  it("solo 'attended' con fecha genera interacción: la inscripción no; date_only conserva la precisión", async () => {
    const db = await getDb();
    const before = (await db.selectFrom("person_interactions").select("id").execute()).length;
    const result = await syncParticipationInteractions(db, { actorUserId: masterId });
    expect(result.created).toBe(2); // cTeatro2 y hDgtal en el curso (fecha date_only); la de «sinFecha» no tiene fecha
    expect(result.skippedWithoutDate).toBe(1);
    const rows = await db.selectFrom("person_interactions").selectAll().where("source_key", "like", "meeting_participation:%").execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.occurred_precision === "date_only" && r.status === "completed" && r.subject.startsWith("Participó en capacitación: cursoRCP"))).toBe(true);
    // occurred_at = 00:00 de Buenos Aires del día de la actividad (nunca una hora inventada)
    const local = await sql<{ t: string }>`select to_char(occurred_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI') as t from person_interactions where source_key like 'meeting_participation:%' limit 1`.execute(db);
    expect(local.rows[0]!.t).toBe("2026-03-10 00:00");
    expect((await db.selectFrom("person_interactions").select("id").execute()).length).toBe(before + 2);
    // La interacción de cTeatro2 queda en la unidad de la persona (así la ve su área).
    const mine = await db.selectFrom("person_interactions").select("owner_organization_id").where("person_id", "=", P.cTeatro2!).where("source_key", "is not", null).executeTakeFirstOrThrow();
    expect(mine.owner_organization_id).toBe(O.EATC);
  });

  it("es idempotente: reprocesar la reunión no duplica", async () => {
    const db = await getDb();
    const before = (await db.selectFrom("person_interactions").select("id").execute()).length;
    const again = await syncParticipationInteractions(db, { actorUserId: masterId });
    const scoped = await syncParticipationInteractions(db, { meetingId: M.cursoRCP!, actorUserId: masterId });
    expect(again.created).toBe(0);
    expect(scoped.created).toBe(0);
    expect((await db.selectFrom("person_interactions").select("id").execute()).length).toBe(before);
  });

  it("la interacción de participación entra al semáforo con la fecha de la actividad", async () => {
    // La actividad fue el 2026-03-10: cTeatro2 pasa de 'rojo por una llamada vieja' a la fecha más reciente entre ambas.
    const t = await getPersonTraffic(master, P.cTeatro2!);
    expect(t?.lastInteractionDate).not.toBeNull();
    // Una participación futura respecto de hoy no existe: la fecha es la mayor entre la llamada (hace 200 días) y la actividad.
    const days = t!.daysSinceInteraction!;
    expect(days).toBeLessThanOrEqual(200);
  });

  it("una fecha desconocida no inventa nada: al tener fecha, la interacción se genera sin duplicar", async () => {
    const db = await getDb();
    await db.updateTable("meetings").set({ schedule_precision: "date_only", event_date: new Date("2026-04-01T00:00:00Z") } as never).where("id", "=", M.sinFecha!).execute();
    const result = await syncParticipationInteractions(db, { actorUserId: masterId });
    expect(result.created).toBe(1);
    expect(result.skippedWithoutDate).toBe(0);
    expect((await syncParticipationInteractions(db, { actorUserId: masterId })).created).toBe(0);
  });

  it("el check-in real genera la interacción; corregido a 'ausente' se anula; vuelto a 'asistió' se reactiva", async () => {
    const db = await getDb();
    const inv = await db
      .insertInto("meeting_invitations")
      .values({ meeting_id: M.soloHacienda!, person_id: P.hRaiz!, token_hash: randomUUID(), attendance_status: "attended" } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    const att = await db
      .insertInto("meeting_attendance")
      .values({ meeting_id: M.soloHacienda!, person_id: P.hRaiz!, invitation_id: inv.id, method: "dni" } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    const created = await syncParticipationInteractions(db, { meetingId: M.soloHacienda!, actorUserId: masterId });
    expect(created.created).toBe(1);
    const key = `meeting_attendance:${att.id}`;
    const status = async () => (await db.selectFrom("person_interactions").select(["status", "occurred_precision"]).where("source_key", "=", key).executeTakeFirstOrThrow());
    expect(await status()).toMatchObject({ status: "completed", occurred_precision: "exact_datetime" });
    expect((await getPersonTraffic(master, P.hRaiz!))?.trafficLight).toBe("green");

    await db.updateTable("meeting_invitations").set({ attendance_status: "absent" }).where("id", "=", inv.id).execute();
    const voided = await syncParticipationInteractions(db, { meetingId: M.soloHacienda!, actorUserId: masterId });
    expect(voided.voided).toBe(1);
    expect((await status()).status).toBe("voided");
    expect((await getPersonTraffic(master, P.hRaiz!))?.trafficLight).toBe("gray");

    await db.updateTable("meeting_invitations").set({ attendance_status: "attended" }).where("id", "=", inv.id).execute();
    expect((await syncParticipationInteractions(db, { meetingId: M.soloHacienda!, actorUserId: masterId })).reactivated).toBe(1);
    expect((await status()).status).toBe("completed");
  });

  it("la restricción de base impide un date_only con hora inventada y una source_key repetida", async () => {
    const db = await getDb();
    const type = (await db.selectFrom("interaction_types").select("id").where("key", "=", "llamada").executeTakeFirstOrThrow()).id;
    const base = { person_id: P.pg1!, owner_organization_id: O.PG!, interaction_type_id: type, subject: "x", status: "completed", created_by: masterId };
    await expect(db.insertInto("person_interactions").values({ ...base, occurred_at: new Date("2026-03-10T15:30:00Z"), occurred_precision: "date_only" } as never).execute()).rejects.toThrow();
    const ok = { ...base, occurred_at: new Date("2026-03-10T15:30:00Z"), source_key: "k:unico" };
    await db.insertInto("person_interactions").values(ok as never).execute();
    await expect(db.insertInto("person_interactions").values(ok as never).execute()).rejects.toThrow();
  });
});

describe("Usuarios: afiliación (Área/Repartición) separada de autorización (scopes)", () => {
  it("crear con Área+Repartición guarda la afiliación y el scope pedido; la afiliación sola NO da acceso", async () => {
    const created = await createUser(master, {
      email: "afiliado@sutecba.local",
      fullName: "Afiliado",
      roleKey: "ADMIN",
      scopes: [{ organizationId: O.MCGC!, includeDescendants: true }],
      moduleKeys: ["personas"],
      primaryOrganizationId: O.EATC!,
    });
    const db = await getDb();
    const row = await db.selectFrom("users").select("primary_organization_id").where("id", "=", created.userId).executeTakeFirstOrThrow();
    expect(row.primary_organization_id).toBe(O.EATC);
    const scopes = await db.selectFrom("user_scopes").select(["organization_id", "include_descendants"]).where("user_id", "=", created.userId).execute();
    expect(scopes).toEqual([{ organization_id: O.MCGC, include_descendants: true }]);

    // Cambiar la afiliación a Hacienda NO cambia lo que ve: eso lo definen los scopes.
    await setUserPrimaryOrganization(master, created.userId, O.MHFGC!);
    const afiliado = actorOf(created.userId, "ADMIN");
    expect((await listPeoplePage(afiliado, {}, { field: "name", direction: "asc" }, 1, 50)).total).toBe(3);
  });

  it("la afiliación no puede ser SUTECBA ni una unidad inexistente o fuera del alcance de quien la asigna", async () => {
    await expect(createUser(master, { email: "x1@sutecba.local", fullName: "X", roleKey: "ADMIN", primaryOrganizationId: O.SUTECBA! })).rejects.toThrow(/SUTECBA/);
    await expect(createUser(master, { email: "x2@sutecba.local", fullName: "X", roleKey: "ADMIN", primaryOrganizationId: randomUUID() })).rejects.toThrow();
  });
});

describe("registration + participated: estado efectivo sin doble conteo", () => {
  let beforeDashboard: Awaited<ReturnType<typeof getDashboardCounts>>;
  let beforeKpis: Awaited<ReturnType<typeof getTrafficKpis>>;
  beforeAll(async () => {
    beforeDashboard = await getDashboardCounts(cultura);
    beforeKpis = await getTrafficKpis(cultura, {});
    const db = await getDb();
    await db.insertInto("meeting_participations").values([
      { person_id: P.cTeatro1!, meeting_id: M.cursoRCP!, participation_kind: "participated", participation_basis: "legacy_initial_import" },
      { person_id: P.cTeatro1!, campaign_key: "ophthalmology:canale", participation_kind: "participated", participation_basis: "legacy_initial_import" },
    ]).execute();
  });
  it("listado y contador cuentan una persona; participated tiene fecha real", async () => {
    const participants = await listMeetingParticipants(cultura, M.cursoRCP!);
    expect(participants.assigned).toHaveLength(2);
    const row = participants.assigned.find((p) => p.personId === P.cTeatro1)!;
    expect(row.statusLabel).toBe("Participó");
    expect(row.date).not.toBeNull();
    expect(row.datePrecision).toBe("date_only");
    expect((await listMeetings(cultura)).find((m) => m.id === M.cursoRCP)?.participantsCount).toBe(2);
  });
  it("campaña conserva una fila, sin jornada ni fecha inventadas", async () => {
    const participants = (await listMeetingParticipants(cultura, M.canale!)).campaign!.participants;
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({ statusLabel: "Participó — jornada no determinada", date: null });
  });
  it("ficha incluye jornada y campaña una vez, y respeta el alcance Cultura", async () => {
    const rows = await getPersonMeetingActivity(cultura, P.cTeatro1!);
    expect(rows.filter((r) => r.meetingId === M.cursoRCP)).toHaveLength(1);
    expect(rows.find((r) => r.meetingId === M.cursoRCP)).toMatchObject({ statusLabel: "Participó", invited: false, datePrecision: "date_only" });
    expect(rows.find((r) => r.meetingId === "campaign:ophthalmology:canale")).toMatchObject({ statusLabel: "Participó — jornada no determinada", startsAt: null });
    expect(await getPersonMeetingActivity(cultura, P.hDgtal!)).toEqual([]);
  });
  it("exportación, dashboard y KPIs no multiplican personas por filas históricas", async () => {
    const csv = await exportPeopleCsv(cultura, {}, { field: "name", direction: "asc" });
    expect(csv.trim().split(/\r?\n/)).toHaveLength(4);
    expect(csv.match(/cTeatro1/g)).toHaveLength(1);
    expect(csv).not.toContain("hDgtal");
    expect(await getDashboardCounts(cultura)).toEqual(beforeDashboard);
    expect(await getTrafficKpis(cultura, {})).toEqual(beforeKpis);
  });
});
