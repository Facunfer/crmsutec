import { getDb } from "../db/client.js";
import { syncParticipationInteractions } from "../interactions/participation-sync.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { canAccessMeeting } from "../scope/organizations.js";
import type { SessionUser } from "../permissions/can.js";

assertServerOnly("lib/attendance/manual.ts");

export class ManualAttendanceError extends Error {}

/**
 * Corrección manual de asistencia (sección 12.3): permiso propio, motivo
 * obligatorio, auditada con el antes/después. Nunca pisa en silencio un
 * check-in por QR — si ya había una fila en `meeting_attendance`, queda
 * intacta como el hecho histórico ("se acreditó a las 18:03"); lo que
 * cambia acá es el estado resumen de la invitación, y el motivo queda en
 * la auditoría explicando por qué no coinciden.
 */
export async function setAttendanceManually(
  actor: SessionUser,
  meetingId: string,
  personId: string,
  attendanceStatus: "attended" | "absent",
  reason: string
): Promise<void> {
  assertPermission(actor, "meetings.attendance_manual");

  if (!(await canAccessMeeting(actor, meetingId))) {
    throw new ManualAttendanceError("La reunión no existe.");
  }

  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new ManualAttendanceError("El motivo es obligatorio para una corrección manual.");
  }

  const db = await getDb();
  const invitation = await db
    .selectFrom("meeting_invitations")
    .selectAll()
    .where("meeting_id", "=", meetingId)
    .where("person_id", "=", personId)
    .where("withdrawn_at", "is", null)
    .executeTakeFirst();
  if (!invitation) {
    throw new ManualAttendanceError("Esa persona no está invitada a esta reunión.");
  }

  const existingCheckin = await db
    .selectFrom("meeting_attendance")
    .select(["id"])
    .where("meeting_id", "=", meetingId)
    .where("person_id", "=", personId)
    .executeTakeFirst();

  await db.transaction().execute(async (trx) => {
    if (attendanceStatus === "attended" && !existingCheckin) {
      await trx
        .insertInto("meeting_attendance")
        .values({
          meeting_id: meetingId,
          person_id: personId,
          invitation_id: invitation.id,
          method: "manual",
          registered_by: actor.id,
          correction_reason: trimmedReason,
        })
        .execute();
    }

    await trx
      .updateTable("meeting_invitations")
      .set({ attendance_status: attendanceStatus })
      .where("id", "=", invitation.id)
      .execute();
    // Misma transacción: la interacción (o su anulación si se corrige a «ausente») nunca queda desfasada de la asistencia.
    await syncParticipationInteractions(trx, { meetingId, personId, actorUserId: actor.id });
  });

}
