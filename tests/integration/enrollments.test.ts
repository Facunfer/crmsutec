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
const { migrationStatements } = await import("../../lib/db/migration-sql.js");
const reg = await import("../../lib/meetings/registrations.js");
const inv = await import("../../lib/meetings/invitations.js");
const att = await import("../../lib/attendance/manual.js");
const { respondToInvitation } = await import("../../lib/meetings/public.js");
const { loadMeetingMetrics, loadCampaignMetrics } = await import("../../lib/activities/metrics.js");
const { listMeetingParticipants } = await import("../../lib/meetings/participants.js");
const { listCampaignParticipants } = await import("../../lib/campaigns/queries.js");
const { syncParticipationInteractions } = await import("../../lib/interactions/participation-sync.js");
const { getPersonMeetingActivity } = await import("../../lib/people/queries.js");
const { metricNumber } = await import("../../lib/activities/labels.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));
const O: Record<string, string> = {};
let masterId: string;
let master: any;
let culturaOp: any;
let haciendaOp: any;
let noManage: any;
let seq = 0;
let ip = 0;
const nextIp = () => `10.8.${Math.floor(++ip / 250)}.${ip % 250}`;

function actorOf(id: string, roleKey: "MASTER_GLOBAL" | "ADMIN", permissions: Set<string> = ALL): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions };
}
async function makeUser(email: string, roleKey: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id, status: "active" } as never).returning("id").executeTakeFirstOrThrow()).id;
}
async function person(orgCode: string | null = "MCGC") {
  const db = await getDb();
  seq += 1;
  return (await db.insertInto("people").values({ first_name: `Per${seq}`, last_name: `Ape${seq}`, dni: `6${String(seq).padStart(7, "0")}`, organization_id: orgCode ? O[orgCode]! : null, origin: "import" } as never).returning("id").executeTakeFirstOrThrow()).id;
}
async function meeting(status: "draft" | "scheduled" | "in_progress" | "finished" | "cancelled", extra: Record<string, unknown> = {}) {
  const db = await getDb();
  return (
    await db
      .insertInto("meetings")
      .values({
        name: `Reunión ${status} ${++seq}`, owner_organization_id: O.MCGC!, organizer_user_id: masterId, created_by: masterId, origin: "manual", status,
        meeting_type: "reunion", schedule_precision: "exact_datetime", starts_at: new Date(Date.now() + 3_600_000), ends_at: new Date(Date.now() + 7_200_000), ...extra,
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}
const regRows = async (m: string, p: string) => {
  const db = await getDb();
  return db.selectFrom("meeting_participations").selectAll().where("meeting_id", "=", m).where("person_id", "=", p).where("participation_kind", "=", "registration").execute();
};
const events = async (participationId: string) => {
  const db = await getDb();
  return db.selectFrom("meeting_registration_events").selectAll().where("participation_id", "=", participationId).orderBy("seq", "asc").execute();
};
const countOf = async (table: string) => {
  const db = await getDb();
  return (await sql<{ n: number }>`select count(*)::int n from ${sql.table(table)}`.execute(db)).rows[0]!.n;
};
const enroll = (actor: any, m: string, p: string, extra: Record<string, unknown> = {}) =>
  reg.enrollPerson(actor, { meetingId: m, personId: p, channel: "whatsapp", when: { kind: "now" }, ...extra } as never);
const registeredMetric = async (m: string, actor: any = master) => metricNumber((await loadMeetingMetrics(actor, [m])).get(m)!.registered);
async function inviteAndAccept(m: string, p: string, how: "staff" | "public" = "staff") {
  const batch = await inv.createInvitationBatch(master, m, { personIds: [p] }, { channel: "whatsapp" });
  const token = batch.links[0]!.token;
  const db = await getDb();
  const row = await db.selectFrom("meeting_invitations").select("id").where("meeting_id", "=", m).where("person_id", "=", p).executeTakeFirstOrThrow();
  if (how === "public") await respondToInvitation(token, "confirmed", nextIp());
  else await inv.recordInvitationResponse(master, { invitationId: row.id, response: "confirmed", channel: "phone", respondedAt: { kind: "unknown" } });
  return row.id;
}

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
  masterId = await makeUser("b4-master@sutecba.local", "MASTER_GLOBAL");
  master = actorOf(masterId, "MASTER_GLOBAL");
  const culturaId = await makeUser("b4-cultura@sutecba.local", "ADMIN");
  const haciendaId = await makeUser("b4-hacienda@sutecba.local", "ADMIN");
  const noManageId = await makeUser("b4-nomanage@sutecba.local", "ADMIN");
  const scope = (user: string, orgId: string) => db.insertInto("user_scopes").values({ user_id: user, organization_id: orgId, include_descendants: true, granted_by: masterId } as never).execute();
  await scope(culturaId, O.MCGC!);
  await scope(haciendaId, O.MHFGC!);
  await scope(noManageId, O.MCGC!);
  culturaOp = actorOf(culturaId, "ADMIN");
  haciendaOp = actorOf(haciendaId, "ADMIN");
  noManage = actorOf(noManageId, "ADMIN", new Set([...ALL].filter((p) => p !== "meetings.manage_invitations")));
});

afterAll(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("B4 · inscripción manual (clase A)", () => {
  it("sin invitación y sin respuesta: queda la fila con operador, canal real y fecha; evento registered; nada más se crea", async () => {
    const m = await meeting("scheduled");
    const p = await person();
    const before = { inv: await countOf("meeting_invitations"), att: await countOf("meeting_attendance"), itx: await countOf("person_interactions"), part: await countOf("meeting_participations") };
    expect(await enroll(culturaOp, m, p, { channel: "phone" })).toEqual({ changed: true });
    const [r] = await regRows(m, p);
    expect(r).toMatchObject({
      participation_kind: "registration", participation_basis: "standard", recorded_by: culturaOp.id, origin_channel: "phone", origin_invitation_id: null,
      registered_at_precision: "exact_datetime", evidence: null, import_row_id: null, voided_at: null,
    });
    expect(r!.registered_at!.getTime()).toBeLessThanOrEqual(Date.now());
    const ev = await events(r!.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: "registered", recorded_by: culturaOp.id, origin_channel: "phone", origin_invitation_id: null, registered_at_precision: "exact_datetime" });
    // una inscripción NO crea invitación, participación, asistencia ni interacción
    expect(await countOf("meeting_invitations")).toBe(before.inv);
    expect(await countOf("meeting_attendance")).toBe(before.att);
    expect(await countOf("person_interactions")).toBe(before.itx);
    expect(await countOf("meeting_participations")).toBe(before.part + 1); // solo la propia inscripción
    expect(await registeredMetric(m)).toBe(1);
    const db = await getDb();
    expect(await db.selectFrom("meeting_participations").select("id").where("meeting_id", "=", m).where("participation_kind", "in", ["participated", "attended"] as never).execute()).toHaveLength(0);
    expect(metricNumber((await loadMeetingMetrics(master, [m])).get(m)!.participated)).toBe(0);
  });

  it("fecha: «no se sabe» deja registered_at NULL; solo el día = medianoche de Buenos Aires; nunca futura", async () => {
    const m = await meeting("scheduled");
    const [a, b, c] = [await person(), await person(), await person()];
    await enroll(culturaOp, m, a, { when: { kind: "unknown" } });
    expect((await regRows(m, a))[0]).toMatchObject({ registered_at: null, registered_at_precision: null });
    await enroll(culturaOp, m, b, { when: { kind: "date_only", day: "2026-03-10" } });
    const rb = (await regRows(m, b))[0]!;
    expect(rb.registered_at!.toISOString()).toBe("2026-03-10T03:00:00.000Z");
    expect(rb.registered_at_precision).toBe("date_only");
    await expect(enroll(culturaOp, m, c, { when: { kind: "exact", at: new Date(Date.now() + 86400_000) } })).rejects.toThrow(/futura/);
    await expect(enroll(culturaOp, m, c, { when: { kind: "date_only", day: "2999-01-01" } })).rejects.toThrow(/futura/);
    await expect(enroll(culturaOp, m, c, { channel: "public_link" })).rejects.toThrow(/Canal/);
    expect(await regRows(m, c)).toHaveLength(0);
  });

  it("estados: draft, scheduled e in_progress sí; finished solo retroactiva (sin «ahora», con motivo); cancelled no", async () => {
    for (const status of ["draft", "scheduled", "in_progress"] as const) {
      const m = await meeting(status);
      expect(await enroll(culturaOp, m, await person())).toEqual({ changed: true });
    }
    const fin = await meeting("finished");
    const p = await person();
    await expect(enroll(culturaOp, fin, p)).rejects.toThrow(/motivo|retroactiva/);
    await expect(enroll(culturaOp, fin, p, { when: { kind: "date_only", day: "2026-03-10" } })).rejects.toThrow(/motivo/);
    await expect(enroll(culturaOp, fin, p, { when: { kind: "now" }, reason: "carga tardía" })).rejects.toThrow(/retroactiva/);
    expect(await enroll(culturaOp, fin, p, { when: { kind: "date_only", day: "2026-03-10" }, reason: "carga tardía de la planilla" })).toEqual({ changed: true });
    const [r] = await regRows(fin, p);
    expect((await events(r!.id))[0]).toMatchObject({ event_type: "registered", reason: "carga tardía de la planilla" });
    await expect(enroll(culturaOp, await meeting("cancelled"), await person())).rejects.toThrow(/cancelada/);
  });

  it("doble clic = no-op; carrera concurrente = una fila y un evento; dos operadores a la vez también", async () => {
    const m = await meeting("scheduled");
    const p = await person();
    expect((await enroll(culturaOp, m, p)).changed).toBe(true);
    expect((await enroll(culturaOp, m, p)).changed).toBe(false);
    const q = await person();
    const results = await Promise.all([enroll(culturaOp, m, q), enroll(master, m, q, { channel: "email" }), enroll(culturaOp, m, q), enroll(master, m, q)]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    const rows = await regRows(m, q);
    expect(rows).toHaveLength(1);
    expect(await events(rows[0]!.id)).toHaveLength(1);
  });

  it("alcance y permisos: sin permiso, otra área, persona fuera de alcance y persona sin organización fallan; Master global", async () => {
    const m = await meeting("scheduled");
    const mine = await person("MCGC");
    const other = await person("MHFGC");
    const noOrg = await person(null);
    await expect(enroll(noManage, m, mine)).rejects.toThrow(/permiso/);
    await expect(enroll(haciendaOp, m, mine)).rejects.toThrow(/no existe/);
    await expect(enroll(culturaOp, m, other)).rejects.toThrow(/no existe/);
    await expect(enroll(culturaOp, m, noOrg)).rejects.toThrow(/no existe/);
    expect(await enroll(master, m, noOrg)).toEqual({ changed: true });
    expect(await regRows(m, other)).toHaveLength(0);
    expect(await regRows(m, mine)).toHaveLength(0);
  });
});

describe("B4 · «Inscribir aceptados» (clase B)", () => {
  it("la respuesta afirmativa NO inscribe sola", async () => {
    const m = await meeting("scheduled");
    const p = await person();
    await inviteAndAccept(m, p);
    expect(await regRows(m, p)).toHaveLength(0);
    expect(await registeredMetric(m)).toBe(0);
  });

  it("vista previa sin escribir; ejecución: solo invitaciones vigentes confirmed en alcance, con origen en la invitación y sin canal propio", async () => {
    const m = await meeting("scheduled");
    const acceptedPublic = await person();
    const acceptedStaff = await person();
    const pending = await person();
    const declined = await person();
    const withdrawn = await person();
    const outOfScope = await person("MHFGC");
    const already = await person();
    const voidedOne = await person();
    const db = await getDb();
    const invPublic = await inviteAndAccept(m, acceptedPublic, "public");
    await inviteAndAccept(m, acceptedStaff);
    await inv.createInvitationBatch(master, m, { personIds: [pending] });
    const dInv = await inviteAndAccept(m, declined);
    await inv.recordInvitationResponse(master, { invitationId: dInv, response: "declined", channel: "phone", respondedAt: { kind: "unknown" } });
    const wInv = await inviteAndAccept(m, withdrawn);
    await inv.withdrawInvitation(master, wInv);
    await inviteAndAccept(m, outOfScope);
    await inviteAndAccept(m, already);
    await inviteAndAccept(m, voidedOne);
    await enroll(culturaOp, m, already);
    await enroll(culturaOp, m, voidedOne);
    const vId = (await regRows(m, voidedOne))[0]!.id;
    await reg.voidEnrollment(culturaOp, { participationId: vId, reason: "error" });

    const partsBefore = await countOf("meeting_participations");
    const preview = await reg.previewEnrollAccepted(culturaOp, m);
    expect(preview).toEqual({ eligible: 4, alreadyRegistered: 1, voided: 1, created: 2, outOfScope: 1 });
    expect(await countOf("meeting_participations")).toBe(partsBefore); // la vista previa no escribe

    const before = new Date();
    const done = await reg.enrollAccepted(culturaOp, m);
    expect(done).toEqual({ eligible: 4, alreadyRegistered: 1, voided: 1, created: 2, outOfScope: 1 });
    for (const p of [acceptedPublic, acceptedStaff]) {
      const [r] = await regRows(m, p);
      expect(r).toMatchObject({ recorded_by: culturaOp.id, origin_channel: null, registered_at_precision: "exact_datetime", participation_basis: "standard", voided_at: null });
      expect(r!.origin_invitation_id).not.toBeNull();
      expect(r!.registered_at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5);
      const ev = await events(r!.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ event_type: "registered", origin_channel: null, origin_invitation_id: r!.origin_invitation_id, recorded_by: culturaOp.id });
    }
    // el canal con que respondió la persona NO se copia: la inscripción por enlace público NO queda como «public_link»
    const pubReg = (await regRows(m, acceptedPublic))[0]!;
    expect(pubReg.origin_invitation_id).toBe(invPublic);
    const invRow = await db.selectFrom("meeting_invitations").select(["response_channel"]).where("id", "=", invPublic).executeTakeFirstOrThrow();
    expect(invRow.response_channel).toBe("public_link");
    expect(pubReg.origin_channel).toBeNull();
    // no inscribe a pendientes, rechazados, retirados, fuera de alcance, ni restaura anuladas
    for (const p of [pending, declined, withdrawn, outOfScope]) expect(await regRows(m, p)).toHaveLength(0);
    expect((await regRows(m, voidedOne))[0]!.voided_at).not.toBeNull();
    expect((await regRows(m, already))[0]!.origin_invitation_id).toBeNull(); // la manual previa no se pisa
    expect(await registeredMetric(m)).toBe(3); // already + los 2 creados (la anulada no cuenta)
  });

  it("idempotente: segunda ejecución y ejecuciones concurrentes no duplican filas ni eventos", async () => {
    const m = await meeting("scheduled");
    const people = [await person(), await person(), await person()];
    for (const p of people) await inviteAndAccept(m, p);
    const results = await Promise.all([reg.enrollAccepted(culturaOp, m), reg.enrollAccepted(master, m), reg.enrollAccepted(culturaOp, m)]);
    expect(results.reduce((a, r) => a + r.created, 0)).toBe(3);
    const again = await reg.enrollAccepted(culturaOp, m);
    expect(again.created).toBe(0);
    expect(again.alreadyRegistered).toBe(3);
    for (const p of people) {
      const rows = await regRows(m, p);
      expect(rows).toHaveLength(1);
      expect(await events(rows[0]!.id)).toHaveLength(1);
    }
  });

  it("estados y permisos: solo reunión programada o en curso; sin permiso o fuera de alcance falla; FK compuesta impide el origen cruzado", async () => {
    const fin = await meeting("finished");
    await expect(reg.enrollAccepted(culturaOp, fin)).rejects.toThrow(/programada o en curso/);
    const m = await meeting("scheduled");
    await expect(reg.enrollAccepted(noManage, m)).rejects.toThrow(/permiso/);
    await expect(reg.enrollAccepted(haciendaOp, m)).rejects.toThrow(/no existe/);
    // la invitación de origen debe ser de la MISMA persona y la MISMA reunión
    const [juan, pedro] = [await person(), await person()];
    const m2 = await meeting("scheduled");
    const invPedro = await inviteAndAccept(m, pedro);
    const invJuanOtraReunion = await inviteAndAccept(m2, juan);
    const db = await getDb();
    const base = { participation_kind: "registration", participation_basis: "standard", recorded_by: masterId, registered_at: null, registered_at_precision: null };
    await expect(db.insertInto("meeting_participations").values({ ...base, meeting_id: m, person_id: juan, origin_invitation_id: invPedro } as never).execute()).rejects.toThrow();
    await expect(db.insertInto("meeting_participations").values({ ...base, meeting_id: m, person_id: juan, origin_invitation_id: invJuanOtraReunion } as never).execute()).rejects.toThrow();
    await expect(db.insertInto("meeting_participations").values({ ...base, meeting_id: m2, person_id: juan, origin_invitation_id: invJuanOtraReunion } as never).execute()).resolves.toBeDefined();
  });
});

describe("B4 · anulación, restauración y corrección", () => {
  async function registered(status: "scheduled" | "in_progress" = "scheduled") {
    const m = await meeting(status);
    const p = await person();
    await enroll(culturaOp, m, p);
    const row = (await regRows(m, p))[0]!;
    return { m, p, id: row.id };
  }

  it("anular exige motivo; deja la fila, deja de contar y no muestra chip activo; NO toca participación, asistencia, invitación ni interacciones", async () => {
    const { m, p, id } = await registered("in_progress");
    const db = await getDb();
    // la persona además participó (por regla de la fuente), asistió y fue invitada: cada hecho es independiente
    await db.insertInto("meeting_participations").values({ meeting_id: m, person_id: p, participation_kind: "participated", participation_basis: "source_business_rule", evidence: "regla" } as never).execute();
    await inv.createInvitationBatch(master, m, { personIds: [p] }, { channel: "email" });
    await att.registerAttendanceManually(culturaOp, { meetingId: m, personId: p, reason: "mesa", occurred: { kind: "now" } });
    const snap = async () => ({
      part: await db.selectFrom("meeting_participations").select(["id", "participation_kind", "voided_at"]).where("meeting_id", "=", m).where("person_id", "=", p).where("participation_kind", "=", "participated").execute(),
      att: await db.selectFrom("meeting_attendance").select(["id", "revoked_at"]).where("meeting_id", "=", m).execute(),
      inv: await db.selectFrom("meeting_invitations").selectAll().where("meeting_id", "=", m).where("person_id", "=", p).execute(),
      itx: await countOf("person_interactions"),
    });
    const before = await snap();
    const metricsBefore = (await loadMeetingMetrics(master, [m])).get(m)!;
    expect(metricNumber(metricsBefore.registered)).toBe(1);

    await expect(reg.voidEnrollment(culturaOp, { participationId: id, reason: "  " })).rejects.toThrow(/motivo/);
    expect(await reg.voidEnrollment(culturaOp, { participationId: id, reason: "carga duplicada" })).toEqual({ changed: true });
    const [row] = await regRows(m, p);
    expect(row).toMatchObject({ voided_by: culturaOp.id, void_reason: "carga duplicada", recorded_by: culturaOp.id, origin_channel: "whatsapp" }); // la procedencia se conserva
    expect(row!.voided_at).not.toBeNull();

    const metricsAfter = (await loadMeetingMetrics(master, [m])).get(m)!;
    expect(metricNumber(metricsAfter.registered)).toBe(0);
    expect(metricNumber(metricsAfter.participated)).toBe(metricNumber(metricsBefore.participated));
    expect(metricNumber(metricsAfter.attended)).toBe(metricNumber(metricsBefore.attended));
    expect(JSON.stringify(await snap())).toBe(JSON.stringify(before));
    const facts = (await listMeetingParticipants(master, m)).assigned.find((x) => x.personId === p)!;
    expect(facts.facts.registered).toBe(false); // sin chip activo de Inscripto
    expect(facts.facts.participated).toBe(true);
    expect(facts.facts.attended).toBe(true);
    expect(facts.registration).toMatchObject({ active: false, voidReason: "carga duplicada" });
    const act = (await getPersonMeetingActivity(master, p)).find((a) => a.meetingId === m)!;
    expect(act.activityKind).not.toBe("registration");
  });

  it("restaurar exige motivo, vuelve a contar, usa la MISMA fila y deja la cadena de eventos con quién/cuándo/por qué", async () => {
    const { m, p, id } = await registered();
    await reg.voidEnrollment(culturaOp, { participationId: id, reason: "error de carga" });
    await expect(reg.restoreEnrollment(culturaOp, { participationId: id, reason: "" })).rejects.toThrow(/motivo/);
    expect(await reg.restoreEnrollment(master, { participationId: id, reason: "era correcta" })).toEqual({ changed: true });
    const rows = await regRows(m, p);
    expect(rows).toHaveLength(1); // sin segunda fila
    expect(rows[0]).toMatchObject({ id, voided_at: null, voided_by: null, void_reason: null });
    expect(await registeredMetric(m)).toBe(1);
    const ev = await events(id);
    expect(ev.map((e) => e.event_type)).toEqual(["registered", "voided", "restored"]);
    expect(ev[1]).toMatchObject({ recorded_by: culturaOp.id, reason: "error de carga" });
    expect(ev[2]).toMatchObject({ recorded_by: masterId, reason: "era correcta" });
    // volver a inscribir a mano una anulada no crea otra fila: se restaura
    await reg.voidEnrollment(culturaOp, { participationId: id, reason: "otra vez" });
    await expect(enroll(culturaOp, m, p)).rejects.toThrow(/restaurala/);
    expect(await regRows(m, p)).toHaveLength(1);
  });

  it("reintentos = no-op (anular dos veces, restaurar dos veces, restaurar una vigente) y sin eventos duplicados", async () => {
    const { id } = await registered();
    expect((await reg.restoreEnrollment(culturaOp, { participationId: id, reason: "x" })).changed).toBe(false);
    await reg.voidEnrollment(culturaOp, { participationId: id, reason: "uno" });
    expect((await reg.voidEnrollment(culturaOp, { participationId: id, reason: "dos" })).changed).toBe(false);
    await reg.restoreEnrollment(culturaOp, { participationId: id, reason: "tres" });
    expect((await reg.restoreEnrollment(culturaOp, { participationId: id, reason: "cuatro" })).changed).toBe(false);
    const ev = await events(id);
    expect(ev.map((e) => e.event_type)).toEqual(["registered", "voided", "restored"]);
    expect(ev[1]!.reason).toBe("uno");
  });

  it("concurrencia: dos anulaciones = un evento; anular y restaurar a la vez dejan una cadena coherente con la fila", async () => {
    const a = await registered();
    await Promise.all([reg.voidEnrollment(culturaOp, { participationId: a.id, reason: "a" }), reg.voidEnrollment(master, { participationId: a.id, reason: "b" })]);
    expect((await events(a.id)).filter((e) => e.event_type === "voided")).toHaveLength(1);
    await reg.restoreEnrollment(culturaOp, { participationId: a.id, reason: "c" });
    await Promise.all([
      reg.voidEnrollment(culturaOp, { participationId: a.id, reason: "d" }),
      reg.restoreEnrollment(master, { participationId: a.id, reason: "e" }),
      reg.voidEnrollment(master, { participationId: a.id, reason: "f" }),
    ]);
    const chain = (await events(a.id)).slice(1);
    let active = true;
    for (const e of chain) {
      if (e.event_type === "voided") { expect(active).toBe(true); active = false; }
      if (e.event_type === "restored") { expect(active).toBe(false); active = true; }
    }
    const db = await getDb();
    const row = await db.selectFrom("meeting_participations").select("voided_at").where("id", "=", a.id).executeTakeFirstOrThrow();
    expect(row.voided_at === null).toBe(active);
  });

  it("corregir (manual): fecha, precisión y canal; mismo valor = no-op; motivo obligatorio; sin tocar identidad ni origen", async () => {
    const { m, p, id } = await registered();
    await expect(reg.correctEnrollment(culturaOp, { participationId: id, reason: "", when: { kind: "unknown" }, channel: "email" })).rejects.toThrow(/motivo/);
    await expect(reg.correctEnrollment(culturaOp, { participationId: id, reason: "x", when: { kind: "unknown" }, channel: "public_link" })).rejects.toThrow(/Canal/);
    expect(await reg.correctEnrollment(culturaOp, { participationId: id, reason: "era por correo", when: { kind: "date_only", day: "2026-03-09" }, channel: "email" })).toEqual({ changed: true });
    const [r] = await regRows(m, p);
    expect(r).toMatchObject({ origin_channel: "email", registered_at_precision: "date_only", recorded_by: culturaOp.id, participation_basis: "standard", person_id: p, meeting_id: m });
    expect(r!.registered_at!.toISOString()).toBe("2026-03-09T03:00:00.000Z");
    expect((await reg.correctEnrollment(culturaOp, { participationId: id, reason: "igual", when: { kind: "date_only", day: "2026-03-09" }, channel: "email" })).changed).toBe(false);
    await reg.correctEnrollment(culturaOp, { participationId: id, reason: "no se sabe", when: { kind: "unknown" }, channel: "email" });
    expect((await regRows(m, p))[0]).toMatchObject({ registered_at: null, registered_at_precision: null });
    const ev = await events(id);
    expect(ev.map((e) => e.event_type)).toEqual(["registered", "corrected", "corrected"]);
    expect(ev[1]).toMatchObject({ reason: "era por correo", origin_channel: "email", registered_at_precision: "date_only", origin_invitation_id: null });
    // una inscripción anulada no se corrige
    await reg.voidEnrollment(culturaOp, { participationId: id, reason: "x" });
    await expect(reg.correctEnrollment(culturaOp, { participationId: id, reason: "x", when: { kind: "unknown" }, channel: "email" })).rejects.toThrow(/anulada/);
  });

  it("corregir (desde aceptación): solo fecha/precisión; no admite canal; el origen es inmutable (también en la base)", async () => {
    const m = await meeting("scheduled");
    const p = await person();
    const invId = await inviteAndAccept(m, p);
    await reg.enrollAccepted(culturaOp, m);
    const [r] = await regRows(m, p);
    await expect(reg.correctEnrollment(culturaOp, { participationId: r!.id, reason: "x", when: { kind: "unknown" }, channel: "email" })).rejects.toThrow(/sin canal propio|no tiene canal/);
    expect(await reg.correctEnrollment(culturaOp, { participationId: r!.id, reason: "fecha real", when: { kind: "date_only", day: "2026-03-09" } })).toEqual({ changed: true });
    const after = (await regRows(m, p))[0]!;
    expect(after).toMatchObject({ origin_channel: null, origin_invitation_id: invId, registered_at_precision: "date_only" });
    const db = await getDb();
    const other = await inviteAndAccept(await meeting("scheduled"), p);
    for (const set of [{ origin_invitation_id: other }, { origin_invitation_id: null }, { recorded_by: masterId }, { participation_basis: "legacy_initial_import" }, { participation_kind: "participated" }, { person_id: await person() }, { meeting_id: await meeting("scheduled") }, { import_row_id: null, evidence: "x" }, { created_at: new Date() }]) {
      await expect(db.updateTable("meeting_participations").set(set as never).where("id", "=", r!.id).execute()).rejects.toThrow();
    }
    // y la corrección no puede darle un canal a una inscripción nacida de una aceptación (CHECK de clase)
    await expect(db.updateTable("meeting_participations").set({ origin_channel: "email" } as never).where("id", "=", r!.id).execute()).rejects.toThrow();
  });

  it("alcance y permisos de anular/restaurar/corregir/historial", async () => {
    const m = await meeting("scheduled");
    const inScope = await person("MCGC");
    const outScope = await person("MHFGC");
    await enroll(master, m, inScope);
    await enroll(master, m, outScope);
    const a = (await regRows(m, inScope))[0]!.id;
    const b = (await regRows(m, outScope))[0]!.id;
    await expect(reg.voidEnrollment(culturaOp, { participationId: b, reason: "x" })).rejects.toThrow(/no existe/);
    await expect(reg.voidEnrollment(haciendaOp, { participationId: a, reason: "x" })).rejects.toThrow(/no existe/);
    await expect(reg.voidEnrollment(noManage, { participationId: a, reason: "x" })).rejects.toThrow(/permiso/);
    await expect(reg.restoreEnrollment(noManage, { participationId: a, reason: "x" })).rejects.toThrow(/permiso/);
    await expect(reg.listEnrollmentEvents(noManage, a)).rejects.toThrow(/permiso/);
    expect(await reg.listEnrollmentEvents(culturaOp, b)).toEqual([]); // persona fuera de alcance: no se revela nada
    expect((await reg.listEnrollmentEvents(culturaOp, a)).map((e) => e.eventType)).toEqual(["registered"]);
    expect((await reg.listEnrollmentEvents(master, b)).length).toBe(1);
    expect((await reg.voidEnrollment(master, { participationId: b, reason: "global" })).changed).toBe(true);
    // los no gestores no ven inscripciones anuladas, ni quién las cargó ni el motivo
    await reg.voidEnrollment(culturaOp, { participationId: a, reason: "motivo reservado" });
    const asManager = (await listMeetingParticipants(culturaOp, m)).assigned.find((x) => x.personId === inScope)!;
    expect(asManager.registration).toMatchObject({ active: false, voidReason: "motivo reservado" });
    const asReader = await listMeetingParticipants(noManage, m);
    expect(asReader.assigned.find((x) => x.personId === inScope)).toBeUndefined();
    expect(JSON.stringify(asReader)).not.toContain("motivo reservado");
  });

  it("rollback atómico: si falla el evento, ni la inscripción ni la anulación quedan", async () => {
    const m = await meeting("scheduled");
    const p = await person();
    const db = await getDb();
    const fail = async (type: string, name: string) => {
      await sql.raw(`CREATE OR REPLACE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.event_type = '${type}' THEN RAISE EXCEPTION 'falla simulada'; END IF; RETURN NEW; END $f$`).execute(db);
      await sql.raw(`CREATE TRIGGER ${name}_trg BEFORE INSERT ON public.meeting_registration_events FOR EACH ROW EXECUTE FUNCTION public.${name}()`).execute(db);
      return async () => {
        await sql.raw(`DROP TRIGGER ${name}_trg ON public.meeting_registration_events`).execute(db);
        await sql.raw(`DROP FUNCTION public.${name}()`).execute(db);
      };
    };
    let undo = await fail("registered", "fail_reg");
    try { await expect(enroll(culturaOp, m, p)).rejects.toThrow(); } finally { await undo(); }
    expect(await regRows(m, p)).toHaveLength(0);
    await enroll(culturaOp, m, p);
    const id = (await regRows(m, p))[0]!.id;
    undo = await fail("voided", "fail_void");
    try { await expect(reg.voidEnrollment(culturaOp, { participationId: id, reason: "x" })).rejects.toThrow(); } finally { await undo(); }
    expect((await regRows(m, p))[0]!.voided_at).toBeNull();
    expect(await events(id)).toHaveLength(1);
    // inscribir aceptados también es atómico
    const m2 = await meeting("scheduled");
    const q = await person();
    await inviteAndAccept(m2, q);
    undo = await fail("registered", "fail_acc");
    try { await expect(reg.enrollAccepted(culturaOp, m2)).rejects.toThrow(); } finally { await undo(); }
    expect(await regRows(m2, q)).toHaveLength(0);
  });

  it("el historial es append-only", async () => {
    const { id } = await registered();
    const db = await getDb();
    await expect(db.updateTable("meeting_registration_events").set({ reason: "x" } as never).where("participation_id", "=", id).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom("meeting_registration_events").where("participation_id", "=", id).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom("meeting_participations").where("id", "=", id).execute()).rejects.toThrow(/DELETE/);
  });
});

describe("B4 · históricos intactos", () => {
  async function historical(m: string | null, campaignKey: string | null, p: string, evidence: string | null = null) {
    const db = await getDb();
    return (
      await db
        .insertInto("meeting_participations")
        .values({ meeting_id: m, campaign_key: campaignKey, person_id: p, participation_kind: "registration", participation_basis: "standard", evidence } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  }

  it("una inscripción importada no tiene operador, fecha, canal ni invitación; no hay eventos retroactivos; solo admite anulación/restauración", async () => {
    const m = await meeting("finished", { origin: "import", schedule_precision: "date_only", event_date: new Date("2026-03-10T00:00:00Z"), starts_at: null, ends_at: null, source_event_key: `training:52016-${seq}` });
    const p = await person();
    const id = await historical(m, null, p, "Inscripción según el listado 52016 (T-test), fila 3: no acredita participación ni asistencia.");
    const [r0] = await regRows(m, p);
    expect(r0).toMatchObject({ recorded_by: null, registered_at: null, registered_at_precision: null, origin_channel: null, origin_invitation_id: null, voided_at: null });
    expect(await events(id)).toHaveLength(0);
    expect(await registeredMetric(m)).toBe(1);
    // corregir una importada no se puede (no tiene metadata operativa) ni por comando ni directo en la base
    await expect(reg.correctEnrollment(culturaOp, { participationId: id, reason: "x", when: { kind: "date_only", day: "2026-03-10" }, channel: "email" })).rejects.toThrow(/cargada desde el CRM/);
    const db = await getDb();
    await expect(db.updateTable("meeting_participations").set({ registered_at: new Date(), registered_at_precision: "exact_datetime" } as never).where("id", "=", id).execute()).rejects.toThrow();
    await expect(db.updateTable("meeting_participations").set({ origin_channel: "phone" } as never).where("id", "=", id).execute()).rejects.toThrow();
    // sí se puede anular y restaurar (acto administrativo con motivo e historial)
    await reg.voidEnrollment(culturaOp, { participationId: id, reason: "importada por error" });
    expect(await registeredMetric(m)).toBe(0);
    await reg.restoreEnrollment(culturaOp, { participationId: id, reason: "estaba bien" });
    expect(await registeredMetric(m)).toBe(1);
    const [r1] = await regRows(m, p);
    expect(r1).toMatchObject({ recorded_by: null, registered_at: null, origin_channel: null, origin_invitation_id: null, evidence: r0!.evidence, participation_basis: "standard" });
    expect((await events(id)).map((e) => e.event_type)).toEqual(["voided", "restored"]);
    const facts = (await listMeetingParticipants(master, m)).assigned.find((x) => x.personId === p)!;
    expect(facts.registration).toMatchObject({ active: true, operative: false, registeredAt: null });
    expect(facts.provenance).toContain("Inscripción registrada en el sistema"); // fixture sin import_row_id: no se afirma «listado importado»
    expect(facts.facts).toMatchObject({ registered: true, participated: false, attended: false });
  });

  it("combinaciones imposibles en la base: una fila importada no recibe metadata; las clases A y B son excluyentes", async () => {
    const m = await meeting("scheduled");
    const db = await getDb();
    const p = () => person();
    const reg1 = async (extra: Record<string, unknown>) =>
      db.insertInto("meeting_participations").values({ meeting_id: m, person_id: await p(), participation_kind: "registration", participation_basis: "standard", ...extra } as never).execute();
    await expect(reg1({ origin_channel: "phone" })).rejects.toThrow(); // canal sin operador
    await expect(reg1({ registered_at: new Date(), registered_at_precision: "exact_datetime" })).rejects.toThrow(); // fecha sin operador
    await expect(reg1({ recorded_by: masterId })).rejects.toThrow(); // operador sin canal ni origen
    await expect(reg1({ recorded_by: masterId, origin_channel: "phone", origin_invitation_id: randomUUID() })).rejects.toThrow(); // A y B a la vez
    await expect(reg1({ recorded_by: masterId, origin_channel: "paloma" })).rejects.toThrow();
    await expect(reg1({ recorded_by: masterId, origin_channel: "public_link" })).rejects.toThrow(); // public_link no es canal de inscripción manual
    await expect(reg1({ recorded_by: masterId, origin_channel: "phone", participation_basis: "legacy_initial_import" })).rejects.toThrow();
    await expect(reg1({ recorded_by: masterId, origin_channel: "phone", registered_at: new Date() })).rejects.toThrow(); // fecha sin precisión
    await expect(reg1({ recorded_by: masterId, origin_channel: "phone", registered_at: new Date("2026-03-10T12:00:00Z"), registered_at_precision: "date_only" })).rejects.toThrow(); // no es medianoche BA
    await expect(reg1({ voided_at: new Date(), voided_by: masterId, void_reason: "x" })).rejects.toThrow(); // no nace anulada
    await expect(db.insertInto("meeting_participations").values({ campaign_key: "x:camp", person_id: await p(), participation_kind: "registration", participation_basis: "standard", recorded_by: masterId, origin_channel: "phone" } as never).execute()).rejects.toThrow(); // nunca a nivel campaña
    await expect(db.insertInto("meeting_participations").values({ meeting_id: m, person_id: await p(), participation_kind: "participated", participation_basis: "source_business_rule", evidence: "x", voided_at: new Date(), voided_by: masterId, void_reason: "x" } as never).execute()).rejects.toThrow(); // solo se anulan inscripciones
    const q = await p();
    await reg1.call(null, {}).catch(() => undefined);
    await db.insertInto("meeting_participations").values({ meeting_id: m, person_id: q, participation_kind: "registration", participation_basis: "standard", recorded_by: masterId, origin_channel: "phone" } as never).execute();
    for (const set of [{ voided_at: new Date() }, { voided_at: new Date(), voided_by: masterId }, { voided_at: new Date(), voided_by: masterId, void_reason: " " }]) {
      await expect(db.updateTable("meeting_participations").set(set as never).where("person_id", "=", q).where("meeting_id", "=", m).execute()).rejects.toThrow();
    }
  });

  it("campañas: sin jornada no admite inscripción nueva; las históricas a nivel campaña se pueden anular; DISTINCT entre campaña y jornada", async () => {
    const db = await getDb();
    const key = `ophthalmology:b4-${seq}`;
    const camp = (await db.insertInto("campaigns").values({ campaign_key: key, name: "Campaña B4", campaign_type: "ophthalmology", owner_organization_id: O.SUTECBA!, origin: "import", historical_condition: "imported_undated", created_by: masterId } as never).returning("id").executeTakeFirstOrThrow()).id;
    const p = await person();
    await expect(enroll(master, camp, p)).rejects.toThrow(/no existe/); // una campaña no es una reunión
    const campaignLevel = await historical(null, key, p);
    expect(metricNumber((await loadCampaignMetrics(master, [camp])).get(camp)!.registered)).toBe(1);
    const j1 = await meeting("scheduled");
    await db.updateTable("meetings").set({ campaign_id: camp } as never).where("id", "=", j1).execute();
    await enroll(culturaOp, j1, p);
    expect(metricNumber((await loadCampaignMetrics(master, [camp])).get(camp)!.registered)).toBe(1); // la misma persona: una vez
    const jornadaRow = (await regRows(j1, p))[0]!;
    await reg.voidEnrollment(culturaOp, { participationId: jornadaRow.id, reason: "x" });
    expect(metricNumber((await loadCampaignMetrics(master, [camp])).get(camp)!.registered)).toBe(1); // sigue la de nivel campaña
    expect((await reg.voidEnrollment(master, { participationId: campaignLevel, reason: "histórica errónea" })).changed).toBe(true);
    expect(metricNumber((await loadCampaignMetrics(master, [camp])).get(camp)!.registered)).toBe(0);
    const page = await listCampaignParticipants(master, camp);
    expect(page.rows.find((r) => r.personId === p)?.registered).toBe(false);
    // la participación de campaña no existe: nada se crea
    expect(await db.selectFrom("meeting_participations").select("id").where("campaign_key", "=", key).where("participation_kind", "=", "participated").execute()).toHaveLength(0);
  });

  it("contadores de «personas vinculadas» (lista de reuniones y detalle de campaña) no cuentan inscripciones anuladas", async () => {
    const { listMeetings } = await import("../../lib/meetings/queries.js");
    const { getCampaignById } = await import("../../lib/campaigns/queries.js");
    const db = await getDb();
    const key = `ophthalmology:b4-vinc-${++seq}`;
    const camp = (await db.insertInto("campaigns").values({ campaign_key: key, name: "Campaña vinculadas", campaign_type: "ophthalmology", owner_organization_id: O.SUTECBA!, origin: "import", historical_condition: "imported_undated", created_by: masterId } as never).returning("id").executeTakeFirstOrThrow()).id;
    const j = await meeting("scheduled");
    await db.updateTable("meetings").set({ campaign_id: camp } as never).where("id", "=", j).execute();
    const [a, b, c] = [await person(), await person(), await person()];
    await enroll(master, j, a);
    await enroll(master, j, b);
    await historical(null, key, c);
    const counts = async () => {
      const row = (await listMeetings(master)).find((m) => m.id === j)!;
      const detail = (await getCampaignById(master, camp))!;
      return { jornada: row.participantsCount, campLevelList: row.campaignParticipantsCount, jornadaDetail: detail.jornadas[0]!.participantsCount, campLevelDetail: detail.campaignLevelOnlyCount };
    };
    expect(await counts()).toEqual({ jornada: 2, campLevelList: 1, jornadaDetail: 2, campLevelDetail: 1 });
    await reg.voidEnrollment(master, { participationId: (await regRows(j, a))[0]!.id, reason: "x" });
    const campRow = (await db.selectFrom("meeting_participations").select("id").where("campaign_key", "=", key).executeTakeFirstOrThrow()).id;
    await reg.voidEnrollment(master, { participationId: campRow, reason: "x" });
    expect(await counts()).toEqual({ jornada: 1, campLevelList: 0, jornadaDetail: 1, campLevelDetail: 0 });
  });

  it("la inscripción no genera interacciones (ni al inscribir, ni al anular, ni al restaurar)", async () => {
    const m = await meeting("scheduled");
    const p = await person();
    const before = await countOf("person_interactions");
    await enroll(culturaOp, m, p);
    const id = (await regRows(m, p))[0]!.id;
    await reg.voidEnrollment(culturaOp, { participationId: id, reason: "x" });
    await reg.restoreEnrollment(culturaOp, { participationId: id, reason: "y" });
    const db = await getDb();
    expect(await syncParticipationInteractions(db, { meetingId: m, actorUserId: masterId })).toMatchObject({ created: 0 });
    expect(await countOf("person_interactions")).toBe(before);
  });

  it("código: solo registrations.ts muta inscripciones operativas; migraciones 0041 y 0042 idempotentes", async () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (name === "node_modules" || name === ".next") continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          const rel = full.replace(/\\/g, "/");
          const src = readFileSync(full, "utf8");
          if (/updateTable\(\s*["']meeting_participations["']\s*\)/.test(src) && rel !== "lib/meetings/registrations.ts") offenders.push(rel);
        }
      }
    };
    walk("lib");
    walk("app");
    expect(offenders).toEqual([]);

    const db = await getDb();
    const snap = async () =>
      (
        await sql<{ c: number; p: number; e: number; a: number; i: number }>`
          select (select count(*)::int from pg_constraint where conrelid in ('public.meeting_participations'::regclass, 'public.meeting_registration_events'::regclass)) c,
                 (select count(*)::int from meeting_participations) p, (select count(*)::int from meeting_registration_events) e,
                 (select count(*)::int from meeting_attendance) a, (select count(*)::int from person_interactions) i`.execute(db)
      ).rows[0]!;
    const before = await snap();
    for (const file of ["0041_registration_metadata_voiding.sql", "0042_meeting_registration_events.sql"]) {
      for (let pass = 0; pass < 2; pass += 1) {
        await db.transaction().execute(async (trx) => {
          for (const st of migrationStatements(readFileSync(`db/migrations/${file}`, "utf8"))) await sql.raw(st).execute(trx);
        });
      }
    }
    expect(await snap()).toEqual(before);
  });
});
