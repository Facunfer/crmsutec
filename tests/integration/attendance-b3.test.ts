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
const inv = await import("../../lib/meetings/invitations.js");
const { respondToInvitation } = await import("../../lib/meetings/public.js");
const att = await import("../../lib/attendance/manual.js");
const { resolveQrToken, identifyForCheckin, confirmCheckin, checkInWithInvitationToken } = await import("../../lib/attendance/checkin.js");
const { signRotatingQrToken } = await import("../../lib/attendance/qr.js");
const { getLivePanelData, quickSearchForAccreditation } = await import("../../lib/attendance/live.js");
const { loadMeetingMetrics, loadCampaignMetrics } = await import("../../lib/activities/metrics.js");
const { listMeetingParticipants } = await import("../../lib/meetings/participants.js");
const { changeMeetingStatus } = await import("../../lib/meetings/commands.js");
const { getPersonMeetingActivity } = await import("../../lib/people/queries.js");
const { syncParticipationInteractions } = await import("../../lib/interactions/participation-sync.js");
const { metricNumber } = await import("../../lib/activities/labels.js");
const { normalizePhone } = await import("../../lib/people/normalize.js");

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
const nextIp = () => `10.7.${Math.floor(++ip / 250)}.${ip % 250}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const dni = `7${String(seq).padStart(7, "0")}`;
  const row = await db
    .insertInto("people")
    .values({ first_name: `Per${seq}`, last_name: `Ape${seq}`, dni, email: `per${seq}@example.com`, phone: normalizePhone(`011 4${String(seq).padStart(7, "0")}`) ?? undefined, organization_id: orgCode ? O[orgCode]! : null, origin: "import" } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, dni, lastName: `Ape${seq}`, email: `per${seq}@example.com`, phone: normalizePhone(`011 4${String(seq).padStart(7, "0")}`)! };
}
async function meeting(status: "draft" | "scheduled" | "in_progress" | "finished" | "cancelled", extra: Record<string, unknown> = {}) {
  const db = await getDb();
  return (
    await db
      .insertInto("meetings")
      .values({
        name: `Reunión ${status} ${++seq}`, owner_organization_id: O.MCGC!, organizer_user_id: masterId, created_by: masterId, origin: "manual", status,
        meeting_type: "reunion", schedule_precision: "exact_datetime", starts_at: new Date(Date.now() - 600_000), ends_at: new Date(Date.now() + 4_800_000), ...extra,
      } as never)
      .returning(["id", "qr_secret_version"])
      .executeTakeFirstOrThrow()
  );
}
async function invite(m: string, p: { id: string }, actor: any = master) {
  const r = await inv.createInvitationBatch(actor, m, { personIds: [p.id] }, { channel: "whatsapp" });
  return r.links[0]!.token;
}
const reg = (actor: any, m: string, p: string, occurred: any = { kind: "now" }, reason = "acreditación en mesa") => att.registerAttendanceManually(actor, { meetingId: m, personId: p, reason, occurred });
const rows = async (m: string, p: string) => {
  const db = await getDb();
  return db.selectFrom("meeting_attendance").selectAll().where("meeting_id", "=", m).where("person_id", "=", p).execute();
};
const events = async (m: string, p: string) => {
  const db = await getDb();
  return db.selectFrom("meeting_attendance_events").selectAll().where("meeting_id", "=", m).where("person_id", "=", p).orderBy("seq", "asc").execute();
};
const countOf = async (table: string) => {
  const db = await getDb();
  return (await sql<{ n: number }>`select count(*)::int n from ${sql.table(table)}`.execute(db)).rows[0]!.n;
};
const attendedMetric = async (m: string, actor: any = master) => metricNumber((await loadMeetingMetrics(actor, [m])).get(m)!.attended);

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
  masterId = await makeUser("b3-master@sutecba.local", "MASTER_GLOBAL");
  master = actorOf(masterId, "MASTER_GLOBAL");
  const culturaId = await makeUser("b3-cultura@sutecba.local", "ADMIN");
  const haciendaId = await makeUser("b3-hacienda@sutecba.local", "ADMIN");
  const noManageId = await makeUser("b3-nomanage@sutecba.local", "ADMIN");
  const scope = (user: string, orgId: string) => db.insertInto("user_scopes").values({ user_id: user, organization_id: orgId, include_descendants: true, granted_by: masterId } as never).execute();
  await scope(culturaId, O.MCGC!);
  await scope(haciendaId, O.MHFGC!);
  await scope(noManageId, O.MCGC!);
  culturaOp = actorOf(culturaId, "ADMIN");
  haciendaOp = actorOf(haciendaId, "ADMIN");
  noManage = actorOf(noManageId, "ADMIN", new Set([...ALL].filter((p) => p !== "meetings.attendance_manual")));
});

afterAll(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("B3 · check-in público (QR / enlace)", () => {
  it("QR → identificación → confirmación: una asistencia con medio qr, identificación usada y evento sin usuario", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    const { token: qr } = signRotatingQrToken(m.id, m.qr_secret_version as number);
    expect((await resolveQrToken(qr, nextIp())).kind).toBe("ok");
    const idf = await identifyForCheckin(m.id, p.dni, p.lastName, nextIp());
    if (idf.kind !== "need_confirmation") throw new Error(idf.kind);
    expect((await confirmCheckin(idf.confirmToken, nextIp(), "ua")).kind).toBe("ok");
    const [r] = await rows(m.id, p.id);
    expect(r).toMatchObject({ method: "qr", identification: "dni", occurred_precision: "exact_datetime", revoked_at: null, registered_by: null });
    expect(r!.checked_in_at!.getTime()).toBe(r!.recorded_at.getTime()); // QR: ocurrió = registrado
    const ev = await events(m.id, p.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: "checked_in", recorded_by: null, attendance_method: "qr", identification: "dni", occurred_precision: "exact_datetime" });
  });

  it("la identificación por email o teléfono se guarda tal cual (el medio sigue siendo qr)", async () => {
    const m = await meeting("in_progress");
    const a = await person();
    const b = await person();
    await invite(m.id, a);
    await invite(m.id, b);
    for (const [p, value, expected] of [[a, a.email, "email"], [b, b.phone, "phone"]] as const) {
      const idf = await identifyForCheckin(m.id, value, p.lastName, nextIp());
      if (idf.kind !== "need_confirmation") throw new Error(idf.kind);
      await confirmCheckin(idf.confirmToken, nextIp(), "ua");
      expect((await rows(m.id, p.id))[0]).toMatchObject({ method: "qr", identification: expected });
    }
  });

  it("enlace personal: medio invitation_link + identificación invitation_token; retry = no-op (una fila, un evento)", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    expect((await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua")).kind).toBe("ok");
    expect((await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua")).kind).toBe("already_checked_in");
    expect((await rows(m.id, p.id))[0]).toMatchObject({ method: "invitation_link", identification: "invitation_token" });
    expect(await events(m.id, p.id)).toHaveLength(1);
  });

  it("doble QR completo = una asistencia y un evento", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    for (let i = 0; i < 2; i += 1) {
      const idf = await identifyForCheckin(m.id, p.dni, p.lastName, nextIp());
      if (idf.kind === "need_confirmation") await confirmCheckin(idf.confirmToken, nextIp(), "ua");
      else expect(idf.kind).toBe("already_checked_in");
    }
    expect(await rows(m.id, p.id)).toHaveLength(1);
    expect(await events(m.id, p.id)).toHaveLength(1);
  });

  it("carrera concurrente: 6 check-ins simultáneos dejan UNA fila y UN evento", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    const results = await Promise.all(Array.from({ length: 6 }, () => checkInWithInvitationToken(m.id, p.id, nextIp(), "ua")));
    expect(results.filter((r) => r.kind === "ok")).toHaveLength(1);
    expect(await rows(m.id, p.id)).toHaveLength(1);
    expect((await events(m.id, p.id)).filter((e) => e.event_type === "checked_in")).toHaveLength(1);
  });

  it("QR + manual al mismo tiempo: una sola asistencia y un solo evento", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    const [a, b] = await Promise.all([checkInWithInvitationToken(m.id, p.id, nextIp(), "ua"), reg(culturaOp, m.id, p.id)]);
    expect(await rows(m.id, p.id)).toHaveLength(1);
    expect(await events(m.id, p.id)).toHaveLength(1);
    expect([a.kind === "ok", (b as any).changed === true].filter(Boolean)).toHaveLength(1); // exactamente uno ganó
  });

  it("estados: el check-in público solo en scheduled/in_progress (dentro de la ventana); draft, finished y cancelled no", async () => {
    const p = await person();
    for (const status of ["draft", "finished", "cancelled"] as const) {
      const m = await meeting(status);
      await invite(m.id, p).catch(() => undefined); // el draft/finished no admiten invitar: se inserta directo si falla
      const db = await getDb();
      const exists = await db.selectFrom("meeting_invitations").select("id").where("meeting_id", "=", m.id).executeTakeFirst();
      if (!exists) await db.insertInto("meeting_invitations").values({ meeting_id: m.id, person_id: p.id, token_hash: randomUUID() } as never).execute();
      const r = await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua");
      expect(["not_active", "invalid"]).toContain(r.kind);
      const { token } = signRotatingQrToken(m.id, m.qr_secret_version as number);
      expect(["not_active", "cancelled"]).toContain((await resolveQrToken(token, nextIp())).kind);
      expect(await rows(m.id, p.id)).toHaveLength(0);
    }
    const m = await meeting("scheduled");
    await invite(m.id, p);
    expect((await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua")).kind).toBe("ok"); // programada dentro de la ventana
  });
});

describe("B3 · asistencia manual", () => {
  it("sin invitación previa: permitida con permiso, reunión y persona en alcance; no crea ninguna invitación", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    const invBefore = await countOf("meeting_invitations");
    expect(await reg(culturaOp, m.id, p.id)).toEqual({ changed: true });
    expect(await countOf("meeting_invitations")).toBe(invBefore);
    const [r] = await rows(m.id, p.id);
    expect(r).toMatchObject({ method: "manual", identification: null, invitation_id: null, registered_by: culturaOp.id, correction_reason: "acreditación en mesa", occurred_precision: "exact_datetime" });
    const ev = (await events(m.id, p.id))[0]!;
    expect(ev).toMatchObject({ event_type: "checked_in", recorded_by: culturaOp.id, attendance_method: "manual", reason: "acreditación en mesa" });
    expect(await attendedMetric(m.id)).toBe(1);
  });

  it("con invitación vigente: se enlaza por referencia", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    await reg(culturaOp, m.id, p.id);
    const [r] = await rows(m.id, p.id);
    expect(r!.invitation_id).not.toBeNull();
  });

  it("doble clic manual = no-op (una fila, un evento)", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    expect((await reg(culturaOp, m.id, p.id)).changed).toBe(true);
    expect((await reg(culturaOp, m.id, p.id)).changed).toBe(false);
    const results = await Promise.all([reg(culturaOp, m.id, (await person()).id), reg(culturaOp, m.id, p.id)]);
    expect(results[1]!.changed).toBe(false);
    expect(await events(m.id, p.id)).toHaveLength(1);
  });

  it("alcance y permisos: otra área, persona fuera de alcance, persona sin organización y usuario sin permiso fallan", async () => {
    const m = await meeting("in_progress");
    const mine = await person("MCGC");
    const other = await person("MHFGC");
    const noOrg = await person(null);
    await expect(reg(haciendaOp, m.id, mine.id)).rejects.toThrow(/no existe/); // sin acceso a la reunión
    await expect(reg(culturaOp, m.id, other.id)).rejects.toThrow(/no existe/); // persona fuera de alcance
    await expect(reg(culturaOp, m.id, noOrg.id)).rejects.toThrow(/no existe/); // sin organización: fuera de scopes restringidos
    await expect(reg(noManage, m.id, mine.id)).rejects.toThrow(/permiso/);
    expect(await reg(master, m.id, other.id)).toEqual({ changed: true }); // Master: visión global
    expect(await rows(m.id, other.id)).toHaveLength(1);
    expect(await rows(m.id, mine.id)).toHaveLength(0);
  });

  it("motivo obligatorio; estados permitidos: solo in_progress y finished (no draft, scheduled ni cancelled)", async () => {
    const p = await person();
    const live = await meeting("in_progress");
    await expect(reg(culturaOp, live.id, p.id, { kind: "now" }, "  ")).rejects.toThrow(/motivo/);
    for (const status of ["draft", "scheduled", "cancelled"] as const) {
      const m = await meeting(status);
      await expect(reg(culturaOp, m.id, p.id)).rejects.toThrow(/en curso o finalizada/);
    }
  });

  it("reunión finalizada = carga retroactiva: «ahora» no se acepta; día y hora, solo el día o desconocida sí; nunca futura", async () => {
    const m = await meeting("finished");
    const [a, b, c, d] = [await person(), await person(), await person(), await person()];
    await expect(reg(culturaOp, m.id, a.id, { kind: "now" })).rejects.toThrow(/retroactiva/);
    await expect(reg(culturaOp, m.id, a.id, { kind: "exact", at: new Date(Date.now() + 86400_000) })).rejects.toThrow(/futura/);
    await reg(culturaOp, m.id, a.id, { kind: "exact", at: new Date("2026-03-10T18:30:00Z") });
    expect((await rows(m.id, a.id))[0]).toMatchObject({ occurred_precision: "exact_datetime" });
    await reg(culturaOp, m.id, b.id, { kind: "date_only", day: "2026-03-10" });
    const rb = (await rows(m.id, b.id))[0]!;
    expect(rb.occurred_precision).toBe("date_only");
    expect(rb.checked_in_at!.toISOString()).toBe("2026-03-10T03:00:00.000Z"); // medianoche de Buenos Aires: no se inventa una hora
    await reg(culturaOp, m.id, c.id, { kind: "unknown" });
    const rc = (await rows(m.id, c.id))[0]!;
    expect(rc).toMatchObject({ checked_in_at: null, occurred_precision: "unknown", method: "manual" });
    expect(rc.recorded_at).toBeInstanceOf(Date); // el CRM sí sabe cuándo la cargó
    await expect(reg(culturaOp, m.id, d.id, { kind: "unknown" }, "")).rejects.toThrow(/motivo/);
    expect(await attendedMetric(m.id)).toBe(3);
  });
});

describe("B3 · revocación y restauración", () => {
  async function present(m: { id: string }, p: { id: string }) {
    await reg(culturaOp, m.id, p.id);
  }

  it("revocar exige motivo y usuario; la fila queda; deja de contar en métricas, panel, lista e invitaciones", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    const q = await person();
    await invite(m.id, p);
    await present(m, p);
    await present(m, q);
    expect(await attendedMetric(m.id)).toBe(2);
    await expect(att.revokeAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "" })).rejects.toThrow(/motivo/);
    expect((await att.revokeAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "se retiró" }))).toEqual({ changed: true });
    const [r] = await rows(m.id, p.id);
    expect(r).toMatchObject({ revoke_reason: "se retiró", revoked_by: culturaOp.id });
    expect(r!.revoked_at).not.toBeNull();
    expect(await attendedMetric(m.id)).toBe(1);
    const live = (await getLivePanelData(culturaOp, m.id))!;
    expect(live.present).toBe(1);
    expect(live.arrived.map((a) => a.personId)).toEqual([q.id]);
    expect(live.revoked.map((a) => a.personId)).toEqual([p.id]);
    expect(live.revoked[0]!.reason).toBe("se retiró");
    expect(live.invitedNotArrived).toBe(1); // «Sin asistencia registrada», no «ausente»
    const part = (await listMeetingParticipants(master, m.id)).assigned.find((x) => x.personId === p.id)!;
    expect(part.facts.attended).toBe(false);
    expect((await inv.listInvitations(master, m.id)).find((i) => i.personId === p.id)!.attended).toBe(false);
    const act = (await getPersonMeetingActivity(master, p.id)).find((a) => a.meetingId === m.id)!;
    expect(act.attended).toBe(false);
  });

  it("restaurar exige motivo y vuelve a contar; la fila limpia revoked_* pero los eventos conservan quién, cuándo y por qué", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await present(m, p);
    await att.revokeAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "error de carga" });
    await expect(att.restoreAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: " " })).rejects.toThrow(/motivo/);
    expect(await att.restoreAttendance(master, { meetingId: m.id, personId: p.id, reason: "era un error" })).toEqual({ changed: true });
    expect((await rows(m.id, p.id))[0]).toMatchObject({ revoked_at: null, revoked_by: null, revoke_reason: null });
    expect(await attendedMetric(m.id)).toBe(1);
    const ev = await events(m.id, p.id);
    expect(ev.map((e) => e.event_type)).toEqual(["checked_in", "revoked", "restored"]);
    expect(ev[1]).toMatchObject({ recorded_by: culturaOp.id, reason: "error de carga" });
    expect(ev[2]).toMatchObject({ recorded_by: masterId, reason: "era un error" });
    expect(ev[2]!.occurred_at.getTime()).toBeGreaterThanOrEqual(ev[1]!.occurred_at.getTime());
  });

  it("retry de revocación y de restauración = no-op; restaurar una vigente = no-op", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await present(m, p);
    expect((await att.restoreAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "x" })).changed).toBe(false);
    await att.revokeAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "uno" });
    expect((await att.revokeAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "dos" })).changed).toBe(false);
    await att.restoreAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "tres" });
    expect((await att.restoreAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "cuatro" })).changed).toBe(false);
    expect((await events(m.id, p.id)).map((e) => e.event_type)).toEqual(["checked_in", "revoked", "restored"]);
    expect((await events(m.id, p.id))[1]!.reason).toBe("uno"); // el motivo original no se pisa
  });

  it("concurrencia: dos revocaciones = un evento; revocar y restaurar a la vez dejan una cadena coherente", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    const q = await person();
    await present(m, p);
    await present(m, q);
    await Promise.all([att.revokeAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "a" }), att.revokeAttendance(master, { meetingId: m.id, personId: p.id, reason: "b" })]);
    expect((await events(m.id, p.id)).filter((e) => e.event_type === "revoked")).toHaveLength(1);
    await att.restoreAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "c" });
    await Promise.all([
      att.revokeAttendance(culturaOp, { meetingId: m.id, personId: q.id, reason: "d" }),
      att.restoreAttendance(master, { meetingId: m.id, personId: q.id, reason: "e" }).catch(() => null),
    ]);
    const ev = await events(m.id, q.id);
    const state = (await rows(m.id, q.id))[0]!;
    let active = true;
    for (const e of ev.slice(1)) {
      if (e.event_type === "revoked") { expect(active).toBe(true); active = false; }
      if (e.event_type === "restored") { expect(active).toBe(false); active = true; }
    }
    expect(state.revoked_at === null).toBe(active); // la fila coincide con el último evento
  });

  it("el check-in público sobre una asistencia REVOCADA no la restaura ni registra nada", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua");
    await att.revokeAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "se fue" });
    expect((await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua")).kind).toBe("already_processed");
    const idf = await identifyForCheckin(m.id, p.dni, p.lastName, nextIp());
    expect(idf.kind).toBe("already_processed");
    expect((await rows(m.id, p.id))[0]!.revoked_at).not.toBeNull();
    expect((await events(m.id, p.id)).map((e) => e.event_type)).toEqual(["checked_in", "revoked"]);
    await expect(reg(culturaOp, m.id, p.id)).rejects.toThrow(/restaurala/); // tampoco se re-registra a mano
  });

  it("alcance estricto: persona fuera del alcance no se revoca/restaura/ve; el panel no expone su nombre; el historial exige permiso y alcance", async () => {
    const m = await meeting("in_progress");
    const inScope = await person("MCGC");
    const outScope = await person("MHFGC");
    await present(m, inScope);
    await reg(master, m.id, outScope.id);
    await expect(att.revokeAttendance(culturaOp, { meetingId: m.id, personId: outScope.id, reason: "x" })).rejects.toThrow(/No hay una asistencia/);
    await expect(att.restoreAttendance(culturaOp, { meetingId: m.id, personId: outScope.id, reason: "x" })).rejects.toThrow(/No hay una asistencia/);
    await expect(att.revokeAttendance(haciendaOp, { meetingId: m.id, personId: inScope.id, reason: "x" })).rejects.toThrow(/no existe/);
    await expect(att.revokeAttendance(noManage, { meetingId: m.id, personId: inScope.id, reason: "x" })).rejects.toThrow(/permiso/);
    const panel = (await getLivePanelData(culturaOp, m.id))!;
    expect(panel.arrived.map((a) => a.personId)).toEqual([inScope.id]);
    expect(JSON.stringify(panel)).not.toContain(outScope.id);
    expect((await getLivePanelData(master, m.id))!.arrived).toHaveLength(2);
    expect(await getLivePanelData(haciendaOp, m.id)).toBeNull();
    expect((await quickSearchForAccreditation(culturaOp, m.id, "Per")).map((r) => r.personId)).not.toContain(outScope.id);
    expect(await att.listAttendanceEvents(culturaOp, m.id, outScope.id)).toEqual([]);
    expect((await att.listAttendanceEvents(culturaOp, m.id, inScope.id)).length).toBe(1);
    await expect(att.listAttendanceEvents(noManage, m.id, inScope.id)).rejects.toThrow(/permiso/);
    // el panel de quien no gestiona no lista revocadas
    await att.revokeAttendance(culturaOp, { meetingId: m.id, personId: inScope.id, reason: "x" });
    const readOnly = actorOf(noManage.id, "ADMIN", new Set([...ALL].filter((p) => p !== "meetings.attendance_manual")));
    expect((await getLivePanelData(readOnly, m.id))!.revoked).toEqual([]);
    const search = await quickSearchForAccreditation(culturaOp, m.id, inScope.lastName);
    expect(search[0]).toMatchObject({ checkedIn: false, revoked: true });
  });
});

describe("B3 · corrección de hora (evento corrected)", () => {
  it("solo hora/precisión de una asistencia MANUAL vigente; mismo valor = no-op; usuario y motivo obligatorios", async () => {
    const m = await meeting("finished");
    const p = await person();
    await reg(culturaOp, m.id, p.id, { kind: "date_only", day: "2026-03-10" });
    await expect(att.correctAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "", occurred: { kind: "unknown" } })).rejects.toThrow(/motivo/);
    expect(await att.correctAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "el día era otro", occurred: { kind: "date_only", day: "2026-03-11" } })).toEqual({ changed: true });
    expect((await rows(m.id, p.id))[0]!.checked_in_at!.toISOString()).toBe("2026-03-11T03:00:00.000Z");
    expect((await att.correctAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "igual", occurred: { kind: "date_only", day: "2026-03-11" } })).changed).toBe(false);
    await att.correctAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "no se sabe", occurred: { kind: "unknown" } });
    expect((await rows(m.id, p.id))[0]).toMatchObject({ checked_in_at: null, occurred_precision: "unknown", method: "manual", person_id: p.id });
    const ev = await events(m.id, p.id);
    expect(ev.map((e) => e.event_type)).toEqual(["checked_in", "corrected", "corrected"]);
    expect(ev[1]).toMatchObject({ recorded_by: culturaOp.id, reason: "el día era otro", occurred_precision: "date_only", attendance_method: null });
    expect(ev[2]).toMatchObject({ occurred_precision: "unknown", checked_in_at: null });
  });

  it("no corrige un check-in por QR/enlace ni una asistencia revocada; el guard de base impide cambiar identidad", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    const q = await person();
    await invite(m.id, p);
    await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua");
    await expect(att.correctAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "x", occurred: { kind: "unknown" } })).rejects.toThrow(/manualmente/);
    await reg(culturaOp, m.id, q.id);
    await att.revokeAttendance(culturaOp, { meetingId: m.id, personId: q.id, reason: "x" });
    await expect(att.correctAttendance(culturaOp, { meetingId: m.id, personId: q.id, reason: "x", occurred: { kind: "unknown" } })).rejects.toThrow(/revocada/);
    const db = await getDb();
    for (const set of [{ method: "qr", identification: "dni" }, { person_id: q.id }, { correction_reason: "otro" }, { registered_by: masterId }, { recorded_at: new Date() }]) {
      await expect(db.updateTable("meeting_attendance").set(set as never).where("meeting_id", "=", m.id).where("person_id", "=", p.id).execute()).rejects.toThrow();
    }
    // la hora de un check-in NO manual tampoco se toca directamente
    await expect(db.updateTable("meeting_attendance").set({ checked_in_at: new Date(Date.now() - 1000) } as never).where("meeting_id", "=", m.id).where("person_id", "=", p.id).execute()).rejects.toThrow(/manual/);
  });
});

describe("B3 · historial y constraints de base", () => {
  it("el historial es append-only y la fila de asistencia no se borra", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await reg(culturaOp, m.id, p.id);
    const db = await getDb();
    await expect(db.updateTable("meeting_attendance_events").set({ reason: "x" } as never).where("meeting_id", "=", m.id).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom("meeting_attendance_events").where("meeting_id", "=", m.id).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom("meeting_attendance").where("meeting_id", "=", m.id).execute()).rejects.toThrow(/DELETE/);
    expect(await events(m.id, p.id)).toHaveLength(1);
  });

  it("rollback atómico: si falla el evento, ni la fila ni el cambio quedan", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    const db = await getDb();
    const fail = async (type: string, name: string) => {
      await sql.raw(`CREATE OR REPLACE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.event_type = '${type}' THEN RAISE EXCEPTION 'falla simulada'; END IF; RETURN NEW; END $f$`).execute(db);
      await sql.raw(`CREATE TRIGGER ${name}_trg BEFORE INSERT ON public.meeting_attendance_events FOR EACH ROW EXECUTE FUNCTION public.${name}()`).execute(db);
      return async () => {
        await sql.raw(`DROP TRIGGER ${name}_trg ON public.meeting_attendance_events`).execute(db);
        await sql.raw(`DROP FUNCTION public.${name}()`).execute(db);
      };
    };
    let undo = await fail("checked_in", "fail_ci");
    try { await expect(reg(culturaOp, m.id, p.id)).rejects.toThrow(); } finally { await undo(); }
    expect(await rows(m.id, p.id)).toHaveLength(0);
    await reg(culturaOp, m.id, p.id);
    undo = await fail("revoked", "fail_rv");
    try { await expect(att.revokeAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "x" })).rejects.toThrow(); } finally { await undo(); }
    expect((await rows(m.id, p.id))[0]!.revoked_at).toBeNull();
    expect(await events(m.id, p.id)).toHaveLength(1);
  });

  it("combinaciones imposibles se rechazan en la base", async () => {
    const m = await meeting("in_progress");
    const db = await getDb();
    const ins = async (extra: Record<string, unknown>) => {
      const p = await person();
      return db.insertInto("meeting_attendance").values({ meeting_id: m.id, person_id: p.id, ...extra } as never).execute();
    };
    await expect(ins({ method: "qr" })).rejects.toThrow(); // qr exige identificación
    await expect(ins({ method: "qr", identification: "invitation_token" })).rejects.toThrow();
    await expect(ins({ method: "invitation_link", identification: "dni" })).rejects.toThrow();
    await expect(ins({ method: "manual", identification: "dni", registered_by: masterId, correction_reason: "x" })).rejects.toThrow();
    await expect(ins({ method: "manual" })).rejects.toThrow(); // manual exige operador y motivo
    await expect(ins({ method: "manual", registered_by: masterId, correction_reason: "  " })).rejects.toThrow();
    await expect(ins({ method: "qr", identification: "dni", occurred_precision: "date_only", checked_in_at: new Date("2026-03-10T03:00:00Z") })).rejects.toThrow(); // solo lo manual es inexacto
    await expect(ins({ method: "qr", identification: "dni", occurred_precision: "unknown", checked_in_at: null })).rejects.toThrow();
    await expect(ins({ method: "manual", registered_by: masterId, correction_reason: "x", occurred_precision: "unknown", checked_in_at: new Date() })).rejects.toThrow(); // unknown ⇒ sin hora
    await expect(ins({ method: "manual", registered_by: masterId, correction_reason: "x", occurred_precision: "exact_datetime", checked_in_at: null })).rejects.toThrow();
    await expect(ins({ method: "manual", registered_by: masterId, correction_reason: "x", occurred_precision: "date_only", checked_in_at: new Date("2026-03-10T15:00:00Z") })).rejects.toThrow(); // día no es medianoche BA
    await expect(ins({ method: "qr", identification: "dni", revoked_at: new Date(), revoked_by: masterId, revoke_reason: "x" })).rejects.toThrow(); // no nace revocada
    await expect(ins({ method: "paloma" })).rejects.toThrow();
    const p = await person();
    await reg(culturaOp, m.id, p.id);
    for (const set of [{ revoked_at: new Date() }, { revoked_at: new Date(), revoked_by: masterId }, { revoked_at: new Date(), revoked_by: masterId, revoke_reason: "  " }]) {
      await expect(db.updateTable("meeting_attendance").set(set as never).where("meeting_id", "=", m.id).where("person_id", "=", p.id).execute()).rejects.toThrow();
    }
  });
});

describe("B3 · reglas semánticas", () => {
  it("la asistencia NO crea interacciones (ni registrar, ni revocar, ni restaurar) y no toca las existentes", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    const before = await countOf("person_interactions");
    await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua");
    await att.revokeAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "x" });
    await att.restoreAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "y" });
    const q = await person();
    await reg(culturaOp, m.id, q.id);
    const db = await getDb();
    const result = await syncParticipationInteractions(db, { meetingId: m.id, actorUserId: masterId });
    expect(result).toMatchObject({ created: 0, reactivated: 0, voided: 0 });
    expect(await countOf("person_interactions")).toBe(before);
    expect(await db.selectFrom("person_interactions").select("id").where("source_key", "like", "meeting_attendance:%").execute()).toHaveLength(0);
  });

  it("attendance_status se ignora y nadie lo escribe: ni check-in, ni manual, ni finalizar la reunión", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    const q = await person();
    await invite(m.id, p);
    await invite(m.id, q);
    await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua");
    await reg(culturaOp, m.id, q.id);
    await att.revokeAttendance(culturaOp, { meetingId: m.id, personId: q.id, reason: "x" });
    await changeMeetingStatus(master, m.id, "finished");
    const db = await getDb();
    const all = await db.selectFrom("meeting_invitations").select(["person_id", "attendance_status"]).where("meeting_id", "=", m.id).execute();
    expect(all.every((r) => r.attendance_status === "unknown")).toBe(true);
    // poner attendance_status a mano NO crea asistencia en ninguna lectura
    const r = await person();
    await invite(m.id, r).catch(() => undefined);
    await db.updateTable("meeting_invitations").set({ attendance_status: "attended" } as never).where("meeting_id", "=", m.id).execute();
    expect(await attendedMetric(m.id)).toBe(1); // solo p (q está revocada)
    const act = (await getPersonMeetingActivity(master, q.id)).find((a) => a.meetingId === m.id)!;
    expect(act.attended).toBe(false);
  });

  it("source_business_rule, legacy e inscripción NO crean asistencia (ni filas, ni métricas)", async () => {
    const m = await meeting("finished", { origin: "import", schedule_precision: "date_only", event_date: new Date("2026-03-10T00:00:00Z"), starts_at: null, ends_at: null, source_event_key: `ophthalmology:2026-03-10:b3-${seq}` });
    const [a, b, c] = [await person(), await person(), await person()];
    const db = await getDb();
    const part = (p: { id: string }, kind: string, basis: string) =>
      db.insertInto("meeting_participations").values({ meeting_id: m.id, person_id: p.id, participation_kind: kind, participation_basis: basis, evidence: "test" } as never).execute();
    await part(a, "participated", "source_business_rule");
    await part(b, "participated", "legacy_initial_import");
    await part(c, "registration", "standard"); // p. ej. 52016
    const before = await countOf("meeting_attendance");
    const metrics = (await loadMeetingMetrics(master, [m.id])).get(m.id)!;
    expect(await countOf("meeting_attendance")).toBe(before);
    expect(metrics.attended.kind).toBe("no_information"); // histórico/importado: «Sin información», no 0 ni ausencia
    expect(metricNumber(metrics.participated)).toBe(2);
    expect(metricNumber(metrics.registered)).toBe(1);
    const parts = (await listMeetingParticipants(master, m.id)).assigned;
    expect(parts.every((x) => x.facts.attended === false)).toBe(true);
  });

  it("campañas: sin jornada no admiten asistencia; con jornadas suman DISTINCT y el revocar baja la cuenta", async () => {
    const db = await getDb();
    const camp = (await db.insertInto("campaigns").values({ campaign_key: `vaccination:b3-${seq}`, name: "Campaña B3", campaign_type: "vaccination", owner_organization_id: O.SUTECBA!, origin: "import", historical_condition: "imported_undated", created_by: masterId } as never).returning("id").executeTakeFirstOrThrow()).id;
    const p = await person();
    // una campaña no es una reunión: no hay forma de registrar asistencia contra ella
    await expect(reg(master, camp, p.id)).rejects.toThrow(/no existe/);
    await expect(db.insertInto("meeting_attendance").values({ meeting_id: camp, person_id: p.id, method: "manual", registered_by: masterId, correction_reason: "x" } as never).execute()).rejects.toThrow();
    const j1 = await meeting("in_progress");
    const j2 = await meeting("in_progress");
    await db.updateTable("meetings").set({ campaign_id: camp } as never).where("id", "in", [j1.id, j2.id] as never).execute();
    expect(metricNumber((await loadCampaignMetrics(master, [camp])).get(camp)!.attended)).toBe(0);
    await reg(culturaOp, j1.id, p.id);
    await reg(culturaOp, j2.id, p.id);
    expect(metricNumber((await loadCampaignMetrics(master, [camp])).get(camp)!.attended)).toBe(1); // DISTINCT por persona
    await att.revokeAttendance(culturaOp, { meetingId: j1.id, personId: p.id, reason: "x" });
    expect(metricNumber((await loadCampaignMetrics(master, [camp])).get(camp)!.attended)).toBe(1); // sigue vigente en j2
    await att.revokeAttendance(culturaOp, { meetingId: j2.id, personId: p.id, reason: "x" });
    expect(metricNumber((await loadCampaignMetrics(master, [camp])).get(camp)!.attended)).toBe(0);
    expect(metricNumber((await loadCampaignMetrics(master, [camp])).get(camp)!.participated)).toBe(0); // Asistió ⊆ Participó derivado
  });

  it("Asistió implica Participó sin crear una fila de participación; B2 (invitaciones y eventos) queda intacto", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    const token = await invite(m.id, p);
    await respondToInvitation(token, "confirmed", nextIp());
    const partBefore = await countOf("meeting_participations");
    const evBefore = await countOf("meeting_invitation_events");
    const invBefore = await (await getDb()).selectFrom("meeting_invitations").selectAll().where("meeting_id", "=", m.id).where("person_id", "=", p.id).executeTakeFirstOrThrow();
    await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua");
    await att.revokeAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "x" });
    await att.restoreAttendance(culturaOp, { meetingId: m.id, personId: p.id, reason: "y" });
    expect(await countOf("meeting_participations")).toBe(partBefore); // sin fila física
    expect(await countOf("meeting_invitation_events")).toBe(evBefore);
    expect(await (await getDb()).selectFrom("meeting_invitations").selectAll().where("id", "=", invBefore.id).executeTakeFirstOrThrow()).toEqual(invBefore);
    const m1 = (await loadMeetingMetrics(master, [m.id])).get(m.id)!;
    expect(metricNumber(m1.attended)).toBe(1);
    expect(metricNumber(m1.participated)).toBe(1);
    const fact = (await listMeetingParticipants(master, m.id)).assigned.find((x) => x.personId === p.id)!.facts;
    expect(fact).toMatchObject({ attended: true, participated: true, participationBases: [] });
  });

  it("0 usos runtime de attendance_status: solo schema legacy, migraciones y tests de compatibilidad", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (name === "node_modules" || name === ".next") continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          const rel = full.replace(/\\/g, "/");
          if (rel === "lib/db/schema.ts") continue; // schema legacy
          const src = readFileSync(full, "utf8");
          // se ignoran comentarios que expliquen la deprecación
          const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
          if (/attendance_status|attendanceStatus/.test(code)) hits.push(rel);
        }
      }
    };
    walk("lib");
    walk("app");
    expect(hits).toEqual([]);
  });

  it("migraciones 0039 y 0040 idempotentes (dos pasadas) sin cambiar filas ni constraints", async () => {
    const db = await getDb();
    const snap = async () =>
      (
        await sql<{ c: number; a: number; e: number; p: number; i: number }>`
          select (select count(*)::int from pg_constraint where conrelid in ('public.meeting_attendance'::regclass, 'public.meeting_attendance_events'::regclass)) c,
                 (select count(*)::int from meeting_attendance) a, (select count(*)::int from meeting_attendance_events) e,
                 (select count(*)::int from meeting_participations) p, (select count(*)::int from person_interactions) i`.execute(db)
      ).rows[0]!;
    const before = await snap();
    for (const file of ["0039_attendance_revocation_metadata.sql", "0040_meeting_attendance_events.sql"]) {
      for (let pass = 0; pass < 2; pass += 1) {
        await db.transaction().execute(async (trx) => {
          for (const st of migrationStatements(readFileSync(`db/migrations/${file}`, "utf8"))) await sql.raw(st).execute(trx);
        });
      }
    }
    expect(await snap()).toEqual(before);
    const grants = await sql<{ privs: string }>`select string_agg(distinct privilege_type, ',' order by privilege_type) privs from information_schema.role_table_grants where table_name = 'meeting_attendance_events' and grantee = 'sutecba_app'`.execute(db);
    expect(grants.rows[0]!.privs).toBe("INSERT,SELECT");
    await sleep(1);
  });
});
