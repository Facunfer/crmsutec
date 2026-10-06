import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
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
const inv = await import("../../lib/meetings/invitations.js");
const { respondToInvitation } = await import("../../lib/meetings/public.js");
const { loadMeetingMetrics } = await import("../../lib/activities/metrics.js");
const { metricNumber } = await import("../../lib/activities/labels.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));
const O: Record<string, string> = {};
let masterId: string;
let master: any;
let culturaOp: any;
let haciendaOp: any;
let noManage: any;
let meetingId: string;
let seqPerson = 0;

function actorOf(id: string, roleKey: "MASTER_GLOBAL" | "ADMIN", permissions: Set<string> = ALL): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions };
}
async function makeUser(email: string, roleKey: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id, status: "active" } as never).returning("id").executeTakeFirstOrThrow()).id;
}
async function person(orgCode: string | null): Promise<string> {
  const db = await getDb();
  seqPerson += 1;
  return (await db.insertInto("people").values({ first_name: `P${seqPerson}`, last_name: "Test", dni: `9${String(seqPerson).padStart(7, "0")}`, organization_id: orgCode ? O[orgCode]! : null, origin: "import" } as never).returning("id").executeTakeFirstOrThrow()).id;
}
async function invite(actor: any, personId: string, channel: string | null = "whatsapp") {
  const result = await inv.createInvitationBatch(actor, meetingId, { personIds: [personId] }, { channel });
  const db = await getDb();
  const row = await db.selectFrom("meeting_invitations").selectAll().where("meeting_id", "=", meetingId).where("person_id", "=", personId).executeTakeFirstOrThrow();
  return { id: row.id, token: result.links[0]?.token ?? "", result };
}
const events = async (invitationId: string) => {
  const db = await getDb();
  return db.selectFrom("meeting_invitation_events").selectAll().where("invitation_id", "=", invitationId).orderBy("seq", "asc").execute();
};
const row = async (invitationId: string) => {
  const db = await getDb();
  return db.selectFrom("meeting_invitations").selectAll().where("id", "=", invitationId).executeTakeFirstOrThrow();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  masterId = await makeUser("im-master@sutecba.local", "MASTER_GLOBAL");
  master = actorOf(masterId, "MASTER_GLOBAL");
  const culturaId = await makeUser("im-cultura@sutecba.local", "ADMIN");
  const haciendaId = await makeUser("im-hacienda@sutecba.local", "ADMIN");
  const noManageId = await makeUser("im-nomanage@sutecba.local", "ADMIN");
  const scope = (user: string, orgId: string) => db.insertInto("user_scopes").values({ user_id: user, organization_id: orgId, include_descendants: true, granted_by: masterId } as never).execute();
  await scope(culturaId, O.MCGC!);
  await scope(haciendaId, O.MHFGC!);
  await scope(noManageId, O.MCGC!);
  culturaOp = actorOf(culturaId, "ADMIN");
  haciendaOp = actorOf(haciendaId, "ADMIN");
  noManage = actorOf(noManageId, "ADMIN", new Set([...ALL].filter((p) => p !== "meetings.manage_invitations")));

  meetingId = (
    await db
      .insertInto("meetings")
      .values({
        name: "Reunión de prueba B2", owner_organization_id: O.MCGC!, organizer_user_id: masterId, created_by: masterId, origin: "manual", status: "scheduled",
        meeting_type: "reunion", schedule_precision: "exact_datetime", starts_at: new Date(Date.now() + 86400_000), ends_at: new Date(Date.now() + 2 * 86400_000),
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
});

afterAll(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("B2 · invitar guarda usuario, canal y evento", () => {
  it("invitación: invited_by, canal de comunicación, canal técnico intacto y evento «invited»", async () => {
    const p = await person("MCGC");
    const { id } = await invite(culturaOp, p, "whatsapp");
    const r = await row(id);
    expect(r).toMatchObject({ invited_by: culturaOp.id, invitation_channel: "whatsapp", channel: "manual_link", response_status: "pending", response_channel: null, response_recorded_by: null, response_recorded_at: null, responded_at: null });
    const ev = await events(id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: "invited", recorded_by: culturaOp.id, invitation_channel: "whatsapp", response_status_from: null, response_status_to: "pending", meeting_id: meetingId, person_id: p });
    const db = await getDb();
    const batch = await db.selectFrom("meeting_invitation_batches").selectAll().where("id", "=", ev[0]!.batch_id!).executeTakeFirstOrThrow();
    expect(batch.created_by).toBe(culturaOp.id); // created_by (tanda) e invited_by (invitación) son conceptos distintos
  });

  it("canal opcional (NULL = no registrado); canal inválido se rechaza sin dejar nada a medias", async () => {
    const db = await getDb();
    const p1 = await person("MCGC");
    const { id } = await invite(culturaOp, p1, null);
    expect((await row(id)).invitation_channel).toBeNull();
    const p2 = await person("MCGC");
    const batchesBefore = await db.selectFrom("meeting_invitation_batches").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow();
    await expect(inv.createInvitationBatch(culturaOp, meetingId, { personIds: [p2] }, { channel: "paloma" })).rejects.toThrow(/Canal/);
    const after = await db.selectFrom("meeting_invitation_batches").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow();
    expect(after.n).toBe(batchesBefore.n);
    expect(await db.selectFrom("meeting_invitations").select("id").where("person_id", "=", p2).execute()).toHaveLength(0);
  });

  it("la audiencia respeta el alcance de quien invita (personas de otra área y sin organización quedan afuera)", async () => {
    const pOut = await person("MHFGC");
    const pNoOrg = await person(null);
    await expect(inv.createInvitationBatch(culturaOp, meetingId, { personIds: [pOut, pNoOrg] }, { channel: "email" })).rejects.toThrow(/ninguna persona/);
  });

  it("sin permiso manage_invitations no se puede invitar; otra área no accede a la reunión", async () => {
    const p = await person("MCGC");
    await expect(inv.createInvitationBatch(noManage, meetingId, { personIds: [p] })).rejects.toThrow(/permiso/);
    await expect(inv.createInvitationBatch(haciendaOp, meetingId, { personIds: [p] })).rejects.toThrow(/no existe/);
  });

  it("doble clic en «Generar invitaciones»: segunda tanda no duplica filas ni eventos", async () => {
    const p = await person("MCGC");
    const first = await invite(culturaOp, p, "email");
    const again = await inv.createInvitationBatch(culturaOp, meetingId, { personIds: [p] }, { channel: "email" });
    expect(again.createdCount).toBe(0);
    expect(again.alreadyInvitedCount).toBe(1);
    expect(await events(first.id)).toHaveLength(1);
  });
});

describe("B2 · respuesta pública (directa)", () => {
  it("responded: canal public_link, sin usuario, responded_at = response_recorded_at exacto", async () => {
    const p = await person("MCGC");
    const { id, token } = await invite(culturaOp, p);
    expect(await respondToInvitation(token, "confirmed", "10.0.0.1")).toEqual({ ok: true });
    const r = await row(id);
    expect(r).toMatchObject({ response_status: "confirmed", response_channel: "public_link", response_recorded_by: null, responded_at_precision: "exact_datetime" });
    expect(r.responded_at).not.toBeNull();
    expect(r.responded_at!.getTime()).toBe(r.response_recorded_at!.getTime());
    const ev = await events(id);
    expect(ev.map((e) => e.event_type)).toEqual(["invited", "responded"]);
    expect(ev[1]).toMatchObject({ recorded_by: null, response_status_from: "pending", response_status_to: "confirmed", response_channel: "public_link", responded_at_precision: "exact_datetime" });
  });

  it("doble clic / retry con la MISMA respuesta es NO-OP: ni responded_at ni evento nuevo (aunque pase el tiempo)", async () => {
    const p = await person("MCGC");
    const { id, token } = await invite(culturaOp, p);
    await respondToInvitation(token, "declined", "10.0.0.2");
    const before = await row(id);
    await sleep(15);
    expect(await respondToInvitation(token, "declined", "10.0.0.2")).toEqual({ ok: true });
    const after = await row(id);
    expect(after.responded_at!.getTime()).toBe(before.responded_at!.getTime());
    expect(after.response_recorded_at!.getTime()).toBe(before.response_recorded_at!.getTime());
    expect((await events(id)).map((e) => e.event_type)).toEqual(["invited", "responded"]);
  });

  it("cambio real confirmed ↔ declined por el enlace: response_changed y se actualiza la fila", async () => {
    const p = await person("MCGC");
    const { id, token } = await invite(culturaOp, p);
    await respondToInvitation(token, "confirmed", "10.0.0.3");
    await sleep(10);
    await respondToInvitation(token, "declined", "10.0.0.3");
    await sleep(10);
    await respondToInvitation(token, "confirmed", "10.0.0.3");
    const ev = await events(id);
    expect(ev.map((e) => e.event_type)).toEqual(["invited", "responded", "response_changed", "response_changed"]);
    expect(ev.slice(1).map((e) => `${e.response_status_from}>${e.response_status_to}`)).toEqual(["pending>confirmed", "confirmed>declined", "declined>confirmed"]);
    expect((await row(id)).response_status).toBe("confirmed");
  });

  it("dos solicitudes concurrentes con el mismo estado: un solo cambio y un solo evento", async () => {
    const p = await person("MCGC");
    const { id, token } = await invite(culturaOp, p);
    const [a, b] = await Promise.all([respondToInvitation(token, "confirmed", "10.0.0.4"), respondToInvitation(token, "confirmed", "10.0.0.5")]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect((await events(id)).filter((e) => e.event_type !== "invited")).toHaveLength(1);
  });

  it("dos respuestas concurrentes distintas se serializan: el historial es una cadena coherente con el estado final", async () => {
    const p = await person("MCGC");
    const { id, token } = await invite(culturaOp, p);
    await Promise.all([respondToInvitation(token, "confirmed", "10.0.0.6"), respondToInvitation(token, "declined", "10.0.0.7")]);
    const ev = (await events(id)).filter((e) => e.event_type !== "invited");
    expect(ev).toHaveLength(2);
    expect(ev[0]!.event_type).toBe("responded");
    expect(ev[1]!.event_type).toBe("response_changed");
    expect(ev[1]!.response_status_from).toBe(ev[0]!.response_status_to); // la cadena no tiene huecos
    expect((await row(id)).response_status).toBe(ev[1]!.response_status_to);
    expect(ev[1]!.occurred_at.getTime()).toBeGreaterThanOrEqual(ev[0]!.occurred_at.getTime());
  });

  it("enlace de invitación retirada o reunión no programada: no responde", async () => {
    const p = await person("MCGC");
    const { id, token } = await invite(culturaOp, p);
    await inv.withdrawInvitation(culturaOp, id);
    expect(await respondToInvitation(token, "confirmed", "10.0.0.8")).toEqual({ ok: false, reason: "invalid" });
    expect((await events(id)).map((e) => e.event_type)).toEqual(["invited", "withdrawn"]);
  });
});

describe("B2 · respuesta cargada por un operador", () => {
  it("fecha desconocida: responded_at NULL (no se inventa), recorder = operador, evento responded", async () => {
    const p = await person("MCGC");
    const { id } = await invite(culturaOp, p);
    const res = await inv.recordInvitationResponse(culturaOp, { invitationId: id, response: "confirmed", channel: "phone", respondedAt: { kind: "unknown" } });
    expect(res).toEqual({ changed: true, eventType: "responded" });
    const r = await row(id);
    expect(r).toMatchObject({ response_status: "confirmed", response_channel: "phone", response_recorded_by: culturaOp.id, responded_at: null, responded_at_precision: null });
    expect(r.response_recorded_at).not.toBeNull();
    const ev = (await events(id))[1]!;
    expect(ev).toMatchObject({ event_type: "responded", recorded_by: culturaOp.id, response_channel: "phone", responded_at: null, responded_at_precision: null });
  });

  it("solo el día: medianoche de Buenos Aires con precisión date_only; día y hora: exacto", async () => {
    const p1 = await person("MCGC");
    const a = await invite(culturaOp, p1);
    await inv.recordInvitationResponse(culturaOp, { invitationId: a.id, response: "declined", channel: "whatsapp", respondedAt: { kind: "date_only", day: "2026-03-10" } });
    const ra = await row(a.id);
    expect(ra).toMatchObject({ responded_at_precision: "date_only", response_channel: "whatsapp" });
    expect(ra.responded_at!.toISOString()).toBe("2026-03-10T03:00:00.000Z");
    const p2 = await person("MCGC");
    const b = await invite(culturaOp, p2);
    await inv.recordInvitationResponse(culturaOp, { invitationId: b.id, response: "confirmed", channel: "in_person", respondedAt: { kind: "exact", at: new Date("2026-03-10T15:30:00-03:00") } });
    const rb = await row(b.id);
    expect(rb).toMatchObject({ responded_at_precision: "exact_datetime" });
    expect(rb.responded_at!.toISOString()).toBe("2026-03-10T18:30:00.000Z");
  });

  it("validaciones: fecha futura, canal public_link, respuesta pending o canal inválido se rechazan sin dejar rastro", async () => {
    const p = await person("MCGC");
    const { id } = await invite(culturaOp, p);
    const tomorrow = new Date(Date.now() + 86400_000);
    await expect(inv.recordInvitationResponse(culturaOp, { invitationId: id, response: "confirmed", channel: "email", respondedAt: { kind: "exact", at: tomorrow } })).rejects.toThrow(/futura/);
    await expect(inv.recordInvitationResponse(culturaOp, { invitationId: id, response: "confirmed", channel: "email", respondedAt: { kind: "date_only", day: tomorrow.toISOString().slice(0, 10).replace(/^(\d{4})/, (y) => String(Number(y) + 1)) } })).rejects.toThrow(/futura/);
    await expect(inv.recordInvitationResponse(culturaOp, { invitationId: id, response: "confirmed", channel: "public_link", respondedAt: { kind: "unknown" } })).rejects.toThrow(/Canal/);
    await expect(inv.recordInvitationResponse(culturaOp, { invitationId: id, response: "pending" as never, channel: "email", respondedAt: { kind: "unknown" } })).rejects.toThrow(/Aceptó/);
    expect((await row(id)).response_status).toBe("pending");
    expect(await events(id)).toHaveLength(1);
  });

  it("mismo estado + canal + fecha = no-op; mismo estado con otro canal/fecha = corrección (response_changed con from = to)", async () => {
    const p = await person("MCGC");
    const { id } = await invite(culturaOp, p);
    const base = { invitationId: id, response: "confirmed" as const, channel: "whatsapp", respondedAt: { kind: "date_only" as const, day: "2026-03-09" } };
    expect((await inv.recordInvitationResponse(culturaOp, base)).changed).toBe(true);
    expect(await inv.recordInvitationResponse(culturaOp, base)).toEqual({ changed: false, eventType: null });
    expect(await events(id)).toHaveLength(2);
    const fix = await inv.recordInvitationResponse(culturaOp, { ...base, channel: "phone" });
    expect(fix).toEqual({ changed: true, eventType: "response_changed" });
    const ev = (await events(id)).at(-1)!;
    expect(ev).toMatchObject({ event_type: "response_changed", response_status_from: "confirmed", response_status_to: "confirmed", response_channel: "phone" });
    const fixDate = await inv.recordInvitationResponse(culturaOp, { ...base, channel: "phone", respondedAt: { kind: "unknown" } });
    expect(fixDate.eventType).toBe("response_changed");
    expect(await events(id)).toHaveLength(4);
  });

  it("confirmed ↔ declined por staff y luego por la persona: cada paso es un evento y el último gana", async () => {
    const p = await person("MCGC");
    const { id, token } = await invite(culturaOp, p);
    await inv.recordInvitationResponse(culturaOp, { invitationId: id, response: "confirmed", channel: "phone", respondedAt: { kind: "unknown" } });
    await inv.recordInvitationResponse(culturaOp, { invitationId: id, response: "declined", channel: "phone", respondedAt: { kind: "unknown" } });
    await respondToInvitation(token, "confirmed", "10.0.1.1");
    const r = await row(id);
    expect(r).toMatchObject({ response_status: "confirmed", response_channel: "public_link", response_recorded_by: null });
    expect((await events(id)).map((e) => `${e.event_type}:${e.response_status_from ?? "-"}>${e.response_status_to}:${e.recorded_by ? "staff" : "persona"}`)).toEqual([
      "invited:->pending:staff",
      "responded:pending>confirmed:staff",
      "response_changed:confirmed>declined:staff",
      "response_changed:declined>confirmed:persona",
    ]);
  });

  it("alcance: otra área, persona fuera de alcance y usuario sin permiso no pueden registrar ni retirar", async () => {
    const pIn = await person("MCGC");
    const pOut = await person("MHFGC"); // la invita un usuario con alcance más amplio
    const a = await invite(culturaOp, pIn);
    const b = await invite(master, pOut);
    await expect(inv.recordInvitationResponse(haciendaOp, { invitationId: a.id, response: "confirmed", channel: "email", respondedAt: { kind: "unknown" } })).rejects.toThrow(/no existe/);
    await expect(inv.recordInvitationResponse(culturaOp, { invitationId: b.id, response: "confirmed", channel: "email", respondedAt: { kind: "unknown" } })).rejects.toThrow(/no existe/);
    await expect(inv.recordInvitationResponse(noManage, { invitationId: a.id, response: "confirmed", channel: "email", respondedAt: { kind: "unknown" } })).rejects.toThrow(/permiso/);
    await expect(inv.withdrawInvitation(culturaOp, b.id)).rejects.toThrow(/no existe/); // persona fuera del alcance
    await expect(inv.withdrawInvitation(haciendaOp, a.id)).rejects.toThrow(/no existe/);
    expect((await row(b.id)).withdrawn_at).toBeNull();
    expect(await events(b.id)).toHaveLength(1);
    // el Master sí
    expect((await inv.recordInvitationResponse(master, { invitationId: b.id, response: "declined", channel: "email", respondedAt: { kind: "unknown" } })).changed).toBe(true);
  });

  it("listInvitations filtra por persona en alcance; los nombres internos solo con manage_invitations; sin DNI", async () => {
    const pIn = await person("MCGC");
    const pOut = await person("MHFGC");
    const a = await invite(culturaOp, pIn);
    const b = await invite(master, pOut);
    const asCultura = await inv.listInvitations(culturaOp, meetingId);
    expect(asCultura.some((r) => r.id === a.id)).toBe(true);
    expect(asCultura.some((r) => r.id === b.id)).toBe(false);
    const asMaster = await inv.listInvitations(master, meetingId);
    expect(asMaster.some((r) => r.id === b.id)).toBe(true);
    const mine = asCultura.find((r) => r.id === a.id)!;
    expect(mine.invitedByName).toBe("im-cultura@sutecba.local");
    const noNames = (await inv.listInvitations(noManage, meetingId)).find((r) => r.id === a.id)!;
    expect(noNames.invitedByName).toBeNull();
    expect(noNames.invitationChannel).toBe("whatsapp"); // el canal no es sensible
    expect(Object.keys(mine)).not.toContain("dni");
    expect(await inv.listInvitations(haciendaOp, meetingId)).toEqual([]);
  });

  it("historial legible con permiso y alcance, en orden real", async () => {
    const p = await person("MCGC");
    const { id } = await invite(culturaOp, p);
    await inv.recordInvitationResponse(culturaOp, { invitationId: id, response: "confirmed", channel: "email", respondedAt: { kind: "unknown" } });
    const history = await inv.listInvitationEvents(culturaOp, id);
    expect(history.map((h) => h.eventType)).toEqual(["invited", "responded"]);
    expect(history[1]!.recordedByName).toBe("im-cultura@sutecba.local");
    expect(await inv.listInvitationEvents(haciendaOp, id)).toEqual([]);
    await expect(inv.listInvitationEvents(noManage, id)).rejects.toThrow(/permiso/);
  });
});

describe("B2 · inserted_count refleja lo efectivamente aplicado por cada tanda", () => {
  async function batchFacts(batchId: string) {
    const db = await getDb();
    const batch = await db.selectFrom("meeting_invitation_batches").selectAll().where("id", "=", batchId).executeTakeFirstOrThrow();
    const rows = await db.selectFrom("meeting_invitations").select("id").where("batch_id", "=", batchId).execute();
    const evs = await db.selectFrom("meeting_invitation_events").select(["event_type", "invitation_id"]).where("batch_id", "=", batchId).execute();
    return { batch, rows: rows.length, events: evs.length, evs };
  }

  it("5 tandas concurrentes sobre las mismas personas: solo lo que corresponde, cada contador = lo aplicado por ESA tanda, y la suma no inventa nada", async () => {
    const db = await getDb();
    const people = [await person("MCGC"), await person("MCGC"), await person("MCGC"), await person("MCGC")];
    const results = await Promise.all(Array.from({ length: 5 }, () => inv.createInvitationBatch(culturaOp, meetingId, { personIds: people }, { channel: "whatsapp" })));
    let sumCounts = 0;
    let sumEvents = 0;
    for (const r of results) {
      const f = await batchFacts(r.batchId);
      expect(f.batch.inserted_count).toBe(r.createdCount + r.revivedCount); // contador = lo que ESA tanda aplicó
      expect(f.batch.inserted_count).toBe(f.rows); // y las invitaciones que quedaron asociadas a ella
      expect(f.events).toBe(f.batch.inserted_count);
      expect(f.batch.resolved_count).toBe(4); // tamaño de la audiencia: semántica propia, no cambia
      sumCounts += f.batch.inserted_count;
      sumEvents += f.events;
    }
    expect(sumCounts).toBe(4); // la suma de los contadores no inventa invitaciones
    expect(sumEvents).toBe(4);
    const created = await db.selectFrom("meeting_invitations").select("id").where("person_id", "in", people).execute();
    expect(created).toHaveLength(4);
    expect(results.filter((r) => r.createdCount > 0)).toHaveLength(1); // una sola tanda ganó
  });

  it("tandas concurrentes con audiencias que se superponen: cada persona se invita una vez y cada contador coincide con sus filas", async () => {
    const [a, b, c, d, e] = [await person("MCGC"), await person("MCGC"), await person("MCGC"), await person("MCGC"), await person("MCGC")];
    const results = await Promise.all([
      inv.createInvitationBatch(culturaOp, meetingId, { personIds: [a, b, c] }, { channel: "email" }),
      inv.createInvitationBatch(culturaOp, meetingId, { personIds: [b, c, d, e] }, { channel: "phone" }),
      inv.createInvitationBatch(culturaOp, meetingId, { personIds: [a, e] }, { channel: "sms" }),
    ]);
    let total = 0;
    for (const r of results) {
      const f = await batchFacts(r.batchId);
      expect(f.batch.inserted_count).toBe(f.rows);
      expect(f.events).toBe(f.rows);
      total += f.batch.inserted_count;
    }
    expect(total).toBe(5);
  });

  it("retry / no-op: la tanda repetida registra contador 0, sin filas ni eventos asociados", async () => {
    const people = [await person("MCGC"), await person("MCGC")];
    await inv.createInvitationBatch(culturaOp, meetingId, { personIds: people }, { channel: "email" });
    const retry = await inv.createInvitationBatch(culturaOp, meetingId, { personIds: people }, { channel: "email" });
    const f = await batchFacts(retry.batchId);
    expect(retry.createdCount + retry.revivedCount).toBe(0);
    expect(retry.alreadyInvitedCount).toBe(2);
    expect(f.batch.inserted_count).toBe(0);
    expect(f.batch.resolved_count).toBe(2);
    expect(f.rows).toBe(0);
    expect(f.events).toBe(0);
  });

  it("nuevas + reinvitadas: el contador histórico suma ambas operaciones efectivamente realizadas", async () => {
    const pOld = await person("MCGC");
    const pNew = await person("MCGC");
    const first = await invite(culturaOp, pOld);
    await inv.withdrawInvitation(culturaOp, first.id);
    const res = await inv.createInvitationBatch(culturaOp, meetingId, { personIds: [pOld, pNew] }, { channel: "phone" });
    expect(res.createdCount).toBe(1);
    expect(res.revivedCount).toBe(1);
    const f = await batchFacts(res.batchId);
    expect(f.batch.inserted_count).toBe(2);
    expect(f.rows).toBe(2);
    expect(f.evs.map((e) => e.event_type).sort()).toEqual(["invited", "reinvited"]);
  });
});

describe("B2 · retiro y reinvitación", () => {
  it("withdrawn: un evento; retirar de nuevo es no-op", async () => {
    const p = await person("MCGC");
    const { id } = await invite(culturaOp, p);
    await inv.withdrawInvitation(culturaOp, id);
    await inv.withdrawInvitation(culturaOp, id);
    const r = await row(id);
    expect(r.withdrawn_by).toBe(culturaOp.id);
    expect((await events(id)).map((e) => e.event_type)).toEqual(["invited", "withdrawn"]);
  });

  it("reinvitar conserva toda la historia en eventos y reinicia el estado actual (token viejo inválido)", async () => {
    const p = await person("MCGC");
    const first = await invite(culturaOp, p, "email");
    await respondToInvitation(first.token, "confirmed", "10.0.2.1");
    await inv.withdrawInvitation(culturaOp, first.id);
    const again = await inv.createInvitationBatch(master, meetingId, { personIds: [p] }, { channel: "phone" });
    expect(again.revivedCount).toBe(1);
    const r = await row(first.id);
    expect(r).toMatchObject({
      response_status: "pending", responded_at: null, responded_at_precision: null, response_channel: null, response_recorded_by: null,
      response_recorded_at: null, withdrawn_at: null, withdrawn_by: null, invited_by: masterId, invitation_channel: "phone", attendance_status: "unknown",
    });
    expect(await respondToInvitation(first.token, "declined", "10.0.2.2")).toEqual({ ok: false, reason: "invalid" });
    const ev = await events(first.id);
    expect(ev.map((e) => e.event_type)).toEqual(["invited", "responded", "withdrawn", "reinvited"]);
    expect(ev[1]).toMatchObject({ response_status_to: "confirmed", response_channel: "public_link" }); // la respuesta anterior sigue en el historial
    expect(ev[3]).toMatchObject({ response_status_from: "confirmed", response_status_to: "pending", invitation_channel: "phone", recorded_by: masterId });
    expect(ev[0]!.invitation_channel).toBe("email"); // el canal original también
  });
});

describe("B2 · atomicidad: estado + evento juntos", () => {
  async function failEventsOf(type: string, name: string) {
    const db = await getDb();
    await sql.raw(`CREATE OR REPLACE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.event_type = '${type}' THEN RAISE EXCEPTION 'falla simulada'; END IF; RETURN NEW; END $f$`).execute(db);
    await sql.raw(`CREATE TRIGGER ${name}_trg BEFORE INSERT ON public.meeting_invitation_events FOR EACH ROW EXECUTE FUNCTION public.${name}()`).execute(db);
    return async () => {
      await sql.raw(`DROP TRIGGER ${name}_trg ON public.meeting_invitation_events`).execute(db);
      await sql.raw(`DROP FUNCTION public.${name}()`).execute(db);
    };
  }

  it("si falla el evento, la respuesta de staff hace rollback: fila y evento quedan intactos", async () => {
    const p = await person("MCGC");
    const { id } = await invite(culturaOp, p);
    await inv.recordInvitationResponse(culturaOp, { invitationId: id, response: "confirmed", channel: "phone", respondedAt: { kind: "unknown" } });
    const before = await row(id);
    const undo = await failEventsOf("response_changed", "fail_rc");
    try {
      await expect(inv.recordInvitationResponse(culturaOp, { invitationId: id, response: "declined", channel: "phone", respondedAt: { kind: "unknown" } })).rejects.toThrow();
    } finally {
      await undo();
    }
    expect(await row(id)).toEqual(before);
    expect(await events(id)).toHaveLength(2);
  });

  it("si falla el evento, la respuesta pública hace rollback", async () => {
    const p = await person("MCGC");
    const { id, token } = await invite(culturaOp, p);
    const undo = await failEventsOf("responded", "fail_pub");
    try {
      await expect(respondToInvitation(token, "confirmed", "10.0.3.1")).rejects.toThrow();
    } finally {
      await undo();
    }
    expect((await row(id)).response_status).toBe("pending");
    expect(await events(id)).toHaveLength(1);
  });

  it("si falla el evento, el retiro hace rollback; y la tanda completa también (sin tanda ni invitaciones huérfanas)", async () => {
    const db = await getDb();
    const p = await person("MCGC");
    const { id } = await invite(culturaOp, p);
    const undoW = await failEventsOf("withdrawn", "fail_w");
    try {
      await expect(inv.withdrawInvitation(culturaOp, id)).rejects.toThrow();
    } finally {
      await undoW();
    }
    expect((await row(id)).withdrawn_at).toBeNull();

    const p2 = await person("MCGC");
    const batches = await db.selectFrom("meeting_invitation_batches").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow();
    const undoI = await failEventsOf("invited", "fail_i");
    try {
      await expect(inv.createInvitationBatch(culturaOp, meetingId, { personIds: [p2] }, { channel: "sms" })).rejects.toThrow();
    } finally {
      await undoI();
    }
    expect((await db.selectFrom("meeting_invitation_batches").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow()).n).toBe(batches.n);
    expect(await db.selectFrom("meeting_invitations").select("id").where("person_id", "=", p2).execute()).toHaveLength(0);
  });

  it("el historial es append-only: ni UPDATE ni DELETE", async () => {
    const p = await person("MCGC");
    const { id } = await invite(culturaOp, p);
    const db = await getDb();
    await expect(db.updateTable("meeting_invitation_events").set({ recorded_by: null } as never).where("invitation_id", "=", id).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom("meeting_invitation_events").where("invitation_id", "=", id).execute()).rejects.toThrow(/append-only/);
    expect(await events(id)).toHaveLength(1);
  });
});

describe("B2 · constraints de coherencia en base", () => {
  async function failsWith(id: string, set: Record<string, unknown>) {
    const db = await getDb();
    await expect(db.updateTable("meeting_invitations").set(set as never).where("id", "=", id).execute()).rejects.toThrow();
    expect((await row(id)).response_status).toBe("pending"); // nada quedó a medias
  }
  const now = () => new Date();

  it("combinaciones imposibles se rechazan", async () => {
    const p = await person("MCGC");
    const { id } = await invite(culturaOp, p);
    const t = now();
    // pending con datos de respuesta
    await failsWith(id, { response_channel: "email" });
    await failsWith(id, { response_recorded_at: t });
    // respondida sin canal / sin fecha de registro
    await failsWith(id, { response_status: "confirmed", response_recorded_at: t, response_recorded_by: culturaOp.id, responded_at: t, responded_at_precision: "exact_datetime" });
    await failsWith(id, { response_status: "confirmed", response_channel: "email", response_recorded_by: culturaOp.id, responded_at: t, responded_at_precision: "exact_datetime" });
    // enlace público con usuario / sin exactitud
    await failsWith(id, { response_status: "confirmed", response_channel: "public_link", response_recorded_by: culturaOp.id, response_recorded_at: t, responded_at: t, responded_at_precision: "exact_datetime" });
    await failsWith(id, { response_status: "confirmed", response_channel: "public_link", response_recorded_at: t, responded_at: t, responded_at_precision: "date_only" });
    // canal de staff sin operador
    await failsWith(id, { response_status: "confirmed", response_channel: "phone", response_recorded_at: t, responded_at: t, responded_at_precision: "exact_datetime" });
    // fecha desconocida sin operador
    await failsWith(id, { response_status: "confirmed", response_channel: "public_link", response_recorded_at: t });
    // precisión sin fecha / fecha sin precisión
    await failsWith(id, { response_status: "confirmed", response_channel: "phone", response_recorded_by: culturaOp.id, response_recorded_at: t, responded_at_precision: "exact_datetime" });
    await failsWith(id, { response_status: "confirmed", response_channel: "phone", response_recorded_by: culturaOp.id, response_recorded_at: t, responded_at: t });
    // date_only que no es medianoche de Buenos Aires
    await failsWith(id, { response_status: "confirmed", response_channel: "phone", response_recorded_by: culturaOp.id, response_recorded_at: t, responded_at: new Date("2026-03-10T12:00:00Z"), responded_at_precision: "date_only" });
    // fecha de respuesta posterior al registro
    await failsWith(id, { response_status: "confirmed", response_channel: "phone", response_recorded_by: culturaOp.id, response_recorded_at: t, responded_at: new Date(t.getTime() + 60_000), responded_at_precision: "exact_datetime" });
    // vocabularios y retiro incompleto
    await failsWith(id, { invitation_channel: "paloma" });
    await failsWith(id, { withdrawn_at: t });
  });
});

describe("B2 · B1 y datos ajenos intactos", () => {
  it("las métricas de B1 reflejan las respuestas (Aceptaron/Rechazaron/Pendientes disjuntos) sin leer attendance_status", async () => {
    const m = (await loadMeetingMetrics(master, [meetingId])).get(meetingId)!;
    const n = (v: any) => metricNumber(v)!;
    expect(n(m.accepted) + n(m.declined) + n(m.pending)).toBe(n(m.invited));
    expect(n(m.attended)).toBe(0);
    const db = await getDb();
    await db.updateTable("meeting_invitations").set({ attendance_status: "attended" } as never).where("meeting_id", "=", meetingId).execute();
    const again = (await loadMeetingMetrics(master, [meetingId])).get(meetingId)!;
    expect(metricNumber(again.attended)).toBe(0);
    await db.updateTable("meeting_invitations").set({ attendance_status: "unknown" } as never).where("meeting_id", "=", meetingId).execute();
  });

  it("migraciones 0037 y 0038 idempotentes: re-ejecutarlas no cambia constraints ni toca participaciones, asistencia o interacciones", async () => {
    const db = await getDb();
    const snapshot = async () =>
      (
        await sql<{ c: number; p: number; a: number; i: number }>`
          select (select count(*)::int from pg_constraint where conrelid in ('public.meeting_invitations'::regclass, 'public.meeting_invitation_events'::regclass)) c,
                 (select count(*)::int from meeting_participations) p, (select count(*)::int from meeting_attendance) a, (select count(*)::int from person_interactions) i`.execute(db)
      ).rows[0]!;
    const before = await snapshot();
    for (const file of ["0037_invitation_response_metadata.sql", "0038_meeting_invitation_events.sql"]) {
      const source = readFileSync(`db/migrations/${file}`, "utf8");
      for (let pass = 0; pass < 2; pass++) {
        await db.transaction().execute(async (trx) => {
          for (const st of migrationStatements(source)) await sql.raw(st).execute(trx);
        });
      }
    }
    expect(await snapshot()).toEqual(before);
    const grants = await sql<{ privs: string }>`select string_agg(distinct privilege_type, ',' order by privilege_type) privs from information_schema.role_table_grants where table_name = 'meeting_invitation_events' and grantee = 'sutecba_app'`.execute(db);
    expect(grants.rows[0]!.privs).toBe("INSERT,SELECT");
    const rls = await sql<{ relrowsecurity: boolean }>`select relrowsecurity from pg_class where oid = 'public.meeting_invitation_events'::regclass`.execute(db);
    expect(rls.rows[0]!.relrowsecurity).toBe(true);
  });

  it("defensa adicional (no es garantía de integridad): solo los comandos del módulo de invitaciones escriben meeting_invitations", () => {
    const allowedFull = new Set(["lib/meetings/invitations.ts", "lib/meetings/public.ts"]);
    // Escritores LEGACY del campo deprecado attendance_status (B3 los reemplaza): solo pueden tocar ese campo.
    const legacyAttendanceOnly = new Set(["lib/meetings/commands.ts", "lib/attendance/manual.ts", "lib/attendance/checkin.ts"]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (name === "node_modules" || name === ".next") continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          const src = readFileSync(full, "utf8");
          const rel = full.replace(/\\/g, "/");
          if (!/updateTable\(\s*["']meeting_invitations["']\s*\)|insertInto\(\s*["']meeting_invitations["']\s*\)/.test(src)) continue;
          if (allowedFull.has(rel)) continue;
          if (legacyAttendanceOnly.has(rel)) {
            const sets = [...src.matchAll(/updateTable\(\s*["']meeting_invitations["']\s*\)[\s\S]{0,200}?\.set\(\s*\{([^}]*)\}/g)].map((m) => m[1]!.trim());
            if (sets.every((s) => /^attendance_status\b/.test(s))) continue;
          }
          offenders.push(rel);
        }
      }
    };
    walk("lib");
    walk("app");
    expect(offenders).toEqual([]);
  });
});
