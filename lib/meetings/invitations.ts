import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { toJsonb } from "../db/json.js";
import type { Json } from "../db/schema.js";
import type { SessionUser } from "../permissions/can.js";
import { resolveAudienceIds, type MeetingAudienceSpec } from "./audience.js";
import { canAccessMeeting } from "../scope/organizations.js";
import { canManageInvitations, STATUS_LABEL } from "./state-machine.js";
import { generateInvitationToken, hashInvitationToken } from "./tokens.js";

assertServerOnly("lib/meetings/invitations.ts");

export class MeetingInvitationError extends Error {}

export interface CreatedInvitationLink {
  personId: string;
  personName: string;
  token: string;
}

export interface CreateInvitationBatchResult {
  batchId: string;
  resolvedCount: number;
  createdCount: number;
  revivedCount: number;
  alreadyInvitedCount: number;
  /** Tokens en claro, solo para esta respuesta — nunca quedan guardados (D10). */
  links: CreatedInvitationLink[];
}

/**
 * Crea una tanda de invitaciones a partir de una audiencia (sección 11 del
 * prompt). Idempotente ante doble clic: quien ya está invitado (activo) se
 * omite; quien fue retirado antes se "revive" con un token nuevo en vez de
 * violar el UNIQUE (meeting_id, person_id); recién ahí se insertan los que
 * nunca estuvieron invitados.
 */
export async function createInvitationBatch(
  actor: SessionUser,
  meetingId: string,
  spec: MeetingAudienceSpec
): Promise<CreateInvitationBatchResult> {
  assertPermission(actor, "meetings.manage_invitations");

  if (!(await canAccessMeeting(actor, meetingId))) throw new MeetingInvitationError("La reunión no existe.");

  const db = await getDb();
  const meeting = await db.selectFrom("meetings").selectAll().where("id", "=", meetingId).executeTakeFirst();
  if (!meeting) throw new MeetingInvitationError("La reunión no existe.");
  if (!canManageInvitations(meeting.status)) {
    throw new MeetingInvitationError(
      `No se pueden generar invitaciones para una reunión en estado "${STATUS_LABEL[meeting.status]}".`
    );
  }

  const resolvedIds = await resolveAudienceIds(actor, spec);
  if (resolvedIds.length === 0) {
    throw new MeetingInvitationError("La audiencia elegida no incluye a ninguna persona activa.");
  }

  const existingRows = await db
    .selectFrom("meeting_invitations")
    .select(["id", "person_id", "withdrawn_at"])
    .where("meeting_id", "=", meetingId)
    .where("person_id", "in", resolvedIds)
    .execute();

  const activeExistingIds = new Set(existingRows.filter((r) => !r.withdrawn_at).map((r) => r.person_id));
  const withdrawnRows = existingRows.filter((r) => r.withdrawn_at);
  const withdrawnPersonIds = new Set(withdrawnRows.map((r) => r.person_id));
  const brandNewIds = resolvedIds.filter((id) => !activeExistingIds.has(id) && !withdrawnPersonIds.has(id));

  const idsNeedingNames = [...withdrawnPersonIds, ...brandNewIds];
  const peopleToName =
    idsNeedingNames.length > 0
      ? await db.selectFrom("people").select(["id", "first_name", "last_name"]).where("id", "in", idsNeedingNames).execute()
      : [];
  const nameById = new Map(peopleToName.map((p) => [p.id, `${p.first_name} ${p.last_name}`]));

  const links: CreatedInvitationLink[] = [];

  const batch = await db
    .insertInto("meeting_invitation_batches")
    .values({
      meeting_id: meetingId,
      criteria: toJsonb(spec as unknown as Json),
      resolved_count: resolvedIds.length,
      inserted_count: brandNewIds.length + withdrawnRows.length,
      created_by: actor.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await db.transaction().execute(async (trx) => {
    for (const row of withdrawnRows) {
      const token = generateInvitationToken();
      await trx
        .updateTable("meeting_invitations")
        .set({
          token_hash: hashInvitationToken(token),
          response_status: "pending",
          attendance_status: "unknown",
          batch_id: batch.id,
          invited_at: new Date(),
          responded_at: null,
          withdrawn_at: null,
          withdrawn_by: null,
        })
        .where("id", "=", row.id)
        .execute();
      links.push({ personId: row.person_id, personName: nameById.get(row.person_id) ?? "", token });
    }

    if (brandNewIds.length > 0) {
      const rows = brandNewIds.map((personId) => {
        const token = generateInvitationToken();
        links.push({ personId, personName: nameById.get(personId) ?? "", token });
        return {
          meeting_id: meetingId,
          person_id: personId,
          batch_id: batch.id,
          token_hash: hashInvitationToken(token),
        };
      });
      await trx.insertInto("meeting_invitations").values(rows).execute();
    }
  });


  return {
    batchId: batch.id,
    resolvedCount: resolvedIds.length,
    createdCount: brandNewIds.length,
    revivedCount: withdrawnRows.length,
    alreadyInvitedCount: activeExistingIds.size,
    links,
  };
}

export interface InvitationRow {
  id: string;
  personId: string;
  firstName: string;
  lastName: string;
  responseStatus: string;
  attendanceStatus: string;
  invitedAt: Date;
  respondedAt: Date | null;
  withdrawn: boolean;
}

export async function listInvitations(actor: SessionUser, meetingId: string): Promise<InvitationRow[]> {
  if (!(await canAccessMeeting(actor, meetingId))) return [];

  const db = await getDb();
  const rows = await db
    .selectFrom("meeting_invitations")
    .innerJoin("people", "people.id", "meeting_invitations.person_id")
    .select([
      "meeting_invitations.id",
      "meeting_invitations.person_id",
      "people.first_name",
      "people.last_name",
      "meeting_invitations.response_status",
      "meeting_invitations.attendance_status",
      "meeting_invitations.invited_at",
      "meeting_invitations.responded_at",
      "meeting_invitations.withdrawn_at",
    ])
    .where("meeting_invitations.meeting_id", "=", meetingId)
    .orderBy("people.last_name", "asc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    personId: r.person_id,
    firstName: r.first_name,
    lastName: r.last_name,
    responseStatus: r.response_status,
    attendanceStatus: r.attendance_status,
    invitedAt: r.invited_at,
    respondedAt: r.responded_at,
    withdrawn: r.withdrawn_at !== null,
  }));
}

/** Nunca borra la fila (R8): siempre se marca, haya o no respondido (sección 11 del prompt). */
export async function withdrawInvitation(actor: SessionUser, invitationId: string): Promise<void> {
  assertPermission(actor, "meetings.manage_invitations");

  const db = await getDb();
  const invitation = await db
    .selectFrom("meeting_invitations")
    .selectAll()
    .where("id", "=", invitationId)
    .where("withdrawn_at", "is", null)
    .executeTakeFirst();
  if (!invitation) return;

  if (!(await canAccessMeeting(actor, invitation.meeting_id))) {
    throw new MeetingInvitationError("La reunión no existe.");
  }

  await db
    .updateTable("meeting_invitations")
    .set({ withdrawn_at: new Date(), withdrawn_by: actor.id })
    .where("id", "=", invitationId)
    .execute();

}
