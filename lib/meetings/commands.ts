import { getDb } from "../db/client.js";
import { parseLocalDateTimeInBusinessTz } from "../datetime.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import type { SessionUser } from "../permissions/can.js";
import { canActorOwnInOrganization } from "../organizations/ownership.js";
import { canAccessAssociation, canAccessMeeting } from "../scope/organizations.js";
import type { MeetingInput } from "./schema.js";
import { canEditCoreFields, canTransition, STATUS_LABEL, type MeetingStatus } from "./state-machine.js";

assertServerOnly("lib/meetings/commands.ts");

export class MeetingCommandError extends Error {}

export type CreateMeetingInput = MeetingInput & { ownerOrganizationId: string };

export async function createMeeting(actor: SessionUser, input: CreateMeetingInput): Promise<{ id: string }> {
  assertPermission(actor, "meetings.create");

  if (!(await canActorOwnInOrganization(actor.id, input.ownerOrganizationId))) {
    throw new MeetingCommandError("La unidad organizativa no existe, está inactiva o está fuera de tu alcance.");
  }

  const db = await getDb();
  const created = await db
    .insertInto("meetings")
    .values({
      owner_organization_id: input.ownerOrganizationId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      starts_at: parseLocalDateTimeInBusinessTz(input.startsAt),
      ends_at: parseLocalDateTimeInBusinessTz(input.endsAt),
      location_name: input.locationName?.trim() || null,
      address: input.address?.trim() || null,
      notes: input.notes?.trim() || null,
      meeting_type: input.meetingType ?? "reunion",
      organizer_user_id: actor.id,
      status: "draft",
      qr_mode: input.qrMode ?? "rotating",
      checkin_tolerance_before_minutes: input.checkinToleranceBeforeMinutes ?? 30,
      checkin_tolerance_after_minutes: input.checkinToleranceAfterMinutes ?? 60,
      allow_uninvited_checkin: input.allowUninvitedCheckin ?? false,
      created_by: actor.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();


  return { id: created.id };
}

export async function updateMeeting(actor: SessionUser, meetingId: string, input: MeetingInput): Promise<void> {
  assertPermission(actor, "meetings.edit");

  if (!(await canAccessMeeting(actor, meetingId))) throw new MeetingCommandError("La reunión no existe.");

  const db = await getDb();
  const existing = await db.selectFrom("meetings").selectAll().where("id", "=", meetingId).executeTakeFirst();
  if (!existing) throw new MeetingCommandError("La reunión no existe.");
  if (!canEditCoreFields(existing.status)) {
    throw new MeetingCommandError(
      `No se pueden editar los datos de una reunión en estado "${STATUS_LABEL[existing.status]}".`
    );
  }

  await db
    .updateTable("meetings")
    .set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      starts_at: parseLocalDateTimeInBusinessTz(input.startsAt),
      ends_at: parseLocalDateTimeInBusinessTz(input.endsAt),
      // Cargar fecha y hora reales en una actividad importada (date_only/unknown) la vuelve exacta:
      // el día suelto deja de ser la fuente de verdad.
      schedule_precision: "exact_datetime",
      event_date: null,
      location_name: input.locationName?.trim() || null,
      address: input.address?.trim() || null,
      notes: input.notes?.trim() || null,
      qr_mode: input.qrMode ?? existing.qr_mode,
      checkin_tolerance_before_minutes: input.checkinToleranceBeforeMinutes ?? existing.checkin_tolerance_before_minutes,
      checkin_tolerance_after_minutes: input.checkinToleranceAfterMinutes ?? existing.checkin_tolerance_after_minutes,
      allow_uninvited_checkin: input.allowUninvitedCheckin ?? existing.allow_uninvited_checkin,
      updated_at: new Date(),
    })
    .where("id", "=", meetingId)
    .execute();

}

export async function changeMeetingStatus(
  actor: SessionUser,
  meetingId: string,
  targetStatus: MeetingStatus
): Promise<void> {
  assertPermission(actor, "meetings.change_status");

  if (!(await canAccessMeeting(actor, meetingId))) throw new MeetingCommandError("La reunión no existe.");

  const db = await getDb();
  const existing = await db.selectFrom("meetings").selectAll().where("id", "=", meetingId).executeTakeFirst();
  if (!existing) throw new MeetingCommandError("La reunión no existe.");

  if (!canTransition(existing.status, targetStatus)) {
    throw new MeetingCommandError(
      `No se puede pasar de "${STATUS_LABEL[existing.status]}" a "${STATUS_LABEL[targetStatus]}".`
    );
  }

  await db.transaction().execute(async (trx) => {
    await trx.updateTable("meetings").set({ status: targetStatus, updated_at: new Date() }).where("id", "=", meetingId).execute();

    // Al finalizar se congela el resultado (sección 11 del prompt): toda
    // invitación que sigue "unknown" pasa a "absent" en la misma transacción.
    if (targetStatus === "finished") {
      await trx
        .updateTable("meeting_invitations")
        .set({ attendance_status: "absent" })
        .where("meeting_id", "=", meetingId)
        .where("attendance_status", "=", "unknown")
        .execute();
    }
  });

}

/** Invalida todos los QR ya emitidos (sección 12.1): el secreto real se deriva de este número + el id de la reunión. */
export async function regenerateQrSecret(actor: SessionUser, meetingId: string): Promise<void> {
  assertPermission(actor, "meetings.change_status");

  if (!(await canAccessMeeting(actor, meetingId))) throw new MeetingCommandError("La reunión no existe.");

  const db = await getDb();
  const updated = await db
    .updateTable("meetings")
    .set((eb) => ({ qr_secret_version: eb("qr_secret_version", "+", 1) }))
    .where("id", "=", meetingId)
    .returning("qr_secret_version")
    .executeTakeFirst();
  if (!updated) throw new MeetingCommandError("La reunión no existe.");

}

export async function setMeetingAssociations(
  actor: SessionUser,
  meetingId: string,
  associationIds: string[]
): Promise<void> {
  assertPermission(actor, "meetings.edit");

  if (!(await canAccessMeeting(actor, meetingId))) throw new MeetingCommandError("La reunión no existe.");

  // Las asociaciones a vincular también tienen que estar dentro del alcance del usuario.
  for (const associationId of associationIds) {
    if (!(await canAccessAssociation(actor, associationId))) {
      throw new MeetingCommandError("Una de las asociaciones no existe.");
    }
  }

  const db = await getDb();
  const existing = await db.selectFrom("meetings").select("status").where("id", "=", meetingId).executeTakeFirst();
  if (!existing) throw new MeetingCommandError("La reunión no existe.");
  if (!canEditCoreFields(existing.status)) {
    throw new MeetingCommandError(
      `No se pueden editar las asociaciones de una reunión en estado "${STATUS_LABEL[existing.status]}".`
    );
  }

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("meeting_associations").where("meeting_id", "=", meetingId).execute();
    if (associationIds.length > 0) {
      await trx
        .insertInto("meeting_associations")
        .values(associationIds.map((association_id) => ({ meeting_id: meetingId, association_id })))
        .execute();
    }
  });

}
