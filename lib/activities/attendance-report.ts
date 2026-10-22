import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { can, type SessionUser } from "../permissions/can.js";
import { isUuid, personInScope } from "../scope/organizations.js";
import { maskDni } from "../people/masking.js";
import { getActivityHub, type ActivityKind } from "./hub.js";
import { listAttendanceInteractionFacts } from "../interactions/queries.js";

assertServerOnly("lib/activities/attendance-report.ts");

/**
 * REGISTRO DE ASISTENCIA de una actividad (Etapa 1f): quiénes fueron y quiénes no, por fecha y por persona, con trazabilidad.
 *
 * Definiciones (una sola, acá; las pantallas y el CSV no calculan nada por su cuenta):
 *   - ESPERADOS de una fecha = personas con INSCRIPCIÓN VIGENTE (`registration`, `voided_at IS NULL`, B4) en esa reunión. La respuesta al
 *     formulario inscribe (1c); un operador también puede inscribir.
 *   - ASISTIERON = personas con ASISTENCIA VIGENTE (`meeting_attendance.revoked_at IS NULL`, B3) en esa reunión.
 *   - AUSENTES = esperados que no asistieron.
 *   - SIN INSCRIPCIÓN = asistieron sin estar inscriptos (solo si la reunión permite el check-in sin invitación).
 * Todo es DISTINCT person_id dentro del ALCANCE del usuario (`personInScope`): quien mira solo cuenta y ve a las personas de su órbita.
 */

export type AttendanceCell = "attended" | "absent" | "walk_in" | "none";

export interface DateAttendanceSummary {
  meetingId: string;
  number: number;
  name: string;
  startsAt: Date | null;
  expected: number;
  attended: number;
  absent: number;
  walkIns: number;
  /** % de esperados que asistieron (0–100, un decimal); null si no hay esperados. */
  attendanceRate: number | null;
}

export interface AttendanceTotals {
  /** Personas distintas esperadas en al menos una fecha. */
  expectedPeople: number;
  /** De esas, las que asistieron al menos una vez. */
  expectedAttendedAny: number;
  /** De esas, las que NO asistieron a ninguna fecha. */
  expectedNeverAttended: number;
  /** Personas (esperadas o no) que asistieron a TODAS las fechas. */
  attendedAllDates: number;
  /** Personas que asistieron al menos una vez sin estar inscriptas en esa fecha. */
  walkInPeople: number;
  /** Respuestas de los formularios de la actividad que no se pudieron vincular a una persona (un operador decide). */
  unlinkedResponses: number;
}

export interface AttendanceRow {
  personId: string;
  firstName: string;
  lastName: string;
  /** Enmascarado sin people.view_sensitive. */
  dni: string | null;
  organizationName: string | null;
  /** Estado de la persona en cada fecha, por id de reunión. */
  cells: Record<string, AttendanceCell>;
  /** A cuántas fechas asistió. */
  attendedCount: number;
  /** En cuántas fechas estaba inscripta (esperada). */
  expectedCount: number;
}

export interface ActivityAttendanceReport {
  kind: ActivityKind;
  id: string;
  name: string;
  dates: DateAttendanceSummary[];
  totals: AttendanceTotals;
  rows: AttendanceRow[];
  totalRows: number;
  page: number;
  pageSize: number;
}

export interface AttendanceReportOptions {
  page?: number;
  pageSize?: number;
  /** Nombre, apellido o DNI (prefijo). */
  search?: string;
  /** Filtra las filas: solo ausentes (esperados que faltaron a alguna fecha), solo quienes asistieron, o solo quienes asistieron sin inscripción. */
  filter?: "all" | "absent" | "attended" | "walk_in";
}

export const ATTENDANCE_CELL_LABEL: Record<AttendanceCell, string> = {
  attended: "Asistió",
  absent: "Ausente",
  walk_in: "Asistió sin inscripción",
  none: "—",
};

const REGISTERED = sql`(r.participation_kind = 'registration' and r.voided_at is null)`;

export async function getAttendanceReport(actor: SessionUser, kind: ActivityKind, id: string, options: AttendanceReportOptions = {}): Promise<ActivityAttendanceReport | null> {
  const hub = await getActivityHub(actor, kind, id);
  if (!hub) return null;

  const page = Math.max(1, Math.trunc(options.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.trunc(options.pageSize ?? 50) || 50));
  const empty: ActivityAttendanceReport = {
    kind, id, name: hub.name, dates: [], page, pageSize, rows: [], totalRows: 0,
    totals: { expectedPeople: 0, expectedAttendedAny: 0, expectedNeverAttended: 0, attendedAllDates: 0, walkInPeople: 0, unlinkedResponses: 0 },
  };
  const meetingIds = hub.dates.map((d) => d.id);
  if (meetingIds.length === 0) return empty;

  const db = await getDb();
  const idsArray = sql`${meetingIds}::uuid[]`;
  const formIds = hub.forms.map((f) => f.id);

  // 1. Por fecha.
  const perDate = await sql<{ meeting_id: string; expected: number; attended: number; expected_attended: number }>`
    select m.id as meeting_id,
      (select count(distinct r.person_id)::int from meeting_participations r where r.meeting_id = m.id and ${REGISTERED} and ${personInScope(actor, "r.person_id")}) as expected,
      (select count(distinct a.person_id)::int from meeting_attendance a where a.meeting_id = m.id and a.revoked_at is null and ${personInScope(actor, "a.person_id")}) as attended,
      (select count(distinct r.person_id)::int from meeting_participations r where r.meeting_id = m.id and ${REGISTERED} and ${personInScope(actor, "r.person_id")}
         and exists (select 1 from meeting_attendance a where a.meeting_id = m.id and a.person_id = r.person_id and a.revoked_at is null)) as expected_attended
    from meetings m
    where m.id = any(${idsArray})
  `.execute(db);
  const byMeeting = new Map(perDate.rows.map((r) => [r.meeting_id, r]));
  const dates: DateAttendanceSummary[] = hub.dates.map((d) => {
    const r = byMeeting.get(d.id);
    const expected = Number(r?.expected ?? 0);
    const attended = Number(r?.attended ?? 0);
    const expectedAttended = Number(r?.expected_attended ?? 0);
    return {
      meetingId: d.id, number: d.number, name: d.name, startsAt: d.startsAt, expected, attended,
      absent: expected - expectedAttended, walkIns: attended - expectedAttended,
      attendanceRate: expected > 0 ? Math.round((expectedAttended / expected) * 1000) / 10 : null,
    };
  });

  // 2. Totales por persona distinta.
  const totalsRow = (
    await sql<{ expected_people: number; expected_attended_any: number; attended_all: number; walk_in_people: number; unlinked: number }>`
      with reg as (
        select distinct r.person_id from meeting_participations r where r.meeting_id = any(${idsArray}) and ${REGISTERED} and ${personInScope(actor, "r.person_id")}
      ), att as (
        select a.person_id, count(distinct a.meeting_id) as n from meeting_attendance a
        where a.meeting_id = any(${idsArray}) and a.revoked_at is null and ${personInScope(actor, "a.person_id")} group by a.person_id
      ), walk as (
        select distinct a.person_id from meeting_attendance a
        where a.meeting_id = any(${idsArray}) and a.revoked_at is null and ${personInScope(actor, "a.person_id")}
          and not exists (select 1 from meeting_participations r where r.meeting_id = a.meeting_id and r.person_id = a.person_id and ${REGISTERED})
      )
      select (select count(*)::int from reg) as expected_people,
             (select count(*)::int from reg join att using (person_id)) as expected_attended_any,
             (select count(*)::int from att where n = ${meetingIds.length}) as attended_all,
             (select count(*)::int from walk) as walk_in_people,
             ${formIds.length === 0 ? sql`0` : sql`(select count(*)::int from form_submissions fs where fs.form_id = any(${formIds}::uuid[]) and fs.person_id is null)`} as unlinked
    `.execute(db)
  ).rows[0]!;
  const totals: AttendanceTotals = {
    expectedPeople: Number(totalsRow.expected_people),
    expectedAttendedAny: Number(totalsRow.expected_attended_any),
    expectedNeverAttended: Number(totalsRow.expected_people) - Number(totalsRow.expected_attended_any),
    attendedAllDates: Number(totalsRow.attended_all),
    walkInPeople: Number(totalsRow.walk_in_people),
    unlinkedResponses: Number(totalsRow.unlinked),
  };

  // 3. Filas (personas) paginadas: esperadas o que asistieron, dentro del alcance.
  const search = options.search?.trim() ?? "";
  const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const searchFilter = search ? sql`and (p.first_name ilike ${like} or p.last_name ilike ${like} or p.dni like ${`${search.replace(/\D/g, "") || "no-dni"}%`})` : sql``;
  const filter = options.filter ?? "all";
  const filterSql =
    filter === "absent"
      ? sql`and exists (select 1 from meeting_participations r where r.meeting_id = any(${idsArray}) and r.person_id = p.id and ${REGISTERED}
              and not exists (select 1 from meeting_attendance a where a.meeting_id = r.meeting_id and a.person_id = p.id and a.revoked_at is null))`
      : filter === "attended"
        ? sql`and exists (select 1 from meeting_attendance a where a.meeting_id = any(${idsArray}) and a.person_id = p.id and a.revoked_at is null)`
        : filter === "walk_in"
          ? sql`and exists (select 1 from meeting_attendance a where a.meeting_id = any(${idsArray}) and a.person_id = p.id and a.revoked_at is null
                  and not exists (select 1 from meeting_participations r where r.meeting_id = a.meeting_id and r.person_id = p.id and ${REGISTERED}))`
          : sql``;
  const peopleBase = sql`
    from people p
    where (exists (select 1 from meeting_participations r where r.meeting_id = any(${idsArray}) and r.person_id = p.id and ${REGISTERED})
        or exists (select 1 from meeting_attendance a where a.meeting_id = any(${idsArray}) and a.person_id = p.id and a.revoked_at is null))
      and ${personInScope(actor, "p.id")} ${searchFilter} ${filterSql}
  `;
  const [countRow, personRows] = await Promise.all([
    sql<{ n: number }>`select count(*)::int as n ${peopleBase}`.execute(db),
    sql<{ id: string; first_name: string; last_name: string; dni: string | null; organization_name: string | null }>`
      select p.id, p.first_name, p.last_name, p.dni, (select o.name from organizations o where o.id = p.organization_id) as organization_name
      ${peopleBase}
      order by lower(p.last_name), lower(p.first_name), p.id
      limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(db),
  ]);

  const personIds = personRows.rows.map((r) => r.id);
  const cellRows =
    personIds.length === 0
      ? { rows: [] as Array<{ meeting_id: string; person_id: string; registered: boolean; attended: boolean }> }
      : await sql<{ meeting_id: string; person_id: string; registered: boolean; attended: boolean }>`
          select x.meeting_id, x.person_id,
                 exists (select 1 from meeting_participations r where r.meeting_id = x.meeting_id and r.person_id = x.person_id and ${REGISTERED}) as registered,
                 exists (select 1 from meeting_attendance a where a.meeting_id = x.meeting_id and a.person_id = x.person_id and a.revoked_at is null) as attended
          from (select m as meeting_id, p as person_id from unnest(${idsArray}) m cross join unnest(${personIds}::uuid[]) p) x
        `.execute(db);
  const cellsByPerson = new Map<string, Record<string, AttendanceCell>>();
  for (const c of cellRows.rows) {
    const cell: AttendanceCell = c.attended ? (c.registered ? "attended" : "walk_in") : c.registered ? "absent" : "none";
    const map = cellsByPerson.get(c.person_id) ?? {};
    map[c.meeting_id] = cell;
    cellsByPerson.set(c.person_id, map);
  }

  const seeSensitive = can(actor, "people.view_sensitive");
  const rows: AttendanceRow[] = personRows.rows.map((p) => {
    const cells = cellsByPerson.get(p.id) ?? {};
    const values = Object.values(cells);
    return {
      personId: p.id,
      firstName: p.first_name,
      lastName: p.last_name,
      dni: seeSensitive ? p.dni : maskDni(p.dni),
      organizationName: p.organization_name,
      cells,
      attendedCount: values.filter((v) => v === "attended" || v === "walk_in").length,
      expectedCount: values.filter((v) => v === "attended" || v === "absent").length,
    };
  });

  return { kind, id, name: hub.name, dates, totals, rows, totalRows: Number(countRow.rows[0]?.n ?? 0), page, pageSize };
}

/* ------------------------------------------------------------------------------------------------------------------------------------------
 * TRAZABILIDAD
 * ---------------------------------------------------------------------------------------------------------------------------------------- */

export interface TimelineEntry {
  at: Date;
  /** Texto en lenguaje humano. */
  label: string;
  /** Quién: un usuario, «El sistema (formulario)», o «La propia persona» (QR / enlace). */
  actor: string;
  reason: string | null;
  /** Fecha de la actividad a la que corresponde (campañas), si aplica. */
  dateNumber: number | null;
  source: "formulario" | "inscripción" | "asistencia" | "interacción";
}

const FORM_EVENT_LABEL: Record<string, string> = {
  auto_linked: "La respuesta al formulario se vinculó con la persona",
  auto_person_created: "Se creó la ficha de la persona desde el formulario",
  auto_data_applied: "Se completaron datos de la ficha desde el formulario",
  auto_enrolled: "Quedó inscripta automáticamente al responder el formulario",
  linked: "Un operador vinculó la respuesta con la persona",
  person_created: "Un operador creó la ficha desde la respuesta",
  data_applied: "Un operador aplicó datos de la respuesta a la ficha",
  enrolled: "Un operador inscribió a la persona desde su respuesta",
};
const REGISTRATION_EVENT_LABEL: Record<string, string> = {
  registered: "Inscripción registrada",
  voided: "Inscripción anulada",
  restored: "Inscripción restaurada",
  corrected: "Inscripción corregida",
};
const ATTENDANCE_EVENT_LABEL: Record<string, string> = {
  checked_in: "Asistencia registrada",
  revoked: "Asistencia revocada",
  restored: "Asistencia restaurada",
  corrected: "Hora de asistencia corregida",
};
const ATTENDANCE_METHOD_LABEL: Record<string, string> = {
  qr: "por QR",
  invitation_link: "por enlace personal",
  manual: "cargada a mano",
};

/**
 * Historia completa de UNA persona en una actividad, en orden cronológico: respuesta al formulario, inscripción, asistencia (con correcciones y
 * revocaciones) y la interacción resultante en su ficha. null si la actividad o la persona están fuera del alcance (no se distingue).
 */
export async function getPersonActivityTimeline(actor: SessionUser, kind: ActivityKind, id: string, personId: string): Promise<{ person: { id: string; firstName: string; lastName: string }; entries: TimelineEntry[] } | null> {
  if (!isUuid(personId)) return null;
  const hub = await getActivityHub(actor, kind, id);
  if (!hub) return null;
  const db = await getDb();
  const inScope = await sql<{ ok: boolean; first_name: string | null; last_name: string | null }>`
    select ${personInScope(actor, "p.id")} as ok, p.first_name, p.last_name from people p where p.id = ${personId}::uuid
  `.execute(db);
  const p = inScope.rows[0];
  if (!p || !p.ok) return null;

  const meetingIds = hub.dates.map((d) => d.id);
  const numberOf = new Map(hub.dates.map((d) => [d.id, hub.kind === "campana" ? d.number : null]));
  const formIds = hub.forms.map((f) => f.id);
  const entries: TimelineEntry[] = [];
  if (meetingIds.length === 0) return { person: { id: personId, firstName: p.first_name ?? "", lastName: p.last_name ?? "" }, entries };

  const [formEvents, registrationEvents, attendanceEvents, interactions] = await Promise.all([
    formIds.length === 0
      ? Promise.resolve({ rows: [] as Array<{ event_type: string; meeting_id: string | null; occurred_at: Date; actor: string | null; reason: string | null }> })
      : sql<{ event_type: string; meeting_id: string | null; occurred_at: Date; actor: string | null; reason: string | null }>`
          select e.event_type, e.meeting_id, e.occurred_at, u.full_name as actor, e.reason
          from form_submission_events e
          join form_submissions s on s.id = e.submission_id
          left join users u on u.id = e.recorded_by
          where e.person_id = ${personId}::uuid and s.form_id = any(${formIds}::uuid[])
        `.execute(db),
    sql<{ event_type: string; meeting_id: string; occurred_at: Date; actor: string | null; reason: string | null; origin_channel: string | null }>`
      select e.event_type, mp.meeting_id, e.occurred_at, u.full_name as actor, e.reason, e.origin_channel
      from meeting_registration_events e
      join meeting_participations mp on mp.id = e.participation_id
      left join users u on u.id = e.recorded_by
      where e.person_id = ${personId}::uuid and mp.meeting_id = any(${meetingIds}::uuid[])
    `.execute(db),
    sql<{ event_type: string; meeting_id: string; occurred_at: Date; actor: string | null; reason: string | null; attendance_method: string | null }>`
      select e.event_type, e.meeting_id, e.occurred_at, u.full_name as actor, e.reason, e.attendance_method
      from meeting_attendance_events e
      left join users u on u.id = e.recorded_by
      where e.person_id = ${personId}::uuid and e.meeting_id = any(${meetingIds}::uuid[])
    `.execute(db),
    listAttendanceInteractionFacts(personId, meetingIds),
  ]);

  for (const e of formEvents.rows) {
    entries.push({ at: e.occurred_at, label: FORM_EVENT_LABEL[e.event_type] ?? e.event_type, actor: e.actor ?? "El sistema (formulario)", reason: e.reason, dateNumber: e.meeting_id ? (numberOf.get(e.meeting_id) ?? null) : null, source: "formulario" });
  }
  for (const e of registrationEvents.rows) {
    const via = e.event_type === "registered" && e.origin_channel === "form" ? " (desde el formulario)" : "";
    entries.push({ at: e.occurred_at, label: `${REGISTRATION_EVENT_LABEL[e.event_type] ?? e.event_type}${via}`, actor: e.actor ?? "—", reason: e.reason, dateNumber: numberOf.get(e.meeting_id) ?? null, source: "inscripción" });
  }
  for (const e of attendanceEvents.rows) {
    const method = e.event_type === "checked_in" && e.attendance_method ? (ATTENDANCE_METHOD_LABEL[e.attendance_method] ?? "") : "";
    entries.push({ at: e.occurred_at, label: `${ATTENDANCE_EVENT_LABEL[e.event_type] ?? e.event_type}${method ? ` ${method}` : ""}`, actor: e.actor ?? "La propia persona", reason: e.reason, dateNumber: numberOf.get(e.meeting_id) ?? null, source: "asistencia" });
  }
  for (const i of interactions) {
    entries.push({ at: i.createdAt, label: "Se registró «Asistió a…» en la ficha de la persona", actor: "El sistema", reason: null, dateNumber: numberOf.get(i.meetingId) ?? null, source: "interacción" });
    if (i.status === "voided") {
      entries.push({ at: i.updatedAt, label: "La interacción «Asistió a…» se anuló", actor: "El sistema", reason: i.voidReason, dateNumber: numberOf.get(i.meetingId) ?? null, source: "interacción" });
    }
  }
  entries.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { person: { id: personId, firstName: p.first_name ?? "", lastName: p.last_name ?? "" }, entries };
}
