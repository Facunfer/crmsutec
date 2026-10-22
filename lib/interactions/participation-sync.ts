import { sql, type Kysely, type Transaction } from "kysely";
import { assertServerOnly } from "../server-only.js";
import type { Database } from "../db/schema.js";

assertServerOnly("lib/interactions/participation-sync.ts");

type Db = Kysely<Database> | Transaction<Database>;

/**
 * Interacción AUTOMÁTICA por participación real.
 *
 * Regla: si una persona PARTICIPÓ de verdad de una actividad (capacitación, operativo, jornada, reunión), su ficha
 * recibe una interacción «Participó en …», con la fecha real de la actividad y la fuente de origen. Esa interacción
 * cuenta para la última interacción, el semáforo y los KPIs.
 *
 * Qué cuenta como «participó de verdad» (y nada más):
 *   - meeting_participations con participation_kind = 'attended' (exige evidencia, migración 0021) y una jornada concreta;
 *   - meeting_participations con participation_kind = 'participated' y participation_basis = 'legacy_initial_import'
 *     (migración 0028): decisión de negocio EXCLUSIVA de la carga histórica inicial de Gabriel — «inscripto» en esas
 *     fuentes se considera participación. Los importadores y el reconciliador restringen su uso por procedencia;
 *     el CHECK de 0028 valida la combinación de estado/base, no la procedencia. Ver legacy-reconciliation.ts;
 *   (La asistencia — meeting_attendance — NO genera interacciones desde B3: ver el punto 2 del cuerpo de la función.)
 * Una INSCRIPCIÓN estándar (participation_basis='standard'), una invitación o una confirmación NO generan
 * interacción: no se reinterpretan como asistencia. Una participación de campaña sin jornada determinada (meeting_id
 * nulo) tampoco: el JOIN con `meetings` la excluye siempre, aunque sea 'participated'.
 *
 * Fecha: la de la actividad. Si solo se conoce el día (`date_only`), la interacción es `date_only` (occurred_at = inicio
 * de ese día en Buenos Aires, sin hora inventada). Actividades sin fecha (`unknown`) no generan interacción todavía:
 * se informan como omitidas y se generan cuando la actividad tenga fecha (la función es idempotente).
 *
 * Idempotencia: cada interacción lleva `source_key` = «meeting_participation:<id>» (UNIQUE): reprocesar una reunión no duplica.
 *
 * Propietaria de la interacción (owner_organization_id): la unidad de la persona (así la ve su área) y, si la persona no
 * tiene unidad, la propietaria de la actividad. Autor (created_by): el actor; si no hay (check-in público), el
 * organizador o el creador de la reunión.
 */
export interface ParticipationSyncScope {
  /** Exact participation scope for import/maintenance; [] means no work, never global. Excludes attendance. */
  participationIds?: readonly string[];
  meetingId?: string;
  personId?: string;
  /** Quien dispara la sincronización. Sin él (check-in público) se usa el organizador o el creador de la reunión. */
  actorUserId?: string | null;
}

export interface ParticipationSyncResult {
  created: number;
  reactivated: number;
  voided: number;
  /** Participaciones reales cuya actividad no tiene fecha: todavía no generan interacción. */
  skippedWithoutDate: number;
}

export const BA_TIMEZONE = "America/Argentina/Buenos_Aires";

/** Texto de la interacción según el tipo de actividad (sin datos personales). */
export const PARTICIPATION_SUBJECT = sql`case m.meeting_type
    when 'capacitacion' then 'Participó en capacitación: ' || m.name
    when 'operativo_salud' then 'Participó en operativo de salud: ' || m.name
    when 'jornada' then 'Participó en jornada: ' || m.name
    else 'Participó en: ' || m.name end`;

/** Texto de la interacción por ASISTENCIA (check-in real), según el tipo de actividad (sin datos personales). */
export const ATTENDANCE_SUBJECT = sql`case m.meeting_type
    when 'capacitacion' then 'Asistió a capacitación: ' || m.name
    when 'operativo_salud' then 'Asistió a operativo de salud: ' || m.name
    when 'jornada' then 'Asistió a jornada: ' || m.name
    when 'reunion' then 'Asistió a reunión: ' || m.name
    else 'Asistió a: ' || m.name end`;

export const PARTICIPATION_OCCURRED_AT = sql`case when m.schedule_precision = 'exact_datetime' then m.starts_at
       else (m.event_date::timestamp at time zone ${sql.lit(BA_TIMEZONE)}) end`;

export const PARTICIPATION_PRECISION = sql`case when m.schedule_precision = 'exact_datetime' then 'exact_datetime' else 'date_only' end`;

// Actividad con fecha real: hora exacta o solo día. Las `unknown` quedan afuera.
export const PARTICIPATION_HAS_DATE = sql`(m.schedule_precision = 'exact_datetime' and m.starts_at is not null)
    or (m.schedule_precision = 'date_only' and m.event_date is not null)`;

/**
 * Qué cuenta como «participación real» para generar una interacción, a nivel `meeting_participations`:
 *   - 'attended' (flujo estándar: exige evidencia, migración 0021);
 *   - 'participated' con participation_basis='legacy_initial_import' (decisión de negocio de la carga histórica
 *     inicial, migración 0028: ver lib/interactions/legacy-reconciliation.ts). El CHECK valida la combinación;
 *     los importadores y el reconciliador controlan que el origen sea el histórico autorizado.
 * En ambos casos exige jornada (`meeting_id` no nulo, vía el JOIN con `meetings`) y fecha real (`HAS_DATE`):
 * una participación de campaña sin jornada determinada NUNCA genera una interacción con fecha inventada.
 */
const REAL_PARTICIPATION_KIND = sql`(mp.participation_kind = 'attended' or (mp.participation_kind = 'participated' and mp.participation_basis = 'legacy_initial_import'))`;

const BA = BA_TIMEZONE;
const SUBJECT = PARTICIPATION_SUBJECT;
const OCCURRED_AT = PARTICIPATION_OCCURRED_AT;
const PRECISION = PARTICIPATION_PRECISION;
const HAS_DATE = PARTICIPATION_HAS_DATE;

export async function syncParticipationInteractions(db: Db, scope: ParticipationSyncScope = {}): Promise<ParticipationSyncResult> {
  const meetingFilter = scope.meetingId ? sql`and m.id = ${scope.meetingId}::uuid` : sql``;
  const personFilter = scope.personId ? sql`and p.id = ${scope.personId}::uuid` : sql``;
  const actor = scope.actorUserId ?? null;
  const participationFilter = scope.participationIds === undefined ? sql`` : sql`and mp.id = any(${[...scope.participationIds]}::uuid[])`;

  const typeRow = await sql<{ id: string }>`select id from interaction_types where key = 'participation'`.execute(db);
  const typeId = typeRow.rows[0]?.id;
  if (!typeId) throw new Error("Falta el tipo de interacción «participation» (migración 0024).");

  // 1. Participaciones confirmadas (importadas o registradas) con jornada y fecha.
  const fromParticipations = await sql<{ id: string }>`
    insert into person_interactions
      (person_id, owner_organization_id, occurred_at, occurred_precision, interaction_type_id, subject, status, meeting_id, created_by, source_key)
    select p.id, coalesce(p.organization_id, m.owner_organization_id), ${OCCURRED_AT}, ${PRECISION}, ${typeId}::uuid, ${SUBJECT}, 'completed', m.id,
           coalesce(${actor}::uuid, m.organizer_user_id, m.created_by), 'meeting_participation:' || mp.id
    from meeting_participations mp
    join meetings m on m.id = mp.meeting_id
    join people p on p.id = mp.person_id
    where ${REAL_PARTICIPATION_KIND} and (${HAS_DATE}) ${meetingFilter} ${personFilter} ${participationFilter}
      and coalesce(${actor}::uuid, m.organizer_user_id, m.created_by) is not null
    on conflict (source_key) where source_key is not null do nothing
    returning id
  `.execute(db);

  if (scope.participationIds !== undefined) {
    const skipped = await sql<{ n: number }>`select count(*)::int n from meeting_participations mp
      join meetings m on m.id=mp.meeting_id join people p on p.id=mp.person_id
      where ${REAL_PARTICIPATION_KIND} and not (${HAS_DATE}) ${meetingFilter} ${personFilter} ${participationFilter}`.execute(db);
    return { created: fromParticipations.rows.length, reactivated: 0, voided: 0, skippedWithoutDate: Number(skipped.rows[0]?.n ?? 0) };
  }

  // 2. La ASISTENCIA (meeting_attendance) SÍ genera interacciones (decisión del titular, 22/10/2026; revierte la «Opción B» de B3): escanear el
  //    QR, usar el enlace personal o cargar la asistencia a mano deja «Asistió a…» en la ficha. Ver syncAttendanceInteractions.
  const fromAttendance = await syncAttendanceInteractions(db, { meetingId: scope.meetingId, personId: scope.personId, actorUserId: scope.actorUserId });

  const skipped = await sql<{ n: number }>`
    select count(*)::int as n
    from meeting_participations mp
    join meetings m on m.id = mp.meeting_id
    join people p on p.id = mp.person_id
    where ${REAL_PARTICIPATION_KIND} and not (${HAS_DATE}) ${meetingFilter} ${personFilter}
  `.execute(db);

  return {
    created: fromParticipations.rows.length + fromAttendance.created,
    reactivated: fromAttendance.reactivated,
    voided: fromAttendance.voided,
    skippedWithoutDate: Number(skipped.rows[0]?.n ?? 0),
  };
}

export interface AttendanceSyncScope {
  /** Asistencias puntuales (las que acaba de escribir un check-in o una carga manual). [] = nada que hacer, nunca «todo». */
  attendanceIds?: readonly string[];
  meetingId?: string;
  personId?: string;
  /** Autor de las interacciones nuevas. Sin él: quien cargó la asistencia a mano, el organizador o el creador de la reunión. */
  actorUserId?: string | null;
}

export interface AttendanceSyncResult {
  created: number;
  reactivated: number;
  voided: number;
  /** Interacciones existentes cuya fecha se actualizó porque se corrigió la hora de la asistencia manual. */
  updated: number;
}

const REVOKED_REASON = "La asistencia fue revocada";

/**
 * Interacción AUTOMÁTICA por ASISTENCIA (Etapa 1d). Una asistencia VIGENTE (`revoked_at IS NULL`) con fecha real (hora exacta o solo el día; la
 * `unknown` de una carga manual no inventa una fecha: no genera nada) deja una interacción «Asistió a …» con la fecha REAL del check-in.
 *   - Idempotente: `source_key = meeting_attendance:<id>` (UNIQUE parcial).
 *   - Revocar la asistencia ANULA la interacción (`voided`, con motivo); restaurarla la REACTIVA. Nunca se borra nada.
 *   - Corregir la hora de una asistencia manual actualiza la fecha de su interacción.
 *   - Si la persona ya tiene la interacción de una participación «asistió» de ESA misma actividad (carga histórica), no se suma otra.
 *   - Propietaria: la unidad de la persona (así la ve su área) o, si no tiene unidad, la de la actividad.
 * Se invoca DENTRO de la transacción que escribe la asistencia (check-in público y carga manual): o quedan las dos cosas o ninguna.
 */
export async function syncAttendanceInteractions(db: Db, scope: AttendanceSyncScope = {}): Promise<AttendanceSyncResult> {
  if (scope.attendanceIds !== undefined && scope.attendanceIds.length === 0) return { created: 0, reactivated: 0, voided: 0, updated: 0 };
  const attendanceFilter = scope.attendanceIds === undefined ? sql`` : sql`and ma.id = any(${[...scope.attendanceIds]}::uuid[])`;
  const meetingFilter = scope.meetingId ? sql`and m.id = ${scope.meetingId}::uuid` : sql``;
  const personFilter = scope.personId ? sql`and p.id = ${scope.personId}::uuid` : sql``;
  const actor = scope.actorUserId ?? null;
  const filters = sql`${attendanceFilter} ${meetingFilter} ${personFilter}`;

  const typeRow = await sql<{ id: string }>`select id from interaction_types where key = 'participation'`.execute(db);
  const typeId = typeRow.rows[0]?.id;
  if (!typeId) throw new Error("Falta el tipo de interacción «participation» (migración 0024).");

  const created = await sql<{ id: string }>`
    insert into person_interactions
      (person_id, owner_organization_id, occurred_at, occurred_precision, interaction_type_id, subject, status, meeting_id, created_by, source_key)
    select p.id, coalesce(p.organization_id, m.owner_organization_id), ma.checked_in_at, ma.occurred_precision, ${typeId}::uuid, ${ATTENDANCE_SUBJECT}, 'completed', m.id,
           coalesce(${actor}::uuid, ma.registered_by, m.organizer_user_id, m.created_by), 'meeting_attendance:' || ma.id
    from meeting_attendance ma
    join meetings m on m.id = ma.meeting_id
    join people p on p.id = ma.person_id
    where ma.revoked_at is null and ma.checked_in_at is not null and ma.occurred_precision in ('exact_datetime', 'date_only') ${filters}
      and not exists (
        select 1 from person_interactions x
        where x.person_id = ma.person_id and x.meeting_id = ma.meeting_id and x.source_key like 'meeting\\_participation:%' and x.status <> 'voided'
      )
      and coalesce(${actor}::uuid, ma.registered_by, m.organizer_user_id, m.created_by) is not null
    on conflict (source_key) where source_key is not null do nothing
    returning id
  `.execute(db);

  const voided = await sql<{ id: string }>`
    update person_interactions pi
    set status = 'voided', void_reason = ${REVOKED_REASON}, updated_at = now(), version = pi.version + 1
    from meeting_attendance ma
    join meetings m on m.id = ma.meeting_id
    join people p on p.id = ma.person_id
    where pi.source_key = 'meeting_attendance:' || ma.id and pi.status <> 'voided' and ma.revoked_at is not null ${filters}
    returning pi.id
  `.execute(db);

  const reactivated = await sql<{ id: string }>`
    update person_interactions pi
    set status = 'completed', void_reason = null, updated_at = now(), version = pi.version + 1
    from meeting_attendance ma
    join meetings m on m.id = ma.meeting_id
    join people p on p.id = ma.person_id
    where pi.source_key = 'meeting_attendance:' || ma.id and pi.status = 'voided' and pi.void_reason = ${REVOKED_REASON} and ma.revoked_at is null ${filters}
    returning pi.id
  `.execute(db);

  const updated = await sql<{ id: string }>`
    update person_interactions pi
    set occurred_at = ma.checked_in_at, occurred_precision = ma.occurred_precision, updated_at = now(), version = pi.version + 1
    from meeting_attendance ma
    join meetings m on m.id = ma.meeting_id
    join people p on p.id = ma.person_id
    where pi.source_key = 'meeting_attendance:' || ma.id and pi.status <> 'voided' and ma.revoked_at is null
      and ma.checked_in_at is not null and ma.occurred_precision in ('exact_datetime', 'date_only')
      and (pi.occurred_at <> ma.checked_in_at or pi.occurred_precision <> ma.occurred_precision) ${filters}
    returning pi.id
  `.execute(db);

  return { created: created.rows.length, reactivated: reactivated.rows.length, voided: voided.rows.length, updated: updated.rows.length };
}
