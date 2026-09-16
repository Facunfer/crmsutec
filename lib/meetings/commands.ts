import { getDb } from "../db/client.js";
import { parseLocalDateTimeInBusinessTz } from "../datetime.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { writeAuditLog } from "../audit/log.js";
import type { SessionUser } from "../permissions/can.js";
import type { MeetingInput } from "./schema.js";
import { canEditCoreFields, canTransition, STATUS_LABEL, type MeetingStatus } from "./state-machine.js";

assertServerOnly("lib/meetings/commands.ts");

export class MeetingCommandError extends Error {}

export async function createMeeting(actor: SessionUser, input: MeetingInput): Promise<{ id: string }> {
  assertPermission(actor, "meetings.create");

  const db = await getDb();
  const created = await db
    .insertInto("meetings")
    .values({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      starts_at: parseLocalDateTimeInBusinessTz(input.startsAt),
      ends_at: parseLocalDateTimeInBusinessTz(input.endsAt),
      location_name: input.locationName?.trim() || null,
      address: input.address?.trim() || null,
      notes: input.notes?.trim() || null,
      organizer_user_id: actor.id,
      status: "draft",
      created_by: actor.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await writeAuditLog({
    actorUserId: actor.id,
    action: "MEETING_CREATED",
    entityType: "meeting",
    entityId: created.id,
    after: { name: input.name, starts_at: input.startsAt, ends_at: input.endsAt },
  });

  return { id: created.id };
}

export async function updateMeeting(actor: SessionUser, meetingId: string, input: MeetingInput): Promise<void> {
  assertPermission(actor, "meetings.edit");

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
      location_name: input.locationName?.trim() || null,
      address: input.address?.trim() || null,
      notes: input.notes?.trim() || null,
      updated_at: new Date(),
    })
    .where("id", "=", meetingId)
    .execute();

  await writeAuditLog({
    actorUserId: actor.id,
    action: "MEETING_UPDATED",
    entityType: "meeting",
    entityId: meetingId,
    before: { name: existing.name, starts_at: existing.starts_at.toISOString(), ends_at: existing.ends_at.toISOString() },
    after: { name: input.name, starts_at: input.startsAt, ends_at: input.endsAt },
  });
}

export async function changeMeetingStatus(
  actor: SessionUser,
  meetingId: string,
  targetStatus: MeetingStatus
): Promise<void> {
  assertPermission(actor, "meetings.change_status");

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

  await writeAuditLog({
    actorUserId: actor.id,
    action: "MEETING_STATUS_CHANGED",
    entityType: "meeting",
    entityId: meetingId,
    before: { status: existing.status },
    after: { status: targetStatus },
  });
}

export async function setMeetingAssociations(
  actor: SessionUser,
  meetingId: string,
  associationIds: string[]
): Promise<void> {
  assertPermission(actor, "meetings.edit");

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

  await writeAuditLog({
    actorUserId: actor.id,
    action: "MEETING_UPDATED",
    entityType: "meeting",
    entityId: meetingId,
    metadata: { associations_set: associationIds },
  });
}
