import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

/**
 * Actividades unificadas, paso 1d — escanear el QR (o el enlace personal, o cargar la asistencia a mano) deja una INTERACCIÓN «Asistió a…» en la
 * ficha de la persona, con la fecha real de la asistencia. Revocar la asistencia anula la interacción; restaurarla la reactiva. Esto REVIERTE la
 * regla de B3 («la asistencia no crea interacciones»), por decisión del titular. Comportamiento real sobre PGlite.
 */

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.SUTECBA_QR_SECRET = "test-secret-not-for-prod-0123456789";

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS, ROLE_PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const inv = await import("../../lib/meetings/invitations.js");
const att = await import("../../lib/attendance/manual.js");
const { identifyForCheckin, confirmCheckin, checkInWithInvitationToken } = await import("../../lib/attendance/checkin.js");
const { syncParticipationInteractions } = await import("../../lib/interactions/participation-sync.js");
const { createActivity } = await import("../../lib/activities/create.js");
const { submitForm } = await import("../../lib/forms/submit.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));
let master: any;
let areaA: any;
let orgA: string;
let orgB: string;
let ipCounter = 0;
let seq = 0;
const nextIp = () => `10.70.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function actorOf(id: string, roleKey: string, permissions: Set<string>): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions };
}
async function makeUser(email: string, roleKey: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id, status: "active" } as never).returning("id").executeTakeFirstOrThrow()).id;
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  orgA = await createTestOrganization();
  orgB = await createTestOrganization();
  const db = await getDb();
  master = actorOf(await makeUser("att-master@sutecba.local", "MASTER_GLOBAL"), "MASTER_GLOBAL", ALL);
  const a = await makeUser("att-area-a@sutecba.local", "ADMIN");
  await db.insertInto("user_scopes").values({ user_id: a, organization_id: orgA, include_descendants: true, granted_by: master.id } as never).execute();
  areaA = actorOf(a, "ADMIN", new Set<string>(ROLE_PERMISSIONS.ADMIN));
});

afterAll(async () => {
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function person(org = orgA) {
  const db = await getDb();
  seq += 1;
  const dni = `6${String(seq).padStart(7, "0")}`;
  const row = await db.insertInto("people").values({ first_name: `Per${seq}`, last_name: `Ape${seq}`, dni, email: `att${seq}@example.com`, organization_id: org, origin: "manual" } as never).returning("id").executeTakeFirstOrThrow();
  return { id: row.id, dni, lastName: `Ape${seq}` };
}
async function meeting(status: "scheduled" | "in_progress" | "finished", extra: Record<string, unknown> = {}) {
  const db = await getDb();
  seq += 1;
  return (
    await db
      .insertInto("meetings")
      .values({
        name: `Reunión asistencia ${seq}`, owner_organization_id: orgA, organizer_user_id: master.id, created_by: master.id, origin: "manual", status,
        meeting_type: "reunion", schedule_precision: "exact_datetime", starts_at: new Date(Date.now() - 600_000), ends_at: new Date(Date.now() + 4_800_000), ...extra,
      } as never)
      .returning(["id", "name", "qr_secret_version"])
      .executeTakeFirstOrThrow()
  );
}
async function invite(m: string, p: { id: string }) {
  await inv.createInvitationBatch(master, m, { personIds: [p.id] }, { channel: "whatsapp" });
}
async function attendance(m: string, p: string) {
  const db = await getDb();
  return db.selectFrom("meeting_attendance").selectAll().where("meeting_id", "=", m).where("person_id", "=", p).executeTakeFirst();
}
async function interactionsOf(attendanceId: string) {
  const db = await getDb();
  return db.selectFrom("person_interactions").selectAll().where("source_key", "=", `meeting_attendance:${attendanceId}`).execute();
}
const count = async (table: string) => (await sql<{ n: number }>`select count(*)::int n from ${sql.table(table)}`.execute(await getDb())).rows[0]!.n;

describe("1d · el escaneo deja una interacción «Asistió a…»", () => {
  it("enlace personal: una interacción con la hora real del check-in, en la unidad de la persona, a nombre del organizador", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    expect((await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua")).kind).toBe("ok");
    const a = (await attendance(m.id, p.id))!;
    const [i, ...rest] = await interactionsOf(a.id);
    expect(rest).toHaveLength(0);
    expect(i).toMatchObject({
      person_id: p.id, owner_organization_id: orgA, status: "completed", occurred_precision: "exact_datetime", date_basis: "actual", meeting_id: m.id,
      created_by: master.id, subject: `Asistió a reunión: ${m.name}`, void_reason: null, channel_id: null,
    });
    expect(i!.occurred_at.getTime()).toBe(a.checked_in_at!.getTime());
  });

  it("QR: identificar + confirmar también la deja, y reintentar no duplica", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    const idf = await identifyForCheckin(m.id, p.dni, p.lastName, nextIp());
    if (idf.kind !== "need_confirmation") throw new Error(idf.kind);
    expect((await confirmCheckin(idf.confirmToken, nextIp(), "ua")).kind).toBe("ok");
    const a = (await attendance(m.id, p.id))!;
    expect(await interactionsOf(a.id)).toHaveLength(1);
    // reintento del mismo escaneo y reproceso global: una sola interacción
    await confirmCheckin(idf.confirmToken, nextIp(), "ua");
    const db = await getDb();
    const again = await syncParticipationInteractions(db, { meetingId: m.id, actorUserId: master.id });
    expect(again.created).toBe(0);
    expect(await interactionsOf(a.id)).toHaveLength(1);
  });

  it("la interacción nace en la MISMA transacción que la asistencia (si una falla, ninguna queda)", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    const db = await getDb();
    // sin tipo de interacción «participation» no se puede crear la interacción: la asistencia tampoco debe quedar registrada
    const type = await db.selectFrom("interaction_types").select("id").where("key", "=", "participation").executeTakeFirstOrThrow();
    await db.updateTable("interaction_types").set({ key: "participation_renombrado" } as never).where("id", "=", type.id).execute();
    try {
      await expect(checkInWithInvitationToken(m.id, p.id, nextIp(), "ua")).rejects.toThrow();
      expect(await attendance(m.id, p.id)).toBeUndefined();
    } finally {
      await db.updateTable("interaction_types").set({ key: "participation" } as never).where("id", "=", type.id).execute();
    }
    expect((await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua")).kind).toBe("ok");
  });
});

describe("1d · revocar anula la interacción; restaurar la reactiva", () => {
  it("el ciclo completo conserva la misma fila (trazabilidad) y cuenta versiones", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua");
    const a = (await attendance(m.id, p.id))!;
    const [before] = await interactionsOf(a.id);

    await att.revokeAttendance(master, { meetingId: m.id, personId: p.id, reason: "Se escaneó por error" });
    const [revoked] = await interactionsOf(a.id);
    expect(revoked).toMatchObject({ id: before!.id, status: "voided", void_reason: "La asistencia fue revocada" });

    await att.restoreAttendance(master, { meetingId: m.id, personId: p.id, reason: "Era correcta" });
    const [restored] = await interactionsOf(a.id);
    expect(restored).toMatchObject({ id: before!.id, status: "completed", void_reason: null });
    expect(restored!.version).toBeGreaterThan(revoked!.version);
    expect(await interactionsOf(a.id)).toHaveLength(1);
  });

  it("revocar dos veces o restaurar sin revocar no cambia nada", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua");
    const a = (await attendance(m.id, p.id))!;
    await att.restoreAttendance(master, { meetingId: m.id, personId: p.id, reason: "x" });
    expect((await interactionsOf(a.id))[0]).toMatchObject({ status: "completed" });
    await att.revokeAttendance(master, { meetingId: m.id, personId: p.id, reason: "y" });
    await att.revokeAttendance(master, { meetingId: m.id, personId: p.id, reason: "y" });
    expect((await interactionsOf(a.id))[0]).toMatchObject({ status: "voided" });
  });
});

describe("1d · asistencia manual", () => {
  it("retroactiva con hora exacta, solo el día, o desconocida: respeta la precisión y nunca inventa una fecha", async () => {
    const m = await meeting("finished");
    const exact = await person();
    const dayOnly = await person();
    const unknown = await person();
    const at = new Date(Date.now() - 3_600_000);
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await att.registerAttendanceManually(master, { meetingId: m.id, personId: exact.id, reason: "acreditación en mesa", occurred: { kind: "exact", at } } as never);
    await att.registerAttendanceManually(master, { meetingId: m.id, personId: dayOnly.id, reason: "planilla en papel", occurred: { kind: "date_only", day } } as never);
    await att.registerAttendanceManually(master, { meetingId: m.id, personId: unknown.id, reason: "planilla sin fecha", occurred: { kind: "unknown" } } as never);

    const ie = (await interactionsOf((await attendance(m.id, exact.id))!.id))[0]!;
    expect(ie).toMatchObject({ occurred_precision: "exact_datetime", status: "completed", subject: `Asistió a reunión: ${m.name}` });
    expect(ie.occurred_at.getTime()).toBe(at.getTime());
    const id = (await interactionsOf((await attendance(m.id, dayOnly.id))!.id))[0]!;
    expect(id).toMatchObject({ occurred_precision: "date_only", status: "completed" });
    expect(await interactionsOf((await attendance(m.id, unknown.id))!.id)).toHaveLength(0); // sin fecha real no hay interacción
  });

  it("corregir la hora de una asistencia manual actualiza la interacción; corregir una desconocida a una fecha real la crea", async () => {
    const m = await meeting("finished");
    const p = await person();
    const q = await person();
    const t1 = new Date(Date.now() - 7_200_000);
    const t2 = new Date(Date.now() - 5_400_000);
    await att.registerAttendanceManually(master, { meetingId: m.id, personId: p.id, reason: "mesa", occurred: { kind: "exact", at: t1 } } as never);
    await att.correctAttendance(master, { meetingId: m.id, personId: p.id, reason: "hora mal cargada", occurred: { kind: "exact", at: t2 } });
    const [i] = await interactionsOf((await attendance(m.id, p.id))!.id);
    expect(i!.occurred_at.getTime()).toBe(t2.getTime());

    await att.registerAttendanceManually(master, { meetingId: m.id, personId: q.id, reason: "planilla", occurred: { kind: "unknown" } } as never);
    const qa = (await attendance(m.id, q.id))!;
    expect(await interactionsOf(qa.id)).toHaveLength(0);
    await att.correctAttendance(master, { meetingId: m.id, personId: q.id, reason: "ahora se sabe", occurred: { kind: "exact", at: t1 } });
    const created = await interactionsOf(qa.id);
    expect(created).toHaveLength(1);
    expect(created[0]!.occurred_at.getTime()).toBe(t1.getTime());
  });
});

describe("1d · no duplica, y se puede reprocesar", () => {
  it("si la persona ya tiene la interacción de una participación «asistió» de esa misma actividad, la asistencia no suma otra", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    await invite(m.id, p);
    const db = await getDb();
    const participation = await db
      .insertInto("meeting_participations")
      .values({ meeting_id: m.id, person_id: p.id, participation_kind: "attended", participation_basis: "standard", evidence: "planilla de asistencia" } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    await syncParticipationInteractions(db, { meetingId: m.id, actorUserId: master.id });
    expect(await db.selectFrom("person_interactions").select("id").where("source_key", "=", `meeting_participation:${participation.id}`).execute()).toHaveLength(1);
    await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua");
    const a = (await attendance(m.id, p.id))!;
    expect(await interactionsOf(a.id)).toHaveLength(0);
    expect((await db.selectFrom("person_interactions").select("id").where("person_id", "=", p.id).where("meeting_id", "=", m.id).execute())).toHaveLength(1);
  });

  it("el reproceso global genera las que faltan (asistencias cargadas por otro medio) y es idempotente", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    const db = await getDb();
    // asistencia insertada «a mano» en la base, sin pasar por la aplicación: no tiene interacción todavía
    const a = await db
      .insertInto("meeting_attendance")
      .values({ meeting_id: m.id, person_id: p.id, method: "qr", identification: "dni", checked_in_at: new Date(), occurred_precision: "exact_datetime" } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    expect(await interactionsOf(a.id)).toHaveLength(0);
    const first = await syncParticipationInteractions(db, { meetingId: m.id, actorUserId: master.id });
    expect(first.created).toBe(1);
    const second = await syncParticipationInteractions(db, { meetingId: m.id, actorUserId: master.id });
    expect(second).toMatchObject({ created: 0, voided: 0, reactivated: 0 });
    expect(await interactionsOf(a.id)).toHaveLength(1);
  });

  it("una asistencia revocada no genera interacción al reprocesar", async () => {
    const m = await meeting("in_progress");
    const p = await person();
    const db = await getDb();
    const a = await db
      .insertInto("meeting_attendance")
      .values({ meeting_id: m.id, person_id: p.id, method: "qr", identification: "dni", checked_in_at: new Date(), occurred_precision: "exact_datetime" } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    // la base no permite crear una asistencia ya revocada: se revoca después (sin pasar por la aplicación, así que todavía no tiene interacción)
    await db.updateTable("meeting_attendance").set({ revoked_at: new Date(), revoked_by: master.id, revoke_reason: "error" } as never).where("id", "=", a.id).execute();
    const r = await syncParticipationInteractions(db, { meetingId: m.id, actorUserId: master.id });
    expect(r.created).toBe(0);
    expect(await interactionsOf(a.id)).toHaveLength(0);
  });
});

describe("1d · de punta a punta: inscripto por formulario → escanea el QR → interacción; el que no fue no la tiene", () => {
  it("solo quien escaneó recibe la interacción; el inscripto ausente no", async () => {
    const act = await createActivity(areaA, {
      kind: "single", name: "Capacitación punta a punta", meetingType: "capacitacion", ownerOrganizationId: orgA,
      dates: [{ startsAt: "2030-05-10T09:00", endsAt: "2030-05-10T12:00" }],
    });
    const m = act.meetings[0]!.id;
    const db = await getDb();
    const fue = await person();
    const noFue = await person();
    for (const p of [fue, noFue]) {
      const r = await submitForm(act.form.slug, { first_name: "X", last_name: "Y", dni: p.dni, email: "", phone: "" }, randomUUID(), nextIp(), "agent");
      expect(r.kind).toBe("ok");
    }
    // ambos quedaron inscriptos por el formulario; la jornada pasa a «en curso» y el check-in permite sin invitación solo a inscriptos/invitados
    const regs = await db.selectFrom("meeting_participations").select("person_id").where("meeting_id", "=", m).where("participation_kind", "=", "registration").execute();
    expect(regs.map((r) => r.person_id).sort()).toEqual([fue.id, noFue.id].sort());
    await db.updateTable("meetings").set({ status: "in_progress", starts_at: new Date(Date.now() - 600_000), ends_at: new Date(Date.now() + 3_600_000), allow_uninvited_checkin: true } as never).where("id", "=", m).execute();

    const idf = await identifyForCheckin(m, fue.dni, fue.lastName, nextIp());
    if (idf.kind !== "need_confirmation") throw new Error(idf.kind);
    expect((await confirmCheckin(idf.confirmToken, nextIp(), "ua")).kind).toBe("ok");

    const interactions = await db.selectFrom("person_interactions").select(["person_id", "subject"]).where("meeting_id", "=", m).execute();
    expect(interactions).toEqual([{ person_id: fue.id, subject: `Asistió a capacitación: ${act.meetings[0]!.name}` }]);
    expect(await count("meeting_attendance")).toBeGreaterThanOrEqual(1);
  });

  it("la interacción pertenece a la unidad de la persona, así que su área la ve y otra no", async () => {
    const m = await meeting("in_progress");
    const p = await person(orgB);
    await invite(m.id, p);
    await checkInWithInvitationToken(m.id, p.id, nextIp(), "ua");
    const a = (await attendance(m.id, p.id))!;
    const [i] = await interactionsOf(a.id);
    expect(i!.owner_organization_id).toBe(orgB);
  });
});
