import { sql, type RawBuilder } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { can, isMasterGlobal, type SessionUser } from "../permissions/can.js";
import { campaignVisibility, canAccessPerson, isUuid, meetingVisibility, orgScope } from "../scope/organizations.js";
import { countsAsRealContactSql, isParticipationDerivedSql } from "../contacts/real-contact.js";
import { BASIS_COPY, ATTENDANCE_METHOD_COPY, INVITATION_CHANNEL_LABEL, RESPONSE_CHANNEL_LABEL, INVITATION_RESPONSE_LABEL } from "../activities/labels.js";
import { sanitizeFreeText } from "./sanitize-text.js";
import { formatTimelineDate } from "./timeline-format.js";
import { interactionAgeDays, interactionDay } from "./traffic-sql.js";

assertServerOnly("lib/people/timeline.ts");

/**
 * LÍNEA DE TIEMPO DE UNA PERSONA (B5). Cada hecho conserva su categoría: invitación ≠ respuesta ≠ inscripción ≠ participación ≠
 * asistencia ≠ contacto. Nada se colapsa en un estado y nada se deduce de otra cosa.
 *
 * REGLAS (aprobadas):
 *  - Visibilidad del HECHO = alcance ACTUAL de la persona (`canAccessPerson`). El dueño histórico de una interacción NO hace
 *    desaparecer el hecho; solo puede reservar el DETALLE (asunto/nota/resultado/responsable).
 *  - Una línea por hecho + una por acto administrativo relevante (retirada/reinvitación, anulación/restauración, revocación/
 *    restauración, cambio real de respuesta). `corrected` no es línea: queda como detalle de su hecho. El hecho se dibuja desde
 *    su fila (inscripción, asistencia) o desde su evento de origen (invitación/respuesta); el evento `registered`/`checked_in`
 *    NO genera una segunda línea. Históricos sin eventos usan la fila.
 *  - Las interacciones derivadas de una participación (`meeting_participation:*`) NO son líneas: ya existe «Participación».
 *  - Fechas: la del HECHO. Sin fecha real → `at = null` y va al final en «Eventos sin fecha registrada». Jamás created_at,
 *    fecha de importación ni legacy_reference.
 *  - Ninguna categoría excepto `contact` puede contar como contacto real, y solo si cumple `countsAsRealContact`.
 *  - Todo texto libre pasa por `sanitizeFreeText`; los títulos se arman con vocabularios cerrados, nunca con texto libre.
 */

export type TimelineCategory = "contact" | "invitation" | "registration" | "participation" | "attendance";
export const TIMELINE_CATEGORIES: readonly TimelineCategory[] = ["contact", "invitation", "registration", "participation", "attendance"];
export const TIMELINE_CATEGORY_LABEL: Record<TimelineCategory, string> = {
  contact: "Contactos",
  invitation: "Invitaciones",
  registration: "Inscripciones",
  participation: "Actividades",
  attendance: "Asistencia",
};
export function isTimelineCategory(value: unknown): value is TimelineCategory {
  return typeof value === "string" && (TIMELINE_CATEGORIES as readonly string[]).includes(value);
}

export type TimelinePrecision = "exact_datetime" | "date_only";

export interface TimelineEvent {
  /** Estable y único (cursor/deduplicación). */
  id: string;
  category: TimelineCategory;
  kind: string;
  title: string;
  description: string | null;
  /** Fecha del HECHO; null = no registrada. */
  at: Date | null;
  precision: TimelinePrecision | null;
  activity: { type: "meeting" | "campaign"; id: string | null; name: string | null } | null;
  /** Fecha de la actividad (contexto para los hechos sin fecha propia; NUNCA se usa para ordenar). */
  activityDate: Date | null;
  activityPrecision: TimelinePrecision | null;
  origin: string | null;
  recordedBy: string | null;
  provenance: string[];
  /** Solo true para una interacción que cumple la regla canónica. */
  countsAsContact: boolean;
  /** Acto administrativo (anulación, restauración, retiro, revocación, cambio de respuesta). */
  administrative: boolean;
  /** Líneas de detalle ya sanitizadas (motivos, correcciones). */
  details: string[];
}

export interface TimelinePage {
  events: TimelineEvent[];
  nextCursor: string | null;
  counts: Record<TimelineCategory, number>;
}

const BA = "America/Argentina/Buenos_Aires";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const CHANNEL_LABEL: Record<string, string> = {
  presencial: "presencial",
  telefono: "teléfono",
  correo: "correo",
  whatsapp: "WhatsApp",
  sms: "SMS",
  formulario: "formulario",
  otro: "otro canal",
};

const REGISTRATION_CHANNEL_LABEL: Record<string, string> = { ...INVITATION_CHANNEL_LABEL };

// ------------------------------------------------------------------------------------------------------------------
// Consulta
// ------------------------------------------------------------------------------------------------------------------
const actAt = (m: string) => sql`case when ${sql.ref(`${m}.schedule_precision`)} = 'exact_datetime' then ${sql.ref(`${m}.starts_at`)}
  when ${sql.ref(`${m}.schedule_precision`)} = 'date_only' then (${sql.ref(`${m}.event_date`)}::timestamp at time zone ${sql.lit(BA)}) end`;
const actPrec = (m: string) => sql`case when ${sql.ref(`${m}.schedule_precision`)} in ('exact_datetime', 'date_only') then ${sql.ref(`${m}.schedule_precision`)} end`;

interface Ctx {
  actor: SessionUser;
  personId: string;
}

/**
 * CTE `tl`: una fila por línea posible, SIN paginar ni filtrar. Columnas fijas (el orden importa en los UNION):
 * cat, kind, rank, ref, at, prec, act_type, act_id, act_name, act_at, act_prec, by_id, channel, reason, admin, active, counts_contact, extra.
 */
function timelineCte({ actor, personId }: Ctx): RawBuilder<unknown> {
  const p = sql`${personId}::uuid`;
  const meetingName = (m: string) => sql`case when ${meetingVisibility(actor, `${m}.id`, `${m}.owner_organization_id`)} then ${sql.ref(`${m}.name`)} end`;
  const campaignName = (c: string) => sql`case when ${campaignVisibility(actor, `${c}.id`, `${c}.owner_organization_id`, `${c}.campaign_key`)} then ${sql.ref(`${c}.name`)} end`;
  const detailOk = sql`(${sql.lit(can(actor, "interactions.view"))} and ${orgScope(actor, "pi.owner_organization_id")})`;

  return sql`tl as materialized (
    -- INVITACIÓN: eventos (invited/reinvited/withdrawn/responded/response_changed). Un cambio de respuesta con from = to es una
    -- corrección de metadata: no es línea.
    select 'invitation'::text cat, e.event_type::text kind, 30 rank, 'inv:' || e.id::text ref,
           case e.event_type when 'responded' then e.responded_at else e.occurred_at end at,
           (case e.event_type when 'responded' then e.responded_at_precision else 'exact_datetime' end)::text prec,
           'meeting'::text act_type, m.id::text act_id, ${meetingName("m")}::text act_name, ${actAt("m")} act_at, ${actPrec("m")}::text act_prec,
           e.recorded_by by_id, coalesce(e.response_channel, e.invitation_channel)::text channel, null::text reason,
           (e.event_type in ('withdrawn', 'reinvited', 'response_changed')) admin, (i.withdrawn_at is null) active, false counts_contact,
           jsonb_build_object('from', e.response_status_from, 'to', e.response_status_to) extra
    from meeting_invitation_events e
    join meeting_invitations i on i.id = e.invitation_id
    join meetings m on m.id = i.meeting_id
    where i.person_id = ${p}
      and not (e.event_type = 'response_changed' and e.response_status_from is not distinct from e.response_status_to)
    union all
    -- INVITACIÓN histórica SIN eventos: se usa la fila.
    select 'invitation', 'invited', 30, 'invrow:' || i.id::text, i.invited_at, 'exact_datetime',
           'meeting', m.id::text, ${meetingName("m")}, ${actAt("m")}, ${actPrec("m")},
           i.invited_by, i.invitation_channel, null, false, (i.withdrawn_at is null), false, '{}'::jsonb
    from meeting_invitations i join meetings m on m.id = i.meeting_id
    where i.person_id = ${p} and not exists (select 1 from meeting_invitation_events e where e.invitation_id = i.id)
    union all
    select 'invitation', 'responded', 30, 'invresp:' || i.id::text, i.responded_at, i.responded_at_precision,
           'meeting', m.id::text, ${meetingName("m")}, ${actAt("m")}, ${actPrec("m")},
           i.response_recorded_by, i.response_channel, null, false, (i.withdrawn_at is null), false,
           jsonb_build_object('to', i.response_status)
    from meeting_invitations i join meetings m on m.id = i.meeting_id
    where i.person_id = ${p} and i.response_status in ('confirmed', 'declined')
      and not exists (select 1 from meeting_invitation_events e where e.invitation_id = i.id)
    union all
    -- INSCRIPCIÓN: la fila ES el hecho (operativa o histórica). Fecha = registered_at (NULL en lo histórico). Las correcciones
    -- quedan como detalle.
    select 'registration', 'registration', 40, 'reg:' || mp.id::text, mp.registered_at, mp.registered_at_precision,
           (case when mp.meeting_id is not null then 'meeting' else 'campaign' end), coalesce(m.id::text, c.id::text),
           (case when mp.meeting_id is not null then ${meetingName("m")} else ${campaignName("c")} end), ${actAt("m")}, ${actPrec("m")},
           mp.recorded_by, mp.origin_channel, null, false, (mp.voided_at is null), false,
           jsonb_build_object('operative', mp.recorded_by is not null, 'fromAcceptance', mp.origin_invitation_id is not null,
                              'imported', mp.import_row_id is not null, 'voided', mp.voided_at is not null,
                              'corrections', coalesce((select jsonb_agg(jsonb_build_object('at', ce.occurred_at, 'reason', ce.reason, 'by', ce.recorded_by) order by ce.seq)
                                                       from meeting_registration_events ce where ce.participation_id = mp.id and ce.event_type = 'corrected'), '[]'::jsonb))
    from meeting_participations mp
    left join meetings m on m.id = mp.meeting_id
    left join campaigns c on mp.meeting_id is null and c.campaign_key = mp.campaign_key
    where mp.person_id = ${p} and mp.participation_kind = 'registration'
    union all
    select 'registration', e.event_type, 41, 'regev:' || e.id::text, e.occurred_at, 'exact_datetime',
           (case when mp.meeting_id is not null then 'meeting' else 'campaign' end), coalesce(m.id::text, c.id::text),
           (case when mp.meeting_id is not null then ${meetingName("m")} else ${campaignName("c")} end), ${actAt("m")}, ${actPrec("m")},
           e.recorded_by, null, e.reason, true, false, false, '{}'::jsonb
    from meeting_registration_events e
    join meeting_participations mp on mp.id = e.participation_id
    left join meetings m on m.id = mp.meeting_id
    left join campaigns c on mp.meeting_id is null and c.campaign_key = mp.campaign_key
    where mp.person_id = ${p} and e.event_type in ('voided', 'restored')
    union all
    -- PARTICIPACIÓN (todo lo que no es inscripción): fecha de la actividad; campaña sin jornada → sin fecha.
    select 'participation', mp.participation_kind || '/' || mp.participation_basis, 50, 'part:' || mp.id::text,
           ${actAt("m")}, ${actPrec("m")},
           (case when mp.meeting_id is not null then 'meeting' else 'campaign' end), coalesce(m.id::text, c.id::text),
           (case when mp.meeting_id is not null then ${meetingName("m")} else ${campaignName("c")} end), ${actAt("m")}, ${actPrec("m")},
           null::uuid, null, null, false, true, false,
           jsonb_build_object('basis', mp.participation_basis, 'participationKind', mp.participation_kind, 'imported', mp.import_row_id is not null)
    from meeting_participations mp
    left join meetings m on m.id = mp.meeting_id
    left join campaigns c on mp.meeting_id is null and c.campaign_key = mp.campaign_key
    where mp.person_id = ${p} and mp.participation_kind <> 'registration'
    union all
    -- ASISTENCIA: la fila ES el hecho; revocación/restauración son actos propios.
    select 'attendance', 'attendance', 60, 'att:' || a.id::text, a.checked_in_at,
           (case a.occurred_precision when 'unknown' then null else a.occurred_precision end)::text,
           'meeting', m.id::text, ${meetingName("m")}, ${actAt("m")}, ${actPrec("m")},
           a.registered_by, null, a.correction_reason, false, (a.revoked_at is null), false,
           jsonb_build_object('method', a.method, 'revoked', a.revoked_at is not null,
                              'corrections', coalesce((select jsonb_agg(jsonb_build_object('at', ce.occurred_at, 'reason', ce.reason, 'by', ce.recorded_by) order by ce.seq)
                                                       from meeting_attendance_events ce where ce.attendance_id = a.id and ce.event_type = 'corrected'), '[]'::jsonb))
    from meeting_attendance a join meetings m on m.id = a.meeting_id
    where a.person_id = ${p}
    union all
    select 'attendance', e.event_type, 61, 'attev:' || e.id::text, e.occurred_at, 'exact_datetime',
           'meeting', m.id::text, ${meetingName("m")}, ${actAt("m")}, ${actPrec("m")},
           e.recorded_by, null, e.reason, true, false, false, '{}'::jsonb
    from meeting_attendance_events e
    join meeting_attendance a on a.id = e.attendance_id
    join meetings m on m.id = a.meeting_id
    where a.person_id = ${p} and e.event_type in ('revoked', 'restored')
    union all
    -- CONTACTO: interacciones que NO son el espejo técnico de una participación. Solo cuentan las que cumplen la regla canónica.
    select 'contact', 'interaction', 70, 'int:' || pi.id::text, pi.occurred_at, pi.occurred_precision,
           (case when pi.meeting_id is not null then 'meeting' end), m.id::text, ${meetingName("m")}, ${actAt("m")}, ${actPrec("m")},
           pi.responsible_user_id, ch.key, null, false, (pi.status in ('open', 'completed')), ${countsAsRealContactSql("pi")},
           jsonb_build_object('typeKey', it.key, 'status', pi.status, 'detailOk', ${detailOk},
                              'subject', pi.subject, 'description', pi.description, 'outcome', pi.outcome)
    from person_interactions pi
    join interaction_types it on it.id = pi.interaction_type_id
    left join interaction_channels ch on ch.id = pi.channel_id
    left join meetings m on m.id = pi.meeting_id
    where pi.person_id = ${p} and pi.status in ('open', 'completed') and not ${isParticipationDerivedSql("pi")}
  )`;
}

// ------------------------------------------------------------------------------------------------------------------
// Cursor
// ------------------------------------------------------------------------------------------------------------------
interface Cursor {
  /** microsegundos desde epoch; null = sin fecha */
  ts: string | null;
  rank: number;
  ref: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}
function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if ((c.ts !== null && !/^-?\d+$/.test(c.ts)) || !Number.isInteger(c.rank) || typeof c.ref !== "string") return null;
    return c;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Armado de líneas
// ------------------------------------------------------------------------------------------------------------------
interface Row {
  cat: TimelineCategory;
  kind: string;
  rank: number;
  ref: string;
  at: Date | null;
  prec: TimelinePrecision | null;
  ts: string | null;
  act_type: "meeting" | "campaign" | null;
  act_id: string | null;
  act_name: string | null;
  act_at: Date | null;
  act_prec: TimelinePrecision | null;
  by_id: string | null;
  channel: string | null;
  reason: string | null;
  admin: boolean;
  active: boolean;
  counts_contact: boolean;
  extra: Record<string, any>;
  recorder_name: string | null;
}

interface Viewer {
  sensitive: boolean;
  actors: boolean;
}

function viewerOf(actor: SessionUser): Viewer {
  return {
    sensitive: can(actor, "people.view_sensitive"),
    // Nombres de operadores y motivos: solo quien gestiona invitaciones/inscripciones/asistencia (misma convención de B2–B4).
    actors: isMasterGlobal(actor) || can(actor, "meetings.manage_invitations") || can(actor, "meetings.attendance_manual"),
  };
}

function toEvent(r: Row, v: Viewer): TimelineEvent {
  const activityName = r.act_type ? r.act_name : null;
  const activity = r.act_type ? { type: r.act_type, id: r.act_id, name: activityName ? sanitizeFreeText(activityName, v.sensitive) : null } : null;
  const recordedBy = v.actors ? r.recorder_name : null;
  const reason = v.actors ? sanitizeFreeText(r.reason, v.sensitive) : null;
  const details: string[] = [];
  const provenance: string[] = [];
  let title = "";
  let description: string | null = null;
  let origin: string | null = null;
  const x = r.extra ?? {};

  const addCorrections = () => {
    const list = Array.isArray(x.corrections) ? (x.corrections as Array<{ at: string; reason: string | null }>) : [];
    for (const c of list) {
      const when = formatTimelineDate(c.at, "date_only");
      const why = v.actors ? sanitizeFreeText(c.reason, v.sensitive) : null;
      details.push(`Corregido el ${when}${why ? `: ${why}` : ""}`);
    }
  };

  switch (r.cat) {
    case "invitation": {
      if (r.kind === "invited") { title = "Invitación"; origin = r.channel ? (INVITATION_CHANNEL_LABEL as Record<string, string>)[r.channel] ?? null : null; }
      else if (r.kind === "reinvited") { title = "Reinvitación"; origin = r.channel ? (INVITATION_CHANNEL_LABEL as Record<string, string>)[r.channel] ?? null : null; }
      else if (r.kind === "withdrawn") title = "Invitación retirada";
      else if (r.kind === "responded") {
        title = `Respuesta a la invitación: ${(INVITATION_RESPONSE_LABEL as Record<string, string>)[x.to] ?? "—"}`;
        origin = r.channel ? (RESPONSE_CHANNEL_LABEL as Record<string, string>)[r.channel] ?? null : null;
        provenance.push("Una respuesta a una invitación no cuenta como contacto");
      } else if (r.kind === "response_changed") {
        const f = (INVITATION_RESPONSE_LABEL as Record<string, string>)[x.from] ?? "—";
        const t = (INVITATION_RESPONSE_LABEL as Record<string, string>)[x.to] ?? "—";
        title = `Cambió la respuesta a la invitación: ${f} → ${t}`;
        origin = r.channel ? (RESPONSE_CHANNEL_LABEL as Record<string, string>)[r.channel] ?? null : null;
      } else title = "Invitación";
      break;
    }
    case "registration": {
      if (r.kind === "voided") { title = "Inscripción anulada"; if (reason) details.push(`Motivo: ${reason}`); }
      else if (r.kind === "restored") { title = "Inscripción restaurada"; if (reason) details.push(`Motivo: ${reason}`); }
      else {
        title = x.voided ? "Inscripción (anulada)" : "Inscripción";
        provenance.push(x.operative ? (x.fromAcceptance ? "Inscripción desde la aceptación de la invitación" : "Inscripción cargada en el CRM") : x.imported ? "Inscripción según listado importado" : "Inscripción registrada en el sistema");
        origin = r.channel ? REGISTRATION_CHANNEL_LABEL[r.channel] ?? null : null;
        addCorrections();
      }
      break;
    }
    case "participation": {
      const basis = (x.basis ?? "standard") as keyof typeof BASIS_COPY;
      title = x.participationKind === "attended" ? "Participación con evidencia registrada" : BASIS_COPY[basis] ?? "Participación";
      provenance.push(x.imported ? "Según listado importado" : "Registrada en el sistema");
      break;
    }
    case "attendance": {
      if (r.kind === "revoked") { title = "Asistencia revocada"; if (reason) details.push(`Motivo: ${reason}`); }
      else if (r.kind === "restored") { title = "Asistencia restaurada"; if (reason) details.push(`Motivo: ${reason}`); }
      else {
        title = x.revoked ? "Asistencia (revocada)" : "Asistencia";
        provenance.push((ATTENDANCE_METHOD_COPY as Record<string, string>)[x.method ?? ""] ?? "Asistencia comprobada");
        if (x.method === "manual" && reason) details.push(`Motivo de la carga manual: ${reason}`);
        addCorrections();
      }
      break;
    }
    case "contact": {
      const ch = r.channel ? CHANNEL_LABEL[r.channel] ?? "otro canal" : "sin canal";
      if (r.counts_contact) {
        title = `Contacto por ${ch}`;
      } else {
        title = `Interacción registrada (${ch})`; // la UI la marca «No cuenta como contacto»
      }
      // El HECHO se ve siempre; el DETALLE solo si la unidad dueña de la interacción está en el alcance (o es Master).
      if (x.detailOk) {
        description = sanitizeFreeText(x.subject, v.sensitive);
        const extra = sanitizeFreeText(x.description, v.sensitive);
        if (extra) details.push(extra);
        const outcome = sanitizeFreeText(x.outcome, v.sensitive);
        if (outcome) details.push(`Resultado: ${outcome}`);
      } else {
        provenance.push("Detalle reservado a la unidad que lo registró");
      }
      break;
    }
  }

  return {
    id: r.ref,
    category: r.cat,
    kind: r.kind,
    title,
    description,
    at: r.at,
    precision: r.at ? r.prec : null,
    activity,
    activityDate: r.act_at,
    activityPrecision: r.act_prec,
    origin,
    // Un contacto muestra a su responsable solo si el lector ve el detalle de la interacción; el resto, según permisos de gestión.
    recordedBy: r.cat === "contact" ? (x.detailOk ? r.recorder_name : null) : recordedBy,
    provenance,
    countsAsContact: r.counts_contact === true,
    administrative: r.admin,
    details,
  };
}

// ------------------------------------------------------------------------------------------------------------------
// API
// ------------------------------------------------------------------------------------------------------------------
export interface TimelineOptions {
  categories?: readonly TimelineCategory[];
  cursor?: string | null;
  limit?: number;
}

const emptyCounts = (): Record<TimelineCategory, number> => ({ contact: 0, invitation: 0, registration: 0, participation: 0, attendance: 0 });

export async function getPersonTimeline(actor: SessionUser, personId: string, options: TimelineOptions = {}): Promise<TimelinePage | null> {
  if (!isUuid(personId)) return null;
  const db = await getDb();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const cats = (options.categories ?? []).filter(isTimelineCategory);
  const catFilter = cats.length > 0 ? sql`and t.cat = any(${[...cats]}::text[])` : sql``;
  const cursor = decodeCursor(options.cursor);
  // Orden: con fecha primero (más reciente primero), después los sin fecha; desempate estable por rango y ref.
  let after = sql``;
  if (cursor) {
    after =
      cursor.ts === null
        ? sql`and t.ts is null and (t.rank > ${cursor.rank} or (t.rank = ${cursor.rank} and t.ref > ${cursor.ref}))`
        : sql`and (t.ts is null or t.ts < ${cursor.ts}::bigint or (t.ts = ${cursor.ts}::bigint and (t.rank > ${cursor.rank} or (t.rank = ${cursor.rank} and t.ref > ${cursor.ref}))))`;
  }
  const cte = timelineCte({ actor, personId });

  // Tres lecturas independientes en una tanda (el pool tiene 10 conexiones): acceso, líneas y conteos por categoría.
  const [allowed, rows, counts] = await Promise.all([
    canAccessPerson(actor, personId),
    sql<Row>`
      with ${cte},
      tt as (select tl.*, floor(extract(epoch from tl.at) * 1000000)::bigint as ts from tl)
      select t.cat, t.kind, t.rank, t.ref, t.at, t.prec, t.ts::text as ts, t.act_type, t.act_id, t.act_name, t.act_at, t.act_prec, t.by_id,
             t.channel, t.reason, t.admin, t.active, t.counts_contact, t.extra, u.full_name as recorder_name
      from tt t left join users u on u.id = t.by_id
      where true ${catFilter} ${after}
      order by (t.ts is null), t.ts desc, t.rank, t.ref
      limit ${limit + 1}`.execute(db),
    sql<{ cat: TimelineCategory; n: number }>`with ${cte} select cat, count(*)::int n from tl group by cat`.execute(db),
  ]);
  if (!allowed) return null;

  const v = viewerOf(actor);
  const page = rows.rows.slice(0, limit);
  const last = page[page.length - 1];
  const more = rows.rows.length > limit && last;
  const countMap = emptyCounts();
  for (const c of counts.rows) countMap[c.cat] = Number(c.n);
  return {
    events: page.map((r) => toEvent(r, v)),
    nextCursor: more ? encodeCursor({ ts: last!.ts, rank: last!.rank, ref: last!.ref }) : null,
    counts: countMap,
  };
}

// ------------------------------------------------------------------------------------------------------------------
// Estado de relación (tarjetas separadas)
// ------------------------------------------------------------------------------------------------------------------
export interface RelationshipFact {
  at: Date | null;
  precision: TimelinePrecision | null;
  title: string;
  activityName: string | null;
  /** Si hay hechos vigentes pero ninguno con fecha real: «Fecha no registrada». */
  undated: boolean;
}

export interface LastContact {
  /** Día (AAAA-MM-DD, Buenos Aires) y antigüedad en días. */
  date: string;
  days: number;
  at: Date;
  precision: TimelinePrecision;
  channel: string;
  channelLabel: string;
  /** Solo si el lector puede ver el detalle de la interacción (Master, o su unidad es la dueña + interactions.view). */
  detail: { type: string; outcome: string | null; responsible: string | null } | null;
}

export interface PersonRelationship {
  lastContact: LastContact | null;
  lastActivity: RelationshipFact | null;
  lastRegistration: RelationshipFact | null;
  lastParticipation: RelationshipFact | null;
  lastAttendance: RelationshipFact | null;
}

const TYPE_LABEL: Record<string, string> = { consulta: "Consulta", llamada: "Llamada", gestion: "Gestión", visita: "Visita", otro: "Otro" };

/**
 * «Último contacto» y «Última actividad» son cosas distintas y nunca se mezclan:
 *  - Último contacto = la interacción más reciente que cumple `countsAsRealContact` (nada más lo mueve).
 *  - Última actividad = el hecho vigente con fecha real más reciente de cualquier categoría (invitación, respuesta, inscripción,
 *    participación, asistencia, interacción). Excluye actos administrativos, anuladas/revocadas/retiradas, futuras y sin fecha.
 */
export async function getPersonRelationship(actor: SessionUser, personId: string): Promise<PersonRelationship | null> {
  if (!isUuid(personId)) return null;
  const db = await getDb();
  const cte = timelineCte({ actor, personId });
  const detailOk = sql`(${sql.lit(can(actor, "interactions.view"))} and ${orgScope(actor, "pi.owner_organization_id")})`;
  const [allowed, facts, undatedRows, contact] = await Promise.all([
    canAccessPerson(actor, personId),
    sql<Row & { grp: string }>`
      with ${cte},
      tt as (select tl.*, floor(extract(epoch from tl.at) * 1000000)::bigint as ts from tl where tl.at is not null and not tl.admin and tl.active and tl.at <= now())
      select * from (
        select 'activity' as grp, t.*, null::text as recorder_name, row_number() over (order by t.ts desc, t.rank, t.ref) rn from tt t
        union all select 'registration', t.*, null, row_number() over (order by t.ts desc, t.rank, t.ref) from tt t where t.cat = 'registration'
        union all select 'participation', t.*, null, row_number() over (order by t.ts desc, t.rank, t.ref) from tt t where t.cat = 'participation'
        union all select 'attendance', t.*, null, row_number() over (order by t.ts desc, t.rank, t.ref) from tt t where t.cat = 'attendance'
      ) r where rn = 1`.execute(db),
    sql<{ cat: string; n: number }>`with ${cte} select cat, count(*)::int n from tl where not admin and active group by cat`.execute(db),
    sql<{ at: Date; prec: TimelinePrecision; channel: string; type_key: string; outcome: string | null; responsible: string | null; detail_ok: boolean; day: string; days: number }>`
      select pi.occurred_at as at, pi.occurred_precision as prec, ch.key as channel, it.key as type_key, pi.outcome, u.full_name as responsible,
             ${detailOk} as detail_ok, to_char(${interactionDay(sql`pi.occurred_at`)}, 'YYYY-MM-DD') as day, ${interactionAgeDays(interactionDay(sql`pi.occurred_at`))} as days
      from person_interactions pi
      join interaction_channels ch on ch.id = pi.channel_id
      join interaction_types it on it.id = pi.interaction_type_id
      left join users u on u.id = pi.responsible_user_id
      where pi.person_id = ${personId}::uuid and ${countsAsRealContactSql("pi")}
      order by ${interactionDay(sql`pi.occurred_at`)} desc, pi.occurred_at desc, pi.id
      limit 1`.execute(db),
  ]);
  if (!allowed) return null;

  const v = viewerOf(actor);
  const active = new Map<string, number>(undatedRows.rows.map((r) => [r.cat, Number(r.n)]));
  const byGroup = new Map<string, RelationshipFact>();
  for (const r of facts.rows) {
    const e = toEvent(r as Row, v);
    byGroup.set(r.grp, { at: e.at, precision: e.precision, title: e.title, activityName: e.activity?.name ?? null, undated: false });
  }
  const undatedFact = (cat: TimelineCategory, label: string): RelationshipFact | null =>
    (active.get(cat) ?? 0) > 0 ? { at: null, precision: null, title: label, activityName: null, undated: true } : null;

  const c = contact.rows[0];
  const lastContact: LastContact | null = c
    ? {
        date: c.day,
        days: Number(c.days),
        at: c.at,
        precision: c.prec,
        channel: c.channel,
        channelLabel: CHANNEL_LABEL[c.channel] ?? "otro canal",
        detail: c.detail_ok ? { type: TYPE_LABEL[c.type_key] ?? "Interacción", outcome: sanitizeFreeText(c.outcome, v.sensitive), responsible: c.responsible } : null,
      }
    : null;

  const anyActive = [...active.values()].some((n) => n > 0);
  return {
    lastContact,
    lastActivity: byGroup.get("activity") ?? (anyActive ? { at: null, precision: null, title: "Actividad sin fecha registrada", activityName: null, undated: true } : null),
    lastRegistration: byGroup.get("registration") ?? undatedFact("registration", "Inscripción"),
    lastParticipation: byGroup.get("participation") ?? undatedFact("participation", "Participación"),
    lastAttendance: byGroup.get("attendance") ?? undatedFact("attendance", "Asistencia"),
  };
}

// ------------------------------------------------------------------------------------------------------------------
// Vista técnica (solo Master): las interacciones derivadas de participación, fuera del timeline principal.
// ------------------------------------------------------------------------------------------------------------------
export interface TechnicalInteraction {
  id: string;
  occurredAt: Date;
  precision: TimelinePrecision;
  dateBasis: "actual" | "legacy_reference";
  sourceKey: string | null;
  subject: string;
  status: string;
}

export async function getPersonTechnicalInteractions(actor: SessionUser, personId: string): Promise<TechnicalInteraction[]> {
  if (!isMasterGlobal(actor) || !isUuid(personId)) return [];
  const db = await getDb();
  const rows = await sql<{ id: string; occurred_at: Date; occurred_precision: TimelinePrecision; date_basis: "actual" | "legacy_reference"; source_key: string | null; subject: string; status: string }>`
    select pi.id, pi.occurred_at, pi.occurred_precision, pi.date_basis, pi.source_key, pi.subject, pi.status
    from person_interactions pi
    where pi.person_id = ${personId}::uuid and ${isParticipationDerivedSql("pi")}
    order by pi.occurred_at desc, pi.id`.execute(db);
  return rows.rows.map((r) => ({ id: r.id, occurredAt: r.occurred_at, precision: r.occurred_precision, dateBasis: r.date_basis, sourceKey: r.source_key, subject: r.subject, status: r.status }));
}
