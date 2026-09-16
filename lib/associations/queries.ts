import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { maskDni } from "../people/masking.js";

assertServerOnly("lib/associations/queries.ts");

export interface AssociationTypeItem {
  id: string;
  key: string;
  name: string;
  active: boolean;
}

export async function listAssociationTypes(): Promise<AssociationTypeItem[]> {
  const db = await getDb();
  return db
    .selectFrom("association_types")
    .select(["id", "key", "name", "active"])
    .where("active", "=", true)
    .orderBy("name", "asc")
    .execute();
}

export interface AssociationListItem {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  typeName: string;
  memberCount: number;
  createdAt: Date;
}

export async function listAssociations(): Promise<AssociationListItem[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("associations")
    .innerJoin("association_types", "association_types.id", "associations.type_id")
    .leftJoin("people_associations", (join) =>
      join
        .onRef("people_associations.association_id", "=", "associations.id")
        .on("people_associations.status", "=", "active")
    )
    .select([
      "associations.id",
      "associations.name",
      "associations.description",
      "associations.status",
      "association_types.name as type_name",
      "associations.created_at",
      ({ fn }) => fn.count<number>("people_associations.id").as("member_count"),
    ])
    .groupBy([
      "associations.id",
      "associations.name",
      "associations.description",
      "associations.status",
      "association_types.name",
      "associations.created_at",
    ])
    .orderBy("associations.name", "asc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    typeName: r.type_name,
    memberCount: Number(r.member_count),
    createdAt: r.created_at,
  }));
}

export interface AssociationDetail {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  typeId: string;
  typeName: string;
  createdAt: Date;
}

export async function getAssociationById(id: string): Promise<AssociationDetail | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("associations")
    .innerJoin("association_types", "association_types.id", "associations.type_id")
    .select([
      "associations.id",
      "associations.name",
      "associations.description",
      "associations.status",
      "associations.type_id",
      "association_types.name as type_name",
      "associations.created_at",
    ])
    .where("associations.id", "=", id)
    .executeTakeFirst();

  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    typeId: row.type_id,
    typeName: row.type_name,
    createdAt: row.created_at,
  };
}

export interface AssociationMemberRow {
  membershipId: string;
  personId: string;
  firstName: string;
  lastName: string;
  role: string | null;
  addedAt: Date;
}

export async function listActiveMembers(associationId: string): Promise<AssociationMemberRow[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("people_associations")
    .innerJoin("people", "people.id", "people_associations.person_id")
    .select([
      "people_associations.id as membership_id",
      "people.id as person_id",
      "people.first_name",
      "people.last_name",
      "people_associations.role",
      "people_associations.added_at",
    ])
    .where("people_associations.association_id", "=", associationId)
    .where("people_associations.status", "=", "active")
    .orderBy("people.last_name", "asc")
    .execute();

  return rows.map((r) => ({
    membershipId: r.membership_id,
    personId: r.person_id,
    firstName: r.first_name,
    lastName: r.last_name,
    role: r.role,
    addedAt: r.added_at,
  }));
}

export interface AssociationManagerRow {
  managerId: string;
  userId: string | null;
  userName: string | null;
  personId: string | null;
  personName: string | null;
}

export async function listManagers(associationId: string): Promise<AssociationManagerRow[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("association_managers")
    .leftJoin("users", "users.id", "association_managers.user_id")
    .leftJoin("people", "people.id", "association_managers.person_id")
    .select([
      "association_managers.id as manager_id",
      "association_managers.user_id",
      "users.full_name as user_name",
      "association_managers.person_id",
      "people.first_name",
      "people.last_name",
    ])
    .where("association_managers.association_id", "=", associationId)
    .execute();

  return rows.map((r) => ({
    managerId: r.manager_id,
    userId: r.user_id,
    userName: r.user_name,
    personId: r.person_id,
    personName: r.first_name ? `${r.first_name} ${r.last_name}` : null,
  }));
}

/** Miembros activos + reuniones vinculadas (calculado, 0 real hasta la Etapa 6) + asistencia promedio. */
export async function getAssociationMetrics(associationId: string): Promise<{
  activeMembers: number;
  linkedMeetings: number;
  averageAttendanceRate: number | null;
}> {
  const db = await getDb();

  const membersRow = await db
    .selectFrom("people_associations")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .where("association_id", "=", associationId)
    .where("status", "=", "active")
    .executeTakeFirstOrThrow();

  const meetingsRow = await db
    .selectFrom("meeting_associations")
    .select(({ fn }) => fn.count<number>("meeting_id").as("count"))
    .where("association_id", "=", associationId)
    .executeTakeFirstOrThrow();

  return {
    activeMembers: Number(membersRow.count),
    linkedMeetings: Number(meetingsRow.count),
    averageAttendanceRate: null,
  };
}

/** Para elegir un responsable-persona: sin la exclusión de miembros ya activos. */
export async function searchAnyActivePeople(
  search: string,
  limit = 20
): Promise<Array<{ id: string; firstName: string; lastName: string }>> {
  const db = await getDb();
  const term = search.trim();
  if (term.length < 2) return [];

  const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await db
    .selectFrom("people")
    .select(["id", "first_name", "last_name"])
    .where("status", "=", "active")
    .where((eb) => eb.or([eb("first_name", "ilike", pattern), eb("last_name", "ilike", pattern)]))
    .limit(limit)
    .execute();

  return rows.map((r) => ({ id: r.id, firstName: r.first_name, lastName: r.last_name }));
}

/**
 * Buscador de personas para agregar como miembro; excluye a quienes ya
 * están activos (sección 10 del prompt). El DNI es solo para desambiguar
 * homónimos — igual que en Personas, sin `people.view_sensitive` se
 * enmascara acá mismo, nunca le llega el valor real al cliente.
 */
export async function searchPeopleToAdd(
  associationId: string,
  search: string,
  canSeeSensitive: boolean,
  limit = 20
): Promise<Array<{ id: string; firstName: string; lastName: string; dni: string | null }>> {
  const db = await getDb();
  const term = search.trim();
  if (term.length < 2) return [];

  const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

  const rows = await db
    .selectFrom("people")
    .select(["id", "first_name", "last_name", "dni"])
    .where("status", "=", "active")
    .where((eb) =>
      eb.or([
        eb("first_name", "ilike", pattern),
        eb("last_name", "ilike", pattern),
        eb("dni", "ilike", pattern),
      ])
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("people_associations")
            .select("people_associations.id")
            .whereRef("people_associations.person_id", "=", "people.id")
            .where("people_associations.association_id", "=", associationId)
            .where("people_associations.status", "=", "active")
        )
      )
    )
    .limit(limit)
    .execute();

  return rows.map((r) => ({ id: r.id, firstName: r.first_name, lastName: r.last_name, dni: canSeeSensitive ? r.dni : maskDni(r.dni) }));
}
