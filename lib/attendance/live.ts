import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/attendance/live.ts");

export interface LivePanelData {
  invited: number;
  confirmed: number;
  present: number;
  absentSoFar: number;
  pendingResponse: number;
  declined: number;
  attendanceRate: number | null; // present / invited
  arrived: Array<{ personId: string; firstName: string; lastName: string; checkedInAt: Date; method: string }>;
  confirmedNotArrived: Array<{ personId: string; firstName: string; lastName: string }>;
  pending: Array<{ personId: string; firstName: string; lastName: string }>;
  decliners: Array<{ personId: string; firstName: string; lastName: string }>;
}

/** Todo lo que muestra el panel en vivo se deriva de invitaciones/check-ins, nunca se guarda aparte (sección 6.2). */
export async function getLivePanelData(meetingId: string): Promise<LivePanelData> {
  const db = await getDb();

  const invitations = await db
    .selectFrom("meeting_invitations")
    .innerJoin("people", "people.id", "meeting_invitations.person_id")
    .select([
      "people.id as person_id",
      "people.first_name",
      "people.last_name",
      "meeting_invitations.response_status",
      "meeting_invitations.attendance_status",
    ])
    .where("meeting_invitations.meeting_id", "=", meetingId)
    .where("meeting_invitations.withdrawn_at", "is", null)
    .execute();

  const attendanceRows = await db
    .selectFrom("meeting_attendance")
    .select(["person_id", "checked_in_at", "method"])
    .where("meeting_id", "=", meetingId)
    .orderBy("checked_in_at", "asc")
    .execute();
  const attendanceByPerson = new Map(attendanceRows.map((r) => [r.person_id, r]));

  const invited = invitations.length;
  const confirmed = invitations.filter((i) => i.response_status === "confirmed").length;
  const present = attendanceRows.length;
  const pendingResponse = invitations.filter((i) => i.response_status === "pending").length;
  const declined = invitations.filter((i) => i.response_status === "declined").length;
  const absentSoFar = invitations.filter((i) => i.attendance_status === "absent").length;

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
    absentSoFar,
    pendingResponse,
    declined,
    attendanceRate: invited > 0 ? Math.round((present / invited) * 100) : null,
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
export async function quickSearchForAccreditation(meetingId: string, search: string): Promise<QuickSearchResult[]> {
  const term = search.trim();
  if (term.length < 2) return [];

  const db = await getDb();
  const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

  const people = await db
    .selectFrom("people")
    .select(["id", "first_name", "last_name"])
    .where("status", "=", "active")
    .where((eb) => eb.or([eb("first_name", "ilike", pattern), eb("last_name", "ilike", pattern), eb("dni", "ilike", pattern)]))
    .limit(15)
    .execute();

  if (people.length === 0) return [];
  const ids = people.map((p) => p.id);

  const invitations = await db
    .selectFrom("meeting_invitations")
    .select("person_id")
    .where("meeting_id", "=", meetingId)
    .where("person_id", "in", ids)
    .where("withdrawn_at", "is", null)
    .execute();
  const invitedSet = new Set(invitations.map((i) => i.person_id));

  const attendance = await db
    .selectFrom("meeting_attendance")
    .select("person_id")
    .where("meeting_id", "=", meetingId)
    .where("person_id", "in", ids)
    .execute();
  const checkedInSet = new Set(attendance.map((a) => a.person_id));

  return people.map((p) => ({
    personId: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    invited: invitedSet.has(p.id),
    checkedIn: checkedInSet.has(p.id),
  }));
}
