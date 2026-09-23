import { sql, type Kysely } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import type { Database, PersonStatus } from "../db/schema.js";
import type { SessionUser } from "../permissions/can.js";
import { canAccessPerson, isUuid, orgScope, meetingVisibility } from "../scope/organizations.js";
import { PARTICIPANT_STATUS_LABEL, type ParticipantStatus } from "../meetings/participants.js";
import { displayOf, loadOrgDisplayNames } from "../organizations/display.js";
import { TRAFFIC_GREEN_MAX_DAYS, TRAFFIC_YELLOW_MAX_DAYS, trafficLightOf, type TrafficLight } from "./traffic.js";
import { visibleTagIdsCondition } from "../tags/queries.js";
import { validInteraction, interactionDay, interactionAgeDays } from "./traffic-sql.js";

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
  /** Solo cuentan las etiquetas que el usuario puede ver (alcance y sensibilidad); el resto no filtra ni revela nada. */
  tagIds?: string[];
  /** Área = ancestro raíz de la unidad de la persona. Incluye a todas las reparticiones de esa área (dentro del alcance del usuario). */
  areaId?: string;
  /** Repartición (unidad) y sus dependientes. Si viene, manda sobre `areaId`. */
  reparticionId?: string;
  /** Semáforo por última interacción (verde/amarillo/rojo/gris). */
  trafficLight?: TrafficLight;
  /** Fecha (AAAA-MM-DD, día de Buenos Aires) de la última interacción: desde / hasta, inclusive. Las personas sin interacción no cumplen. */
  lastInteractionFrom?: string;
  lastInteractionTo?: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const BA = "America/Argentina/Buenos_Aires";

/**
 * Última interacción REAL de la persona: interacciones válidas (abiertas o completadas, no futuras, no anuladas) dentro
 * del alcance del usuario (unidad propietaria de la interacción). Una inscripción NO cuenta: las participaciones entran
 * solo cuando se confirmaron y generaron su interacción (lib/interactions/participation-sync.ts).
 */
function lastInteractionLateral(actor: SessionUser) {
  return sql<{ last_date: string | null; days: number | null }>`(
    select to_char(m.d, 'YYYY-MM-DD') as last_date,
           ${interactionAgeDays(sql`m.d`)} as days
    from (
      select max(${interactionDay(sql`pi.occurred_at`)}) as d
      from person_interactions pi
      where pi.person_id = people.id
        and ${validInteraction()}
        and ${orgScope(actor, "pi.owner_organization_id")}
    ) m
  )`.as("li");
}

export interface PeopleSort {
  field: "name" | "created_at";
  direction: "asc" | "desc";
}

function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Único punto que arma el conjunto de personas visibles: TODA consulta de
 * personas (grilla, conteo, selección total, export, audiencias) parte de acá,
 * así el alcance organizativo no puede olvidarse en una de ellas.
 */
function applyFilters(db: Kysely<Database>, actor: SessionUser, filter: PeopleFilterSpec) {
  let query = db
    .selectFrom("people")
    .leftJoinLateral(lastInteractionLateral(actor), (join) => join.onTrue())
    .where(orgScope(actor, "people.organization_id"));

  const status = filter.status ?? "active";
  if (status !== "all") {
    query = query.where("people.status", "=", status);
  }

  if (filter.organizationIds && filter.organizationIds.length > 0) {
    query = query.where("people.organization_id", "in", filter.organizationIds);
  }

  const unitFilter = filter.reparticionId ?? filter.areaId;
  if (unitFilter) {
    query = query.where(
      isUuid(unitFilter)
        ? sql<boolean>`people.organization_id in (select organization_id from organization_descendants(${unitFilter}::uuid))`
        : sql<boolean>`false`
    );
  }

  if (filter.trafficLight === "gray") query = query.where(sql<boolean>`li.last_date is null`);
  else if (filter.trafficLight === "green") query = query.where(sql<boolean>`li.days is not null and li.days <= ${TRAFFIC_GREEN_MAX_DAYS}`);
  else if (filter.trafficLight === "yellow")
    query = query.where(sql<boolean>`li.days > ${TRAFFIC_GREEN_MAX_DAYS} and li.days <= ${TRAFFIC_YELLOW_MAX_DAYS}`);
  else if (filter.trafficLight === "red") query = query.where(sql<boolean>`li.days > ${TRAFFIC_YELLOW_MAX_DAYS}`);

  if (filter.lastInteractionFrom) {
    query = query.where(ISO_DAY.test(filter.lastInteractionFrom) ? sql<boolean>`li.last_date >= ${filter.lastInteractionFrom}` : sql<boolean>`false`);
  }
  if (filter.lastInteractionTo) {
    query = query.where(ISO_DAY.test(filter.lastInteractionTo) ? sql<boolean>`li.last_date <= ${filter.lastInteractionTo}` : sql<boolean>`false`);
  }

  if (filter.tagIds && filter.tagIds.length > 0) {
    const tagCondition = visibleTagIdsCondition(actor, filter.tagIds);
    query = query.where(tagCondition);
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

export async function countPeople(actor: SessionUser, filter: PeopleFilterSpec): Promise<number> {
  const db = await getDb();
  const row = await applyFilters(db, actor, filter)
    .select(({ fn }) => fn.count<number>("people.id").as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** IDs de todo lo que matchea el filtro, sin paginar — para "seleccionar todos los resultados". */
export async function listAllMatchingIds(actor: SessionUser, filter: PeopleFilterSpec): Promise<string[]> {
  const db = await getDb();
  const rows = await applyFilters(db, actor, filter).select("people.id").execute();
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
  /** Unidad guardada (people.organization_id). Se mantiene por compatibilidad; en pantalla se muestran Área y Repartición. */
  organizationName: string | null;
  /** Área = ancestro raíz de la unidad. */
  areaName: string | null;
  /** Repartición específica: null cuando la unidad guardada ES el Área (o no hay unidad). */
  reparticionName: string | null;
  /** Fecha de la última interacción real (AAAA-MM-DD, Buenos Aires) y días transcurridos; null si nunca hubo. */
  lastInteractionDate: string | null;
  daysSinceInteraction: number | null;
  trafficLight: TrafficLight;
  createdAt: Date;
}

/** Une la unidad y su Área derivada (organization_area_id, migración 0024). */
function withArea(query: any) {
  return query
    .leftJoin("organizations", "organizations.id", "people.organization_id")
    .leftJoin("organizations as area_org", (join: any) => join.on(sql<boolean>`area_org.id = public.organization_area_id(people.organization_id)`));
}

function toListRow(r: any, names: ReadonlyMap<string, string>): PersonListRow {
  const days = r.days === null || r.days === undefined ? null : Number(r.days);
  return {
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
    // Nombre a mostrar: «Nombre (CÓDIGO)» solo si el nombre no es único (lib/organizations/display.ts).
    areaName: displayOf(names, r.area_id, r.area_name),
    reparticionName: r.reparticion_name === null || r.reparticion_name === undefined ? null : displayOf(names, r.unit_id, r.reparticion_name),
    lastInteractionDate: r.last_interaction_date ?? null,
    daysSinceInteraction: days,
    trafficLight: trafficLightOf(days),
    createdAt: r.created_at,
  };
}

const LIST_COLUMNS = [
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
  "area_org.name as area_name",
  "area_org.id as area_id",
  "organizations.id as unit_id",
] as const;

const extraColumns = () => [
  sql<string | null>`case when organizations.parent_id is null then null else organizations.name end`.as("reparticion_name"),
  sql<string | null>`li.last_date`.as("last_interaction_date"),
  sql<number | null>`li.days`.as("days"),
];

export interface TrafficKpis {
  green: number;
  yellow: number;
  red: number;
  gray: number;
  total: number;
}

/**
 * KPIs del semáforo: cantidad de PERSONAS (no de interacciones) por bucket, sobre el MISMO conjunto que la grilla
 * (alcance + filtros actuales). El propio filtro de semáforo y de fechas de última interacción no se aplica: los cuatro
 * KPIs muestran cómo se reparte el resto de los filtros, y hacer clic en uno activa ese filtro.
 */
export async function getTrafficKpis(actor: SessionUser, filter: PeopleFilterSpec): Promise<TrafficKpis> {
  const db = await getDb();
  const { trafficLight: _t, lastInteractionFrom: _f, lastInteractionTo: _to, ...rest } = filter;
  const rows = await applyFilters(db, actor, rest)
    .select([
      sql<string>`case when li.last_date is null then 'gray'
                       when li.days <= ${TRAFFIC_GREEN_MAX_DAYS} then 'green'
                       when li.days <= ${TRAFFIC_YELLOW_MAX_DAYS} then 'yellow'
                       else 'red' end`.as("bucket"),
      sql<number>`count(*)::int`.as("n"),
    ])
    .groupBy(sql`1`)
    .execute();
  const kpis: TrafficKpis = { green: 0, yellow: 0, red: 0, gray: 0, total: 0 };
  for (const r of rows) {
    const bucket = r.bucket as TrafficLight;
    kpis[bucket] += Number(r.n);
    kpis.total += Number(r.n);
  }
  return kpis;
}

export async function listPeoplePage(
  actor: SessionUser,
  filter: PeopleFilterSpec,
  sort: PeopleSort,
  page: number,
  pageSize: number
): Promise<{ rows: PersonListRow[]; total: number }> {
  const db = await getDb();

  const total = await countPeople(actor, filter);

  let query = withArea(applyFilters(db, actor, filter)).select([...LIST_COLUMNS, ...extraColumns()]);

  query =
    sort.field === "name"
      ? query.orderBy("people.last_name", sort.direction).orderBy("people.first_name", sort.direction)
      : query.orderBy("people.created_at", sort.direction);

  const rows = await query
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();

  const names = await loadOrgDisplayNames(db);
  return { total, rows: (rows as any[]).map((r) => toListRow(r, names)) };
}

/** Sin paginar — solo para exportación, que necesita exactamente el mismo alcance que la grilla. */
export async function listAllMatching(
  actor: SessionUser,
  filter: PeopleFilterSpec,
  sort: PeopleSort
): Promise<PersonListRow[]> {
  const db = await getDb();

  let query = withArea(applyFilters(db, actor, filter)).select([...LIST_COLUMNS, ...extraColumns()]);

  query =
    sort.field === "name"
      ? query.orderBy("people.last_name", sort.direction).orderBy("people.first_name", sort.direction)
      : query.orderBy("people.created_at", sort.direction);

  const rows = await query.execute();
  const names = await loadOrgDisplayNames(db);
  return (rows as any[]).map((r) => toListRow(r, names));
}

export interface PersonDetail extends Omit<PersonListRow, "lastInteractionDate" | "daysSinceInteraction" | "trafficLight"> {
  organizationId: string | null;
  customFields: Record<string, unknown>;
  origin: string;
  version: number;
  updatedAt: Date;
}

/** Ficha por id: null si no existe O está fuera del alcance del usuario (no se distingue). */
export async function getPersonById(actor: SessionUser, id: string): Promise<PersonDetail | null> {
  if (!(await canAccessPerson(actor, id))) return null;

  const db = await getDb();
  const row = await db
    .selectFrom("people")
    .leftJoin("organizations", "organizations.id", "people.organization_id")
    .leftJoin("organizations as area_org", (join) => join.on(sql<boolean>`area_org.id = public.organization_area_id(people.organization_id)`))
    .select([
      sql<string | null>`case when organizations.parent_id is null then null else organizations.name end`.as("reparticion_name"),
      "area_org.name as area_name",
      "area_org.id as area_id",
      "organizations.id as unit_id",
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
  const names = await loadOrgDisplayNames(db);

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
    areaName: displayOf(names, row.area_id, row.area_name),
    reparticionName: row.reparticion_name === null ? null : displayOf(names, row.unit_id, row.reparticion_name),
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
  startsAt: Date | null;
  responseStatus: string;
  attendanceStatus: string;
  statusLabel: string;
  invited: boolean;
  datePrecision: "exact_datetime" | "date_only" | null;
}

/** Actividad histórica y futura: un estado efectivo por jornada o campaña, dentro del alcance. */
export async function getPersonMeetingActivity(actor: SessionUser, personId: string): Promise<PersonMeetingActivityRow[]> {
  if (!(await canAccessPerson(actor, personId))) return [];

  const db = await getDb();
  const result = await sql<{ key: string; name: string; at: Date | null; precision: "exact_datetime" | "date_only" | null; kind: string; response: string | null; invited: boolean; campaign: boolean }>`
    with sources as (
      select mp.meeting_id, mp.campaign_key, mp.participation_kind as kind, null::text as response
      from meeting_participations mp where mp.person_id=${personId}::uuid
      union all
      select mi.meeting_id, null, case when mi.attendance_status in ('attended','absent') then mi.attendance_status
        when mi.response_status='confirmed' then 'confirmed' when mi.response_status='declined' then 'declined' else 'invited' end, mi.response_status
      from meeting_invitations mi where mi.person_id=${personId}::uuid and mi.withdrawn_at is null
      union all
      select ma.meeting_id, null, case when mi.attendance_status='absent' then 'absent' else 'attended' end, null
      from meeting_attendance ma left join meeting_invitations mi on mi.id=ma.invitation_id where ma.person_id=${personId}::uuid
    ), effective as (
      select distinct on (s.meeting_id, s.campaign_key) s.*
      from sources s order by s.meeting_id,s.campaign_key,
        case s.kind when 'attended' then 70 when 'participated' then 65 when 'approved' then 60 when 'absent' then 50
        when 'registration' then 40 when 'confirmed' then 35 when 'declined' then 30 when 'invited' then 20 else 10 end desc
    )
    select coalesce(m.id::text,'campaign:'||e.campaign_key) key,
      coalesce(m.name, 'Campaña: '||e.campaign_key) name, e.kind,
      case when m.schedule_precision='exact_datetime' then m.starts_at when m.schedule_precision='date_only'
        then m.event_date::timestamp at time zone 'America/Argentina/Buenos_Aires' end at,
      case when m.schedule_precision='unknown' then null else m.schedule_precision end as "precision",
      (e.meeting_id is null) campaign,
      exists(select 1 from meeting_invitations mi where mi.person_id=${personId}::uuid and mi.meeting_id=e.meeting_id and mi.withdrawn_at is null) invited,
      (select mi.response_status from meeting_invitations mi where mi.person_id=${personId}::uuid and mi.meeting_id=e.meeting_id and mi.withdrawn_at is null limit 1) response
    from effective e left join meetings m on m.id=e.meeting_id
    where e.meeting_id is null or ${meetingVisibility(actor, "m.id", "m.owner_organization_id")}
    order by at desc nulls last, key
  `.execute(db);
  return result.rows.map((r) => {
    const status = (r.kind === "registration" ? "registered" : r.kind === "unknown" ? "pending" : r.kind) as ParticipantStatus;
    return { meetingId: r.key, meetingName: r.name, startsAt: r.at, responseStatus: r.response ?? "—", attendanceStatus: r.kind,
      statusLabel: (PARTICIPANT_STATUS_LABEL[status] ?? "Pendiente") + (r.campaign && r.kind === "participated" ? " — jornada no determinada" : ""),
      invited: r.invited, datePrecision: r.precision };
  });
}

export interface PersonFormSubmissionRow {
  submissionId: string;
  formName: string;
  createdAt: Date;
}

/** Formularios completados por esta persona. Vacío hasta la Etapa 8. */
export async function getPersonFormSubmissions(actor: SessionUser, personId: string): Promise<PersonFormSubmissionRow[]> {
  if (!(await canAccessPerson(actor, personId))) return [];

  const db = await getDb();
  const rows = await db
    .selectFrom("form_submissions")
    .innerJoin("forms", "forms.id", "form_submissions.form_id")
    .select(["form_submissions.id", "forms.name as form_name", "form_submissions.created_at"])
    .where("form_submissions.person_id", "=", personId)
    .where(orgScope(actor, "forms.owner_organization_id"))
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

/** Semáforo de UNA persona (misma definición que la grilla): null si no existe o está fuera del alcance. */
export async function getPersonTraffic(
  actor: SessionUser,
  personId: string
): Promise<{ lastInteractionDate: string | null; daysSinceInteraction: number | null; trafficLight: TrafficLight } | null> {
  if (!isUuid(personId)) return null;
  const db = await getDb();
  const row = await applyFilters(db, actor, { status: "all" })
    .where("people.id", "=", personId)
    .select([sql<string | null>`li.last_date`.as("last_date"), sql<number | null>`li.days`.as("days")])
    .executeTakeFirst();
  if (!row) return null;
  const days = row.days === null || row.days === undefined ? null : Number(row.days);
  return { lastInteractionDate: row.last_date ?? null, daysSinceInteraction: days, trafficLight: trafficLightOf(days) };
}
