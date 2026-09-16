import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import type { MeetingStatus } from "../db/schema.js";
import { isOverdueUnclosed } from "./state-machine.js";

assertServerOnly("lib/meetings/queries.ts");

export interface MeetingListItem {
  id: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  locationName: string | null;
  status: MeetingStatus;
  displayStatus: MeetingStatus; // igual a status, salvo "vencida sin cerrar" derivado
  organizerName: string | null;
  invitedCount: number;
  confirmedCount: number;
}

export interface MeetingListFilter {
  status?: MeetingStatus | "all";
  associationId?: string;
  organizerUserId?: string;
}

export async function listMeetings(filter: MeetingListFilter = {}): Promise<MeetingListItem[]> {
  const db = await getDb();

  let query = db
    .selectFrom("meetings")
    .leftJoin("users", "users.id", "meetings.organizer_user_id")
    .leftJoin("meeting_invitations", "meeting_invitations.meeting_id", "meetings.id");

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
      "meetings.location_name",
      "meetings.status",
      "users.full_name as organizer_name",
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
      "meetings.location_name",
      "meetings.status",
      "users.full_name",
    ])
    .orderBy("meetings.starts_at", "desc")
    .execute();

  const items = rows.map((r) => {
    const displayStatus = isOverdueUnclosed(r.status, r.ends_at) ? ("overdue_unclosed" as const) : r.status;
    return {
      id: r.id,
      name: r.name,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      locationName: r.location_name,
      status: r.status,
      displayStatus,
      organizerName: r.organizer_name,
      invitedCount: Number(r.invited_count),
      confirmedCount: Number(r.confirmed_count),
    };
  });

  if (!filter.status || filter.status === "all") return items;
  return items.filter((m) => m.displayStatus === filter.status);
}

export interface MeetingDetail {
  id: string;
  name: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  locationName: string | null;
  address: string | null;
  notes: string | null;
  status: MeetingStatus;
  displayStatus: MeetingStatus;
  organizerUserId: string | null;
  organizerName: string | null;
  createdAt: Date;
}

export async function getMeetingById(id: string): Promise<MeetingDetail | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("meetings")
    .leftJoin("users", "users.id", "meetings.organizer_user_id")
    .select([
      "meetings.id",
      "meetings.name",
      "meetings.description",
      "meetings.starts_at",
      "meetings.ends_at",
      "meetings.location_name",
      "meetings.address",
      "meetings.notes",
      "meetings.status",
      "meetings.organizer_user_id",
      "users.full_name as organizer_name",
      "meetings.created_at",
    ])
    .where("meetings.id", "=", id)
    .executeTakeFirst();

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    locationName: row.location_name,
    address: row.address,
    notes: row.notes,
    status: row.status,
    displayStatus: isOverdueUnclosed(row.status, row.ends_at) ? "overdue_unclosed" : row.status,
    organizerUserId: row.organizer_user_id,
    organizerName: row.organizer_name,
    createdAt: row.created_at,
  };
}

export async function getMeetingAssociationIds(meetingId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("meeting_associations")
    .select("association_id")
    .where("meeting_id", "=", meetingId)
    .execute();
  return rows.map((r) => r.association_id);
}
