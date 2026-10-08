import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.SUTECBA_QR_SECRET = "test-secret-not-for-prod-0123456789";

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const rc = await import("../../lib/contacts/real-contact.js");
const tl = await import("../../lib/people/timeline.js");
const { sanitizeFreeText } = await import("../../lib/people/sanitize-text.js");
const { getPersonTraffic, listPeoplePage } = await import("../../lib/people/queries.js");
const reg = await import("../../lib/meetings/registrations.js");
const inv = await import("../../lib/meetings/invitations.js");
const att = await import("../../lib/attendance/manual.js");
const { getParticipationInteractionKpis } = await import("../../lib/analytics/queries.js");
const { trafficLightOf, TRAFFIC_LABEL } = await import("../../lib/people/traffic.js");
const { formatTimelineDate, formatActivityContext } = await import("../../lib/people/timeline-format.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));
const O: Record<string, string> = {};
let masterId: string;
let master: any;
let culturaOp: any;
let haciendaOp: any;
let culturaNoSens: any;
let culturaNoInteractions: any;
let culturaNoManage: any;
let seq = 0;
const typeId: Record<string, string> = {};
const channelId: Record<string, string> = {};

function actorOf(id: string, roleKey: "MASTER_GLOBAL" | "ADMIN", permissions: Set<string> = ALL): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions };
}
const without = (...keys: string[]) => new Set([...ALL].filter((k) => !keys.includes(k)));
async function makeUser(email: string, roleKey: string, fullName: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: fullName, role_id: role.id, status: "active" } as never).returning("id").executeTakeFirstOrThrow()).id;
}
async function person(orgCode: string | null = "MCGC") {
  const db = await getDb();
  seq += 1;
  return (await db.insertInto("people").values({ first_name: `Per${seq}`, last_name: `Ape${seq}`, dni: `7${String(seq).padStart(7, "0")}`, organization_id: orgCode ? O[orgCode]! : null, origin: "import" } as never).returning("id").executeTakeFirstOrThrow()).id;
}
async function meeting(status: "scheduled" | "in_progress" | "finished", extra: Record<string, unknown> = {}) {
  const db = await getDb();
  seq += 1;
  const when = status === "finished" ? { starts_at: new Date(Date.now() - 20 * 86400_000), ends_at: new Date(Date.now() - 20 * 86400_000 + 3600_000) } : { starts_at: new Date(Date.now() + 3_600_000), ends_at: new Date(Date.now() + 7_200_000) };
  return (
    await db
      .insertInto("meetings")
      .values({ name: `Reunión ${seq}`, owner_organization_id: O.MCGC!, organizer_user_id: masterId, created_by: masterId, origin: "manual", status, meeting_type: "reunion", schedule_precision: "exact_datetime", ...when, ...extra } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
interface ContactOpts { type?: string; channel?: string | null; status?: string; at?: Date; owner?: string; subject?: string; sourceKey?: string | null; description?: string | null; outcome?: string | null; responsible?: string | null; meetingId?: string | null; dateBasis?: string; precision?: string }
async function interaction(personId: string, o: ContactOpts = {}) {
  const db = await getDb();
  const p = await db.selectFrom("people").select("organization_id").where("id", "=", personId).executeTakeFirstOrThrow();
  const values: Record<string, unknown> = {
    person_id: personId,
    owner_organization_id: o.owner ?? p.organization_id ?? O.SUTECBA!,
    occurred_at: o.at ?? daysAgo(5),
    occurred_precision: o.precision ?? "exact_datetime",
    interaction_type_id: typeId[o.type ?? "llamada"],
    channel_id: o.channel === null ? null : channelId[o.channel ?? "whatsapp"],
    subject: o.subject ?? "Llamada",
    description: o.description ?? null,
    outcome: o.outcome ?? null,
    responsible_user_id: o.responsible ?? null,
    status: o.status ?? "completed",
    void_reason: o.status === "voided" ? "error de carga" : null,
    created_by: masterId,
    source_key: o.sourceKey ?? null,
    meeting_id: o.meetingId ?? null,
    date_basis: o.dateBasis ?? "actual",
  };
  return (await db.insertInto("person_interactions").values(values as never).returning("id").executeTakeFirstOrThrow()).id;
}
const snapshot = async () => {
  const db = await getDb();
  return (
    await sql<{ i: string; p: string; a: string }>`
      select (select md5(coalesce(string_agg(x::text, '|' order by id), '')) from person_interactions x) i,
             (select md5(coalesce(string_agg(x::text, '|' order by id), '')) from meeting_participations x) p,
             (select count(*)::text from meeting_attendance) a`.execute(db)
  ).rows[0]!;
};
const lines = (page: { events: any[] } | null) => (page?.events ?? []).map((e) => `${e.category}/${e.kind}`);
const allEvents = async (actor: any, personId: string, categories: any[] = []) => {
  const out: any[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const page: any = await tl.getPersonTimeline(actor, personId, { categories, cursor, limit: 3 });
    if (!page) return null;
    out.push(...page.events);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
  throw new Error("paginación sin fin");
};

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
  const org = async (code: string, name: string, typeIdValue: string) => {
    O[code] = (await db.insertInto("organizations").values({ name, type_id: typeIdValue, parent_id: null, official_code: code }).returning("id").executeTakeFirstOrThrow()).id;
  };
  await org("MCGC", "Ministerio de Cultura", tMin);
  await org("MHFGC", "Ministerio de Hacienda", tMin);
  await org("SUTECBA", "Sindicato Único", tSind);
  for (const r of await db.selectFrom("interaction_types").select(["id", "key"]).execute()) typeId[r.key] = r.id;
  for (const r of await db.selectFrom("interaction_channels").select(["id", "key"]).execute()) channelId[r.key] = r.id;
  masterId = await makeUser("b5-master@sutecba.local", "MASTER_GLOBAL", "Maria Master");
  master = actorOf(masterId, "MASTER_GLOBAL");
  const scope = (user: string, orgId: string) => db.insertInto("user_scopes").values({ user_id: user, organization_id: orgId, include_descendants: true, granted_by: masterId } as never).execute();
  const culturaId = await makeUser("b5-cultura@sutecba.local", "ADMIN", "Carla Cultura");
  const haciendaId = await makeUser("b5-hacienda@sutecba.local", "ADMIN", "Hugo Hacienda");
  const c2 = await makeUser("b5-cultura2@sutecba.local", "ADMIN", "Cora Cultura");
  const c3 = await makeUser("b5-cultura3@sutecba.local", "ADMIN", "Cleo Cultura");
  const c4 = await makeUser("b5-cultura4@sutecba.local", "ADMIN", "Cris Cultura");
  for (const [u, o] of [[culturaId, "MCGC"], [haciendaId, "MHFGC"], [c2, "MCGC"], [c3, "MCGC"], [c4, "MCGC"]] as const) await scope(u, O[o]!);
  culturaOp = actorOf(culturaId, "ADMIN");
  haciendaOp = actorOf(haciendaId, "ADMIN");
  culturaNoSens = actorOf(c2, "ADMIN", without("people.view_sensitive"));
  culturaNoInteractions = actorOf(c3, "ADMIN", without("interactions.view"));
  culturaNoManage = actorOf(c4, "ADMIN", without("meetings.manage_invitations", "meetings.attendance_manual"));
});

afterAll(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("B5 · regla canónica de contacto real", () => {
  it("la regla SQL y su espejo TypeScript coinciden en toda la matriz; solo cuenta lo que debe", async () => {
    const db = await getDb();
    const p = await person();
    // participación legacy válida para poder crear una fila legacy_reference (el trigger de 0029 lo exige)
    const m = await meeting("finished");
    const mp = await db.insertInto("meeting_participations").values({ meeting_id: m, person_id: p, participation_kind: "participated", participation_basis: "legacy_initial_import" } as never).returning("id").executeTakeFirstOrThrow();
    const refDate = sql`('2026-01-01'::date::timestamp at time zone 'America/Argentina/Buenos_Aires')`;
    const cases: Array<[string, ContactOpts, boolean]> = [
      ["base: llamada completada por WhatsApp", {}, true],
      ["presencial", { channel: "presencial" }, true],
      ["teléfono", { channel: "telefono" }, true],
      ["correo", { channel: "correo" }, true],
      ["origen communication:*", { sourceKey: "communication:abc" }, true],
      ["date_only conserva la precisión", { precision: "date_only", at: new Date("2026-03-10T03:00:00Z") }, true],
      ["abierta (planificada)", { status: "open" }, false],
      ["cancelada", { status: "cancelled" }, false],
      ["anulada", { status: "voided" }, false],
      ["futura", { at: new Date(Date.now() + 86400_000) }, false],
      ["sin canal", { channel: null }, false],
      ["canal formulario", { channel: "formulario" }, false],
      ["canal otro", { channel: "otro" }, false],
      ["tipo participation", { type: "participation" }, false],
      ["origen no permitido", { sourceKey: "import:xyz" }, false],
      ["espejo de participación con tipo llamada", { sourceKey: `meeting_participation:${randomUUID()}` }, false],
    ];
    const ids: Array<{ id: string; label: string; expected: boolean }> = [];
    for (const [label, o, expected] of cases) ids.push({ id: await interaction(p, o), label, expected });
    // legacy_reference (tipo participation + fecha técnica)
    const legacyId = (
      await db.insertInto("person_interactions").values({ person_id: p, owner_organization_id: O.MCGC!, occurred_at: refDate, occurred_precision: "date_only", date_basis: "legacy_reference", interaction_type_id: typeId.participation, channel_id: channelId.whatsapp, subject: "Participó", status: "completed", created_by: masterId, source_key: `meeting_participation:${mp.id}` } as never).returning("id").executeTakeFirstOrThrow()
    ).id;
    ids.push({ id: legacyId, label: "legacy_reference", expected: false });
    for (const c of ids) {
      const sqlRes = (await sql<{ ok: boolean }>`select ${rc.countsAsRealContactSql("pi")} as ok from person_interactions pi where pi.id = ${c.id}::uuid`.execute(db)).rows[0]!.ok;
      const row = (
        await sql<{ status: string; occurred_at: Date; date_basis: string; source_key: string | null; channel_key: string | null; type_key: string }>`
          select pi.status, pi.occurred_at, pi.date_basis, pi.source_key, ch.key channel_key, it.key type_key
          from person_interactions pi join interaction_types it on it.id = pi.interaction_type_id left join interaction_channels ch on ch.id = pi.channel_id where pi.id = ${c.id}::uuid`.execute(db)
      ).rows[0]!;
      const ts = rc.countsAsRealContact({ status: row.status, occurredAt: row.occurred_at, dateBasis: row.date_basis, sourceKey: row.source_key, channelKey: row.channel_key, typeKey: row.type_key });
      expect(sqlRes, `SQL: ${c.label}`).toBe(c.expected);
      expect(ts, `TS: ${c.label}`).toBe(c.expected);
    }
  });

  it("clasifica el espejo técnico de participación (SQL = TS)", async () => {
    const db = await getDb();
    const p = await person();
    const derived = await interaction(p, { type: "participation", channel: null, sourceKey: `meeting_participation:${randomUUID()}` });
    const manual = await interaction(p, {});
    const res = async (id: string) => (await sql<{ d: boolean }>`select ${rc.isParticipationDerivedSql("pi")} as d from person_interactions pi where pi.id = ${id}::uuid`.execute(db)).rows[0]!.d;
    expect(await res(derived)).toBe(true);
    expect(await res(manual)).toBe(false);
    expect(rc.isParticipationDerived({ sourceKey: `meeting_participation:x`, typeKey: "llamada" })).toBe(true);
    expect(rc.isParticipationDerived({ sourceKey: null, typeKey: "participation" })).toBe(true);
    expect(rc.isParticipationDerived({ sourceKey: null, typeKey: "llamada" })).toBe(false);
  });

  it("contrato Fase F: nada escribe communication:* todavía, y las señales de entrega no cuentan automáticamente como contacto", () => {
    // Si alguien empieza a escribir communication:*, este test falla: hay que revisar countsAsRealContact ANTES de habilitar la escritura.
    expect([...rc.NEVER_AUTOMATIC_CONTACT_SIGNALS]).toEqual(["sent", "delivered", "opened", "clicked", "failed", "bounced", "unsubscribed"]);
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (name === "node_modules" || name === ".next") continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          const rel = full.replace(/\\/g, "/");
          if (rel === "lib/contacts/real-contact.ts") continue;
          if (/["'`]communication:/.test(readFileSync(full, "utf8"))) writers.push(rel);
        }
      }
    };
    walk("lib");
    walk("app");
    walk("scripts");
    expect(writers).toEqual([]);
    // ninguna señal de entrega es un canal comunicacional ni un origen permitido
    for (const signal of rc.NEVER_AUTOMATIC_CONTACT_SIGNALS) {
      expect((rc.COMMUNICATION_CHANNEL_KEYS as readonly string[]).includes(signal)).toBe(false);
      expect(rc.countsAsRealContact({ status: "completed", occurredAt: new Date(Date.now() - 1000), dateBasis: "actual", sourceKey: `other:${signal}`, channelKey: "whatsapp", typeKey: "llamada" })).toBe(false);
    }
  });

  it("código: nadie arma su propio filtro de contacto; solo los módulos autorizados leen person_interactions", async () => {
    const allowed = new Set([
      "lib/contacts/real-contact.ts",
      "lib/people/timeline.ts",
      "lib/people/queries.ts",
      "lib/analytics/queries.ts",
      "lib/interactions/queries.ts",
      "lib/interactions/participation-sync.ts",
      "lib/interactions/legacy-reference-interactions.ts",
      "lib/interactions/legacy-reconciliation.ts",
      "lib/imports/tandas/apply.ts",
      "lib/imports/tandas/snapshot.ts",
      "lib/meetings/registrations.ts", // solo un comentario
      "lib/db/schema.ts",
    ]);
    const offenders: string[] = [];
    const lastContactUsers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (name === "node_modules" || name === ".next") continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          const rel = full.replace(/\\/g, "/");
          const src = readFileSync(full, "utf8");
          if (/person_interactions/.test(src) && !allowed.has(rel)) offenders.push(rel);
          if (/lastInteractionLateral|lastInteractionDerived/.test(src) && !/countsAsRealContactSql/.test(src)) lastContactUsers.push(rel);
          // la regla vieja (cualquier interacción válida) no puede volver a alimentar semáforo/KPIs de la app
          if (/validInteraction\(/.test(src) && (rel.startsWith("app/") || rel === "lib/people/queries.ts" || rel === "lib/analytics/queries.ts")) offenders.push(`${rel} (validInteraction)`);
        }
      }
    };
    walk("lib");
    walk("app");
    expect(offenders).toEqual([]);
    expect(lastContactUsers).toEqual([]);
  });
});

describe("B5 · último contacto, última actividad y semáforo", () => {
  it("sin contacto real: gris y «Sin contacto registrado»; la actividad nunca lo mueve", async () => {
    const p = await person();
    expect(TRAFFIC_LABEL.gray).toBe("Sin contacto registrado");
    expect(trafficLightOf(null)).toBe("gray");
    let t = await getPersonTraffic(culturaOp, p);
    expect(t).toMatchObject({ lastInteractionDate: null, daysSinceInteraction: null, trafficLight: "gray" });

    // Cada hecho de actividad existe, cada uno con su fecha, y ninguno mueve el último contacto.
    const m = await meeting("in_progress");
    const mOld = await meeting("finished");
    const db = await getDb();
    await db.insertInto("meeting_participations").values({ meeting_id: mOld, person_id: p, participation_kind: "participated", participation_basis: "legacy_initial_import" } as never).execute();
    await inv.createInvitationBatch(master, m, { personIds: [p] }, { channel: "whatsapp" });
    const invId = (await db.selectFrom("meeting_invitations").select("id").where("meeting_id", "=", m).where("person_id", "=", p).executeTakeFirstOrThrow()).id;
    await inv.recordInvitationResponse(master, { invitationId: invId, response: "confirmed", channel: "whatsapp", respondedAt: { kind: "now" } as never });
    await reg.enrollPerson(culturaOp, { meetingId: m, personId: p, channel: "phone", when: { kind: "now" } } as never);
    await att.registerAttendanceManually(culturaOp, { meetingId: m, personId: p, reason: "mesa", occurred: { kind: "now" } });
    // interacción técnica derivada + interacción legacy
    await interaction(p, { type: "participation", channel: null, sourceKey: `meeting_participation:${randomUUID()}` });
    t = await getPersonTraffic(culturaOp, p);
    expect(t).toMatchObject({ lastInteractionDate: null, trafficLight: "gray" });
    const rel = (await tl.getPersonRelationship(culturaOp, p))!;
    expect(rel.lastContact).toBeNull();
    expect(rel.lastActivity).not.toBeNull();
    expect(rel.lastAttendance?.at).not.toBeNull();
    expect(rel.lastRegistration?.at).not.toBeNull();
    expect(rel.lastParticipation).not.toBeNull();

    // Un contacto real sí lo mueve; después, una asistencia más nueva mueve la ACTIVIDAD pero no el CONTACTO.
    await interaction(p, { at: daysAgo(10) });
    t = await getPersonTraffic(culturaOp, p);
    expect(t?.trafficLight).toBe("green");
    expect(t?.daysSinceInteraction).toBe(10);
    const rel2 = (await tl.getPersonRelationship(culturaOp, p))!;
    expect(rel2.lastContact?.days).toBe(10);
    expect(rel2.lastContact?.channelLabel).toBe("WhatsApp");
    expect(rel2.lastActivity!.at!.getTime()).toBeGreaterThan(rel2.lastContact!.at.getTime());
  });

  it("Última actividad nunca sale de un espejo técnico ni de legacy_reference: la fecha viene del hecho funcional", async () => {
    const db = await getDb();
    const refDate = sql`('2026-01-01'::date::timestamp at time zone 'America/Argentina/Buenos_Aires')`;
    // Persona A: participación histórica con jornada (fecha real: hace 20 días) + su espejo técnico con una fecha MÁS NUEVA (hace 1 día)
    // + un espejo legacy_reference (2026-01-01) de otra participación de campaña sin jornada.
    const a = await person();
    const mFin = await meeting("finished"); // starts_at = hace 20 días
    const partA = await db.insertInto("meeting_participations").values({ meeting_id: mFin, person_id: a, participation_kind: "participated", participation_basis: "legacy_initial_import" } as never).returning("id").executeTakeFirstOrThrow();
    const partCamp = await db.insertInto("meeting_participations").values({ meeting_id: null, campaign_key: "ophthalmology:b5-actividad", person_id: a, participation_kind: "participated", participation_basis: "legacy_initial_import" } as never).returning("id").executeTakeFirstOrThrow();
    await interaction(a, { type: "participation", channel: null, at: daysAgo(1), sourceKey: `meeting_participation:${partA.id}`, subject: "Participó (espejo)" });
    await db.insertInto("person_interactions").values({ person_id: a, owner_organization_id: O.MCGC!, occurred_at: refDate, occurred_precision: "date_only", date_basis: "legacy_reference", interaction_type_id: typeId.participation, channel_id: null, subject: "Participó (referencia)", status: "completed", created_by: masterId, source_key: `meeting_participation:${partCamp.id}` } as never).execute();
    const relA = (await tl.getPersonRelationship(culturaOp, a))!;
    const meetingStart = (await db.selectFrom("meetings").select("starts_at").where("id", "=", mFin).executeTakeFirstOrThrow()).starts_at as Date;
    expect(relA.lastContact).toBeNull();
    expect(relA.lastActivity?.at?.getTime()).toBe(meetingStart.getTime()); // la participación original, NO el espejo de hace 1 día
    expect(relA.lastParticipation?.at?.getTime()).toBe(meetingStart.getTime());
    expect(relA.lastActivity!.at!.toISOString().slice(0, 10)).not.toBe("2026-01-01");
    const pageA = (await tl.getPersonTimeline(culturaOp, a, { limit: 100 }))!;
    expect(pageA.events.some((e) => e.category === "contact")).toBe(false);
    expect(pageA.events.some((e) => e.at && e.at.toISOString().slice(0, 10) === "2026-01-01")).toBe(false);
    expect(pageA.events.filter((e) => e.category === "participation")).toHaveLength(2); // los hechos originales sí aparecen
    // Persona B: SOLO una participación de campaña sin jornada + su espejo legacy_reference → ninguna fecha técnica gana: queda sin fecha.
    const b = await person();
    const partB = await db.insertInto("meeting_participations").values({ meeting_id: null, campaign_key: "ophthalmology:b5-actividad-b", person_id: b, participation_kind: "participated", participation_basis: "legacy_initial_import" } as never).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("person_interactions").values({ person_id: b, owner_organization_id: O.MCGC!, occurred_at: refDate, occurred_precision: "date_only", date_basis: "legacy_reference", interaction_type_id: typeId.participation, channel_id: null, subject: "Participó (referencia)", status: "completed", created_by: masterId, source_key: `meeting_participation:${partB.id}` } as never).execute();
    const relB = (await tl.getPersonRelationship(culturaOp, b))!;
    expect(relB.lastContact).toBeNull();
    expect(relB.lastActivity).toMatchObject({ at: null, undated: true });
    expect(relB.lastParticipation).toMatchObject({ at: null, undated: true });
    expect((await getPersonTraffic(culturaOp, b))?.trafficLight).toBe("gray");
  });

  it("umbrales 30/60 desde el último contacto real; legacy_reference y espejos nunca cuentan", async () => {
    const [a, b, c, d] = [await person(), await person(), await person(), await person()];
    await interaction(a, { at: daysAgo(45), channel: "correo" });
    await interaction(b, { at: daysAgo(200), channel: "presencial" });
    await interaction(c, { at: daysAgo(3), status: "voided" });
    await interaction(d, { at: daysAgo(2), type: "participation", sourceKey: `meeting_participation:${randomUUID()}` });
    expect((await getPersonTraffic(culturaOp, a))?.trafficLight).toBe("yellow");
    expect((await getPersonTraffic(culturaOp, b))?.trafficLight).toBe("red");
    expect((await getPersonTraffic(culturaOp, c))?.trafficLight).toBe("gray");
    expect((await getPersonTraffic(culturaOp, d))?.trafficLight).toBe("gray");
    // la grilla usa la misma regla
    const page = await listPeoplePage(master, { status: "all" }, { field: "name", direction: "asc" }, 1, 500);
    const byId = new Map(page.rows.map((r) => [r.id, r]));
    expect(byId.get(a)?.trafficLight).toBe("yellow");
    expect(byId.get(d)?.lastInteractionDate).toBeNull();
  });

  it("KPIs del dashboard: contacto real vs interacciones técnicas", async () => {
    const before = await getParticipationInteractionKpis(master);
    const p = await person();
    await interaction(p, { type: "participation", channel: null, sourceKey: `meeting_participation:${randomUUID()}` });
    const mid = await getParticipationInteractionKpis(master);
    expect(mid.technicalInteractions).toBe(before.technicalInteractions + 1);
    expect(mid.realContacts).toBe(before.realContacts);
    await interaction(p, {});
    const after = await getParticipationInteractionKpis(master);
    expect(after.realContacts).toBe(before.realContacts + 1);
    expect(after.peopleWithRealContact).toBe(before.peopleWithRealContact + 1);
    expect(after.technicalInteractions).toBe(mid.technicalInteractions);
  });
});

describe("B5 · línea de tiempo", () => {
  async function fullPerson() {
    const db = await getDb();
    const p = await person();
    const m = await meeting("in_progress");
    const m2 = await meeting("finished", { origin: "import", source_event_key: `training:b5-${++seq}`, schedule_precision: "date_only", event_date: new Date("2026-03-10T03:00:00Z"), starts_at: null, ends_at: null });
    const m3 = await meeting("scheduled");
    // 1. invitación + respuesta (fecha de respuesta desconocida → sin fecha)
    await inv.createInvitationBatch(master, m, { personIds: [p] }, { channel: "whatsapp" });
    const invId = (await db.selectFrom("meeting_invitations").select("id").where("meeting_id", "=", m).where("person_id", "=", p).executeTakeFirstOrThrow()).id;
    await inv.recordInvitationResponse(master, { invitationId: invId, response: "confirmed", channel: "phone", respondedAt: { kind: "unknown" } });
    // 2. inscripción → anulación → restauración
    await reg.enrollPerson(culturaOp, { meetingId: m, personId: p, channel: "email", when: { kind: "now" } } as never);
    const regId = (await db.selectFrom("meeting_participations").select("id").where("meeting_id", "=", m).where("person_id", "=", p).where("participation_kind", "=", "registration").executeTakeFirstOrThrow()).id;
    await reg.voidEnrollment(culturaOp, { participationId: regId, reason: "carga duplicada" });
    await reg.restoreEnrollment(culturaOp, { participationId: regId, reason: "era correcta" });
    await reg.correctEnrollment(culturaOp, { participationId: regId, reason: "era por teléfono", when: { kind: "unknown" }, channel: "phone" } as never);
    // 3. asistencia manual + corrección (queda como detalle, no como línea)
    await att.registerAttendanceManually(culturaOp, { meetingId: m, personId: p, reason: "mesa de acreditación", occurred: { kind: "now" } });
    await att.correctAttendance(culturaOp, { meetingId: m, personId: p, reason: "el día era otro", occurred: { kind: "date_only", day: "2026-03-11" } });
    // 4. retirada + reinvitación en otra reunión
    await inv.createInvitationBatch(master, m3, { personIds: [p] }, { channel: "email" });
    const inv3 = (await db.selectFrom("meeting_invitations").select("id").where("meeting_id", "=", m3).where("person_id", "=", p).executeTakeFirstOrThrow()).id;
    await inv.withdrawInvitation(master, inv3);
    await inv.createInvitationBatch(master, m3, { personIds: [p] }, { channel: "sms" });
    // 5. participaciones históricas: con fecha de actividad, y de campaña sin jornada (sin fecha)
    await db.insertInto("meeting_participations").values({ meeting_id: m2, person_id: p, participation_kind: "participated", participation_basis: "source_business_rule", evidence: "regla del listado" } as never).execute();
    await db.insertInto("meeting_participations").values({ meeting_id: null, campaign_key: "ophthalmology:b5-test", person_id: p, participation_kind: "participated", participation_basis: "legacy_initial_import" } as never).execute();
    // 6. interacciones: el espejo técnico (oculto), un contacto real y una interacción que no cuenta
    await interaction(p, { type: "participation", channel: null, sourceKey: `meeting_participation:${randomUUID()}`, subject: "Participó en: algo" });
    await interaction(p, { at: daysAgo(2), subject: "Llamada de seguimiento", description: "Quedó en responder", outcome: "Positivo" });
    await interaction(p, { at: daysAgo(3), channel: "otro", subject: "Nota interna" });
    return { p, m, m2, m3 };
  }

  it("una línea por hecho + los actos administrativos; el espejo técnico no aparece; correcciones solo como detalle", async () => {
    const { p } = await fullPerson();
    const page = (await tl.getPersonTimeline(master, p, { limit: 100 }))!;
    const l = lines(page);
    const count = (k: string) => l.filter((x) => x === k).length;
    // invitación: invited, responded (m); invited, withdrawn, reinvited (m3)
    expect(count("invitation/invited")).toBe(2);
    expect(count("invitation/responded")).toBe(1);
    expect(count("invitation/withdrawn")).toBe(1);
    expect(count("invitation/reinvited")).toBe(1);
    // inscripción: el hecho una sola vez (NO hay segunda línea por el evento registered) + anulación + restauración
    expect(count("registration/registration")).toBe(1);
    expect(count("registration/voided")).toBe(1);
    expect(count("registration/restored")).toBe(1);
    expect(l.some((x) => x.endsWith("/registered") || x.endsWith("/corrected") || x.endsWith("/checked_in"))).toBe(false);
    // asistencia: el hecho una sola vez
    expect(count("attendance/attendance")).toBe(1);
    // participaciones: 2 (regla de la fuente con fecha de la actividad; campaña sin jornada)
    expect(l.filter((x) => x.startsWith("participation/"))).toHaveLength(2);
    // contactos: la llamada real y la interacción que no cuenta; el espejo técnico NO está
    expect(l.filter((x) => x.startsWith("contact/"))).toHaveLength(2);
    expect(page.events.some((e) => (e.description ?? "").includes("Participó en: algo"))).toBe(false);
    const real = page.events.filter((e) => e.countsAsContact);
    expect(real).toHaveLength(1);
    expect(real[0]!.title).toBe("Contacto por WhatsApp");
    // solo la categoría contacto puede contar como contacto
    expect(page.events.filter((e) => e.countsAsContact && e.category !== "contact")).toHaveLength(0);
    // correcciones como detalle de su hecho
    const registration = page.events.find((e) => e.id.startsWith("reg:"))!;
    expect(registration.details.join(" ")).toMatch(/Corregido el/);
    expect(registration.details.join(" ")).toContain("era por teléfono");
    const attendance = page.events.find((e) => e.id.startsWith("att:"))!;
    expect(attendance.details.join(" ")).toContain("el día era otro");
    // conteos por categoría
    expect(page.counts).toMatchObject({ invitation: 5, registration: 3, attendance: 1, participation: 2, contact: 2 });
  });

  it("orden: con fecha descendente; sin fecha al final y jamás con created_at; la inscripción corregida a «desconocida» queda sin fecha", async () => {
    const { p } = await fullPerson();
    const events = (await allEvents(master, p))!;
    const firstUndated = events.findIndex((e) => e.at === null);
    expect(firstUndated).toBeGreaterThan(0);
    expect(events.slice(firstUndated).every((e) => e.at === null)).toBe(true);
    const dated = events.slice(0, firstUndated).map((e) => e.at!.getTime());
    expect([...dated].sort((a, b) => b - a)).toEqual(dated);
    const undatedKinds = events.slice(firstUndated).map((e) => `${e.category}/${e.kind}`);
    expect(undatedKinds).toContain("registration/registration"); // registered_at corregido a «no se sabe»
    expect(undatedKinds).toContain("invitation/responded"); // respuesta con fecha desconocida
    expect(undatedKinds.some((k) => k.startsWith("participation/participated/legacy_initial_import"))).toBe(true); // campaña sin jornada
    // la participación con jornada tiene la fecha de la actividad (solo el día)
    const withDate = events.find((e) => e.kind === "participated/source_business_rule")!;
    expect(withDate.at!.toISOString()).toBe("2026-03-10T03:00:00.000Z");
    expect(withDate.precision).toBe("date_only");
    // una fecha de importación/created_at jamás ordena: la inscripción sin fecha tiene at = null aunque exista created_at
    const regEvent = events.find((e) => e.id.startsWith("reg:"))!;
    expect(regEvent.at).toBeNull();
  });

  it("paginación por cursor: sin duplicados ni huecos; filtro por categoría; cursor inválido se ignora", async () => {
    const { p } = await fullPerson();
    const whole = (await tl.getPersonTimeline(master, p, { limit: 100 }))!.events.map((e) => e.id);
    const paged = (await allEvents(master, p))!.map((e) => e.id);
    expect(paged).toEqual(whole);
    expect(new Set(paged).size).toBe(paged.length);
    for (const cat of tl.TIMELINE_CATEGORIES) {
      const only = (await allEvents(master, p, [cat]))!;
      expect(only.every((e) => e.category === cat)).toBe(true);
      expect(only.length).toBe((await tl.getPersonTimeline(master, p, { limit: 100 }))!.counts[cat]);
    }
    const bad = await tl.getPersonTimeline(master, p, { cursor: "no-es-un-cursor", limit: 100 });
    expect(bad!.events.map((e) => e.id)).toEqual(whole);
    expect(await tl.getPersonTimeline(master, "no-uuid")).toBeNull();
  });

  it("la lectura no escribe nada: interacciones, participaciones y asistencias idénticas", async () => {
    const { p } = await fullPerson();
    const before = await snapshot();
    await tl.getPersonTimeline(master, p, { limit: 100 });
    await tl.getPersonRelationship(master, p);
    await tl.getPersonTechnicalInteractions(master, p);
    await getPersonTraffic(master, p);
    await listPeoplePage(master, {}, { field: "name", direction: "asc" }, 1, 50);
    await getParticipationInteractionKpis(master);
    expect(await snapshot()).toEqual(before);
  });

  it("vista técnica: solo Master ve el espejo heredado, fuera del timeline", async () => {
    const { p } = await fullPerson();
    expect((await tl.getPersonTechnicalInteractions(master, p)).length).toBe(1);
    expect(await tl.getPersonTechnicalInteractions(culturaOp, p)).toEqual([]);
  });
});

describe("B5 · alcance de la persona vs. detalle de la interacción", () => {
  it("el hecho lo determina la persona; el dueño histórico solo reserva el detalle (caso de las 31)", async () => {
    const p = await person("MCGC");
    // interacción cargada por OTRA unidad (Hacienda) sobre una persona que hoy es de Cultura
    await interaction(p, { owner: O.MHFGC!, at: daysAgo(4), subject: "Gestión reservada de Hacienda", description: "nota interna", outcome: "pendiente" });
    // el semáforo y «Último contacto» ven el HECHO
    const t = await getPersonTraffic(culturaOp, p);
    expect(t?.trafficLight).toBe("green");
    const rel = (await tl.getPersonRelationship(culturaOp, p))!;
    expect(rel.lastContact?.days).toBe(4);
    expect(rel.lastContact?.detail).toBeNull(); // sin detalle: el dueño no está en su alcance
    const ev = (await tl.getPersonTimeline(culturaOp, p))!.events.find((e) => e.category === "contact")!;
    expect(ev.title).toBe("Contacto por WhatsApp");
    expect(ev.countsAsContact).toBe(true);
    expect(ev.description).toBeNull();
    expect(ev.details).toEqual([]);
    expect(ev.provenance).toContain("Detalle reservado a la unidad que lo registró");
    // Master ve el detalle
    const evM = (await tl.getPersonTimeline(master, p))!.events.find((e) => e.category === "contact")!;
    expect(evM.description).toBe("Gestión reservada de Hacienda");
    expect(evM.details.join(" ")).toContain("nota interna");
    // sin interactions.view tampoco hay detalle (aunque el dueño sea su unidad)
    const own = await person("MCGC");
    await interaction(own, { owner: O.MCGC!, subject: "Propia" });
    const evNo = (await tl.getPersonTimeline(culturaNoInteractions, own))!.events.find((e) => e.category === "contact")!;
    expect(evNo.description).toBeNull();
    const evYes = (await tl.getPersonTimeline(culturaOp, own))!.events.find((e) => e.category === "contact")!;
    expect(evYes.description).toBe("Propia");
  });

  it("si no puede ver a la persona, no ve su timeline ni su estado de relación; sin organización solo Master", async () => {
    const mine = await person("MCGC");
    const noOrg = await person(null);
    await interaction(mine, {});
    await interaction(noOrg, {});
    expect(await tl.getPersonTimeline(haciendaOp, mine)).toBeNull();
    expect(await tl.getPersonRelationship(haciendaOp, mine)).toBeNull();
    expect(await getPersonTraffic(haciendaOp, mine)).toBeNull();
    expect(await tl.getPersonTimeline(culturaOp, noOrg)).toBeNull();
    expect(await tl.getPersonRelationship(culturaOp, noOrg)).toBeNull();
    expect(await tl.getPersonTimeline(master, noOrg)).not.toBeNull();
    expect((await tl.getPersonRelationship(master, noOrg))?.lastContact).not.toBeNull();
  });

  it("operadores, motivos y nombres de actividades de otras unidades se reservan", async () => {
    const db = await getDb();
    const p = await person("MCGC");
    const m = await meeting("in_progress");
    await reg.enrollPerson(culturaOp, { meetingId: m, personId: p, channel: "phone", when: { kind: "now" } } as never);
    const regId = (await db.selectFrom("meeting_participations").select("id").where("meeting_id", "=", m).where("person_id", "=", p).executeTakeFirstOrThrow()).id;
    await reg.voidEnrollment(culturaOp, { participationId: regId, reason: "motivo reservado" });
    const asManager = (await tl.getPersonTimeline(culturaOp, p))!.events;
    expect(asManager.find((e) => e.kind === "voided")!.details.join(" ")).toContain("motivo reservado");
    expect(asManager.find((e) => e.id.startsWith("reg:"))!.recordedBy).toBe("Carla Cultura");
    const asReader = (await tl.getPersonTimeline(culturaNoManage, p))!.events;
    expect(JSON.stringify(asReader)).not.toContain("motivo reservado");
    expect(JSON.stringify(asReader)).not.toContain("Carla Cultura");
    // actividad de otra unidad: una inscripción solo anulada no hace visible la reunión → título genérico en el cliente
    const hidden = await meeting("in_progress", { owner_organization_id: O.MHFGC! });
    const q = await person("MCGC");
    await reg.enrollPerson(master, { meetingId: hidden, personId: q, channel: "phone", when: { kind: "now" } } as never);
    const hiddenReg = (await db.selectFrom("meeting_participations").select("id").where("meeting_id", "=", hidden).where("person_id", "=", q).executeTakeFirstOrThrow()).id;
    await reg.voidEnrollment(master, { participationId: hiddenReg, reason: "x" });
    const events = (await tl.getPersonTimeline(culturaOp, q))!.events;
    const e = events.find((x) => x.category === "registration")!;
    expect(e.activity?.name).toBeNull();
    expect(events.find((x) => x.kind === "voided")!.activity?.name).toBeNull();
  });
});

describe("B5 · formato de fechas (hidratación)", () => {
  it("es determinista y ASCII: servidor y navegador producen el mismo texto (sin espacios Unicode de Intl)", () => {
    const d = new Date("2026-10-08T17:33:00Z"); // 14:33 en Buenos Aires
    expect(formatTimelineDate(d, "exact_datetime")).toBe("08/10/2026 14:33");
    expect(formatTimelineDate(d, "date_only")).toBe("08/10/2026");
    expect(formatTimelineDate(d.toISOString(), "exact_datetime")).toBe("08/10/2026 14:33");
    expect(formatTimelineDate(new Date("2026-03-10T03:00:00Z"), "date_only")).toBe("10/03/2026"); // medianoche BA = ese día
    expect(formatTimelineDate(null, null)).toBe("Fecha no registrada");
    expect(formatActivityContext(d, "date_only")).toBe("actividad del 08/10/2026");
    expect(formatTimelineDate(d, "exact_datetime")).toMatch(/^[ -~]+$/);
  });
});

describe("B5 · sanitización", () => {
  it("sanitizeFreeText enmascara DNI, teléfono y email salvo con people.view_sensitive", () => {
    const raw = "Hablé al 11 2345-6789 (+54 9 11 5555-4444), DNI 30.123.456 / 28999888, mail juan.perez@mail.com.ar";
    expect(sanitizeFreeText(raw, true)).toBe(raw);
    const clean = sanitizeFreeText(raw, false)!;
    for (const leak of ["2345", "5555", "30.123.456", "30123456", "28999888", "juan.perez", "@mail"]) expect(clean).not.toContain(leak);
    expect(clean).toContain("[email oculto]");
    expect(clean).toContain("[DNI oculto]");
    expect(clean).toContain("[teléfono oculto]");
    expect(sanitizeFreeText(null, false)).toBeNull();
    expect(sanitizeFreeText("Sin datos personales", false)).toBe("Sin datos personales");
  });

  it("el timeline sanitiza el texto libre de las interacciones sin people.view_sensitive y nunca arma títulos con él", async () => {
    const p = await person("MCGC");
    const raw = "Llamó al 11 2345-6789 por DNI 30.123.456 y mail a@b.com";
    await interaction(p, { owner: O.MCGC!, subject: raw, description: raw, outcome: raw });
    const withSens = (await tl.getPersonTimeline(culturaOp, p))!.events.find((e) => e.category === "contact")!;
    expect(withSens.description).toBe(raw);
    const noSens = (await tl.getPersonTimeline(culturaNoSens, p))!.events.find((e) => e.category === "contact")!;
    const dump = JSON.stringify(noSens);
    for (const leak of ["2345-6789", "30.123.456", "a@b.com"]) expect(dump).not.toContain(leak);
    expect(noSens.title).toBe("Contacto por WhatsApp"); // título cerrado, sin texto libre
    const rel = (await tl.getPersonRelationship(culturaNoSens, p))!;
    expect(JSON.stringify(rel)).not.toContain("30.123.456");
  });
});
