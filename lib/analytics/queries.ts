import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { isOverdueUnclosed, STATUS_LABEL, type MeetingStatus } from "../meetings/state-machine.js";
import type { SessionUser } from "../permissions/can.js";
import { orgScope } from "../scope/organizations.js";
import { listUsersInScope } from "../users/administration.js";

assertServerOnly("lib/analytics/queries.ts");

/**
 * Todos los indicadores se calculan SOLO sobre registros accesibles al usuario:
 * cada consulta parte de `orgScope(actor, ...)` (lib/scope/organizations.ts).
 * MASTER_GLOBAL ve agregados globales; un usuario con alcance limitado, solo los
 * de sus unidades (y dependientes si su alcance las incluye). Ninguna consulta
 * puede agregarse sin pasar por el alcance: por eso todas reciben `actor`.
 *
 * Indicadores siempre calculados en consulta, nunca guardados (lección de
 * la sección 6.2 del prompt): todo acá se deriva de las tablas de negocio
 * en el momento, para que el dashboard y esta pantalla nunca puedan
 * divergir por tener dos cálculos separados del mismo número.
 */

export interface Serie {
  nombre: string;
  valor: number;
}

/**
 * Últimos 12 meses en Buenos Aires (-03:00 fijo, D15: Argentina no observa
 * horario de verano desde 2009), en orden ascendente, "YYYY-MM". Se genera
 * en código para que un mes sin ningún registro aparezca en 0, no ausente
 * — si no, el eje X de un gráfico de línea "saltearía" ese mes.
 *
 * Ojo: tiene que usar la MISMA zona que `monthKeyExpr` del lado SQL. Leer
 * `getUTCMonth()` directo de "ahora" desincroniza los dos lados durante las
 * primeras ~3 horas de cada mes en UTC (que en Buenos Aires todavía son el
 * mes anterior, porque BA siempre está detrás de UTC) — el mes actual
 * quedaría fuera de las 12 claves generadas acá. Se corrige restando el
 * offset antes de leer año/mes, el mismo truco que un `AT TIME ZONE` fijo.
 */
function last12MonthKeys(): string[] {
  const keys: string[] = [];
  const nowInBusinessTz = new Date(Date.now() - 3 * 60 * 60_000);
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(nowInBusinessTz.getUTCFullYear(), nowInBusinessTz.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

function fillMonthlySeries(counts: Map<string, number>): Serie[] {
  return last12MonthKeys().map((mes) => ({ nombre: mes, valor: counts.get(mes) ?? 0 }));
}

/** Expresión SQL de "mes en zona de negocio" (-03:00 fijo, mismo criterio que lib/datetime.ts), reutilizada en cada consulta mensual. */
const monthKeyExpr = (column: string) => sql<string>`to_char(${sql.ref(column)} at time zone '-03:00', 'YYYY-MM')`;

export interface PeopleAnalytics {
  total: number;
  active: number;
  inactive: number;
  byOrigin: Serie[];
  byOrganization: Serie[];
  monthlySignups: Serie[];
  missingDni: number;
  missingEmail: number;
  missingPhone: number;
  missingOrganization: number;
}

export async function getPeopleAnalytics(actor: SessionUser): Promise<PeopleAnalytics> {
  const db = await getDb();
  const inScope = orgScope(actor, "people.organization_id");

  const [statusRows, originRows, orgRows, monthRows, missing] = await Promise.all([
    db.selectFrom("people").where(inScope).select(["status", ({ fn }) => fn.count<number>("id").as("count")]).groupBy("status").execute(),
    db.selectFrom("people").where(inScope).select(["origin", ({ fn }) => fn.count<number>("id").as("count")]).groupBy("origin").execute(),
    db
      .selectFrom("people")
      .where(inScope)
      .leftJoin("organizations", "organizations.id", "people.organization_id")
      .select([
        ({ fn }) => fn.coalesce("organizations.name", sql<string>`'Sin organismo'`).as("name"),
        ({ fn }) => fn.count<number>("people.id").as("count"),
      ])
      .where("people.status", "!=", "merged")
      .groupBy("organizations.name")
      .orderBy("count", "desc")
      .limit(10)
      .execute(),
    db
      .selectFrom("people")
      .where(inScope)
      .select([monthKeyExpr("people.created_at").as("month"), ({ fn }) => fn.count<number>("id").as("count")])
      .where("created_at", ">=", new Date(Date.now() - 366 * 86_400_000))
      .groupBy("month")
      .execute(),
    db
      .selectFrom("people")
      .where(inScope)
      .select([
        ({ fn, eb }) => fn.count<number>(eb.case().when("dni", "is", null).then(1).end()).as("missing_dni"),
        ({ fn, eb }) => fn.count<number>(eb.case().when("email", "is", null).then(1).end()).as("missing_email"),
        ({ fn, eb }) => fn.count<number>(eb.case().when("phone", "is", null).then(1).end()).as("missing_phone"),
        ({ fn, eb }) => fn.count<number>(eb.case().when("organization_id", "is", null).then(1).end()).as("missing_organization"),
      ])
      .where("status", "=", "active")
      .executeTakeFirstOrThrow(),
  ]);

  const active = statusRows.find((r) => r.status === "active")?.count ?? 0;
  const inactive = statusRows.find((r) => r.status === "inactive")?.count ?? 0;
  const merged = statusRows.find((r) => r.status === "merged")?.count ?? 0;

  const ORIGIN_LABEL: Record<string, string> = { manual: "Carga manual", import: "Importación", form: "Formulario" };

  return {
    total: Number(active) + Number(inactive) + Number(merged),
    active: Number(active),
    inactive: Number(inactive),
    byOrigin: originRows.map((r) => ({ nombre: ORIGIN_LABEL[r.origin] ?? r.origin, valor: Number(r.count) })),
    byOrganization: orgRows.map((r) => ({ nombre: r.name, valor: Number(r.count) })),
    monthlySignups: fillMonthlySeries(new Map(monthRows.map((r) => [r.month, Number(r.count)]))),
    missingDni: Number(missing.missing_dni),
    missingEmail: Number(missing.missing_email),
    missingPhone: Number(missing.missing_phone),
    missingOrganization: Number(missing.missing_organization),
  };
}

export interface AssociationsAnalytics {
  total: number;
  active: number;
  inactive: number;
  byType: Serie[];
  topByMembers: Serie[];
}

export async function getAssociationsAnalytics(actor: SessionUser): Promise<AssociationsAnalytics> {
  const db = await getDb();
  const inScope = orgScope(actor, "associations.owner_organization_id");

  const [statusRows, typeRows, topRows] = await Promise.all([
    db.selectFrom("associations").where(inScope).select(["status", ({ fn }) => fn.count<number>("id").as("count")]).groupBy("status").execute(),
    db
      .selectFrom("associations")
      .where(inScope)
      .innerJoin("association_types", "association_types.id", "associations.type_id")
      .select(["association_types.name", ({ fn }) => fn.count<number>("associations.id").as("count")])
      .where("associations.status", "=", "active")
      .groupBy("association_types.name")
      .execute(),
    db
      .selectFrom("associations")
      .where(inScope)
      .leftJoin("people_associations", (join) =>
        join.onRef("people_associations.association_id", "=", "associations.id").on("people_associations.status", "=", "active")
      )
      .select(["associations.name", ({ fn }) => fn.count<number>("people_associations.id").as("count")])
      .where("associations.status", "=", "active")
      .groupBy("associations.name")
      .orderBy("count", "desc")
      .limit(10)
      .execute(),
  ]);

  const active = statusRows.find((r) => r.status === "active")?.count ?? 0;
  const inactive = statusRows.find((r) => r.status === "inactive")?.count ?? 0;

  return {
    total: Number(active) + Number(inactive),
    active: Number(active),
    inactive: Number(inactive),
    byType: typeRows.map((r) => ({ nombre: r.name, valor: Number(r.count) })),
    topByMembers: topRows.map((r) => ({ nombre: r.name, valor: Number(r.count) })),
  };
}

export interface MeetingsAnalytics {
  total: number;
  byStatus: Serie[];
  monthly: Serie[];
  invited: number;
  confirmed: number;
  declined: number;
  pendingResponse: number;
  attendanceRate: number | null;
}

export async function getMeetingsAnalytics(actor: SessionUser): Promise<MeetingsAnalytics> {
  const db = await getDb();
  const inScope = orgScope(actor, "meetings.owner_organization_id");

  const [meetings, monthRows, invitationRows, attendanceCount] = await Promise.all([
    db.selectFrom("meetings").where(inScope).select(["status", "ends_at"]).execute(),
    db
      .selectFrom("meetings")
      .where(inScope)
      .select([monthKeyExpr("starts_at").as("month"), ({ fn }) => fn.count<number>("id").as("count")])
      .where("starts_at", ">=", new Date(Date.now() - 366 * 86_400_000))
      .groupBy("month")
      .execute(),
    db
      .selectFrom("meeting_invitations")
      .innerJoin("meetings", "meetings.id", "meeting_invitations.meeting_id")
      .select(["meeting_invitations.response_status", ({ fn }) => fn.count<number>("meeting_invitations.id").as("count")])
      .where("meeting_invitations.withdrawn_at", "is", null)
      .where(inScope)
      .groupBy("meeting_invitations.response_status")
      .execute(),
    db
      .selectFrom("meeting_attendance")
      .innerJoin("meetings", "meetings.id", "meeting_attendance.meeting_id")
      .select(({ fn }) => fn.count<number>("meeting_attendance.id").as("count"))
      .where(inScope)
      .executeTakeFirstOrThrow(),
  ]);

  const displayStatusCounts = new Map<string, number>();
  for (const m of meetings) {
    const display = isOverdueUnclosed(m.status, m.ends_at) ? "overdue_unclosed" : m.status;
    displayStatusCounts.set(display, (displayStatusCounts.get(display) ?? 0) + 1);
  }

  const invited = invitationRows.reduce((acc, r) => acc + Number(r.count), 0);
  const confirmed = invitationRows.find((r) => r.response_status === "confirmed")?.count ?? 0;
  const declined = invitationRows.find((r) => r.response_status === "declined")?.count ?? 0;
  const pendingResponse = invitationRows.find((r) => r.response_status === "pending")?.count ?? 0;
  const attended = Number(attendanceCount.count);

  return {
    total: meetings.length,
    byStatus: [...displayStatusCounts.entries()].map(([status, count]) => ({
      nombre: STATUS_LABEL[status as MeetingStatus] ?? status,
      valor: count,
    })),
    monthly: fillMonthlySeries(new Map(monthRows.map((r) => [r.month, Number(r.count)]))),
    invited,
    confirmed: Number(confirmed),
    declined: Number(declined),
    pendingResponse: Number(pendingResponse),
    attendanceRate: invited > 0 ? Math.round((attended / invited) * 100) : null,
  };
}

export interface FormsAnalytics {
  totalForms: number;
  publishedForms: number;
  submissionsMonthly: Serie[];
  matchResultBreakdown: Serie[];
  pendingDuplicates: number;
}

const MATCH_RESULT_LABEL: Record<string, string> = {
  pending: "Procesando",
  created: "Persona nueva",
  matched: "Persona existente",
  needs_review: "En revisión",
  error: "Error",
};

export async function getFormsAnalytics(actor: SessionUser): Promise<FormsAnalytics> {
  const db = await getDb();
  const inScope = orgScope(actor, "forms.owner_organization_id");

  const [formStatusRows, monthRows, matchResultRows, pendingCount] = await Promise.all([
    db.selectFrom("forms").where(inScope).select(["status", ({ fn }) => fn.count<number>("id").as("count")]).groupBy("status").execute(),
    db
      .selectFrom("form_submissions")
      .innerJoin("forms", "forms.id", "form_submissions.form_id")
      .select([monthKeyExpr("form_submissions.created_at").as("month"), ({ fn }) => fn.count<number>("form_submissions.id").as("count")])
      .where("form_submissions.created_at", ">=", new Date(Date.now() - 366 * 86_400_000))
      .where(inScope)
      .groupBy("month")
      .execute(),
    db
      .selectFrom("form_submissions")
      .innerJoin("forms", "forms.id", "form_submissions.form_id")
      .select(["form_submissions.match_result", ({ fn }) => fn.count<number>("form_submissions.id").as("count")])
      .where(inScope)
      .groupBy("form_submissions.match_result")
      .execute(),
    db
      .selectFrom("person_duplicate_candidates")
      .innerJoin("form_submissions", "form_submissions.id", "person_duplicate_candidates.submission_id")
      .innerJoin("forms", "forms.id", "form_submissions.form_id")
      .select(({ fn }) => fn.count<number>("person_duplicate_candidates.id").as("count"))
      .where("person_duplicate_candidates.status", "=", "pending")
      .where(inScope)
      .executeTakeFirstOrThrow(),
  ]);

  const totalForms = formStatusRows.reduce((acc, r) => acc + Number(r.count), 0);
  const publishedForms = formStatusRows.find((r) => r.status === "published")?.count ?? 0;

  return {
    totalForms,
    publishedForms: Number(publishedForms),
    submissionsMonthly: fillMonthlySeries(new Map(monthRows.map((r) => [r.month, Number(r.count)]))),
    matchResultBreakdown: matchResultRows.map((r) => ({ nombre: MATCH_RESULT_LABEL[r.match_result] ?? r.match_result, valor: Number(r.count) })),
    pendingDuplicates: Number(pendingCount.count),
  };
}

export interface DashboardCounts {
  users: number;
  people: number;
  associations: number;
  meetings: number;
  invited: number;
  confirmed: number;
  submissions: number;
}

/** Totales del dashboard, calculados solo sobre lo accesible al usuario (mismo alcance que Visualización). */
export async function getDashboardCounts(actor: SessionUser): Promise<DashboardCounts> {
  const db = await getDb();
  const meetingScope = orgScope(actor, "meetings.owner_organization_id");

  const [users, people, associations, meetings, invited, confirmed, submissions] = await Promise.all([
    listUsersInScope(actor).then((rows) => rows.length),
    db.selectFrom("people").select(({ fn }) => fn.count<number>("id").as("count")).where(orgScope(actor, "people.organization_id")).executeTakeFirstOrThrow(),
    db.selectFrom("associations").select(({ fn }) => fn.count<number>("id").as("count")).where(orgScope(actor, "associations.owner_organization_id")).executeTakeFirstOrThrow(),
    db.selectFrom("meetings").select(({ fn }) => fn.count<number>("id").as("count")).where(meetingScope).executeTakeFirstOrThrow(),
    db
      .selectFrom("meeting_invitations")
      .innerJoin("meetings", "meetings.id", "meeting_invitations.meeting_id")
      .select(({ fn }) => fn.count<number>("meeting_invitations.id").as("count"))
      .where("meeting_invitations.withdrawn_at", "is", null)
      .where(meetingScope)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("meeting_invitations")
      .innerJoin("meetings", "meetings.id", "meeting_invitations.meeting_id")
      .select(({ fn }) => fn.count<number>("meeting_invitations.id").as("count"))
      .where("meeting_invitations.withdrawn_at", "is", null)
      .where("meeting_invitations.response_status", "=", "confirmed")
      .where(meetingScope)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("form_submissions")
      .innerJoin("forms", "forms.id", "form_submissions.form_id")
      .select(({ fn }) => fn.count<number>("form_submissions.id").as("count"))
      .where(orgScope(actor, "forms.owner_organization_id"))
      .executeTakeFirstOrThrow(),
  ]);

  return {
    users,
    people: Number(people.count),
    associations: Number(associations.count),
    meetings: Number(meetings.count),
    invited: Number(invited.count),
    confirmed: Number(confirmed.count),
    submissions: Number(submissions.count),
  };
}
