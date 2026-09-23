import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.SUTECBA_QR_SECRET = "test-secret-not-for-prod-0123456789";

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createMeeting, changeMeetingStatus, regenerateQrSecret } = await import("../../lib/meetings/commands.js");
const { createInvitationBatch } = await import("../../lib/meetings/invitations.js");
const { checkInByInvitationToken } = await import("../../lib/meetings/public.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { signRotatingQrToken } = await import("../../lib/attendance/qr.js");
const { resolveQrToken, identifyForCheckin, confirmCheckin, checkInWithInvitationToken } = await import(
  "../../lib/attendance/checkin.js"
);
const { setAttendanceManually, ManualAttendanceError } = await import("../../lib/attendance/manual.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL_PERMISSIONS = new Set(PERMISSIONS.map((p) => p.key));

let actor: any;
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

function activeMeetingInput() {
  const start = new Date(Date.now() - 10 * 60_000);
  const end = new Date(Date.now() + 80 * 60_000);
  const toLocal = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return { startsAt: toLocal(start), endsAt: toLocal(end) };
}

async function makeInProgressMeeting(name: string, opts: { allowUninvitedCheckin?: boolean } = {}) {
  const { id } = await createMeeting(actor, { ownerOrganizationId: ownerOrgId,
    name,
    ...activeMeetingInput(),
    description: "",
    locationName: "",
    address: "",
    notes: "",
    allowUninvitedCheckin: opts.allowUninvitedCheckin,
  });
  await changeMeetingStatus(actor, id, "scheduled");
  await changeMeetingStatus(actor, id, "in_progress");
  const db = await getDb();
  const meeting = await db.selectFrom("meetings").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  return { id, qrSecretVersion: meeting.qr_secret_version as number };
}

async function makePerson(firstName: string, lastName: string, dni: string) {
  const db = await getDb();
  const row = await db
    .insertInto("people")
    .values({ first_name: firstName, last_name: lastName, dni, organization_id: ownerOrgId })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id as string;
}

let ownerOrgId: string;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  ownerOrgId = await createTestOrganization();

  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({
      email: "attendance-actor@sutecba.local",
      password_hash: await hashPassword("x-password-123"),
      full_name: "Actor",
      role_id: role.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  actor = {
    id: user.id,
    email: "attendance-actor@sutecba.local",
    fullName: "Actor",
    roleId: role.id,
    roleKey: "MASTER_GLOBAL",
    mustChangePassword: false,
    enabledModules: ALL_MODULE_KEYS,
    permissions: ALL_PERMISSIONS,
  };
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("flujo completo QR -> identificación -> confirmación", () => {
  it("escanea el QR, se identifica con DNI+apellido, confirma, y queda una sola fila de asistencia", async () => {
    const { id, qrSecretVersion } = await makeInProgressMeeting("Reunión QR Completa");
    const personId = await makePerson("Ana", "Gomez", "30111222");
    await createInvitationBatch(actor, id, { personIds: [personId] });

    const { token: qrToken } = signRotatingQrToken(id, qrSecretVersion);
    const resolved = await resolveQrToken(qrToken, nextIp());
    expect(resolved.kind).toBe("ok");
    if (resolved.kind !== "ok") return;
    expect(resolved.meetingId).toBe(id);

    const identify = await identifyForCheckin(resolved.meetingId, "30111222", "Gomez", nextIp());
    expect(identify.kind).toBe("need_confirmation");
    if (identify.kind !== "need_confirmation") return;
    expect(identify.firstName).toBe("Ana");

    const confirm = await confirmCheckin(identify.confirmToken, nextIp(), "vitest-agent");
    expect(confirm.kind).toBe("ok");

    const db = await getDb();
    const rows = await db.selectFrom("meeting_attendance").selectAll().where("meeting_id", "=", id).where("person_id", "=", personId).execute();
    expect(rows.length).toBe(1);
    expect(rows[0]?.method).toBe("dni");

    const [invitation] = await db.selectFrom("meeting_invitations").select("attendance_status").where("meeting_id", "=", id).where("person_id", "=", personId).execute();
    expect(invitation?.attendance_status).toBe("attended");
  });

  it("regenerar el secreto QR invalida los códigos ya emitidos", async () => {
    const { id, qrSecretVersion } = await makeInProgressMeeting("Reunión QR Regenerado");
    const { token: oldToken } = signRotatingQrToken(id, qrSecretVersion);

    await regenerateQrSecret(actor, id);

    const resolved = await resolveQrToken(oldToken, nextIp());
    expect(resolved.kind).toBe("invalid");
  });

  it("un DNI o apellido incorrecto nunca distingue 'no existe' de 'existe pero no coincide'", async () => {
    const { id } = await makeInProgressMeeting("Reunión Identificación");
    const personId = await makePerson("Bruno", "Diaz", "30111333");
    await createInvitationBatch(actor, id, { personIds: [personId] });

    const wrongLastName = await identifyForCheckin(id, "30111333", "ApellidoQueNoEs", nextIp());
    expect(wrongLastName.kind).toBe("not_found");

    const nonExistentDni = await identifyForCheckin(id, "99999999", "Cualquiera", nextIp());
    expect(nonExistentDni.kind).toBe("not_found");
  });
});

describe("prioridad 1: check-in vía enlace personal de invitación", () => {
  it("ya identificado por su token, un solo llamado registra la llegada", async () => {
    const { id } = await makeInProgressMeeting("Reunión Invitación Directa");
    const personId = await makePerson("Carla", "Ruiz", "30111444");
    const batch = await createInvitationBatch(actor, id, { personIds: [personId] });
    const token = batch.links[0]!.token;

    const result = await checkInByInvitationToken(token, nextIp(), "vitest-agent");
    expect(result.ok).toBe(true);

    const again = await checkInByInvitationToken(token, nextIp(), "vitest-agent");
    expect(again.ok).toBe(true);

    const db = await getDb();
    const rows = await db.selectFrom("meeting_attendance").selectAll().where("meeting_id", "=", id).where("person_id", "=", personId).execute();
    expect(rows.length).toBe(1);
    expect(rows[0]?.method).toBe("invitation_token");
  });

  it("un token retirado/inválido no registra nada", async () => {
    const result = await checkInByInvitationToken("token-que-no-existe", nextIp(), undefined);
    expect(result.ok).toBe(false);
  });
});

describe("personas no invitadas", () => {
  it("se rechaza por defecto, y se acepta si la reunión permite acreditación sin invitación", async () => {
    const { id: restrictedId } = await makeInProgressMeeting("Reunión Solo Invitados");
    const uninvited = await makePerson("Dario", "Lopez", "30111555");
    const rejected = await identifyForCheckin(restrictedId, "30111555", "Lopez", nextIp());
    // Una persona existente pero no invitada es indistinguible de una que no existe.
    expect(rejected.kind).toBe("not_found");

    const { id: openId } = await makeInProgressMeeting("Reunión Abierta", { allowUninvitedCheckin: true });
    const allowed = await identifyForCheckin(openId, "30111555", "Lopez", nextIp());
    expect(allowed.kind).toBe("need_confirmation");
    void uninvited;
  });
});

describe("concurrencia: dos confirmaciones simultáneas de la misma persona", () => {
  it("una sola fila de asistencia sobrevive, la otra responde 'already_checked_in'", async () => {
    const { id } = await makeInProgressMeeting("Reunión Concurrencia");
    const personId = await makePerson("Elena", "Vega", "30111666");
    await createInvitationBatch(actor, id, { personIds: [personId] });

    const identify = await identifyForCheckin(id, "30111666", "Vega", nextIp());
    expect(identify.kind).toBe("need_confirmation");
    if (identify.kind !== "need_confirmation") return;

    const [first, second] = await Promise.all([
      confirmCheckin(identify.confirmToken, nextIp(), "a"),
      confirmCheckin(identify.confirmToken, nextIp(), "b"),
    ]);

    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["already_checked_in", "ok"].sort());

    const db = await getDb();
    const rows = await db.selectFrom("meeting_attendance").selectAll().where("meeting_id", "=", id).where("person_id", "=", personId).execute();
    expect(rows.length).toBe(1);
  });
});

describe("rate limiting en identificación pública", () => {
  it("después de muchos intentos fallidos desde la misma IP, se corta con 'rate_limited'", async () => {
    const { id } = await makeInProgressMeeting("Reunión Rate Limit");
    const ip = nextIp();

    let lastKind = "";
    for (let i = 0; i < 41; i += 1) {
      const result = await identifyForCheckin(id, "30199999", "NoExiste", ip);
      lastKind = result.kind;
      if (lastKind === "rate_limited") break;
    }
    expect(lastKind).toBe("rate_limited");
  }, 30_000);
});

describe("corrección manual de asistencia", () => {
  it("exige un motivo, y nunca pisa un check-in por QR ya existente", async () => {
    const { id } = await makeInProgressMeeting("Reunión Manual");
    const personId = await makePerson("Franco", "Paz", "30111777");
    await createInvitationBatch(actor, id, { personIds: [personId] });

    await expect(setAttendanceManually(actor, id, personId, "attended", "")).rejects.toThrow(ManualAttendanceError);

    await checkInWithInvitationToken(id, personId, nextIp(), "qr-agent");
    const db = await getDb();
    const [beforeRow] = await db
      .selectFrom("meeting_attendance")
      .select(["method", "checked_in_at"])
      .where("meeting_id", "=", id)
      .where("person_id", "=", personId)
      .execute();
    expect(beforeRow?.method).toBe("invitation_token");

    await setAttendanceManually(actor, id, personId, "absent", "Se retiró antes, dato corregido a mano");

    const rowsAfter = await db
      .selectFrom("meeting_attendance")
      .select(["method", "checked_in_at"])
      .where("meeting_id", "=", id)
      .where("person_id", "=", personId)
      .execute();
    expect(rowsAfter.length).toBe(1);
    expect(rowsAfter[0]?.method).toBe("invitation_token"); // el hecho histórico del QR no se borra

    const [invitation] = await db
      .selectFrom("meeting_invitations")
      .select("attendance_status")
      .where("meeting_id", "=", id)
      .where("person_id", "=", personId)
      .execute();
    expect(invitation?.attendance_status).toBe("absent"); // el resumen sí refleja la corrección
  });

  it("una persona sin permiso no puede corregir asistencia", async () => {
    const { id } = await makeInProgressMeeting("Reunión Manual Sin Permiso");
    const personId = await makePerson("Gina", "Soto", "30111888");
    await createInvitationBatch(actor, id, { personIds: [personId] });

    const noPermActor = { ...actor, permissions: new Set<string>() };
    await expect(setAttendanceManually(noPermActor, id, personId, "attended", "motivo cualquiera")).rejects.toThrow();
  });
});
