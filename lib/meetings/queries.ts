import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import type { SessionUser } from "../permissions/can.js";
import { canAccessMeeting, canViewMeeting, isUuid, meetingVisibility, personInScope } from "../scope/organizations.js";
import type { MeetingStatus } from "../db/schema.js";
import { isOverdueUnclosed } from "./state-machine.js";

assertServerOnly("lib/meetings/queries.ts");

export interface MeetingListItem {
  id: string;
  name: string;
  /** null en actividades importadas sin hora conocida (ver schedulePrecision / eventDate). */
  startsAt: Date | null;
  endsAt: Date | null;
  schedulePrecision: "exact_datetime" | "date_only" | "unknown";
  eventDate: Date | null;
  locationName: string | null;
  status: MeetingStatus;
  displayStatus: MeetingStatus; // igual a status, salvo "vencida sin cerrar" derivado
  organizerName: string | null;
  /** Solo invitados/confirmados y participantes DENTRO del alcance del usuario (nunca los de otras áreas). */
  invitedCount: number;
  confirmedCount: number;
  /** Asignados a ESTA jornada puntual (meeting_id = esta reunión). Nunca incluye a quienes quedaron solo a nivel de
   * campaña sin jornada determinada: ver `campaignParticipantsCount`. */
  participantsCount: number;
  /** Personas distintas de la MISMA campaña con participación a nivel campaña (sin jornada asignada) — para que la lista
   * nunca dé la impresión de que la actividad no tuvo a nadie solo porque no se sabe a qué día corresponden.
   * `null` cuando la reunión no pertenece a ninguna campaña (meetings.campaign_id). */
  campaignParticipantsCount: number | null;
  /** Campaña a la que pertenece la jornada (0036); null en reuniones comunes y capacitaciones. */
  campaignId: string | null;
  campaignName: string | null;
  meetingType: string;
}

export interface MeetingListFilter {
  status?: MeetingStatus | "all";
  associationId?: string;
  organizerUserId?: string;
}

/**
 * Reuniones visibles: propietaria en el alcance del usuario, O con participantes suyos (ver meetingVisibility). Los
 * conteos se limitan a las personas del alcance del usuario.
 */
export async function listMeetings(actor: SessionUser, filter: MeetingListFilter = {}): Promise<MeetingListItem[]> {
  const db = await getDb();

  let query = db
    .selectFrom("meetings")
    .where(meetingVisibility(actor))
    .leftJoin("users", "users.id", "meetings.organizer_user_id")
    .leftJoin("meeting_invitations", (join) =>
      join.onRef("meeting_invitations.meeting_id", "=", "meetings.id").on(personInScope(actor, "meeting_invitations.person_id"))
    );

  if (filter.associationId) {
    query = query.innerJoin("meeting_associations", (join) =>
      join
        .onRef("meeting_associations.meeting_id", "=", "meetings.id")
        .on("meeting_associations.association_id", "=", filter.associationId!)
    );
  }
  if (filter.organizerUserId) {
    query = query.where("meetings.organizer_user_id", "=", filter.organizerUserId);
  }

  const rows = await query
    .select([
      "meetings.id",
      "meetings.name",
      "meetings.starts_at",
      "meetings.ends_at",
      "meetings.schedule_precision",
      "meetings.event_date",
      "meetings.location_name",
      "meetings.status",
      "meetings.campaign_id",
      "meetings.meeting_type",
      sql<string | null>`(select cn.name from campaigns cn where cn.id = meetings.campaign_id)`.as("campaign_name"),
      "users.full_name as organizer_name",
      sql<number>`(
        select count(distinct mp.person_id)::int from meeting_participations mp
        where mp.meeting_id = meetings.id and mp.voided_at is null and ${personInScope(actor, "mp.person_id")}
      )`.as("participants_count"),
      // Personas de la campaña de esta jornada (meetings.campaign_id) con participación a nivel campaña, dentro del alcance:
      // null si la reunión no pertenece a ninguna campaña.
      sql<number | null>`(
        case
          when meetings.campaign_id is null then null
          else (
            select count(distinct mp2.person_id)::int from meeting_participations mp2
            join campaigns cc on cc.id = meetings.campaign_id
            where mp2.meeting_id is null and mp2.campaign_key = cc.campaign_key and mp2.voided_at is null
              and ${personInScope(actor, "mp2.person_id")}
          )
        end
      )`.as("campaign_participants_count"),
      ({ fn }) => fn.count<number>("meeting_invitations.id").as("invited_count"),
      ({ fn, eb }) =>
        fn
          .count<number>(eb.case().when("meeting_invitations.response_status", "=", "confirmed").then(1).end())
          .as("confirmed_count"),
    ])
    .groupBy([
      "meetings.id",
      "meetings.name",
      "meetings.starts_at",
      "meetings.ends_at",
      "meetings.schedule_precision",
      "meetings.event_date",
      "meetings.location_name",
      "meetings.status",
      "meetings.campaign_id",
      "meetings.meeting_type",
      "users.full_name",
    ])
    // Las actividades importadas sin hora (date_only) ordenan por su día; las sin fecha van al final.
    .orderBy(sql`coalesce(meetings.starts_at, meetings.event_date::timestamptz)`, (ob) => ob.desc().nullsLast())
    .execute();

  const items = rows.map((r) => {
    const displayStatus = isOverdueUnclosed(r.status, r.ends_at) ? ("overdue_unclosed" as const) : r.status;
    return {
      id: r.id,
      name: r.name,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      schedulePrecision: r.schedule_precision,
      eventDate: r.event_date,
      locationName: r.location_name,
      status: r.status,
      displayStatus,
      organizerName: r.organizer_name,
      invitedCount: Number(r.invited_count),
      confirmedCount: Number(r.confirmed_count),
      participantsCount: Number(r.participants_count),
      campaignParticipantsCount: r.campaign_participants_count === null ? null : Number(r.campaign_participants_count),
      campaignId: r.campaign_id,
      campaignName: r.campaign_name,
      meetingType: r.meeting_type,
    };
  });

  if (!filter.status || filter.status === "all") return items;
  return items.filter((m) => m.displayStatus === filter.status);
}

export interface MeetingDetail {
  id: string;
  name: string;
  description: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  schedulePrecision: "exact_datetime" | "date_only" | "unknown";
  eventDate: Date | null;
  locationName: string | null;
  address: string | null;
  notes: string | null;
  status: MeetingStatus;
  displayStatus: MeetingStatus;
  organizerUserId: string | null;
  organizerName: string | null;
  createdAt: Date;
  /** 'owner': la unidad propietaria está en el alcance del usuario (puede operar). 'participants': solo la ve porque tiene participantes suyos (solo lectura). */
  accessLevel: "owner" | "participants";
  /** Clave de la actividad importada (p. ej. «ophthalmology:2026-03-10:canale»); null en reuniones creadas a mano. */
  sourceEventKey: string | null;
  /** Campaña a la que pertenece esta jornada (0036), con su nombre; null si no pertenece a ninguna. */
  campaign: { id: string; name: string } | null;
  meetingType: string;
}

/** null si no existe O está fuera del alcance del usuario (no se distingue). */
export async function getMeetingById(actor: SessionUser, id: string): Promise<MeetingDetail | null> {
  // Visibilidad, propiedad y lectura de la fila son independientes: van en UNA tanda (un solo round trip). Si la reunión no
  // es visible, la fila leída se descarta y nunca se devuelve.
  const db = await getDb();
  const rowQuery = db
    .selectFrom("meetings")
    .leftJoin("users", "users.id", "meetings.organizer_user_id")
    .select([
      "meetings.id",
      "meetings.name",
      "meetings.description",
      "meetings.starts_at",
      "meetings.ends_at",
      "meetings.schedule_precision",
      "meetings.event_date",
      "meetings.location_name",
      "meetings.address",
      "meetings.notes",
      "meetings.status",
      "meetings.organizer_user_id",
      "users.full_name as organizer_name",
      "meetings.created_at",
      "meetings.source_event_key",
      "meetings.meeting_type",
      sql<string | null>`meetings.campaign_id`.as("campaign_id"),
      sql<string | null>`(select cn.name from campaigns cn where cn.id = meetings.campaign_id)`.as("campaign_name"),
    ])
    .where("meetings.id", "=", id);
  if (!isUuid(id)) return null;
  const [visible, isOwner, row] = await Promise.all([canViewMeeting(actor, id), canAccessMeeting(actor, id), rowQuery.executeTakeFirst()]);
  if (!visible || !row) return null;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    schedulePrecision: row.schedule_precision,
    eventDate: row.event_date,
    locationName: row.location_name,
    address: row.address,
    notes: row.notes,
    status: row.status,
    displayStatus: isOverdueUnclosed(row.status, row.ends_at) ? "overdue_unclosed" : row.status,
    organizerUserId: row.organizer_user_id,
    organizerName: row.organizer_name,
    createdAt: row.created_at,
    accessLevel: isOwner ? "owner" : "participants",
    sourceEventKey: row.source_event_key,
    campaign: row.campaign_id && row.campaign_name ? { id: row.campaign_id, name: row.campaign_name } : null,
    meetingType: row.meeting_type,
  };
}

export async function getMeetingAssociationIds(actor: SessionUser, meetingId: string): Promise<string[]> {
  if (!(await canAccessMeeting(actor, meetingId))) return [];

  const db = await getDb();
  const rows = await db
    .selectFrom("meeting_associations")
    .select("association_id")
    .where("meeting_id", "=", meetingId)
    .execute();
  return rows.map((r) => r.association_id);
}
