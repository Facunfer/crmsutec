import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { writeAuditLog } from "../audit/log.js";
import { checkPublicLinkRateLimit, recordPublicLinkAttempt } from "../security/public-rate-limit.js";
import { normalizeDni, normalizeEmail, normalizePhone } from "../people/normalize.js";
import { isQrWithinWindow, verifyQrSignature, DEFAULT_ROTATION_SECONDS } from "./qr.js";
import { signPendingCheckin, verifyPendingCheckin } from "./session-tokens.js";

assertServerOnly("lib/attendance/checkin.ts");

export type QrResolution =
  | { kind: "ok"; meetingId: string; meetingName: string }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "cancelled" }
  | { kind: "not_active" }
  | { kind: "rate_limited" };

/** Primer paso: validar el QR escaneado y decidir si abrir una sesión de check-in. */
export async function resolveQrToken(token: string, ip: string): Promise<QrResolution> {
  const rate = await checkPublicLinkRateLimit("checkin_qr", token.slice(0, 24), ip, { perIdentifierLimit: 60 });
  if (!rate.allowed) return { kind: "rate_limited" };

  const payload = verifyQrSignature(token);
  if (!payload || !isQrWithinWindow(payload, DEFAULT_ROTATION_SECONDS)) {
    await recordPublicLinkAttempt("checkin_qr", token.slice(0, 24), ip, false);
    return payload ? { kind: "expired" } : { kind: "invalid" };
  }

  const db = await getDb();
  const meeting = await db.selectFrom("meetings").selectAll().where("id", "=", payload.m).executeTakeFirst();
  if (!meeting || meeting.qr_secret_version !== payload.v) {
    await recordPublicLinkAttempt("checkin_qr", token.slice(0, 24), ip, false);
    return { kind: "invalid" };
  }
  if (meeting.status === "cancelled") return { kind: "cancelled" };

  const now = Date.now();
  const from = meeting.starts_at.getTime() - meeting.checkin_tolerance_before_minutes * 60_000;
  const to = meeting.ends_at.getTime() + meeting.checkin_tolerance_after_minutes * 60_000;
  if (now < from || now > to) return { kind: "not_active" };

  await recordPublicLinkAttempt("checkin_qr", token.slice(0, 24), ip, true);
  return { kind: "ok", meetingId: meeting.id, meetingName: meeting.name };
}

/** Nombre de la reunión para la pantalla pública de check-in (sesión de cookie ya validada). */
export async function getCheckinMeetingName(meetingId: string): Promise<string | null> {
  const db = await getDb();
  const meeting = await db.selectFrom("meetings").select(["name"]).where("id", "=", meetingId).executeTakeFirst();
  return meeting?.name ?? null;
}

export type IdentifyResult =
  | { kind: "need_confirmation"; firstName: string; confirmToken: string }
  | { kind: "already_checked_in"; firstName: string; checkedInAt: Date }
  | { kind: "not_found" }
  | { kind: "not_invited" }
  | { kind: "rate_limited" };

/**
 * Prioridad de identificación (sección 12.2): acá se cubren las
 * prioridades 2 y 3 (DNI, o email/teléfono, siempre + apellido como
 * segundo dato). La prioridad 1 (token de invitación individual) es un
 * camino aparte — ver `checkInWithInvitationToken`, que ya conoce a la
 * persona y no necesita este paso.
 *
 * Mensajes que nunca distinguen "no existe" de "existe pero no coincide
 * el apellido" ni de "existe pero no está invitada": todo cae en
 * "not_found" salvo el caso explícito de invitada-pero-no-encontrada, que
 * de por sí ya no revela nada (sección 12.2: no enumerar).
 */
export async function identifyForCheckin(
  meetingId: string,
  identifier: string,
  lastName: string,
  ip: string
): Promise<IdentifyResult> {
  const rate = await checkPublicLinkRateLimit("checkin_identify", `${meetingId}:${ip}`, ip, {
    perIdentifierLimit: 40,
    perIpLimit: 300,
  });
  if (!rate.allowed) return { kind: "rate_limited" };

  const dni = normalizeDni(identifier);
  const email = normalizeEmail(identifier);
  const phone = normalizePhone(identifier);
  const lastNameNormalized = lastName.trim().toLowerCase();

  if (!lastNameNormalized || (!dni && !email && !phone)) {
    await recordPublicLinkAttempt("checkin_identify", `${meetingId}:${ip}`, ip, false);
    return { kind: "not_found" };
  }

  const db = await getDb();
  let person = dni
    ? await db.selectFrom("people").selectAll().where("dni", "=", dni).where("status", "=", "active").executeTakeFirst()
    : undefined;
  if (!person && email) {
    person = await db
      .selectFrom("people")
      .selectAll()
      .where(({ fn }) => fn("lower", ["email"]), "=", email)
      .where("status", "=", "active")
      .executeTakeFirst();
  }
  if (!person && phone) {
    person = await db.selectFrom("people").selectAll().where("phone", "=", phone).where("status", "=", "active").executeTakeFirst();
  }

  if (!person || person.last_name.trim().toLowerCase() !== lastNameNormalized) {
    await recordPublicLinkAttempt("checkin_identify", `${meetingId}:${ip}`, ip, false);
    return { kind: "not_found" };
  }

  const meeting = await db.selectFrom("meetings").select(["allow_uninvited_checkin"]).where("id", "=", meetingId).executeTakeFirst();
  const invitation = await db
    .selectFrom("meeting_invitations")
    .select(["id"])
    .where("meeting_id", "=", meetingId)
    .where("person_id", "=", person.id)
    .where("withdrawn_at", "is", null)
    .executeTakeFirst();

  if (!invitation && !meeting?.allow_uninvited_checkin) {
    await recordPublicLinkAttempt("checkin_identify", `${meetingId}:${ip}`, ip, false);
    return { kind: "not_invited" };
  }

  const existingAttendance = await db
    .selectFrom("meeting_attendance")
    .select(["checked_in_at"])
    .where("meeting_id", "=", meetingId)
    .where("person_id", "=", person.id)
    .executeTakeFirst();

  await recordPublicLinkAttempt("checkin_identify", `${meetingId}:${ip}`, ip, true);

  if (existingAttendance) {
    return { kind: "already_checked_in", firstName: person.first_name, checkedInAt: existingAttendance.checked_in_at };
  }

  return {
    kind: "need_confirmation",
    firstName: person.first_name,
    confirmToken: signPendingCheckin(meetingId, person.id),
  };
}

export type ConfirmResult =
  | { kind: "ok"; firstName: string; checkedInAt: Date }
  | { kind: "already_checked_in"; firstName: string; checkedInAt: Date }
  | { kind: "invalid" }
  | { kind: "not_active" }
  | { kind: "rate_limited" };

export async function confirmCheckin(confirmToken: string, ip: string, userAgent: string | undefined): Promise<ConfirmResult> {
  const pending = verifyPendingCheckin(confirmToken);
  if (!pending) return { kind: "invalid" };

  const rate = await checkPublicLinkRateLimit("checkin_confirm", `${pending.m}:${ip}`, ip, { perIdentifierLimit: 60, perIpLimit: 300 });
  if (!rate.allowed) return { kind: "rate_limited" };

  return recordCheckIn(pending.m, pending.p, "dni", { ip, userAgent });
}

/** Prioridad 1 de identificación: ya sabemos quién es por su invitación personal. */
export async function checkInWithInvitationToken(
  meetingId: string,
  personId: string,
  ip: string,
  userAgent: string | undefined
): Promise<ConfirmResult> {
  return recordCheckIn(meetingId, personId, "invitation_token", { ip, userAgent });
}

type AttendanceMethod = "invitation_token" | "dni" | "email" | "phone" | "manual";

/**
 * Única ruta de escritura de check-in (sección 12.2): tanto la
 * confirmación por QR como el check-in vía enlace de invitación pasan
 * por acá. `unique(meeting_id, person_id)` en la base es el resguardo
 * final contra duplicados si dos pestañas confirman a la vez.
 */
async function recordCheckIn(
  meetingId: string,
  personId: string,
  method: AttendanceMethod,
  meta: { ip: string; userAgent?: string }
): Promise<ConfirmResult> {
  const db = await getDb();

  const meeting = await db.selectFrom("meetings").selectAll().where("id", "=", meetingId).executeTakeFirst();
  if (!meeting || meeting.status === "cancelled") return { kind: "invalid" };

  const now = Date.now();
  const from = meeting.starts_at.getTime() - meeting.checkin_tolerance_before_minutes * 60_000;
  const to = meeting.ends_at.getTime() + meeting.checkin_tolerance_after_minutes * 60_000;
  if (now < from || now > to) return { kind: "not_active" };

  const person = await db.selectFrom("people").select(["id", "first_name"]).where("id", "=", personId).executeTakeFirst();
  if (!person) return { kind: "invalid" };

  const existing = await db
    .selectFrom("meeting_attendance")
    .select(["checked_in_at"])
    .where("meeting_id", "=", meetingId)
    .where("person_id", "=", personId)
    .executeTakeFirst();
  if (existing) {
    return { kind: "already_checked_in", firstName: person.first_name, checkedInAt: existing.checked_in_at };
  }

  const invitation = await db
    .selectFrom("meeting_invitations")
    .select(["id"])
    .where("meeting_id", "=", meetingId)
    .where("person_id", "=", personId)
    .where("withdrawn_at", "is", null)
    .executeTakeFirst();

  const checkedInAt = new Date();

  try {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("meeting_attendance")
        .values({
          meeting_id: meetingId,
          person_id: personId,
          invitation_id: invitation?.id ?? null,
          method,
          checked_in_at: checkedInAt,
          ip_address: meta.ip,
          user_agent: meta.userAgent ?? null,
        })
        .execute();

      if (invitation) {
        await trx
          .updateTable("meeting_invitations")
          .set({ attendance_status: "attended" })
          .where("id", "=", invitation.id)
          .execute();
      }
    });
  } catch {
    // Concurrencia real (sección 12.3): dos check-ins casi simultáneos de
    // la misma persona chocan contra el UNIQUE(meeting_id, person_id) — el
    // segundo no crea una fila nueva, solo informa la que ya existe.
    const raceWinner = await db
      .selectFrom("meeting_attendance")
      .select(["checked_in_at"])
      .where("meeting_id", "=", meetingId)
      .where("person_id", "=", personId)
      .executeTakeFirst();
    if (raceWinner) {
      return { kind: "already_checked_in", firstName: person.first_name, checkedInAt: raceWinner.checked_in_at };
    }
    throw new Error("No se pudo registrar el check-in.");
  }

  await writeAuditLog({
    actorType: "public",
    action: "CHECKIN_REGISTERED",
    entityType: "meeting",
    entityId: meetingId,
    metadata: { person_id: personId, method },
  });

  return { kind: "ok", firstName: person.first_name, checkedInAt };
}
