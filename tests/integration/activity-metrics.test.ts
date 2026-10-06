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
const { loadMeetingMetrics, loadCampaignMetrics } = await import("../../lib/activities/metrics.js");
const labels = await import("../../lib/activities/labels.js");
const { listCampaigns, listCampaignParticipants } = await import("../../lib/campaigns/queries.js");
const { listMeetingParticipants } = await import("../../lib/meetings/participants.js");
const { listInvitations } = await import("../../lib/meetings/invitations.js");
const { getLivePanelData } = await import("../../lib/attendance/live.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const PERMS = new Set(PERMISSIONS.map((p) => p.key));
const O: Record<string, string> = {};
const P: Record<string, string> = {};
const M: Record<string, string> = {};
const C: Record<string, string> = {};
let masterId: string;
let master: any;
let cultura: any;
let hacienda: any;
let reparticion: any;

function actorOf(id: string, roleKey: "MASTER_GLOBAL" | "ADMIN", permissions: Set<string> = PERMS): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions };
}
async function makeUser(email: string, roleKey: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id, status: "active" } as never).returning("id").executeTakeFirstOrThrow()).id;
}
const num = (m: { kind: string; value?: number }) => (m.kind === "value" ? m.value : m.kind);

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
  const tSind = await type("sindicato", "Sindicato", 0);
  const org = async (code: string, name: string, typeId: string, parent: string | null) => {
    O[code] = (await db.insertInto("organizations").values({ name, type_id: typeId, parent_id: parent, official_code: code }).returning("id").executeTakeFirstOrThrow()).id;
  };
  await org("MCGC", "Ministerio de Cultura", tMin, null);
  await org("DGC", "DG Cultura", tDg, O.MCGC!);
  await org("MHFGC", "Ministerio de Hacienda", tMin, null);
  await org("SUTECBA", "Sindicato Único", tSind, null);

  masterId = await makeUser("am-master@sutecba.local", "MASTER_GLOBAL");
  master = actorOf(masterId, "MASTER_GLOBAL");
  const culturaId = await makeUser("am-cultura@sutecba.local", "ADMIN");
  const haciendaId = await makeUser("am-hacienda@sutecba.local", "ADMIN");
  const repId = await makeUser("am-rep@sutecba.local", "ADMIN");
  const scope = (user: string, orgId: string) => db.insertInto("user_scopes").values({ user_id: user, organization_id: orgId, include_descendants: true, granted_by: masterId } as never).execute();
  await scope(culturaId, O.MCGC!);
  await scope(haciendaId, O.MHFGC!);
  await scope(repId, O.DGC!);
  cultura = actorOf(culturaId, "ADMIN");
  hacienda = actorOf(haciendaId, "ADMIN");
  reparticion = actorOf(repId, "ADMIN");

  const person = async (key: string, dni: string, orgCode: string | null) => {
    P[key] = (await db.insertInto("people").values({ first_name: key, last_name: "Apellido", dni, organization_id: orgCode ? O[orgCode]! : null, origin: "import" } as never).returning("id").executeTakeFirstOrThrow()).id;
  };
  await person("a", "80000001", "MCGC");
  await person("b", "80000002", "MCGC");
  await person("c", "80000003", "MHFGC");
  await person("d", "80000004", null);
  await person("e", "80000005", "MCGC");
  await person("f", "80000006", "DGC");

  const meeting = async (key: string, values: Record<string, unknown>) => {
    M[key] = (await db.insertInto("meetings").values({ name: key, owner_organization_id: O.SUTECBA!, organizer_user_id: masterId, created_by: masterId, ...values } as never).returning("id").executeTakeFirstOrThrow()).id;
  };
  const manual = { origin: "manual", status: "in_progress", meeting_type: "reunion", schedule_precision: "exact_datetime", starts_at: new Date(Date.now() - 3600_000), ends_at: new Date(Date.now() + 3600_000) };
  const imported = (key: string) => ({ origin: "import", status: "finished", meeting_type: "operativo_salud", schedule_precision: "date_only", event_date: new Date("2026-03-10T00:00:00Z"), source_event_key: key });
  await meeting("m1", manual);
  await meeting("imp", imported("ophthalmology:2026-03-10:imp"));
  await meeting("j1", imported("ophthalmology:2026-03-11:camp"));
  await meeting("j2", { ...manual, source_event_key: null });

  const invite = (m: string, p: string, response: string, extra: Record<string, unknown> = {}) =>
    db.insertInto("meeting_invitations").values({ meeting_id: M[m]!, person_id: P[p]!, token_hash: randomUUID(), response_status: response, ...extra } as never).execute();
  const attend = (m: string, p: string) =>
    db.insertInto("meeting_attendance").values({ meeting_id: M[m]!, person_id: P[p]!, method: "manual", registered_by: masterId, correction_reason: "test" } as never).execute();
  const part = (m: string | null, ck: string | null, p: string, kind: string, basis = "standard") =>
    db.insertInto("meeting_participations").values({ meeting_id: m ? M[m]! : null, campaign_key: ck, person_id: P[p]!, participation_kind: kind, participation_basis: basis, evidence: "test" } as never).execute();

  // m1 (reunión gestionada): invitados a,b,c,d,e con respuestas distintas; asistencia a (invitado, aceptó), e (invitado, sin responder), f (SIN invitación)
  await invite("m1", "a", "confirmed");
  await invite("m1", "b", "declined");
  await invite("m1", "c", "pending");
  await invite("m1", "d", "pending");
  await invite("m1", "e", "pending");
  await attend("m1", "a");
  await attend("m1", "e");
  await attend("m1", "f");
  await part("m1", null, "a", "registration");
  await part("m1", null, "b", "registration");
  await part("m1", null, "e", "participated", "source_business_rule");

  // Campaña con 2 jornadas (j1 importada, j2 gestionada) y registros a nivel campaña
  for (const [key, name] of [["vaccination:t", "Campaña con jornadas"], ["ophthalmology:solo", "Campaña sin reunión"]] as const) {
    C[key] = (await db.insertInto("campaigns").values({ campaign_key: key, name, campaign_type: key.startsWith("vac") ? "vaccination" : "ophthalmology", owner_organization_id: O.SUTECBA!, origin: "import", historical_condition: "imported_undated", created_by: masterId } as never).returning("id").executeTakeFirstOrThrow()).id;
  }
  await db.updateTable("meetings").set({ campaign_id: C["vaccination:t"]! } as never).where("id", "in", [M.j1!, M.j2!] as never).execute();
  // a: declinó j1 y aceptó j2 → aceptó; b: pendiente en j1 y rechazó j2 → pendiente; c: rechazó j1 → rechazó
  await invite("j1", "a", "declined");
  await invite("j2", "a", "confirmed");
  await invite("j1", "b", "pending");
  await invite("j2", "b", "declined");
  await invite("j1", "c", "declined");
  await attend("j1", "a");
  await attend("j2", "a");
  await part(null, "vaccination:t", "a", "participated", "source_business_rule");
  await part(null, "vaccination:t", "b", "registration");
  await part("j1", null, "b", "registration");
  await part(null, "ophthalmology:solo", "a", "participated", "legacy_initial_import");
  await part(null, "ophthalmology:solo", "a", "registration");
  await part(null, "ophthalmology:solo", "e", "registration");
  // importada sin invitaciones ni asistencia
  await part("imp", null, "a", "registration");
  await part("imp", null, "b", "participated", "source_business_rule");
});

afterAll(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("métricas puras (labels)", () => {
  it("nunca muestra 0 donde el dato no se releva: «No disponible» / «Sin información»", () => {
    const m = labels.buildMetrics({ invited: 0, accepted: 0, declined: 0, pending: 0, registered: 0, participated: 0, attended: 0, invitationsTracked: false, attendanceTracked: false });
    expect(labels.metricText(m.invited)).toBe("No disponible");
    expect(labels.metricText(m.accepted)).toBe("No disponible");
    expect(labels.metricText(m.attended)).toBe("Sin información");
    expect(labels.metricText(m.registered)).toBe("0"); // viene de registros cargados: es un número
    const tracked = labels.buildMetrics({ invited: 0, accepted: 0, declined: 0, pending: 0, registered: 0, participated: 0, attended: 0, invitationsTracked: true, attendanceTracked: true });
    expect(labels.metricText(tracked.invited)).toBe("0");
    expect(labels.metricText(tracked.attended)).toBe("0");
  });

  it("los chips son hechos independientes (sin estado único) y no hay hecho de actividad que cuente como contacto", () => {
    const base: import("../../lib/activities/labels.js").PersonActivityFacts = { invited: false, response: null, registered: false, participated: false, participationBases: [], attended: false };
    expect(labels.factChips({ ...base })).toEqual([]);
    expect(labels.factChips({ ...base, registered: true }).map((c) => c.label)).toEqual(["Inscripto"]); // 52016: solo inscripción
    expect(labels.factChips({ ...base, invited: true, response: "confirmed" }).map((c) => c.label)).toEqual(["Invitado", "Aceptó"]);
    expect(labels.factChips({ ...base, invited: true, response: "pending", registered: true, participated: true, attended: true }).map((c) => c.label)).toEqual(["Invitado", "Sin respuesta", "Inscripto", "Participó", "Asistió"]);
    expect(Object.values(labels.ACTIVITY_FACT_COUNTS_AS_CONTACT).every((v) => v === false)).toBe(true);
  });
});

describe("B1 · métricas de reunión/jornada", () => {
  it("Master: siete conteos por persona distinta; Asistieron ⊆ Participaron derivado, sin fila física de participación", async () => {
    const db = await getDb();
    const before = await db.selectFrom("meeting_participations").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow();
    const m = (await loadMeetingMetrics(master, [M.m1!])).get(M.m1!)!;
    expect(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, num(v as any)]))).toEqual({
      invited: 5, accepted: 1, declined: 1, pending: 3, // partición disjunta: 1+1+3 = 5
      registered: 2, // a, b
      participated: 3, // explícito e ∪ asistencia a, e, f → {a, e, f}
      attended: 3, // a, e, f (f sin invitación)
    });
    // el check-in NO creó participaciones físicas
    expect((await db.selectFrom("meeting_participations").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow()).n).toBe(before.n);
    expect(await db.selectFrom("meeting_participations").select("id").where("person_id", "=", P.a!).where("meeting_id", "=", M.m1!).where("participation_kind", "=", "participated").execute()).toHaveLength(0);
  });

  it("scopes: Área, Repartición, otra Área y persona sin organización", async () => {
    const get = async (actor: any) => Object.fromEntries(Object.entries((await loadMeetingMetrics(actor, [M.m1!])).get(M.m1!)!).map(([k, v]) => [k, num(v as any)]));
    expect(await get(cultura)).toEqual({ invited: 3, accepted: 1, declined: 1, pending: 1, registered: 2, participated: 3, attended: 3 }); // a, b, e, f; sin c ni d
    expect(await get(hacienda)).toEqual({ invited: 1, accepted: 0, declined: 0, pending: 1, registered: 0, participated: 0, attended: 0 }); // solo c
    expect(await get(reparticion)).toEqual({ invited: 0, accepted: 0, declined: 0, pending: 0, registered: 0, participated: 1, attended: 1 }); // solo f (dentro de DG Cultura)
    // la persona sin organización (d) cuenta solo para Master
    expect(num((await loadMeetingMetrics(master, [M.m1!])).get(M.m1!)!.invited as any)).toBe(5);
  });

  it("actividad importada: invitaciones «No disponible», asistencia «Sin información»; inscripción y participación por registros", async () => {
    const m = (await loadMeetingMetrics(master, [M.imp!])).get(M.imp!)!;
    expect(labels.metricText(m.invited)).toBe("No disponible");
    expect(labels.metricText(m.accepted)).toBe("No disponible");
    expect(labels.metricText(m.attended)).toBe("Sin información");
    expect(num(m.registered as any)).toBe(1);
    expect(num(m.participated as any)).toBe(1); // b por regla de la fuente: participación, NO asistencia
    expect(labels.metricText(m.attended)).not.toBe("1");
  });

  it("attendance_status de la invitación está deprecado: no genera asistencia ni chip", async () => {
    const db = await getDb();
    await db.updateTable("meeting_invitations").set({ attendance_status: "attended" } as never).where("meeting_id", "=", M.m1!).where("person_id", "=", P.b!).execute();
    const m = (await loadMeetingMetrics(master, [M.m1!])).get(M.m1!)!;
    expect(num(m.attended as any)).toBe(3); // sigue siendo a, e, f: b no tiene fila de asistencia
    const parts = await listMeetingParticipants(master, M.m1!);
    expect(parts.assigned.find((p) => p.firstName === "b")!.facts.attended).toBe(false);
    const inv = (await listInvitations(master, M.m1!)).find((i) => i.firstName === "b")!;
    expect(inv.attended).toBe(false);
    await db.updateTable("meeting_invitations").set({ attendance_status: "unknown" } as never).where("meeting_id", "=", M.m1!).where("person_id", "=", P.b!).execute();
  });
});

describe("B1 · hechos independientes por persona", () => {
  it("cada persona muestra sus hechos y su procedencia humana; el código técnico queda aparte", async () => {
    const parts = await listMeetingParticipants(master, M.m1!);
    const by = new Map(parts.assigned.map((p) => [p.firstName, p]));
    expect(by.get("a")!.facts).toMatchObject({ invited: true, response: "confirmed", registered: true, participated: true, attended: true, participationBases: [] });
    expect(by.get("e")!.facts).toMatchObject({ invited: true, response: "pending", registered: false, participated: true, attended: true, participationBases: ["source_business_rule"] });
    expect(by.get("f")!.facts).toMatchObject({ invited: false, response: null, registered: false, attended: true });
    expect(by.get("b")!.facts).toMatchObject({ invited: true, response: "declined", registered: true, participated: false, attended: false });
    expect(by.get("e")!.provenance).toContain("Participación acreditada por regla de la fuente");
    expect(by.get("a")!.provenance).toContain("Asistencia registrada manualmente");
    expect(by.get("a")!.provenance.join(" ")).not.toMatch(/\b[FT]\d{2}\b/);
  });

  it("52016 / registro estándar: solo inscripción; legacy: participación histórica; ninguno es asistencia", async () => {
    const imp = await listMeetingParticipants(master, M.imp!);
    const a = imp.assigned.find((p) => p.firstName === "a")!;
    expect(a.facts).toMatchObject({ registered: true, participated: false, attended: false, invited: false });
    const b = imp.assigned.find((p) => p.firstName === "b")!;
    expect(b.facts).toMatchObject({ participated: true, attended: false, participationBases: ["source_business_rule"] });
    const camp = await listCampaignParticipants(master, C["ophthalmology:solo"]!);
    const ca = camp.rows.find((r) => r.firstName === "a")!;
    expect(ca).toMatchObject({ participated: true, registered: true, attended: false, participationBases: ["legacy_initial_import"] });
  });

  it("el panel en vivo usa la asistencia real: invitados que asistieron sobre invitados, sin leer attendance_status", async () => {
    const live = (await getLivePanelData(master, M.m1!))!;
    expect(live.invited).toBe(5);
    expect(live.present).toBe(3); // a, e, f
    expect(live.invitedNotArrived).toBe(3); // b, c, d
    expect(live.attendanceRate).toBe(40); // a y e de 5 invitados
  });
});

describe("B1 · métricas de campaña", () => {
  it("campaña con jornadas: DISTINCT por persona sobre campaña ∪ jornadas, respuesta de campaña disjunta, asistencia en 2 jornadas cuenta una vez", async () => {
    const m = (await loadCampaignMetrics(master, [C["vaccination:t"]!])).get(C["vaccination:t"]!)!;
    expect(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, num(v as any)]))).toEqual({
      invited: 3, accepted: 1, declined: 1, pending: 1, // a aceptó (algún sí), b pendiente (pendiente ≻ rechazó), c rechazó
      registered: 1, // b (a nivel campaña y en j1: una vez)
      participated: 1, // a: regla de fuente a nivel campaña + asistencia en 2 jornadas = una persona
      attended: 1,
    });
    expect(m.invited.kind).toBe("value");
  });

  it("campaña sin reunión: invitaciones «No disponible», asistencia «Sin información»; solo registros a nivel campaña", async () => {
    const m = (await loadCampaignMetrics(master, [C["ophthalmology:solo"]!])).get(C["ophthalmology:solo"]!)!;
    expect(labels.metricText(m.invited)).toBe("No disponible");
    expect(labels.metricText(m.attended)).toBe("Sin información");
    expect(num(m.registered as any)).toBe(2); // a, e
    expect(num(m.participated as any)).toBe(1); // a (legacy)
  });

  it("la lista de campañas y el módulo común coinciden; scopes aplican a la campaña", async () => {
    const list = await listCampaigns(master);
    for (const c of list) {
      const direct = (await loadCampaignMetrics(master, [c.id])).get(c.id)!;
      expect(c.participatedCount).toBe(num(direct.participated as any));
      expect(c.registeredCount).toBe(num(direct.registered as any));
    }
    const camp = (await listCampaigns(cultura)).find((c) => c.key === "vaccination:t")!;
    expect(num(camp.metrics.invited as any)).toBe(2); // a, b (c es de Hacienda)
    expect(num(camp.metrics.participated as any)).toBe(1);
  });

  it("personas de la campaña traen hechos independientes (respuesta, inscripción, participación, asistencia)", async () => {
    const page = await listCampaignParticipants(master, C["vaccination:t"]!);
    const by = new Map(page.rows.map((r) => [r.firstName, r]));
    expect(by.get("a")).toMatchObject({ response: "confirmed", participated: true, attended: true, registered: false, participationBases: ["source_business_rule"] });
    expect(by.get("b")).toMatchObject({ response: "pending", registered: true, participated: false, attended: false });
    expect(by.get("c")).toMatchObject({ response: "declined", registered: false, participated: false, attended: false });
  });
});
