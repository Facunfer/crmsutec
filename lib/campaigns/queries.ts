import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import type { CampaignHistoricalCondition, CampaignStatus, CampaignType } from "../db/schema.js";
import { can, type SessionUser } from "../permissions/can.js";
import { campaignVisibility, isUuid, meetingVisibility, personInScope } from "../scope/organizations.js";
import { maskDni } from "../people/masking.js";
import { displayOf, loadOrgDisplayNames } from "../organizations/display.js";
import { PEOPLE_COLUMNS } from "../meetings/participants.js";
import { loadCampaignMetrics, ATTENDANCE_ACTIVE, PARTICIPATED_KINDS } from "../activities/metrics.js";
import { metricNumber, type ActivityMetrics, type InvitationResponse, type ParticipationBasis } from "../activities/labels.js";

assertServerOnly("lib/campaigns/queries.ts");

/**
 * CAMPAÑAS (0036). Regla canónica de conteo: PERSONAS DISTINTAS (`DISTINCT person_id`) sobre la unión de
 *   · participaciones a nivel campaña (meeting_participations.meeting_id IS NULL y campaign_key = campaigns.campaign_key), y
 *   · participaciones de TODAS sus jornadas (meetings.campaign_id = campaigns.id).
 * Nunca se cuentan filas: una persona presente a nivel campaña y en una jornada, o en dos jornadas, cuenta una vez. Los
 * conjuntos «participaron» e «inscriptas» pueden solaparse (una persona con inscripción y participación estará en ambos):
 * no se suman. La ausencia de un dato (invitaciones, asistencia) no se representa como cero: se informa como no disponible.
 * Los siete conteos salen de lib/activities/metrics.ts (única definición); «participaron» = participación explícita ∪ asistencia vigente.
 * Todo se limita a las personas del alcance del usuario.
 */

export interface CampaignListItem {
  id: string;
  key: string;
  name: string;
  type: CampaignType;
  /** Estado operativo gestionado en el sistema; null si nadie lo gestionó (p. ej. importadas). */
  status: CampaignStatus | null;
  /** Solo importadas: «ocurrió con fecha documentada» / «ocurrió sin fecha documentada». */
  historicalCondition: CampaignHistoricalCondition | null;
  origin: "manual" | "import";
  /** Jornadas (reuniones con campaign_id) VISIBLES para el usuario. */
  jornadasCount: number;
  /** Rango de fechas de sus jornadas con fecha real; null si ninguna tiene fecha documentada (no se inventa). */
  dateFrom: string | null;
  dateTo: string | null;
  /** Personas distintas (del alcance) con participación registrada o asistencia comprobada. Igual a `metrics.participated`. */
  participatedCount: number;
  /** Personas distintas (del alcance) con inscripción (registration). Puede solaparse con `participatedCount`. */
  registeredCount: number;
  /** Los siete conteos (Invitados … Asistieron) con «No disponible» / «Sin información» donde corresponde. */
  metrics: ActivityMetrics;
}

/** Día calendario (Buenos Aires) de una jornada con fecha real; las de fecha desconocida se excluyen antes. Nunca se inventa. */
const DAY_OF_MEETING = sql`coalesce(mj.event_date, (mj.starts_at at time zone 'America/Argentina/Buenos_Aires')::date)`;

export async function listCampaigns(actor: SessionUser, onlyCampaignId?: string): Promise<CampaignListItem[]> {
  const db = await getDb();
  const only = onlyCampaignId ? sql`and c.id = ${onlyCampaignId}::uuid` : sql``;
  // Lista y métricas son independientes: una sola tanda (un round trip). Ambas aplican la misma visibilidad.
  const [rows, metricsById] = await Promise.all([sql<{
    id: string; campaign_key: string; name: string; campaign_type: CampaignType; status: CampaignStatus | null;
    historical_condition: CampaignHistoricalCondition | null; origin: "manual" | "import";
    jornadas: number; date_from: string | null; date_to: string | null;
  }>`
    select c.id, c.campaign_key, c.name, c.campaign_type, c.status, c.historical_condition, c.origin,
      (select count(*)::int from meetings mj where mj.campaign_id = c.id and ${meetingVisibility(actor, "mj.id", "mj.owner_organization_id")}) as jornadas,
      (select to_char(min(${DAY_OF_MEETING}), 'YYYY-MM-DD') from meetings mj
         where mj.campaign_id = c.id and mj.schedule_precision <> 'unknown' and ${meetingVisibility(actor, "mj.id", "mj.owner_organization_id")}) as date_from,
      (select to_char(max(${DAY_OF_MEETING}), 'YYYY-MM-DD') from meetings mj
         where mj.campaign_id = c.id and mj.schedule_precision <> 'unknown' and ${meetingVisibility(actor, "mj.id", "mj.owner_organization_id")}) as date_to
    from campaigns c
    where ${campaignVisibility(actor)} ${only}
    order by c.name asc
  `.execute(db), loadCampaignMetrics(actor, onlyCampaignId ? [onlyCampaignId] : undefined)]);
  return rows.rows.map((r) => {
    const metrics = metricsById.get(r.id)!;
    return {
      id: r.id, key: r.campaign_key, name: r.name, type: r.campaign_type, status: r.status, historicalCondition: r.historical_condition, origin: r.origin,
      jornadasCount: Number(r.jornadas), dateFrom: r.date_from, dateTo: r.date_to,
      participatedCount: metricNumber(metrics.participated) ?? 0, registeredCount: metricNumber(metrics.registered) ?? 0, metrics,
    };
  });
}

export interface CampaignJornada {
  id: string;
  name: string;
  schedulePrecision: "exact_datetime" | "date_only" | "unknown";
  /** AAAA-MM-DD (día en Buenos Aires) o null si la jornada no tiene fecha documentada. */
  day: string | null;
  status: string;
  /** Participaciones de ESTA jornada (personas distintas del alcance); no incluye la participación a nivel campaña. */
  participantsCount: number;
}

export interface CampaignDetail extends CampaignListItem {
  ownerOrganizationId: string;
  jornadas: CampaignJornada[];
  /** Personas del alcance con participación SOLO a nivel campaña (sin jornada asignada). */
  campaignLevelOnlyCount: number;
}

/** null si no existe o está fuera del alcance del usuario (no se distingue). */
export async function getCampaignById(actor: SessionUser, id: string): Promise<CampaignDetail | null> {
  if (!isUuid(id)) return null;
  const db = await getDb();
  // La lista (que decide la visibilidad) y el resto de las lecturas son independientes: van en UNA tanda. Si la campaña no es
  // visible para el usuario, lo demás se descarta y se devuelve null.
  const [list, meta, jornadas, levelOnly] = await Promise.all([
    listCampaigns(actor, id),
    db.selectFrom("campaigns").select("owner_organization_id").where("id", "=", id).executeTakeFirst(),
    sql<{ id: string; name: string; schedule_precision: CampaignJornada["schedulePrecision"]; day: string | null; status: string; n: number }>`
      select m.id, m.name, m.schedule_precision, m.status,
        case when m.schedule_precision = 'unknown' then null else to_char(coalesce(m.event_date, (m.starts_at at time zone 'America/Argentina/Buenos_Aires')::date), 'YYYY-MM-DD') end as day,
        (select count(distinct mp.person_id)::int from meeting_participations mp where mp.meeting_id = m.id and ${personInScope(actor, "mp.person_id")}) as n
      from meetings m
      where m.campaign_id = ${id}::uuid and ${meetingVisibility(actor, "m.id", "m.owner_organization_id")}
      order by coalesce(m.starts_at, m.event_date::timestamptz) asc nulls last, m.name
    `.execute(db),
    sql<{ n: number }>`
      select count(distinct mp.person_id)::int as n
      from meeting_participations mp
      join campaigns c on c.campaign_key = mp.campaign_key
      where c.id = ${id}::uuid and mp.meeting_id is null and ${personInScope(actor, "mp.person_id")}
    `.execute(db),
  ]);
  const base = list.find((c) => c.id === id);
  if (!base) return null;
  return {
    ...base,
    ownerOrganizationId: meta!.owner_organization_id,
    jornadas: jornadas.rows.map((j) => ({ id: j.id, name: j.name, schedulePrecision: j.schedule_precision, day: j.day, status: j.status, participantsCount: Number(j.n) })),
    campaignLevelOnlyCount: Number(levelOnly.rows[0]?.n ?? 0),
  };
}

export interface CampaignParticipant {
  personId: string;
  firstName: string;
  lastName: string;
  /** Enmascarado sin people.view_sensitive. */
  dni: string | null;
  areaName: string | null;
  reparticionName: string | null;
  participated: boolean;
  registered: boolean;
  /** Tiene participación asignada a alguna jornada de la campaña (además o en lugar del nivel campaña). */
  inJornada: boolean;
  /** Asistencia presencial comprobada vigente en alguna jornada de la campaña (meeting_attendance). */
  attended: boolean;
  /** Respuesta de campaña de la invitación (aceptó > pendiente > rechazó entre sus jornadas); null si no fue invitada. */
  response: InvitationResponse | null;
  /** Bases de las participaciones explícitas (no incluye la asistencia). */
  participationBases: ParticipationBasis[];
}

export interface CampaignParticipantsPage {
  rows: CampaignParticipant[];
  total: number;
}

/** Personas de la campaña (una fila por persona), dentro del alcance, paginadas y con búsqueda por nombre/DNI. */
export async function listCampaignParticipants(
  actor: SessionUser,
  campaignId: string,
  options: { page?: number; pageSize?: number; search?: string } = {}
): Promise<CampaignParticipantsPage> {
  if (!isUuid(campaignId)) return { rows: [], total: 0 };
  const db = await getDb();
  // La visibilidad se evalúa en la misma tanda que las lecturas (un round trip); si no es visible, se descarta todo.
  const visibleQuery = sql<{ ok: boolean }>`select exists (select 1 from campaigns c where c.id = ${campaignId}::uuid and ${campaignVisibility(actor)}) as ok`.execute(db);

  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 200);
  const page = Math.max(options.page ?? 1, 1);
  const term = options.search?.trim();
  const pattern = term ? `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const searchSql = pattern ? sql`and (p.first_name ilike ${pattern} or p.last_name ilike ${pattern} or p.dni ilike ${pattern})` : sql``;
  const canSeeSensitive = can(actor, "people.view_sensitive");

  // Una fila por persona con sus hechos independientes. Fuentes: participaciones (nivel campaña y jornadas), invitaciones vigentes
  // de las jornadas y asistencia vigente de las jornadas (ATTENDANCE_ACTIVE). Nunca se deriva asistencia de otra cosa.
  const grouped = sql`
    select x.person_id,
           (bool_or(x.src = 'participation' and x.kind in ${PARTICIPATED_KINDS}) or bool_or(x.src = 'attendance')) as participated,
           bool_or(x.src = 'participation' and x.kind = 'registration') as registered,
           bool_or(x.in_jornada) as in_jornada,
           bool_or(x.src = 'attendance') as attended,
           case when bool_or(x.src = 'invitation') then
                  case when bool_or(x.src = 'invitation' and x.kind = 'confirmed') then 'confirmed'
                       when bool_or(x.src = 'invitation' and x.kind = 'pending') then 'pending'
                       else 'declined' end
                else null end as response,
           coalesce(array_agg(distinct x.basis) filter (where x.src = 'participation' and x.kind in ${PARTICIPATED_KINDS}), '{}') as bases
    from (
      select mp.person_id, 'participation' as src, mp.participation_kind as kind, mp.participation_basis as basis, false as in_jornada
      from meeting_participations mp join campaigns c on c.campaign_key = mp.campaign_key
      where c.id = ${campaignId}::uuid and mp.meeting_id is null
      union all
      select mp.person_id, 'participation', mp.participation_kind, mp.participation_basis, true
      from meeting_participations mp join meetings mj on mj.id = mp.meeting_id
      where mj.campaign_id = ${campaignId}::uuid
      union all
      select mi.person_id, 'invitation', mi.response_status, null, true
      from meeting_invitations mi join meetings mj on mj.id = mi.meeting_id
      where mj.campaign_id = ${campaignId}::uuid and mi.withdrawn_at is null
      union all
      select ma.person_id, 'attendance', ma.method, null, true
      from meeting_attendance ma join meetings mj on mj.id = ma.meeting_id
      where mj.campaign_id = ${campaignId}::uuid and ${ATTENDANCE_ACTIVE}
    ) x
    where ${personInScope(actor, "x.person_id")}
    group by x.person_id
  `;

  const [visible, totalRow, pageRows, names] = await Promise.all([
    visibleQuery,
    sql<{ n: number }>`select count(*)::int as n from (${grouped}) g join people p on p.id = g.person_id where true ${searchSql}`.execute(db),
    sql<{
      person_id: string; first_name: string; last_name: string; dni: string | null; area_name: string | null; reparticion_name: string | null;
      area_id: string | null; unit_id: string | null; participated: boolean; registered: boolean; in_jornada: boolean;
      attended: boolean; response: InvitationResponse | null; bases: ParticipationBasis[];
    }>`
      select ${PEOPLE_COLUMNS}, g.participated, g.registered, g.in_jornada, g.attended, g.response, g.bases
      from (${grouped}) g
      join people p on p.id = g.person_id
      where true ${searchSql}
      order by p.last_name asc, p.first_name asc, p.id asc
      limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(db),
    loadOrgDisplayNames(db),
  ]);
  if (!visible.rows[0]?.ok) return { rows: [], total: 0 };
  return {
    total: Number(totalRow.rows[0]?.n ?? 0),
    rows: pageRows.rows.map((r) => ({
      personId: r.person_id, firstName: r.first_name, lastName: r.last_name, dni: canSeeSensitive ? r.dni : maskDni(r.dni),
      areaName: displayOf(names, r.area_id, r.area_name), reparticionName: r.reparticion_name === null ? null : displayOf(names, r.unit_id, r.reparticion_name),
      participated: r.participated, registered: r.registered, inJornada: r.in_jornada,
      attended: r.attended, response: r.response, participationBases: r.bases,
    })),
  };
}
