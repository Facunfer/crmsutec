import { sql, type Transaction } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import type { Database, RegistrationChannel, RegistrationEventType } from "../db/schema.js";
import type { SessionUser } from "../permissions/can.js";
import { campaignVisibility, canAccessMeeting, isPersonInScope, isUuid, orgScope, personInScope } from "../scope/organizations.js";
import { INVITATION_CHANNELS, isInvitationChannel } from "../activities/labels.js";

assertServerOnly("lib/meetings/registrations.ts");

/**
 * INSCRIPCIÓN OPERATIVA (B4). La inscripción es un hecho independiente: NO es invitación, respuesta, participación ni asistencia, y
 * ninguna acción de este módulo crea (ni modifica) invitaciones, respuestas, participaciones, asistencia ni `person_interactions`.
 * La fila vive en `meeting_participations` (kind `registration`, base `standard`); su historial en `meeting_registration_events`.
 *
 * Dos clases de inscripción operativa, siempre a nivel reunión/jornada (nunca a nivel campaña):
 *   A. manual individual  → recorded_by + origin_channel (canal REAL por el que llegó la solicitud);
 *   B. desde aceptación   → recorded_by + origin_invitation_id (la invitación confirmada que la originó). El canal con que la persona
 *      respondió es otro hecho y vive en la invitación: NO se copia como canal de inscripción.
 * Las inscripciones históricas/importadas no tienen operador, fecha, canal ni invitación de origen y no reciben eventos retroactivos;
 * solo admiten anulación/restauración administrativa.
 *
 * INVARIANTE DE INTEGRIDAD DEL HISTORIAL (aplicación, no de base de datos): toda mutación operativa de inscripciones pasa
 * EXCLUSIVAMENTE por los comandos transaccionales de este módulo, que cambian la fila Y registran su evento en la MISMA
 * transacción, con la fila bloqueada (FOR UPDATE) cuando corresponde. La base impone combinaciones imposibles (0041) y que el
 * historial sea append-only (0042), pero no que exista un evento por cada cambio. Permiso temporal: `meetings.manage_invitations`
 * (hasta la Fase C), más acceso a la reunión y persona dentro del alcance actual.
 */

export class RegistrationError extends Error {}
type Trx = Transaction<Database>;

const BA = "America/Argentina/Buenos_Aires";
/** Estados en los que se inscribe con normalidad. `finished` solo admite carga retroactiva; `cancelled` no admite nada. */
const NORMAL_STATUSES = new Set(["draft", "scheduled", "in_progress"]);

/** Cuándo ocurrió la inscripción. `now` solo en una actividad no finalizada; en una finalizada hay que indicar cuándo (o que se desconoce). */
export type EnrollmentWhen =
  | { kind: "now" }
  | { kind: "exact"; at: Date }
  /** Solo se conoce el día (AAAA-MM-DD, Buenos Aires): medianoche local con precisión `date_only`. */
  | { kind: "date_only"; day: string }
  /** Se desconoce cuándo se inscribió: registered_at queda NULL. Nunca se inventa una fecha. */
  | { kind: "unknown" };

interface ResolvedWhen {
  registeredAt: Date | null;
  precision: "exact_datetime" | "date_only" | null;
}

async function resolveWhen(trx: Trx, when: EnrollmentWhen, now: Date, meetingStatus: string | null): Promise<ResolvedWhen> {
  switch (when.kind) {
    case "now":
      if (meetingStatus === "finished") {
        throw new RegistrationError("En una actividad finalizada es una carga retroactiva: indicá cuándo se inscribió la persona (día y hora, solo el día, o que se desconoce).");
      }
      return { registeredAt: now, precision: "exact_datetime" };
    case "exact":
      if (!(when.at instanceof Date) || Number.isNaN(when.at.getTime())) throw new RegistrationError("Fecha de inscripción inválida.");
      if (when.at.getTime() > now.getTime()) throw new RegistrationError("La fecha de la inscripción no puede ser futura.");
      return { registeredAt: when.at, precision: "exact_datetime" };
    case "date_only": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(when.day)) throw new RegistrationError("Fecha de inscripción inválida.");
      let ts: Date | null = null;
      try {
        ts = (await sql<{ ts: Date | null }>`select (${when.day}::date::timestamp at time zone ${BA}) as ts`.execute(trx)).rows[0]?.ts ?? null;
      } catch {
        ts = null;
      }
      if (!ts) throw new RegistrationError("Fecha de inscripción inválida.");
      if (ts.getTime() > now.getTime()) throw new RegistrationError("La fecha de la inscripción no puede ser futura.");
      return { registeredAt: ts, precision: "date_only" };
    }
    case "unknown":
      return { registeredAt: null, precision: null };
    default:
      throw new RegistrationError("Fecha de inscripción inválida.");
  }
}

function requireReason(reason: string | undefined, what: string): string {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) throw new RegistrationError(`El motivo es obligatorio para ${what}.`);
  return trimmed;
}

async function authorizeMeeting(actor: SessionUser, meetingId: string): Promise<void> {
  assertPermission(actor, "meetings.manage_invitations");
  if (!isUuid(meetingId) || !(await canAccessMeeting(actor, meetingId))) throw new RegistrationError("La reunión no existe.");
}

async function insertEvents(
  trx: Trx,
  events: Array<{
    participation_id: string;
    person_id: string;
    event_type: RegistrationEventType;
    occurred_at: Date;
    recorded_by: string;
    reason?: string | null;
    origin_channel?: RegistrationChannel | null;
    origin_invitation_id?: string | null;
    registered_at?: Date | null;
    registered_at_precision?: "exact_datetime" | "date_only" | null;
  }>
): Promise<void> {
  for (let i = 0; i < events.length; i += 500) {
    const part = events.slice(i, i + 500);
    if (part.length === 0) continue;
    await trx
      .insertInto("meeting_registration_events")
      .values(
        part.map((e) => ({
          participation_id: e.participation_id,
          person_id: e.person_id,
          event_type: e.event_type,
          occurred_at: e.occurred_at,
          recorded_by: e.recorded_by,
          reason: e.reason ?? null,
          origin_channel: e.origin_channel ?? null,
          origin_invitation_id: e.origin_invitation_id ?? null,
          registered_at: e.registered_at ?? null,
          registered_at_precision: e.registered_at_precision ?? null,
        }))
      )
      .execute();
  }
}

export interface EnrollmentResult {
  /** false = ya estaba (reintento / doble clic / otra solicitud ganó la carrera): no se escribió nada ni se registró evento. */
  changed: boolean;
}

/**
 * Registra una inscripción MANUAL a una reunión/jornada (clase A). No exige invitación previa y no crea invitación, respuesta,
 * participación, asistencia ni interacción. Estados: draft, scheduled e in_progress con normalidad; finished solo retroactiva (sin
 * «ahora» y con motivo); cancelled no. Si la persona ya figura inscripta (incluso por listado importado) es un no-op; si su
 * inscripción fue ANULADA hay que restaurarla (no se crea una segunda fila).
 */
export async function enrollPerson(
  actor: SessionUser,
  input: { meetingId: string; personId: string; channel: string; when: EnrollmentWhen; reason?: string }
): Promise<EnrollmentResult> {
  await authorizeMeeting(actor, input.meetingId);
  if (!isUuid(input.personId)) throw new RegistrationError("La persona no existe.");
  if (!isInvitationChannel(input.channel)) {
    throw new RegistrationError(`Canal de inscripción inválido. Opciones: ${INVITATION_CHANNELS.join(", ")}.`);
  }
  const channel: RegistrationChannel = input.channel;

  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const meeting = await trx.selectFrom("meetings").select(["status"]).where("id", "=", input.meetingId).executeTakeFirst();
    if (!meeting) throw new RegistrationError("La reunión no existe.");
    if (meeting.status === "cancelled") throw new RegistrationError("No se puede inscribir en una reunión cancelada.");
    const retroactive = meeting.status === "finished";
    if (!retroactive && !NORMAL_STATUSES.has(meeting.status)) throw new RegistrationError("La reunión no admite inscripciones en su estado actual.");
    const reason = retroactive ? requireReason(input.reason, "una inscripción retroactiva en una reunión finalizada") : (input.reason?.trim() || null);

    if (!(await isPersonInScope(trx, actor, input.personId))) throw new RegistrationError("La persona no existe.");
    const person = await trx.selectFrom("people").select(["id", "status"]).where("id", "=", input.personId).executeTakeFirst();
    if (!person || person.status !== "active") throw new RegistrationError("La persona no existe o no está activa.");

    const now = new Date();
    const when = await resolveWhen(trx, input.when, now, meeting.status);

    // UNIQUE (meeting_id, person_id, participation_kind) + ON CONFLICT: doble clic o dos operadores dejan UNA fila y UN evento.
    const inserted = await trx
      .insertInto("meeting_participations")
      .values({
        meeting_id: input.meetingId,
        person_id: input.personId,
        participation_kind: "registration",
        participation_basis: "standard",
        recorded_by: actor.id,
        origin_channel: channel,
        registered_at: when.registeredAt,
        registered_at_precision: when.precision,
      })
      .onConflict((oc) => oc.doNothing())
      .returning("id")
      .executeTakeFirst();

    if (!inserted) {
      const existing = await trx
        .selectFrom("meeting_participations")
        .select(["voided_at"])
        .where("meeting_id", "=", input.meetingId)
        .where("person_id", "=", input.personId)
        .where("participation_kind", "=", "registration")
        .executeTakeFirst();
      if (existing?.voided_at) throw new RegistrationError("La inscripción de esta persona fue anulada: restaurala (no se crea una segunda).");
      return { changed: false };
    }
    await insertEvents(trx, [
      {
        participation_id: inserted.id, person_id: input.personId, event_type: "registered", occurred_at: now, recorded_by: actor.id, reason,
        origin_channel: channel, registered_at: when.registeredAt, registered_at_precision: when.precision,
      },
    ]);
    return { changed: true };
  });
}

export interface AcceptedEnrollmentCounts {
  /** Invitaciones vigentes con respuesta «Aceptó» (confirmed) de personas dentro del alcance. */
  eligible: number;
  /** Elegibles que ya tienen una inscripción vigente. */
  alreadyRegistered: number;
  /** Elegibles con una inscripción ANULADA: no se restauran automáticamente. */
  voided: number;
  /** Se crearían / se crearon. */
  created: number;
  /** Invitaciones aceptadas de personas fuera del alcance del usuario: solo la cantidad, sin nombres. */
  outOfScope: number;
}

async function countAccepted(trx: Trx | Awaited<ReturnType<typeof getDb>>, actor: SessionUser, meetingId: string): Promise<Omit<AcceptedEnrollmentCounts, "created">> {
  const r = await sql<{ confirmed_total: number; eligible: number; already: number; voided: number }>`
    with conf as (
      select mi.person_id, ${personInScope(actor, "mi.person_id")} as in_scope
      from meeting_invitations mi
      where mi.meeting_id = ${meetingId}::uuid and mi.withdrawn_at is null and mi.response_status = 'confirmed'
    ), elig as (select person_id from conf where in_scope)
    select
      (select count(*)::int from conf) as confirmed_total,
      (select count(*)::int from elig) as eligible,
      (select count(*)::int from elig e where exists (select 1 from meeting_participations mp where mp.meeting_id = ${meetingId}::uuid and mp.person_id = e.person_id and mp.participation_kind = 'registration' and mp.voided_at is null)) as already,
      (select count(*)::int from elig e where exists (select 1 from meeting_participations mp where mp.meeting_id = ${meetingId}::uuid and mp.person_id = e.person_id and mp.participation_kind = 'registration' and mp.voided_at is not null)) as voided
  `.execute(trx as never);
  const row = r.rows[0]!;
  return {
    eligible: Number(row.eligible),
    alreadyRegistered: Number(row.already),
    voided: Number(row.voided),
    outOfScope: Number(row.confirmed_total) - Number(row.eligible),
  };
}

/** Vista previa (solo lectura) de «Inscribir aceptados»: qué se crearía, sin escribir nada. */
export async function previewEnrollAccepted(actor: SessionUser, meetingId: string): Promise<AcceptedEnrollmentCounts> {
  await authorizeMeeting(actor, meetingId);
  const db = await getDb();
  const counts = await countAccepted(db, actor, meetingId);
  return { ...counts, created: Math.max(0, counts.eligible - counts.alreadyRegistered - counts.voided) };
}

/**
 * «Inscribir aceptados» (clase B): acción EXPLÍCITA, nunca automática. Toma únicamente invitaciones vigentes `confirmed` de personas
 * dentro del alcance, en una reunión programada o en curso. Un `INSERT … SELECT … ON CONFLICT DO NOTHING` + un evento por cada
 * inscripción creada, en una transacción: ejecutarla dos veces (o dos operadores a la vez) no duplica nada. No restaura anuladas.
 * Cada inscripción guarda `origin_invitation_id` (FK compuesta: misma reunión y misma persona) y registered_at = el instante en
 * que el operador ejecuta la acción; origin_channel queda NULL (el canal de respuesta de la persona es de la invitación).
 */
export async function enrollAccepted(actor: SessionUser, meetingId: string): Promise<AcceptedEnrollmentCounts> {
  await authorizeMeeting(actor, meetingId);
  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const meeting = await trx.selectFrom("meetings").select(["status"]).where("id", "=", meetingId).executeTakeFirst();
    if (!meeting) throw new RegistrationError("La reunión no existe.");
    if (meeting.status !== "scheduled" && meeting.status !== "in_progress") {
      throw new RegistrationError("Solo se puede inscribir a los aceptados de una reunión programada o en curso.");
    }
    const before = await countAccepted(trx, actor, meetingId);
    const now = new Date();
    const inserted = await sql<{ id: string; person_id: string; origin_invitation_id: string }>`
      insert into meeting_participations (meeting_id, person_id, participation_kind, participation_basis, recorded_by, origin_invitation_id, registered_at, registered_at_precision)
      select ${meetingId}::uuid, mi.person_id, 'registration', 'standard', ${actor.id}::uuid, mi.id, ${now}, 'exact_datetime'
      from meeting_invitations mi
      where mi.meeting_id = ${meetingId}::uuid and mi.withdrawn_at is null and mi.response_status = 'confirmed' and ${personInScope(actor, "mi.person_id")}
      on conflict do nothing
      returning id, person_id, origin_invitation_id
    `.execute(trx);
    await insertEvents(
      trx,
      inserted.rows.map((r) => ({
        participation_id: r.id, person_id: r.person_id, event_type: "registered" as const, occurred_at: now, recorded_by: actor.id,
        origin_invitation_id: r.origin_invitation_id, registered_at: now, registered_at_precision: "exact_datetime" as const,
      }))
    );
    return { ...before, created: inserted.rows.length };
  });
}

interface LockedRegistration {
  id: string;
  meeting_id: string | null;
  campaign_key: string | null;
  person_id: string;
  participation_kind: string;
  recorded_by: string | null;
  origin_invitation_id: string | null;
  origin_channel: string | null;
  registered_at: Date | null;
  registered_at_precision: "exact_datetime" | "date_only" | null;
  voided_at: Date | null;
}

/** Acceso a la inscripción: reunión accesible, o (si es histórica a nivel campaña) campaña visible para el usuario. */
async function authorizeRegistration(actor: SessionUser, participationId: string): Promise<void> {
  assertPermission(actor, "meetings.manage_invitations");
  if (!isUuid(participationId)) throw new RegistrationError("La inscripción no existe.");
  const db = await getDb();
  const probe = await db.selectFrom("meeting_participations").select(["meeting_id", "campaign_key"]).where("id", "=", participationId).executeTakeFirst();
  if (!probe) throw new RegistrationError("La inscripción no existe.");
  let allowed = false;
  if (probe.meeting_id) allowed = await canAccessMeeting(actor, probe.meeting_id);
  else if (probe.campaign_key) {
    const r = await sql<{ ok: boolean }>`select exists (select 1 from campaigns c where c.campaign_key = ${probe.campaign_key} and ${campaignVisibility(actor)}) as ok`.execute(db);
    allowed = r.rows[0]?.ok === true;
  }
  if (!allowed) throw new RegistrationError("La inscripción no existe.");
}

async function lockRegistration(trx: Trx, actor: SessionUser, participationId: string): Promise<LockedRegistration> {
  const row = await trx
    .selectFrom("meeting_participations")
    .select(["id", "meeting_id", "campaign_key", "person_id", "participation_kind", "recorded_by", "origin_invitation_id", "origin_channel", "registered_at", "registered_at_precision", "voided_at"])
    .where("id", "=", participationId)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.participation_kind !== "registration" || !(await isPersonInScope(trx, actor, row.person_id))) throw new RegistrationError("La inscripción no existe.");
  return row as LockedRegistration;
}

/**
 * ANULA una inscripción (también una histórica importada): la fila queda, deja de contar como «Inscripto» y de mostrar el chip activo.
 * NO toca participación, asistencia, invitación, respuesta ni interacciones. Motivo y usuario obligatorios; ya anulada = no-op.
 */
export async function voidEnrollment(actor: SessionUser, input: { participationId: string; reason: string }): Promise<EnrollmentResult> {
  await authorizeRegistration(actor, input.participationId);
  const reason = requireReason(input.reason, "anular una inscripción");
  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const row = await lockRegistration(trx, actor, input.participationId);
    if (row.voided_at) return { changed: false };
    const now = new Date();
    await trx.updateTable("meeting_participations").set({ voided_at: now, voided_by: actor.id, void_reason: reason }).where("id", "=", row.id).execute();
    await insertEvents(trx, [{ participation_id: row.id, person_id: row.person_id, event_type: "voided", occurred_at: now, recorded_by: actor.id, reason }]);
    return { changed: true };
  });
}

/** RESTAURA una inscripción anulada (misma fila, motivo obligatorio, con evento). No anulada = no-op. */
export async function restoreEnrollment(actor: SessionUser, input: { participationId: string; reason: string }): Promise<EnrollmentResult> {
  await authorizeRegistration(actor, input.participationId);
  const reason = requireReason(input.reason, "restaurar una inscripción");
  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const row = await lockRegistration(trx, actor, input.participationId);
    if (!row.voided_at) return { changed: false };
    const now = new Date();
    await trx.updateTable("meeting_participations").set({ voided_at: null, voided_by: null, void_reason: null }).where("id", "=", row.id).execute();
    await insertEvents(trx, [{ participation_id: row.id, person_id: row.person_id, event_type: "restored", occurred_at: now, recorded_by: actor.id, reason }]);
    return { changed: true };
  });
}

/**
 * CORRIGE la metadata de una inscripción OPERATIVA vigente: fecha y precisión (siempre) y canal (solo en la manual). En una inscripción
 * nacida de una aceptación NO se cambia la invitación de origen por esta vía (si estuviera mal vinculada, se anula con motivo y se
 * vuelve a inscribir desde la invitación correcta). Nunca persona, reunión, tipo, base ni import_row_id. Las importadas no se corrigen.
 */
export async function correctEnrollment(
  actor: SessionUser,
  input: { participationId: string; reason: string; when: Exclude<EnrollmentWhen, { kind: "now" }>; channel?: string }
): Promise<EnrollmentResult> {
  await authorizeRegistration(actor, input.participationId);
  const reason = requireReason(input.reason, "corregir una inscripción");
  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const row = await lockRegistration(trx, actor, input.participationId);
    if (!row.recorded_by) throw new RegistrationError("Solo se corrige una inscripción cargada desde el CRM: las importadas no tienen metadata operativa.");
    if (row.voided_at) throw new RegistrationError("La inscripción está anulada: restauráala antes de corregirla.");
    const fromAcceptance = row.origin_invitation_id !== null;
    let channel: RegistrationChannel | null = null;
    if (fromAcceptance) {
      if (input.channel) throw new RegistrationError("Una inscripción nacida de una aceptación no tiene canal propio: no se puede asignar uno.");
    } else {
      if (!isInvitationChannel(input.channel)) throw new RegistrationError(`Canal de inscripción inválido. Opciones: ${INVITATION_CHANNELS.join(", ")}.`);
      channel = input.channel;
    }
    const meeting = row.meeting_id ? await trx.selectFrom("meetings").select("status").where("id", "=", row.meeting_id).executeTakeFirst() : undefined;
    const now = new Date();
    const when = await resolveWhen(trx, input.when, now, meeting?.status ?? null);
    const sameInstant = (a: Date | null, b: Date | null) => (a === null && b === null) || (a !== null && b !== null && a.getTime() === b.getTime());
    if (sameInstant(row.registered_at, when.registeredAt) && row.registered_at_precision === when.precision && (row.origin_channel ?? null) === channel) {
      return { changed: false };
    }
    await trx
      .updateTable("meeting_participations")
      .set({ registered_at: when.registeredAt, registered_at_precision: when.precision, origin_channel: channel })
      .where("id", "=", row.id)
      .execute();
    await insertEvents(trx, [
      {
        participation_id: row.id, person_id: row.person_id, event_type: "corrected", occurred_at: now, recorded_by: actor.id, reason,
        origin_channel: channel, registered_at: when.registeredAt, registered_at_precision: when.precision,
      },
    ]);
    return { changed: true };
  });
}

export interface EnrollmentEventRow {
  eventType: RegistrationEventType;
  occurredAt: Date;
  recordedByName: string | null;
  reason: string | null;
  originChannel: string | null;
  originInvitationId: string | null;
  registeredAt: Date | null;
  registeredAtPrecision: "exact_datetime" | "date_only" | null;
}

/** Historial de una inscripción, en el orden real de inserción. Permiso + acceso + persona en alcance. */
export async function listEnrollmentEvents(actor: SessionUser, participationId: string): Promise<EnrollmentEventRow[]> {
  await authorizeRegistration(actor, participationId);
  const db = await getDb();
  const part = await db.selectFrom("meeting_participations").select("person_id").where("id", "=", participationId).executeTakeFirst();
  if (!part || !(await isPersonInScope(db, actor, part.person_id))) return [];
  const rows = await db
    .selectFrom("meeting_registration_events as e")
    .leftJoin("users as u", "u.id", "e.recorded_by")
    .select(["e.event_type", "e.occurred_at", "u.full_name as recorder_name", "e.reason", "e.origin_channel", "e.origin_invitation_id", "e.registered_at", "e.registered_at_precision"])
    .where("e.participation_id", "=", participationId)
    .orderBy("e.seq", "asc")
    .execute();
  return rows.map((r) => ({
    eventType: r.event_type, occurredAt: r.occurred_at, recordedByName: r.recorder_name, reason: r.reason, originChannel: r.origin_channel,
    originInvitationId: r.origin_invitation_id, registeredAt: r.registered_at, registeredAtPrecision: r.registered_at_precision,
  }));
}

export interface EnrollmentSearchResult {
  personId: string;
  firstName: string;
  lastName: string;
  invited: boolean;
  /** Inscripción vigente en ESTA reunión. */
  registered: boolean;
  /** Tiene una inscripción ANULADA en esta reunión (hay que restaurarla). */
  voided: boolean;
  /** Ya figura inscripta a nivel campaña (jornada no determinada): no se duplica, es un hecho distinto. */
  registeredAtCampaignLevel: boolean;
}

/** Búsqueda de personas para inscribir (nombre/apellido/DNI), solo dentro del alcance del usuario. */
export async function searchPeopleForEnrollment(actor: SessionUser, meetingId: string, search: string): Promise<EnrollmentSearchResult[]> {
  await authorizeMeeting(actor, meetingId);
  const term = search.trim();
  if (term.length < 2) return [];
  const db = await getDb();
  const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const people = await db
    .selectFrom("people")
    .select(["id", "first_name", "last_name"])
    .where("status", "=", "active")
    .where(orgScope(actor, "people.organization_id"))
    .where((eb) => eb.or([eb("first_name", "ilike", pattern), eb("last_name", "ilike", pattern), eb("dni", "ilike", pattern)]))
    .limit(15)
    .execute();
  if (people.length === 0) return [];
  const ids = people.map((p) => p.id);
  const [regs, invs, camp] = await Promise.all([
    db.selectFrom("meeting_participations").select(["person_id", "voided_at"]).where("meeting_id", "=", meetingId).where("participation_kind", "=", "registration").where("person_id", "in", ids).execute(),
    db.selectFrom("meeting_invitations").select("person_id").where("meeting_id", "=", meetingId).where("withdrawn_at", "is", null).where("person_id", "in", ids).execute(),
    sql<{ person_id: string }>`select mp.person_id from meeting_participations mp join campaigns c on c.campaign_key = mp.campaign_key join meetings m on m.campaign_id = c.id
      where m.id = ${meetingId}::uuid and mp.meeting_id is null and mp.participation_kind = 'registration' and mp.voided_at is null and mp.person_id = any(${ids}::uuid[])`.execute(db),
  ]);
  const active = new Set(regs.filter((r) => r.voided_at === null).map((r) => r.person_id));
  const voided = new Set(regs.filter((r) => r.voided_at !== null).map((r) => r.person_id));
  const invited = new Set(invs.map((i) => i.person_id));
  const atCampaign = new Set(camp.rows.map((r) => r.person_id));
  return people.map((p) => ({
    personId: p.id, firstName: p.first_name, lastName: p.last_name,
    invited: invited.has(p.id), registered: active.has(p.id), voided: voided.has(p.id), registeredAtCampaignLevel: atCampaign.has(p.id),
  }));
}
