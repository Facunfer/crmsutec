import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { maskDni } from "../people/masking.js";
import type { SessionUser } from "../permissions/can.js";
import { canAccessAssociation, orgScope } from "../scope/organizations.js";

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

/** Solo asociaciones cuya unidad propietaria está dentro del alcance del usuario. */
export async function listAssociations(actor: SessionUser): Promise<AssociationListItem[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("associations")
    .where(orgScope(actor, "associations.owner_organization_id"))
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
  ownerOrganizationId: string;
  name: string;
  description: string | null;
  status: "active" | "inactive";
  typeId: string;
  typeName: string;
  createdAt: Date;
}

/** null si no existe O está fuera del alcance del usuario (no se distingue). */
export async function getAssociationById(actor: SessionUser, id: string): Promise<AssociationDetail | null> {
  if (!(await canAccessAssociation(actor, id))) return null;

  const db = await getDb();
  const row = await db
    .selectFrom("associations")
    .innerJoin("association_types", "association_types.id", "associations.type_id")
    .select([
      "associations.id",
      "associations.owner_organization_id",
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
    ownerOrganizationId: row.owner_organization_id,
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

/**
 * Miembros activos de una asociación del alcance del usuario. Solo se listan las
 * personas que el usuario puede ver: un miembro de otra unidad no se expone.
 */
export async function listActiveMembers(actor: SessionUser, associationId: string): Promise<AssociationMemberRow[]> {
  if (!(await canAccessAssociation(actor, associationId))) return [];

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
    .where(orgScope(actor, "people.organization_id"))
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

export async function listManagers(actor: SessionUser, associationId: string): Promise<AssociationManagerRow[]> {
  if (!(await canAccessAssociation(actor, associationId))) return [];

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
export async function getAssociationMetrics(actor: SessionUser, associationId: string): Promise<{
  activeMembers: number;
  linkedMeetings: number;
  averageAttendanceRate: number | null;
}> {
  if (!(await canAccessAssociation(actor, associationId))) {
    return { activeMembers: 0, linkedMeetings: 0, averageAttendanceRate: null };
  }

  const db = await getDb();

  const membersRow = await db
    .selectFrom("people_associations")
    .innerJoin("people", "people.id", "people_associations.person_id")
    .select(({ fn }) => fn.count<number>("people_associations.id").as("count"))
    .where("people_associations.association_id", "=", associationId)
    .where("people_associations.status", "=", "active")
    .where(orgScope(actor, "people.organization_id"))
    .executeTakeFirstOrThrow();

  const meetingsRow = await db
    .selectFrom("meeting_associations")
    .innerJoin("meetings", "meetings.id", "meeting_associations.meeting_id")
    .select(({ fn }) => fn.count<number>("meeting_associations.meeting_id").as("count"))
    .where("meeting_associations.association_id", "=", associationId)
    .where(orgScope(actor, "meetings.owner_organization_id"))
    .executeTakeFirstOrThrow();

  return {
    activeMembers: Number(membersRow.count),
    linkedMeetings: Number(meetingsRow.count),
    averageAttendanceRate: null,
  };
}

/** Para elegir un responsable-persona: sin la exclusión de miembros ya activos. */
export async function searchAnyActivePeople(
  actor: SessionUser,
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
    .where(orgScope(actor, "people.organization_id"))
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
  actor: SessionUser,
  associationId: string,
  search: string,
  canSeeSensitive: boolean,
  limit = 20
): Promise<Array<{ id: string; firstName: string; lastName: string; dni: string | null }>> {
  if (!(await canAccessAssociation(actor, associationId))) return [];

  const db = await getDb();
  const term = search.trim();
  if (term.length < 2) return [];

  const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

  const rows = await db
    .selectFrom("people")
    .select(["id", "first_name", "last_name", "dni"])
    .where("status", "=", "active")
    .where(orgScope(actor, "people.organization_id"))
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
