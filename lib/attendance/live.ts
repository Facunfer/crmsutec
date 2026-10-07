import { getDb } from "../db/client.js";
import { can, type SessionUser } from "../permissions/can.js";
import { canAccessMeeting, isUuid, orgScope, personInScope } from "../scope/organizations.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/attendance/live.ts");

export interface LivePanelData {
  /** Estado de la reunión (decide si la carga manual puede decir «ahora»: solo en curso). */
  meetingStatus: string;
  /** El usuario puede registrar, revocar, restaurar y corregir (permiso temporal `meetings.attendance_manual`). */
  canManage: boolean;
  invited: number;
  confirmed: number;
  /** Asistencias VIGENTES (revoked_at IS NULL) de personas dentro del alcance. */
  present: number;
  /** Invitados vigentes que todavía no tienen asistencia registrada (no es una ausencia comprobada). */
  invitedNotArrived: number;
  pendingResponse: number;
  declined: number;
  attendanceRate: number | null; // invitados con asistencia registrada / invitados vigentes
  arrived: Array<{
    personId: string;
    firstName: string;
    lastName: string;
    /** Cuándo OCURRIÓ (null = se desconoce; solo en una carga manual). */
    checkedInAt: Date | null;
    precision: "exact_datetime" | "date_only" | "unknown";
    method: string;
    /** Cuándo guardó el CRM la asistencia. */
    recordedAt: Date;
  }>;
  /** Asistencias REVOCADAS (con quién/cuándo/por qué). Solo con permiso de gestión; vacío si no. */
  revoked: Array<{ personId: string; firstName: string; lastName: string; revokedAt: Date; reason: string }>;
  confirmedNotArrived: Array<{ personId: string; firstName: string; lastName: string }>;
  pending: Array<{ personId: string; firstName: string; lastName: string }>;
  decliners: Array<{ personId: string; firstName: string; lastName: string }>;
}

/**
 * Todo lo que muestra el panel se deriva de invitaciones y asistencia al momento, nunca se guarda aparte. Solo personas DENTRO
 * del alcance actual del usuario (estricto, como en las invitaciones: no se expone el nombre ni la asistencia de quien salió de
 * su alcance). null si la reunión no existe o está fuera del alcance.
 */
export async function getLivePanelData(actor: SessionUser, meetingId: string): Promise<LivePanelData | null> {
  if (!isUuid(meetingId)) return null;
  const db = await getDb();
  const canManage = can(actor, "meetings.attendance_manual");

  // Acceso, estado de la reunión, invitaciones y asistencia son independientes: una sola tanda (un round trip).
  const invitationsQuery = db
    .selectFrom("meeting_invitations")
    .innerJoin("people", "people.id", "meeting_invitations.person_id")
    .select(["people.id as person_id", "people.first_name", "people.last_name", "meeting_invitations.response_status"])
    .where("meeting_invitations.meeting_id", "=", meetingId)
    .where("meeting_invitations.withdrawn_at", "is", null)
    .where(personInScope(actor, "meeting_invitations.person_id"));

  const attendanceQuery = db
    .selectFrom("meeting_attendance")
    .innerJoin("people", "people.id", "meeting_attendance.person_id")
    .select([
      "people.id as person_id", "people.first_name", "people.last_name", "meeting_attendance.checked_in_at", "meeting_attendance.occurred_precision",
      "meeting_attendance.method", "meeting_attendance.recorded_at", "meeting_attendance.revoked_at", "meeting_attendance.revoke_reason",
    ])
    .where("meeting_attendance.meeting_id", "=", meetingId)
    .where(personInScope(actor, "meeting_attendance.person_id"))
    .orderBy("meeting_attendance.checked_in_at", "asc");

  const [allowed, meeting, invitations, attendanceRows] = await Promise.all([
    canAccessMeeting(actor, meetingId),
    db.selectFrom("meetings").select("status").where("id", "=", meetingId).executeTakeFirst(),
    invitationsQuery.execute(),
    attendanceQuery.execute(),
  ]);
  if (!allowed || !meeting) return null;

  const active = attendanceRows.filter((r) => r.revoked_at === null);
  const activeByPerson = new Set(active.map((r) => r.person_id));

  const invited = invitations.length;
  const confirmed = invitations.filter((i) => i.response_status === "confirmed").length;
  const pendingResponse = invitations.filter((i) => i.response_status === "pending").length;
  const declined = invitations.filter((i) => i.response_status === "declined").length;
  const invitedNotArrived = invitations.filter((i) => !activeByPerson.has(i.person_id)).length;
  const invitedArrived = invited - invitedNotArrived;

  const named = (i: { person_id: string; first_name: string; last_name: string }) => ({ personId: i.person_id, firstName: i.first_name, lastName: i.last_name });

  return {
    meetingStatus: meeting.status,
    canManage,
    invited,
    confirmed,
    present: active.length,
    invitedNotArrived,
    pendingResponse,
    declined,
    attendanceRate: invited > 0 ? Math.round((invitedArrived / invited) * 100) : null,
    arrived: active.map((r) => ({ ...named(r), checkedInAt: r.checked_in_at, precision: r.occurred_precision, method: r.method, recordedAt: r.recorded_at })),
    revoked: canManage
      ? attendanceRows.filter((r) => r.revoked_at !== null).map((r) => ({ ...named(r), revokedAt: r.revoked_at!, reason: r.revoke_reason ?? "" }))
      : [],
    confirmedNotArrived: invitations.filter((i) => i.response_status === "confirmed" && !activeByPerson.has(i.person_id)).map(named),
    pending: invitations.filter((i) => i.response_status === "pending").map(named),
    decliners: invitations.filter((i) => i.response_status === "declined").map(named),
  };
}

export interface QuickSearchResult {
  personId: string;
  firstName: string;
  lastName: string;
  invited: boolean;
  /** Tiene asistencia VIGENTE. */
  checkedIn: boolean;
  /** Tiene una asistencia REVOCADA (hay que restaurarla, no registrarla de nuevo). */
  revoked: boolean;
}

/** Búsqueda rápida por nombre/DNI para acreditar a mano desde el panel. Solo personas dentro del alcance del usuario. */
export async function quickSearchForAccreditation(
  actor: SessionUser,
  meetingId: string,
  search: string
): Promise<QuickSearchResult[]> {
  const term = search.trim();
  if (term.length < 2) return [];
  if (!isUuid(meetingId)) return [];

  const db = await getDb();
  const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

  // Acceso y búsqueda de personas son independientes: una sola tanda; sin acceso se descarta todo.
  const [allowed, people] = await Promise.all([
    canAccessMeeting(actor, meetingId),
    db
      .selectFrom("people")
      .select(["id", "first_name", "last_name"])
      .where("status", "=", "active")
      .where(orgScope(actor, "people.organization_id"))
      .where((eb) => eb.or([eb("first_name", "ilike", pattern), eb("last_name", "ilike", pattern), eb("dni", "ilike", pattern)]))
      .limit(15)
      .execute(),
  ]);
  if (!allowed || people.length === 0) return [];
  const ids = people.map((p) => p.id);

  const [invitations, attendance] = await Promise.all([
    db
      .selectFrom("meeting_invitations")
      .select("person_id")
      .where("meeting_id", "=", meetingId)
      .where("person_id", "in", ids)
      .where("withdrawn_at", "is", null)
      .execute(),
    db.selectFrom("meeting_attendance").select(["person_id", "revoked_at"]).where("meeting_id", "=", meetingId).where("person_id", "in", ids).execute(),
  ]);
  const invitedSet = new Set(invitations.map((i) => i.person_id));
  const activeSet = new Set(attendance.filter((a) => a.revoked_at === null).map((a) => a.person_id));
  const revokedSet = new Set(attendance.filter((a) => a.revoked_at !== null).map((a) => a.person_id));

  return people.map((p) => ({
    personId: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    invited: invitedSet.has(p.id),
    checkedIn: activeSet.has(p.id),
    revoked: revokedSet.has(p.id),
  }));
}
