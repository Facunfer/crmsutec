import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { can, type SessionUser } from "../permissions/can.js";
import { canViewMeeting, personInScope } from "../scope/organizations.js";
import { maskDni } from "../people/masking.js";
import { displayOf, loadOrgDisplayNames } from "../organizations/display.js";

assertServerOnly("lib/meetings/participants.ts");

/**
 * Participantes de una reunión, SIEMPRE desde las tablas de origen (no hay una segunda fuente de verdad):
 *   - meeting_participations (importadas o registradas): inscripción, invitación, asistencia, ausencia, aprobación;
 *   - meeting_invitations (vigentes): invitado / confirmó / declinó, y su asistencia declarada;
 *   - meeting_attendance: check-in real (QR / DNI / manual).
 *
 * Solo aparecen personas DENTRO del alcance del usuario (un usuario de un área no ve a los de otras áreas, aunque la
 * reunión sea de SUTECBA). Una persona con varias fuentes se muestra una vez, con su estado más fuerte y todas sus fuentes.
 *
 * Inscripción NO es asistencia: «Inscripto» y «Participó/asistió» son estados distintos.
 */

export type ParticipantStatus = "attended" | "participated" | "approved" | "absent" | "registered" | "confirmed" | "invited" | "declined" | "pending";

/**
 * «participated»: SOLO para participation_basis='legacy_initial_import' (carga histórica inicial de Gabriel, ver
 * lib/interactions/legacy-reconciliation.ts). Nunca reemplaza «Inscripto (no implica asistencia)» para inscripciones
 * estándar (actividades creadas normalmente en el CRM): esa etiqueta se conserva sin cambios para esas.
 */
export const PARTICIPANT_STATUS_LABEL: Record<ParticipantStatus, string> = {
  attended: "Participó / asistió",
  participated: "Participó",
  approved: "Aprobó",
  absent: "Ausente",
  registered: "Inscripto (no implica asistencia)",
  confirmed: "Confirmó que asistirá (no implica asistencia)",
  invited: "Invitado",
  declined: "Declinó",
  pending: "Pendiente / sin dato",
};

/** Sufijo para «participated» SOLO en la sección de campaña (sin jornada determinada): nunca se asigna una fecha arbitraria. */
export const PARTICIPATED_WITHOUT_MEETING_SUFFIX = " — jornada no determinada";

// Cuanto mayor, más fuerte: lo que se muestra cuando una persona tiene varias fuentes.
const STRENGTH: Record<ParticipantStatus, number> = { attended: 70, participated: 65, approved: 60, absent: 50, registered: 40, confirmed: 35, declined: 30, invited: 20, pending: 10 };

export interface MeetingParticipant {
  personId: string;
  firstName: string;
  lastName: string;
  /** Enmascarado sin people.view_sensitive. */
  dni: string | null;
  areaName: string | null;
  reparticionName: string | null;
  status: ParticipantStatus;
  statusLabel: string;
  /** De dónde sale el dato: «Importación F05», «Invitación», «Check-in (QR)», «Registro manual»… */
  origins: string[];
  /** Fecha cuando corresponde: la del check-in, o la de la actividad para quien participó. null si no hay fecha real. */
  date: Date | null;
  /** Precisión de esa fecha: solo día (date_only) o con hora. */
  datePrecision: "exact_datetime" | "date_only" | null;
}

export interface MeetingParticipants {
  /** Vinculados a ESTA jornada. */
  assigned: MeetingParticipant[];
  /** Participaciones de la campaña a la que pertenece la actividad SIN jornada probada (no se asignan a ninguna). */
  campaign: { key: string; participants: MeetingParticipant[] } | null;
}

interface RawRow {
  person_id: string;
  first_name: string;
  last_name: string;
  dni: string | null;
  area_name: string | null;
  reparticion_name: string | null;
  area_id: string | null;
  unit_id: string | null;
  status: ParticipantStatus;
  origin: string;
  at: Date | null;
  at_precision: "exact_datetime" | "date_only" | null;
}

const PEOPLE_COLUMNS = sql`
  p.id as person_id, p.first_name, p.last_name, p.dni,
  (select a.name from organizations a where a.id = public.organization_area_id(p.organization_id)) as area_name,
  (select case when o.parent_id is null then null else o.name end from organizations o where o.id = p.organization_id) as reparticion_name,
  public.organization_area_id(p.organization_id) as area_id,
  case when (select o.parent_id from organizations o where o.id = p.organization_id) is null then null else p.organization_id end as unit_id
`;

const ATTENDANCE_METHOD: Record<string, string> = {
  invitation_token: "Check-in (invitación)",
  dni: "Check-in (DNI)",
  email: "Check-in (email)",
  phone: "Check-in (teléfono)",
  manual: "Registro manual",
};

/** «ophthalmology:2026-03-10:canale» → campaña «ophthalmology:canale». Las capacitaciones («training:…») no tienen campaña. */
export function campaignKeyOfMeeting(sourceEventKey: string | null): string | null {
  if (!sourceEventKey) return null;
  const match = /^ophthalmology:(?:\d{4}-\d{2}-\d{2}|sin-fecha):(.+)$/.exec(sourceEventKey);
  return match ? `ophthalmology:${match[1]}` : null;
}

function merge(rows: RawRow[], canSeeSensitive: boolean, meetingDate: { date: Date | null; precision: MeetingParticipant["datePrecision"] }, names: ReadonlyMap<string, string>): MeetingParticipant[] {
  const byPerson = new Map<string, MeetingParticipant & { _strength: number }>();
  for (const r of rows) {
    const strength = STRENGTH[r.status];
    const current = byPerson.get(r.person_id);
    const origin = r.origin;
    if (!current) {
      byPerson.set(r.person_id, {
        personId: r.person_id,
        firstName: r.first_name,
        lastName: r.last_name,
        dni: canSeeSensitive ? r.dni : maskDni(r.dni),
        areaName: displayOf(names, r.area_id, r.area_name),
        reparticionName: r.reparticion_name === null ? null : displayOf(names, r.unit_id, r.reparticion_name),
        status: r.status,
        statusLabel: PARTICIPANT_STATUS_LABEL[r.status],
        origins: [origin],
        date: r.at,
        datePrecision: r.at_precision,
        _strength: strength,
      });
      continue;
    }
    if (!current.origins.includes(origin)) current.origins.push(origin);
    if (strength > current._strength) {
      current.status = r.status;
      current.statusLabel = PARTICIPANT_STATUS_LABEL[r.status];
      current._strength = strength;
    }
    if (r.at && (!current.date || r.status === "attended")) {
      current.date = r.at;
      current.datePrecision = r.at_precision;
    }
  }
  const out = [...byPerson.values()].map(({ _strength: _s, ...p }) => p);
  // Quien participó de verdad tiene la fecha de la actividad aunque la fuente no traiga otra (solo día si es date_only).
  for (const p of out) {
    if ((p.status === "attended" || p.status === "participated") && !p.date && meetingDate.date && meetingDate.precision) {
      p.date = meetingDate.date;
      p.datePrecision = meetingDate.precision;
    }
  }
  return out.sort((a, b) => a.lastName.localeCompare(b.lastName, "es") || a.firstName.localeCompare(b.firstName, "es"));
}

export async function listMeetingParticipants(actor: SessionUser, meetingId: string): Promise<MeetingParticipants> {
  if (!(await canViewMeeting(actor, meetingId))) return { assigned: [], campaign: null };

  const db = await getDb();
  const canSeeSensitive = can(actor, "people.view_sensitive");
  const names = await loadOrgDisplayNames(db);

  const meeting = await db
    .selectFrom("meetings")
    .select(["source_event_key", "schedule_precision", "event_date", "starts_at"])
    .where("id", "=", meetingId)
    .executeTakeFirst();
  if (!meeting) return { assigned: [], campaign: null };
  const meetingDate = {
    date: meeting.starts_at ?? meeting.event_date ?? null,
    precision: meeting.schedule_precision === "unknown" ? null : (meeting.schedule_precision as "exact_datetime" | "date_only"),
  };

  const participations = await sql<RawRow>`
    select ${PEOPLE_COLUMNS},
           case mp.participation_kind
             when 'attended' then 'attended' when 'participated' then 'participated' when 'approved' then 'approved' when 'absent' then 'absent'
             when 'registration' then 'registered' when 'invited' then 'invited' else 'pending' end as status,
           coalesce('Importación ' || ir.source_file_code, 'Registro') as origin,
           null::timestamptz as at, null::text as at_precision
    from meeting_participations mp
    join people p on p.id = mp.person_id
    left join import_rows ir on ir.id = mp.import_row_id
    where mp.meeting_id = ${meetingId}::uuid and ${personInScope(actor, "p.id")}
  `.execute(db);

  const invitations = await sql<RawRow>`
    select ${PEOPLE_COLUMNS},
           case when mi.attendance_status = 'attended' then 'attended'
                when mi.attendance_status = 'absent' then 'absent'
                when mi.response_status = 'confirmed' then 'confirmed'
                when mi.response_status = 'declined' then 'declined'
                else 'invited' end as status,
           'Invitación' as origin, null::timestamptz as at, null::text as at_precision
    from meeting_invitations mi
    join people p on p.id = mi.person_id
    where mi.meeting_id = ${meetingId}::uuid and mi.withdrawn_at is null and ${personInScope(actor, "p.id")}
  `.execute(db);

  const attendance = await sql<RawRow & { method: string }>`
    select ${PEOPLE_COLUMNS}, 'attended' as status, ma.method, ma.checked_in_at as at, 'exact_datetime'::text as at_precision
    from meeting_attendance ma
    join people p on p.id = ma.person_id
    where ma.meeting_id = ${meetingId}::uuid and ${personInScope(actor, "p.id")}
  `.execute(db);

  const assigned = merge(
    [
      ...participations.rows,
      ...invitations.rows,
      ...attendance.rows.map((r) => ({ ...r, origin: ATTENDANCE_METHOD[r.method] ?? "Check-in" })),
    ],
    canSeeSensitive,
    meetingDate,
    names
  );

  // Participantes GENERALES de la campaña: quedaron a nivel campaña, sin jornada probada. No se asignan a esta reunión.
  const campaignKey = campaignKeyOfMeeting(meeting.source_event_key);
  let campaign: MeetingParticipants["campaign"] = null;
  if (campaignKey) {
    const rows = await sql<RawRow>`
      select ${PEOPLE_COLUMNS},
             case mp.participation_kind
               when 'attended' then 'attended' when 'participated' then 'participated' when 'approved' then 'approved' when 'absent' then 'absent'
               when 'registration' then 'registered' when 'invited' then 'invited' else 'pending' end as status,
             coalesce('Importación ' || ir.source_file_code, 'Registro') as origin,
             null::timestamptz as at, null::text as at_precision
      from meeting_participations mp
      join people p on p.id = mp.person_id
      left join import_rows ir on ir.id = mp.import_row_id
      where mp.meeting_id is null and mp.campaign_key = ${campaignKey} and ${personInScope(actor, "p.id")}
    `.execute(db);
    // Sin jornada asignada no hay fecha de actividad que mostrar.
    const campaignParticipants = merge(rows.rows, canSeeSensitive, { date: null, precision: null }, names);
    // Sin jornada determinada: nunca se le atribuye una de las fechas posibles. Solo cambia el texto, no el status.
    for (const p of campaignParticipants) if (p.status === "participated") p.statusLabel += PARTICIPATED_WITHOUT_MEETING_SUFFIX;
    campaign = { key: campaignKey, participants: campaignParticipants };
  }

  return { assigned, campaign };
}
