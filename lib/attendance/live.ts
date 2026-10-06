import { getDb } from "../db/client.js";
import type { SessionUser } from "../permissions/can.js";
import { canAccessMeeting, isUuid, orgScope } from "../scope/organizations.js";
import { sql } from "kysely";
import { ATTENDANCE_ACTIVE } from "../activities/metrics.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/attendance/live.ts");

export interface LivePanelData {
  invited: number;
  confirmed: number;
  present: number;
  /** Invitados vigentes que todavía no tienen asistencia registrada (no es una ausencia comprobada). */
  invitedNotArrived: number;
  pendingResponse: number;
  declined: number;
  attendanceRate: number | null; // invitados que asistieron / invitados
  arrived: Array<{ personId: string; firstName: string; lastName: string; checkedInAt: Date; method: string }>;
  confirmedNotArrived: Array<{ personId: string; firstName: string; lastName: string }>;
  pending: Array<{ personId: string; firstName: string; lastName: string }>;
  decliners: Array<{ personId: string; firstName: string; lastName: string }>;
}

/** Todo lo que muestra el panel en vivo se deriva de invitaciones/check-ins, nunca se guarda aparte (sección 6.2). */
/** null si la reunión no existe o está fuera del alcance del usuario. */
export async function getLivePanelData(actor: SessionUser, meetingId: string): Promise<LivePanelData | null> {
  if (!isUuid(meetingId)) return null;
  const db = await getDb();

  // Acceso, invitaciones y asistencia son independientes: una sola tanda (un round trip); sin acceso se descarta todo.
  const invitationsQuery = db
    .selectFrom("meeting_invitations")
    .innerJoin("people", "people.id", "meeting_invitations.person_id")
    .select([
      "people.id as person_id",
      "people.first_name",
      "people.last_name",
      "meeting_invitations.response_status",
    ])
    .where("meeting_invitations.meeting_id", "=", meetingId)
    .where("meeting_invitations.withdrawn_at", "is", null);

  const attendanceQuery = db
    .selectFrom("meeting_attendance")
    .select(["person_id", "checked_in_at", "method"])
    .where("meeting_id", "=", meetingId)
    .where(sql<boolean>`${ATTENDANCE_ACTIVE}`)
    .orderBy("checked_in_at", "asc");

  const [allowed, invitations, attendanceRows] = await Promise.all([canAccessMeeting(actor, meetingId), invitationsQuery.execute(), attendanceQuery.execute()]);
  if (!allowed) return null;
  const attendanceByPerson = new Map(attendanceRows.map((r) => [r.person_id, r]));

  const invited = invitations.length;
  const confirmed = invitations.filter((i) => i.response_status === "confirmed").length;
  const present = attendanceRows.length;
  const pendingResponse = invitations.filter((i) => i.response_status === "pending").length;
  const declined = invitations.filter((i) => i.response_status === "declined").length;
  const invitedNotArrived = invitations.filter((i) => !attendanceByPerson.has(i.person_id)).length;
  const invitedArrived = invited - invitedNotArrived;

  const arrived = attendanceRows.map((r) => {
    const inv = invitations.find((i) => i.person_id === r.person_id);
    return {
      personId: r.person_id,
      firstName: inv?.first_name ?? "",
      lastName: inv?.last_name ?? "",
      checkedInAt: r.checked_in_at,
      method: r.method,
    };
  });

  const confirmedNotArrived = invitations
    .filter((i) => i.response_status === "confirmed" && !attendanceByPerson.has(i.person_id))
    .map((i) => ({ personId: i.person_id, firstName: i.first_name, lastName: i.last_name }));

  const pending = invitations
    .filter((i) => i.response_status === "pending")
    .map((i) => ({ personId: i.person_id, firstName: i.first_name, lastName: i.last_name }));

  const decliners = invitations
    .filter((i) => i.response_status === "declined")
    .map((i) => ({ personId: i.person_id, firstName: i.first_name, lastName: i.last_name }));

  return {
    invited,
    confirmed,
    present,
    invitedNotArrived,
    pendingResponse,
    declined,
    attendanceRate: invited > 0 ? Math.round((invitedArrived / invited) * 100) : null,
    arrived,
    confirmedNotArrived,
    pending,
    decliners,
  };
}

export interface QuickSearchResult {
  personId: string;
  firstName: string;
  lastName: string;
  invited: boolean;
  checkedIn: boolean;
}

/** Búsqueda rápida por nombre/DNI para acreditar a mano desde el panel (sección 12.3). */
export async function quickSearchForAccreditation(
  actor: SessionUser,
  meetingId: string,
  search: string
): Promise<QuickSearchResult[]> {
  const term = search.trim();
  if (term.length < 2) return [];
  if (!isUuid(meetingId)) return [];

  const db = await getDb();
  const pattern = `%${term.replace(/[\%_]/g, (ch) => `\${ch}`)}%`;

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
    db
      .selectFrom("meeting_attendance")
      .select("person_id")
      .where("meeting_id", "=", meetingId)
      .where("person_id", "in", ids)
      .where(sql<boolean>`${ATTENDANCE_ACTIVE}`)
      .execute(),
  ]);
  const invitedSet = new Set(invitations.map((i) => i.person_id));
  const checkedInSet = new Set(attendance.map((a) => a.person_id));

  return people.map((p) => ({
    personId: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    invited: invitedSet.has(p.id),
    checkedIn: checkedInSet.has(p.id),
  }));
}
