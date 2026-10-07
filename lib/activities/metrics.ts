import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import type { SessionUser } from "../permissions/can.js";
import { campaignVisibility, isUuid, meetingVisibility, personInScope } from "../scope/organizations.js";
import { buildMetrics, type ActivityMetrics, type RawMetricCounts } from "./labels.js";

assertServerOnly("lib/activities/metrics.ts");

/**
 * MÉTRICAS DE ACTIVIDAD (Fase B1). Única definición de los siete conteos; las pantallas no calculan nada por su cuenta.
 * Inscriptos = `registration` VIGENTE (`voided_at IS NULL`, B4): una inscripción anulada no cuenta. Participaron y Asistieron no dependen de ella.
 * Todo es DISTINCT person_id dentro del alcance del usuario (`personInScope`); las categorías solapadas nunca se suman.
 * Definiciones exactas: docs/FASE-B-DISENO.md §3.
 *
 * Asistencia canónica = meeting_attendance VIGENTE (`revoked_at IS NULL`, B3). `meeting_invitations.attendance_status` está
 * deprecado y NO se lee. Los fragmentos SQL que usan esta constante nombran la tabla con el alias `ma`.
 */
export const ATTENDANCE_ACTIVE = sql`ma.revoked_at is null`;

/** Participación explícita que cuenta como «participó» (no incluye registration). */
export const PARTICIPATED_KINDS = sql`('participated', 'attended')`;

interface MetricRow {
  id: string;
  invited: number;
  accepted: number;
  declined: number;
  pending: number;
  registered: number;
  participated: number;
  attended: number;
  any_invitation: boolean;
  any_attendance: boolean;
  managed: boolean;
}

function toMetrics(r: MetricRow): ActivityMetrics {
  const raw: RawMetricCounts = {
    invited: Number(r.invited),
    accepted: Number(r.accepted),
    declined: Number(r.declined),
    pending: Number(r.pending),
    registered: Number(r.registered),
    participated: Number(r.participated),
    attended: Number(r.attended),
    invitationsTracked: r.any_invitation || r.managed,
    attendanceTracked: r.any_attendance || r.managed,
  };
  return buildMetrics(raw);
}

/**
 * Métricas por reunión/jornada (solo lo asignado a ESA reunión; los participantes a nivel campaña sin jornada se informan en la campaña).
 * `meetingIds` omitido → todas las reuniones visibles para el usuario.
 */
export async function loadMeetingMetrics(actor: SessionUser, meetingIds?: readonly string[]): Promise<Map<string, ActivityMetrics>> {
  const ids = meetingIds?.filter(isUuid);
  if (meetingIds && ids!.length === 0) return new Map();
  const db = await getDb();
  const visible = meetingVisibility(actor, "m.id", "m.owner_organization_id");
  const filter = ids ? sql`m.id = any(${[...ids]}::uuid[]) and ${visible}` : visible;
  const rows = await sql<MetricRow>`
    select m.id,
      (select count(*)::int from meeting_invitations mi where mi.meeting_id = m.id and mi.withdrawn_at is null and ${personInScope(actor, "mi.person_id")}) as invited,
      (select count(*)::int from meeting_invitations mi where mi.meeting_id = m.id and mi.withdrawn_at is null and mi.response_status = 'confirmed' and ${personInScope(actor, "mi.person_id")}) as accepted,
      (select count(*)::int from meeting_invitations mi where mi.meeting_id = m.id and mi.withdrawn_at is null and mi.response_status = 'declined' and ${personInScope(actor, "mi.person_id")}) as declined,
      (select count(*)::int from meeting_invitations mi where mi.meeting_id = m.id and mi.withdrawn_at is null and mi.response_status = 'pending' and ${personInScope(actor, "mi.person_id")}) as pending,
      (select count(distinct mp.person_id)::int from meeting_participations mp where mp.meeting_id = m.id and mp.participation_kind = 'registration' and mp.voided_at is null and ${personInScope(actor, "mp.person_id")}) as registered,
      (select count(distinct x.person_id)::int from (
         select mp.person_id from meeting_participations mp where mp.meeting_id = m.id and mp.participation_kind in ${PARTICIPATED_KINDS}
         union all
         select ma.person_id from meeting_attendance ma where ma.meeting_id = m.id and ${ATTENDANCE_ACTIVE}
       ) x where ${personInScope(actor, "x.person_id")}) as participated,
      (select count(distinct ma.person_id)::int from meeting_attendance ma where ma.meeting_id = m.id and ${ATTENDANCE_ACTIVE} and ${personInScope(actor, "ma.person_id")}) as attended,
      exists (select 1 from meeting_invitations mi where mi.meeting_id = m.id) as any_invitation,
      exists (select 1 from meeting_attendance ma where ma.meeting_id = m.id) as any_attendance,
      (m.origin = 'manual') as managed
    from meetings m
    where ${filter}
  `.execute(db);
  return new Map(rows.rows.map((r) => [r.id, toMetrics(r)]));
}

/**
 * Métricas por campaña: unión del nivel campaña (`campaign_key`) y de TODAS sus jornadas (`meetings.campaign_id`), por persona distinta.
 * Respuesta de campaña de una persona invitada a varias jornadas (partición disjunta): aceptó si aceptó alguna; si no, pendiente
 * si alguna sigue pendiente; si no, rechazó. Así Aceptaron + Rechazaron + Pendientes = Invitados.
 * `campaignIds` omitido → todas las campañas visibles.
 */
export async function loadCampaignMetrics(actor: SessionUser, campaignIds?: readonly string[]): Promise<Map<string, ActivityMetrics>> {
  const ids = campaignIds?.filter(isUuid);
  if (campaignIds && ids!.length === 0) return new Map();
  const db = await getDb();
  const visible = campaignVisibility(actor);
  const filter = ids ? sql`c.id = any(${[...ids]}::uuid[]) and ${visible}` : visible;
  const rows = await sql<MetricRow>`
    select c.id,
      inv.invited, inv.accepted, inv.declined, inv.pending,
      (select count(distinct x.person_id)::int from (
         select mp.person_id from meeting_participations mp where mp.meeting_id is null and mp.campaign_key = c.campaign_key and mp.participation_kind = 'registration' and mp.voided_at is null
         union all
         select mp.person_id from meeting_participations mp join meetings mj on mj.id = mp.meeting_id where mj.campaign_id = c.id and mp.participation_kind = 'registration' and mp.voided_at is null
       ) x where ${personInScope(actor, "x.person_id")}) as registered,
      (select count(distinct x.person_id)::int from (
         select mp.person_id from meeting_participations mp where mp.meeting_id is null and mp.campaign_key = c.campaign_key and mp.participation_kind in ${PARTICIPATED_KINDS}
         union all
         select mp.person_id from meeting_participations mp join meetings mj on mj.id = mp.meeting_id where mj.campaign_id = c.id and mp.participation_kind in ${PARTICIPATED_KINDS}
         union all
         select ma.person_id from meeting_attendance ma join meetings mj on mj.id = ma.meeting_id where mj.campaign_id = c.id and ${ATTENDANCE_ACTIVE}
       ) x where ${personInScope(actor, "x.person_id")}) as participated,
      (select count(distinct ma.person_id)::int from meeting_attendance ma join meetings mj on mj.id = ma.meeting_id
         where mj.campaign_id = c.id and ${ATTENDANCE_ACTIVE} and ${personInScope(actor, "ma.person_id")}) as attended,
      exists (select 1 from meeting_invitations mi join meetings mj on mj.id = mi.meeting_id where mj.campaign_id = c.id) as any_invitation,
      exists (select 1 from meeting_attendance ma join meetings mj on mj.id = ma.meeting_id where mj.campaign_id = c.id) as any_attendance,
      exists (select 1 from meetings mj where mj.campaign_id = c.id and mj.origin = 'manual') as managed
    from campaigns c
    cross join lateral (
      select count(*)::int as invited,
             (count(*) filter (where r.resp = 'confirmed'))::int as accepted,
             (count(*) filter (where r.resp = 'declined'))::int as declined,
             (count(*) filter (where r.resp = 'pending'))::int as pending
      from (
        select mi.person_id,
               case when bool_or(mi.response_status = 'confirmed') then 'confirmed'
                    when bool_or(mi.response_status = 'pending') then 'pending'
                    else 'declined' end as resp
        from meeting_invitations mi join meetings mj on mj.id = mi.meeting_id
        where mj.campaign_id = c.id and mi.withdrawn_at is null and ${personInScope(actor, "mi.person_id")}
        group by mi.person_id
      ) r
    ) inv
    where ${filter}
  `.execute(db);
  return new Map(rows.rows.map((r) => [r.id, toMetrics(r)]));
}
