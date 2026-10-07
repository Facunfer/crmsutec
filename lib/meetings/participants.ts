import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { can, type SessionUser } from "../permissions/can.js";
import { canViewMeeting, isUuid, personInScope } from "../scope/organizations.js";
import { maskDni } from "../people/masking.js";
import { displayOf, loadOrgDisplayNames } from "../organizations/display.js";
import { ATTENDANCE_ACTIVE } from "../activities/metrics.js";
import { ATTENDANCE_METHOD_COPY, BASIS_COPY, type InvitationResponse, type ParticipationBasis, type PersonActivityFacts } from "../activities/labels.js";

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

/**
 * LEGACY DE PRESENTACIÓN: `status`/`statusLabel` colapsan los hechos en el «más fuerte». Las pantallas NO los muestran desde B1
 * (usan `facts`); se conservan por compatibilidad con consumidores existentes (p. ej. la actividad de la persona, que B5 reemplaza).
 */
/** Sufijo para «participated» SOLO en la sección de campaña (sin jornada determinada): nunca se asigna una fecha arbitraria. */
export const PARTICIPATED_WITHOUT_MEETING_SUFFIX = " — jornada no determinada";

// Cuanto mayor, más fuerte: lo que se muestra cuando una persona tiene varias fuentes.
const STRENGTH: Record<ParticipantStatus, number> = { attended: 70, participated: 65, approved: 60, absent: 50, registered: 40, confirmed: 35, declined: 30, invited: 20, pending: 10 };

/** La inscripción de la persona en esta actividad (B4). Solo trae nombres de usuarios y motivos si quien mira puede gestionar inscripciones. */
export interface RegistrationInfo {
  participationId: string;
  /** Vigente = no anulada. Una anulada solo se informa a quien gestiona inscripciones. */
  active: boolean;
  /** Cargada desde el CRM por un operador (false = importada: sin operador, fecha ni canal). */
  operative: boolean;
  /** Nacida de «Inscribir aceptados» (invitación de origen). */
  fromAcceptance: boolean;
  originChannel: string | null;
  registeredAt: Date | null;
  registeredAtPrecision: "exact_datetime" | "date_only" | null;
  voidedAt: Date | null;
  voidReason: string | null;
  recordedByName: string | null;
}

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
  /** Hechos independientes de la persona en esta actividad (lo que muestra la UI). */
  facts: PersonActivityFacts;
  /** Detalle de la inscripción (null si no tiene). Los hechos `facts.registered` cuentan solo la VIGENTE. */
  registration: RegistrationInfo | null;
  /** Procedencia en lenguaje humano, una frase por hecho («Participación histórica inicial», «Inscripción según listado importado»…). */
  provenance: string[];
  /** Referencias técnicas de la fuente (códigos de listado importado): solo como detalle, nunca como texto principal. */
  technicalRefs: string[];
}

export interface MeetingParticipants {
  /** Vinculados a ESTA jornada. */
  assigned: MeetingParticipant[];
  /** Participaciones de la campaña a la que pertenece la actividad SIN jornada probada (no se asignan a ninguna). */
  campaign: { key: string; name: string; participants: MeetingParticipant[] } | null;
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
  src: "participation" | "invitation" | "attendance";
  /** participation_kind crudo (solo src = participation). */
  raw_kind: string | null;
  basis: ParticipationBasis | null;
  response: InvitationResponse | null;
  imported: boolean | null;
  tech_ref: string | null;
  method: string | null;
  // Inscripción (solo filas de meeting_participations)
  participation_id?: string;
  voided?: boolean;
  voided_at?: Date | null;
  void_reason?: string | null;
  operative?: boolean;
  from_acceptance?: boolean;
  recorder_name?: string | null;
  origin_channel?: string | null;
  registered_at?: Date | null;
  registered_precision?: "exact_datetime" | "date_only" | null;
}

export const PEOPLE_COLUMNS = sql`
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

const emptyFacts = (): PersonActivityFacts => ({ invited: false, response: null, registered: false, participated: false, participationBases: [], attended: false });

/** Acumula en `facts`/`provenance` lo que aporta UNA fuente. Cada hecho es independiente: ninguno infiere a otro. */
function accumulateFact(m: Pick<MeetingParticipant, "facts" | "provenance" | "technicalRefs" | "registration">, r: RawRow): void {
  const add = (text: string) => { if (!m.provenance.includes(text)) m.provenance.push(text); };
  if (r.src === "invitation") {
    m.facts.invited = true;
    m.facts.response = r.response;
    add("Invitación");
  } else if (r.src === "attendance") {
    m.facts.attended = true;
    m.facts.participated = true; // regla derivada: Asistió ⊆ Participó (sin fila física en meeting_participations)
    add(ATTENDANCE_METHOD_COPY[r.method ?? ""] ?? "Asistencia comprobada");
  } else if (r.raw_kind === "registration") {
    m.registration = {
      participationId: r.participation_id!,
      active: !r.voided,
      operative: !!r.operative,
      fromAcceptance: !!r.from_acceptance,
      originChannel: r.origin_channel ?? null,
      registeredAt: r.registered_at ?? null,
      registeredAtPrecision: r.registered_precision ?? null,
      voidedAt: r.voided_at ?? null,
      voidReason: r.void_reason ?? null,
      recordedByName: r.recorder_name ?? null,
    };
    if (r.voided) {
      // Una inscripción anulada NO es un hecho vigente: sin chip activo.
      add("Inscripción anulada");
    } else {
      m.facts.registered = true;
      add(r.operative ? (r.from_acceptance ? "Inscripción desde la aceptación de la invitación" : "Inscripción cargada en el CRM") : r.imported ? "Inscripción según listado importado" : "Inscripción registrada en el sistema");
    }
  } else if (r.raw_kind === "participated" || r.raw_kind === "attended") {
    m.facts.participated = true;
    const basis = r.basis ?? "standard";
    if (!m.facts.participationBases.includes(basis)) m.facts.participationBases.push(basis);
    add(r.raw_kind === "attended" ? "Participación con evidencia registrada" : BASIS_COPY[basis]);
  }
  if (r.tech_ref && !m.technicalRefs.includes(r.tech_ref)) m.technicalRefs.push(r.tech_ref);
}

function merge(rows: RawRow[], canSeeSensitive: boolean, meetingDate: { date: Date | null; precision: MeetingParticipant["datePrecision"] }, names: ReadonlyMap<string, string>): MeetingParticipant[] {
  const byPerson = new Map<string, MeetingParticipant & { _strength: number }>();
  for (const r of rows) {
    const strength = STRENGTH[r.status];
    const current = byPerson.get(r.person_id);
    const origin = r.origin;
    if (current) accumulateFact(current, r);
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
        facts: emptyFacts(),
        registration: null,
        provenance: [],
        technicalRefs: [],
        _strength: strength,
      });
      accumulateFact(byPerson.get(r.person_id)!, r);
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
  if (!isUuid(meetingId)) return { assigned: [], campaign: null };

  const db = await getDb();
  const canSeeSensitive = can(actor, "people.view_sensitive");
  // Las inscripciones ANULADAS, con quién las cargó y el motivo, solo las ve quien gestiona inscripciones (temporal: manage_invitations).
  const canManageEnrollments = can(actor, "meetings.manage_invitations");

  // Todas estas lecturas son independientes entre sí: se lanzan juntas (un solo round trip en vez de ~8 en serie). La
  // visibilidad se evalúa en la misma tanda; si la reunión no es visible, lo leído se descarta y no se devuelve nada.
  // RIESGO TÉCNICO NO BLOQUEANTE: cada detalle abre ~8 consultas en paralelo y el pool de pg es de 10 conexiones (por defecto);
  // con mucha concurrencia las consultas harán cola (no fallan). Observar antes de tocar el pool; no se modifica en esta fase.
  // La campaña sale de meetings.campaign_id (0036) y su clave se resuelve DENTRO de la consulta de participantes de campaña,
  // sin lookup previo.
  const participationsQuery = sql<RawRow>`
    select ${PEOPLE_COLUMNS},
           case mp.participation_kind
             when 'attended' then 'attended' when 'participated' then 'participated' when 'approved' then 'approved' when 'absent' then 'absent'
             when 'registration' then (case when mp.voided_at is null then 'registered' else 'pending' end) when 'invited' then 'invited' else 'pending' end as status,
           coalesce('Importación ' || ir.source_file_code, 'Registro') as origin,
           null::timestamptz as at, null::text as at_precision,
           'participation' as src, mp.participation_kind as raw_kind, mp.participation_basis as basis, null::text as response,
           (mp.import_row_id is not null) as imported, ir.source_file_code as tech_ref, null::text as method,
           mp.id as participation_id, (mp.voided_at is not null) as voided, mp.voided_at,
           (case when ${canManageEnrollments}::boolean then mp.void_reason end) as void_reason,
           (mp.recorded_by is not null) as operative, (mp.origin_invitation_id is not null) as from_acceptance,
           (case when ${canManageEnrollments}::boolean then ru.full_name end) as recorder_name,
           mp.origin_channel, mp.registered_at, mp.registered_at_precision as registered_precision
    from meeting_participations mp
    join people p on p.id = mp.person_id
    left join import_rows ir on ir.id = mp.import_row_id
    left join users ru on ru.id = mp.recorded_by
    where mp.meeting_id = ${meetingId}::uuid and (mp.voided_at is null or ${canManageEnrollments}::boolean) and ${personInScope(actor, "p.id")}
  `.execute(db);

  const invitationsQuery = sql<RawRow>`
    select ${PEOPLE_COLUMNS},
           case when mi.response_status = 'confirmed' then 'confirmed'
                when mi.response_status = 'declined' then 'declined'
                else 'invited' end as status,
           'Invitación' as origin, null::timestamptz as at, null::text as at_precision,
           'invitation' as src, null::text as raw_kind, null::text as basis, mi.response_status as response,
           null::boolean as imported, null::text as tech_ref, null::text as method
    from meeting_invitations mi
    join people p on p.id = mi.person_id
    where mi.meeting_id = ${meetingId}::uuid and mi.withdrawn_at is null and ${personInScope(actor, "p.id")}
  `.execute(db);

  const attendanceQuery = sql<RawRow & { method: string }>`
    select ${PEOPLE_COLUMNS}, 'attended' as status, ma.method, ma.checked_in_at as at, 'exact_datetime'::text as at_precision,
           'attendance' as src, null::text as raw_kind, null::text as basis, null::text as response,
           null::boolean as imported, null::text as tech_ref
    from meeting_attendance ma
    join people p on p.id = ma.person_id
    where ma.meeting_id = ${meetingId}::uuid and ${ATTENDANCE_ACTIVE} and ${personInScope(actor, "p.id")}
  `.execute(db);

  // Participantes GENERALES de la campaña: quedaron a nivel campaña, sin jornada probada. No se asignan a esta reunión.
  const campaignQuery = sql<RawRow>`
    select ${PEOPLE_COLUMNS},
           case mp.participation_kind
             when 'attended' then 'attended' when 'participated' then 'participated' when 'approved' then 'approved' when 'absent' then 'absent'
             when 'registration' then (case when mp.voided_at is null then 'registered' else 'pending' end) when 'invited' then 'invited' else 'pending' end as status,
           coalesce('Importación ' || ir.source_file_code, 'Registro') as origin,
           null::timestamptz as at, null::text as at_precision,
           'participation' as src, mp.participation_kind as raw_kind, mp.participation_basis as basis, null::text as response,
           (mp.import_row_id is not null) as imported, ir.source_file_code as tech_ref, null::text as method,
           mp.id as participation_id, (mp.voided_at is not null) as voided, mp.voided_at,
           (case when ${canManageEnrollments}::boolean then mp.void_reason end) as void_reason,
           (mp.recorded_by is not null) as operative, (mp.origin_invitation_id is not null) as from_acceptance,
           (case when ${canManageEnrollments}::boolean then ru.full_name end) as recorder_name,
           mp.origin_channel, mp.registered_at, mp.registered_at_precision as registered_precision
    from meeting_participations mp
    join people p on p.id = mp.person_id
    left join import_rows ir on ir.id = mp.import_row_id
    left join users ru on ru.id = mp.recorded_by
    where mp.meeting_id is null and (mp.voided_at is null or ${canManageEnrollments}::boolean)
      and mp.campaign_key = (select c.campaign_key from meetings mm join campaigns c on c.id = mm.campaign_id where mm.id = ${meetingId}::uuid)
      and ${personInScope(actor, "p.id")}
  `.execute(db);

  const meetingQuery = sql<{ schedule_precision: "exact_datetime" | "date_only" | "unknown"; event_date: Date | null; starts_at: Date | null; campaign_key: string | null; campaign_name: string | null }>`
    select m.schedule_precision, m.event_date, m.starts_at, c.campaign_key, c.name as campaign_name
    from meetings m left join campaigns c on c.id = m.campaign_id
    where m.id = ${meetingId}::uuid
  `.execute(db);

  const [visible, names, meetingRes, participations, invitations, attendance, campaignRows] = await Promise.all([
    canViewMeeting(actor, meetingId),
    loadOrgDisplayNames(db),
    meetingQuery,
    participationsQuery,
    invitationsQuery,
    attendanceQuery,
    campaignQuery,
  ]);
  const meeting = meetingRes.rows[0];
  if (!visible || !meeting) return { assigned: [], campaign: null };

  const meetingDate = {
    date: meeting.starts_at ?? meeting.event_date ?? null,
    precision: meeting.schedule_precision === "unknown" ? null : meeting.schedule_precision,
  };

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

  let campaign: MeetingParticipants["campaign"] = null;
  if (meeting.campaign_key) {
    // Sin jornada asignada no hay fecha de actividad que mostrar.
    const campaignParticipants = merge(campaignRows.rows, canSeeSensitive, { date: null, precision: null }, names);
    // Sin jornada determinada: nunca se le atribuye una de las fechas posibles. Solo cambia el texto, no el status.
    for (const p of campaignParticipants) if (p.status === "participated") p.statusLabel += PARTICIPATED_WITHOUT_MEETING_SUFFIX;
    campaign = { key: meeting.campaign_key, name: meeting.campaign_name!, participants: campaignParticipants };
  }

  return { assigned, campaign };
}
