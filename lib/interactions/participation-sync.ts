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
 *   - meeting_attendance (check-in QR/DNI o registro manual) cuya invitación no fue corregida a «ausente».
 * Una INSCRIPCIÓN estándar (participation_basis='standard'), una invitación o una confirmación NO generan
 * interacción: no se reinterpretan como asistencia. Una participación de campaña sin jornada determinada (meeting_id
 * nulo) tampoco: el JOIN con `meetings` la excluye siempre, aunque sea 'participated'.
 *
 * Fecha: la de la actividad. Si solo se conoce el día (`date_only`), la interacción es `date_only` (occurred_at = inicio
 * de ese día en Buenos Aires, sin hora inventada). Actividades sin fecha (`unknown`) no generan interacción todavía:
 * se informan como omitidas y se generan cuando la actividad tenga fecha (la función es idempotente).
 *
 * Idempotencia: cada interacción lleva `source_key` = «meeting_participation:<id>» o «meeting_attendance:<id>» (UNIQUE):
 * reprocesar una reunión no duplica. Si un check-in se corrige a «ausente», su interacción se ANULA (voided, con motivo);
 * si se corrige de nuevo a «asistió», se reactiva.
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

  // 2. Check-in real (QR / DNI / manual) que no fue corregido a «ausente».
  const fromAttendance = await sql<{ id: string }>`
    insert into person_interactions
      (person_id, owner_organization_id, occurred_at, occurred_precision, interaction_type_id, subject, status, meeting_id, created_by, source_key)
    select p.id, coalesce(p.organization_id, m.owner_organization_id), ma.checked_in_at, 'exact_datetime', ${typeId}::uuid, ${SUBJECT}, 'completed', m.id,
           coalesce(${actor}::uuid, ma.registered_by, m.organizer_user_id, m.created_by), 'meeting_attendance:' || ma.id
    from meeting_attendance ma
    join meetings m on m.id = ma.meeting_id
    join people p on p.id = ma.person_id
    left join meeting_invitations mi on mi.id = ma.invitation_id
    where coalesce(mi.attendance_status, 'attended') <> 'absent' ${meetingFilter} ${personFilter}
      and coalesce(${actor}::uuid, ma.registered_by, m.organizer_user_id, m.created_by) is not null
    on conflict (source_key) where source_key is not null do nothing
    returning id
  `.execute(db);

  // 3. Correcciones: un check-in corregido a «ausente» anula su interacción; corregido de nuevo a «asistió», la reactiva.
  const voided = await sql<{ id: string }>`
    update person_interactions pi
    set status = 'voided', void_reason = 'La asistencia fue corregida a ausente', updated_at = now(), version = pi.version + 1
    from meeting_attendance ma
    join meeting_invitations mi on mi.id = ma.invitation_id
    join meetings m on m.id = ma.meeting_id
    join people p on p.id = ma.person_id
    where pi.source_key = 'meeting_attendance:' || ma.id and pi.status <> 'voided' and mi.attendance_status = 'absent' ${meetingFilter} ${personFilter}
    returning pi.id
  `.execute(db);
  const reactivated = await sql<{ id: string }>`
    update person_interactions pi
    set status = 'completed', void_reason = null, updated_at = now(), version = pi.version + 1
    from meeting_attendance ma
    left join meeting_invitations mi on mi.id = ma.invitation_id
    join meetings m on m.id = ma.meeting_id
    join people p on p.id = ma.person_id
    where pi.source_key = 'meeting_attendance:' || ma.id and pi.status = 'voided'
      and pi.void_reason = 'La asistencia fue corregida a ausente' and coalesce(mi.attendance_status, 'attended') <> 'absent' ${meetingFilter} ${personFilter}
    returning pi.id
  `.execute(db);

  const skipped = await sql<{ n: number }>`
    select count(*)::int as n
    from meeting_participations mp
    join meetings m on m.id = mp.meeting_id
    join people p on p.id = mp.person_id
    where ${REAL_PARTICIPATION_KIND} and not (${HAS_DATE}) ${meetingFilter} ${personFilter}
  `.execute(db);

  return {
    created: fromParticipations.rows.length + fromAttendance.rows.length,
    reactivated: reactivated.rows.length,
    voided: voided.rows.length,
    skippedWithoutDate: Number(skipped.rows[0]?.n ?? 0),
  };
}
