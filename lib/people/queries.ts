import { sql, type Kysely } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import type { Database, PersonStatus } from "../db/schema.js";

assertServerOnly("lib/people/queries.ts");

/**
 * Especificación tipada de filtros (sección 9 del prompt): la grilla, la
 * exportación y el conteo previo usan siempre esta misma forma y el mismo
 * resolvedor (`applyFilters`), así que el número que se muestra antes de
 * actuar es exactamente el que después se usa. Se valida acá, nunca se
 * arma SQL a partir de texto libre del usuario.
 */
export interface PeopleFilterSpec {
  search?: string;
  organizationIds?: string[];
  status?: PersonStatus | "all";
  ageMin?: number;
  ageMax?: number;
}

export interface PeopleSort {
  field: "name" | "created_at";
  direction: "asc" | "desc";
}

function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function applyFilters(db: Kysely<Database>, filter: PeopleFilterSpec) {
  let query = db.selectFrom("people");

  const status = filter.status ?? "active";
  if (status !== "all") {
    query = query.where("people.status", "=", status);
  }

  if (filter.organizationIds && filter.organizationIds.length > 0) {
    query = query.where("people.organization_id", "in", filter.organizationIds);
  }

  // El filtro de edad solo aplica a quienes tienen fecha de nacimiento
  // real: una edad declarada sin fecha exacta no se puede acotar a un
  // rango de forma confiable (decisión D7).
  if (filter.ageMin !== undefined) {
    query = query.where(
      sql<boolean>`people.birth_date is not null and floor(date_part('year', age(people.birth_date))) >= ${filter.ageMin}`
    );
  }
  if (filter.ageMax !== undefined) {
    query = query.where(
      sql<boolean>`people.birth_date is not null and floor(date_part('year', age(people.birth_date))) <= ${filter.ageMax}`
    );
  }

  if (filter.search && filter.search.trim()) {
    const pattern = `%${escapeLikeTerm(filter.search.trim())}%`;
    query = query.where((eb) =>
      eb.or([
        eb("people.first_name", "ilike", pattern),
        eb("people.last_name", "ilike", pattern),
        eb("people.dni", "ilike", pattern),
        eb("people.email", "ilike", pattern),
        eb("people.phone", "ilike", pattern),
      ])
    );
  }

  return query;
}

export async function countPeople(filter: PeopleFilterSpec): Promise<number> {
  const db = await getDb();
  const row = await applyFilters(db, filter)
    .select(({ fn }) => fn.count<number>("people.id").as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** IDs de todo lo que matchea el filtro, sin paginar — para "seleccionar todos los resultados". */
export async function listAllMatchingIds(filter: PeopleFilterSpec): Promise<string[]> {
  const db = await getDb();
  const rows = await applyFilters(db, filter).select("people.id").execute();
  return rows.map((r) => r.id);
}

export interface PersonListRow {
  id: string;
  firstName: string;
  lastName: string;
  dni: string | null;
  email: string | null;
  phone: string | null;
  status: PersonStatus;
  birthDate: Date | null;
  declaredAge: number | null;
  declaredAgeAt: Date | null;
  organizationName: string | null;
  createdAt: Date;
}

export async function listPeoplePage(
  filter: PeopleFilterSpec,
  sort: PeopleSort,
  page: number,
  pageSize: number
): Promise<{ rows: PersonListRow[]; total: number }> {
  const db = await getDb();

  const total = await countPeople(filter);

  let query = applyFilters(db, filter)
    .leftJoin("organizations", "organizations.id", "people.organization_id")
    .select([
      "people.id",
      "people.first_name",
      "people.last_name",
      "people.dni",
      "people.email",
      "people.phone",
      "people.status",
      "people.birth_date",
      "people.declared_age",
      "people.declared_age_at",
      "people.created_at",
      "organizations.name as organization_name",
    ]);

  query =
    sort.field === "name"
      ? query.orderBy("people.last_name", sort.direction).orderBy("people.first_name", sort.direction)
      : query.orderBy("people.created_at", sort.direction);

  const rows = await query
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();

  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      dni: r.dni,
      email: r.email,
      phone: r.phone,
      status: r.status,
      birthDate: r.birth_date,
      declaredAge: r.declared_age,
      declaredAgeAt: r.declared_age_at,
      organizationName: r.organization_name,
      createdAt: r.created_at,
    })),
  };
}

/** Sin paginar — solo para exportación, que necesita exactamente el mismo alcance que la grilla. */
export async function listAllMatching(filter: PeopleFilterSpec, sort: PeopleSort): Promise<PersonListRow[]> {
  const db = await getDb();

  let query = applyFilters(db, filter)
    .leftJoin("organizations", "organizations.id", "people.organization_id")
    .select([
      "people.id",
      "people.first_name",
      "people.last_name",
      "people.dni",
      "people.email",
      "people.phone",
      "people.status",
      "people.birth_date",
      "people.declared_age",
      "people.declared_age_at",
      "people.created_at",
      "organizations.name as organization_name",
    ]);

  query =
    sort.field === "name"
      ? query.orderBy("people.last_name", sort.direction).orderBy("people.first_name", sort.direction)
      : query.orderBy("people.created_at", sort.direction);

  const rows = await query.execute();
  return rows.map((r) => ({
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    dni: r.dni,
    email: r.email,
    phone: r.phone,
    status: r.status,
    birthDate: r.birth_date,
    declaredAge: r.declared_age,
    declaredAgeAt: r.declared_age_at,
    organizationName: r.organization_name,
    createdAt: r.created_at,
  }));
}

export interface PersonDetail extends PersonListRow {
  organizationId: string | null;
  customFields: Record<string, unknown>;
  origin: string;
  version: number;
  updatedAt: Date;
}

export async function getPersonById(id: string): Promise<PersonDetail | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("people")
    .leftJoin("organizations", "organizations.id", "people.organization_id")
    .select([
      "people.id",
      "people.first_name",
      "people.last_name",
      "people.dni",
      "people.email",
      "people.phone",
      "people.status",
      "people.birth_date",
      "people.declared_age",
      "people.declared_age_at",
      "people.organization_id",
      "people.custom_fields",
      "people.origin",
      "people.version",
      "people.created_at",
      "people.updated_at",
      "organizations.name as organization_name",
    ])
    .where("people.id", "=", id)
    .executeTakeFirst();

  if (!row) return null;

  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    dni: row.dni,
    email: row.email,
    phone: row.phone,
    status: row.status,
    birthDate: row.birth_date,
    declaredAge: row.declared_age,
    declaredAgeAt: row.declared_age_at,
    organizationName: row.organization_name,
    organizationId: row.organization_id,
    customFields: (row.custom_fields ?? {}) as Record<string, unknown>,
    origin: row.origin,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface PersonMeetingActivityRow {
  meetingId: string;
  meetingName: string;
  startsAt: Date;
  responseStatus: string;
  attendanceStatus: string;
}

/** Reunión | Fecha | Invitado | Confirmó | Asistió (sección 9 del prompt). Vacío hasta la Etapa 6. */
export async function getPersonMeetingActivity(personId: string): Promise<PersonMeetingActivityRow[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("meeting_invitations")
    .innerJoin("meetings", "meetings.id", "meeting_invitations.meeting_id")
    .select([
      "meetings.id as meeting_id",
      "meetings.name as meeting_name",
      "meetings.starts_at",
      "meeting_invitations.response_status",
      "meeting_invitations.attendance_status",
    ])
    .where("meeting_invitations.person_id", "=", personId)
    .orderBy("meetings.starts_at", "desc")
    .execute();

  return rows.map((r) => ({
    meetingId: r.meeting_id,
    meetingName: r.meeting_name,
    startsAt: r.starts_at,
    responseStatus: r.response_status,
    attendanceStatus: r.attendance_status,
  }));
}

export interface PersonFormSubmissionRow {
  submissionId: string;
  formName: string;
  createdAt: Date;
}

/** Formularios completados por esta persona. Vacío hasta la Etapa 8. */
export async function getPersonFormSubmissions(personId: string): Promise<PersonFormSubmissionRow[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("form_submissions")
    .innerJoin("forms", "forms.id", "form_submissions.form_id")
    .select(["form_submissions.id", "forms.name as form_name", "form_submissions.created_at"])
    .where("form_submissions.person_id", "=", personId)
    .orderBy("form_submissions.created_at", "desc")
    .execute();

  return rows.map((r) => ({ submissionId: r.id, formName: r.form_name, createdAt: r.created_at }));
}

/** Edad calculada, nunca guardada (decisión D7). */
export function computeDisplayAge(person: {
  birthDate: Date | null;
  declaredAge: number | null;
  declaredAgeAt: Date | null;
}): { age: number | null; estimated: boolean } {
  if (person.birthDate) {
    const now = new Date();
    let age = now.getFullYear() - person.birthDate.getFullYear();
    const monthDiff = now.getMonth() - person.birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < person.birthDate.getDate())) {
      age -= 1;
    }
    return { age, estimated: false };
  }
  if (person.declaredAge !== null && person.declaredAgeAt) {
    const yearsSinceDeclared = new Date().getFullYear() - person.declaredAgeAt.getFullYear();
    return { age: person.declaredAge + Math.max(0, yearsSinceDeclared), estimated: true };
  }
  return { age: null, estimated: false };
}
