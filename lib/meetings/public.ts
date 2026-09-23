import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { checkPublicLinkRateLimit, recordPublicLinkAttempt } from "../security/public-rate-limit.js";
import { isPubliclyRespondable } from "./state-machine.js";
import { hashInvitationToken } from "./tokens.js";
import { checkInWithInvitationToken } from "../attendance/checkin.js";

assertServerOnly("lib/meetings/public.ts");

export type InvitationPublicView =
  | { kind: "invalid" }
  | { kind: "rate_limited" }
  | { kind: "cancelled" }
  | { kind: "finished" }
  | {
      kind: "checkin"; // la reunión ya arrancó: prioridad 1 de identificación (sección 12.2)
      meetingName: string;
      firstName: string;
      alreadyCheckedIn: boolean;
      checkedInAt: Date | null;
    }
  | {
      kind: "ok";
      meetingName: string;
      startsAt: Date;
      endsAt: Date;
      locationName: string | null;
      address: string | null;
      firstName: string;
      responseStatus: "pending" | "confirmed" | "declined";
    };

const RATE_LIMIT_SCOPE = "invitation_view";

/**
 * Mensajes que no permiten enumerar tokens (sección 12 del prompt): un
 * token con formato válido pero inexistente da exactamente el mismo
 * resultado "invalid" que uno con formato roto.
 */
export async function getInvitationByToken(token: string, ip: string): Promise<InvitationPublicView> {
  const rate = await checkPublicLinkRateLimit(RATE_LIMIT_SCOPE, token, ip, { perIdentifierLimit: 30 });
  if (!rate.allowed) return { kind: "rate_limited" };

  const db = await getDb();
  const tokenHash = hashInvitationToken(token);

  const row = await db
    .selectFrom("meeting_invitations")
    .innerJoin("meetings", "meetings.id", "meeting_invitations.meeting_id")
    .innerJoin("people", "people.id", "meeting_invitations.person_id")
    .select([
      "meetings.id as meeting_id",
      "meetings.name as meeting_name",
      "meetings.starts_at",
      "meetings.ends_at",
      "meetings.location_name",
      "meetings.address",
      "meetings.status as meeting_status",
      "people.id as person_id",
      "people.first_name",
      "meeting_invitations.response_status",
      "meeting_invitations.withdrawn_at",
    ])
    .where("meeting_invitations.token_hash", "=", tokenHash)
    .executeTakeFirst();

  await recordPublicLinkAttempt(RATE_LIMIT_SCOPE, token, ip, !!row);

  if (!row || row.withdrawn_at) return { kind: "invalid" };
  if (row.meeting_status === "cancelled") return { kind: "cancelled" };
  if (row.meeting_status === "finished") return { kind: "finished" };
  if (!isPubliclyRespondable(row.meeting_status) && row.meeting_status !== "in_progress") return { kind: "invalid" };
  if (row.meeting_status === "in_progress") {
    const attendance = await db
      .selectFrom("meeting_attendance")
      .select(["checked_in_at"])
      .where("meeting_id", "=", row.meeting_id)
      .where("person_id", "=", row.person_id)
      .executeTakeFirst();
    return {
      kind: "checkin",
      meetingName: row.meeting_name,
      firstName: row.first_name,
      alreadyCheckedIn: !!attendance,
      checkedInAt: attendance?.checked_in_at ?? null,
    };
  }

  // Las invitaciones públicas solo existen para reuniones con fecha y hora reales.
  if (!row.starts_at || !row.ends_at) return { kind: "invalid" };

  return {
    kind: "ok",
    meetingName: row.meeting_name,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    locationName: row.location_name,
    address: row.address,
    firstName: row.first_name,
    responseStatus: row.response_status,
  };
}

export type RespondResult = { ok: true } | { ok: false; reason: "invalid" | "locked" | "rate_limited" };

export async function respondToInvitation(
  token: string,
  response: "confirmed" | "declined",
  ip: string
): Promise<RespondResult> {
  const rate = await checkPublicLinkRateLimit("invitation_respond", token, ip, { perIdentifierLimit: 15 });
  if (!rate.allowed) return { ok: false, reason: "rate_limited" };

  const db = await getDb();
  const tokenHash = hashInvitationToken(token);

  const row = await db
    .selectFrom("meeting_invitations")
    .innerJoin("meetings", "meetings.id", "meeting_invitations.meeting_id")
    .select(["meeting_invitations.id", "meeting_invitations.meeting_id", "meetings.status as meeting_status", "meeting_invitations.withdrawn_at"])
    .where("meeting_invitations.token_hash", "=", tokenHash)
    .executeTakeFirst();

  if (!row || row.withdrawn_at) {
    await recordPublicLinkAttempt("invitation_respond", token, ip, false);
    return { ok: false, reason: "invalid" };
  }
  if (!isPubliclyRespondable(row.meeting_status)) {
    await recordPublicLinkAttempt("invitation_respond", token, ip, false);
    return { ok: false, reason: "locked" };
  }

  await db
    .updateTable("meeting_invitations")
    .set({ response_status: response, responded_at: new Date() })
    .where("id", "=", row.id)
    .execute();

  await recordPublicLinkAttempt("invitation_respond", token, ip, true);


  return { ok: true };
}

export type CheckinByTokenResult =
  | { ok: true; checkedInAt: Date }
  | { ok: false; reason: "invalid" | "not_active" | "rate_limited" };

/**
 * Prioridad 1 de identificación (sección 12.2): la persona ya está
 * identificada por su enlace personal de invitación, así que solo hace
 * falta un botón de confirmación, sin pedirle de nuevo DNI/apellido.
 */
export async function checkInByInvitationToken(token: string, ip: string, userAgent: string | undefined): Promise<CheckinByTokenResult> {
  const rate = await checkPublicLinkRateLimit("invitation_checkin", token, ip, { perIdentifierLimit: 20 });
  if (!rate.allowed) return { ok: false, reason: "rate_limited" };

  const db = await getDb();
  const tokenHash = hashInvitationToken(token);

  const row = await db
    .selectFrom("meeting_invitations")
    .select(["meeting_id", "person_id", "withdrawn_at"])
    .where("token_hash", "=", tokenHash)
    .executeTakeFirst();

  if (!row || row.withdrawn_at) {
    await recordPublicLinkAttempt("invitation_checkin", token, ip, false);
    return { ok: false, reason: "invalid" };
  }

  const result = await checkInWithInvitationToken(row.meeting_id, row.person_id, ip, userAgent);
  await recordPublicLinkAttempt("invitation_checkin", token, ip, result.kind === "ok" || result.kind === "already_checked_in");

  if (result.kind === "ok" || result.kind === "already_checked_in") {
    return { ok: true, checkedInAt: result.checkedInAt };
  }
  if (result.kind === "not_active") return { ok: false, reason: "not_active" };
  return { ok: false, reason: "invalid" };
}
