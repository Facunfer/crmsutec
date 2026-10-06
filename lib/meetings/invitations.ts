import { sql, type Transaction } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { toJsonb } from "../db/json.js";
import type { Database, InvitationChannel, InvitationEventType, InvitationResponseChannel, InvitationResponseStatus, Json } from "../db/schema.js";
import { can, type SessionUser } from "../permissions/can.js";
import { resolveAudienceIds, type MeetingAudienceSpec } from "./audience.js";
import { canAccessMeeting, isUuid, personInScope } from "../scope/organizations.js";
import { ATTENDANCE_ACTIVE } from "../activities/metrics.js";
import { INVITATION_CHANNELS, isInvitationChannel } from "../activities/labels.js";
import { canManageInvitations, STATUS_LABEL } from "./state-machine.js";
import { generateInvitationToken, hashInvitationToken } from "./tokens.js";

assertServerOnly("lib/meetings/invitations.ts");

export class MeetingInvitationError extends Error {}

/**
 * INVARIANTE DE INTEGRIDAD DEL HISTORIAL (aplicación, no de base de datos):
 * toda mutación de estado o de metadata semántica de `meeting_invitations` (alta, reinvitación, retiro, respuesta y sus
 * campos de canal/fecha/responsable) debe pasar EXCLUSIVAMENTE por los comandos transaccionales de este módulo
 * (`createInvitationBatch`, `withdrawInvitation`, `recordInvitationResponse`) y de `lib/meetings/public.ts`
 * (`respondToInvitation`), que actualizan la fila Y registran su evento en `meeting_invitation_events` en la MISMA transacción,
 * con la invitación bloqueada (FOR UPDATE). La base impone combinaciones imposibles (0037) y que el historial sea append-only
 * (0038), pero NO impone que exista un evento por cada cambio: eso lo garantizan estos comandos. Un test sobre el código fuente
 * es una defensa adicional, no una garantía de integridad.
 *
 * Idempotencia: cada comando compara el estado pedido con el actual DESPUÉS de bloquear la fila; si ya coincide no escribe ni
 * registra nada (reintentos, doble clic y solicitudes concurrentes). Los instantes (occurred_at, response_recorded_at) se toman
 * después del bloqueo para que el orden de los eventos sea el orden real.
 *
 * `attendance_status` está deprecado: este módulo no agrega ninguna lógica nueva sobre ese campo. La reinvitación conserva el
 * comportamiento anterior (lo reinicia a «unknown»); su eliminación semántica completa llega con B3.
 */

export type Trx = Transaction<Database>;

export interface CreatedInvitationLink {
  personId: string;
  personName: string;
  token: string;
}

export interface CreateInvitationBatchResult {
  batchId: string;
  resolvedCount: number;
  createdCount: number;
  revivedCount: number;
  alreadyInvitedCount: number;
  /** Tokens en claro, solo para esta respuesta — nunca quedan guardados (D10). */
  links: CreatedInvitationLink[];
}

const CHUNK = 500;
const chunks = <T,>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

export interface InvitationEventInput {
  invitation_id: string;
  meeting_id: string;
  person_id: string;
  event_type: InvitationEventType;
  occurred_at: Date;
  recorded_by: string | null;
  batch_id?: string | null;
  invitation_channel?: InvitationChannel | null;
  response_status_from?: InvitationResponseStatus | null;
  response_status_to?: InvitationResponseStatus | null;
  response_channel?: InvitationResponseChannel | null;
  responded_at?: Date | null;
  responded_at_precision?: "exact_datetime" | "date_only" | null;
}

/** Único punto de escritura del historial. Se invoca SIEMPRE dentro de la transacción que cambia la fila. */
export async function insertInvitationEvents(trx: Trx, events: InvitationEventInput[]): Promise<void> {
  for (const part of chunks(events)) {
    if (part.length === 0) continue;
    await trx
      .insertInto("meeting_invitation_events")
      .values(
        part.map((e) => ({
          invitation_id: e.invitation_id,
          meeting_id: e.meeting_id,
          person_id: e.person_id,
          event_type: e.event_type,
          occurred_at: e.occurred_at,
          recorded_by: e.recorded_by,
          batch_id: e.batch_id ?? null,
          invitation_channel: e.invitation_channel ?? null,
          response_status_from: e.response_status_from ?? null,
          response_status_to: e.response_status_to ?? null,
          response_channel: e.response_channel ?? null,
          responded_at: e.responded_at ?? null,
          responded_at_precision: e.responded_at_precision ?? null,
        }))
      )
      .execute();
  }
}

/**
 * Crea una tanda de invitaciones a partir de una audiencia (sección 11 del prompt). Todo en UNA transacción: tanda,
 * invitaciones nuevas, reinvitaciones y eventos. Idempotente ante doble clic: quien ya está invitado (activo) se omite;
 * quien fue retirado se REINVITA (misma fila: el UNIQUE (meeting_id, person_id) se respeta) con un token nuevo y un evento
 * `reinvited` que conserva el estado previo; recién ahí se insertan los que nunca estuvieron invitados.
 *
 * `channel` es el canal de COMUNICACIÓN que el operador declara (registro manual): el CRM no envía nada.
 */
export async function createInvitationBatch(
  actor: SessionUser,
  meetingId: string,
  spec: MeetingAudienceSpec,
  options: { channel?: string | null } = {}
): Promise<CreateInvitationBatchResult> {
  assertPermission(actor, "meetings.manage_invitations");

  const rawChannel = options.channel ?? null;
  if (rawChannel !== null && !isInvitationChannel(rawChannel)) {
    throw new MeetingInvitationError(`Canal de invitación inválido. Opciones: ${INVITATION_CHANNELS.join(", ")}.`);
  }
  const channel: InvitationChannel | null = rawChannel;

  if (!(await canAccessMeeting(actor, meetingId))) throw new MeetingInvitationError("La reunión no existe.");

  const db = await getDb();
  const meeting = await db.selectFrom("meetings").selectAll().where("id", "=", meetingId).executeTakeFirst();
  if (!meeting) throw new MeetingInvitationError("La reunión no existe.");
  if (!canManageInvitations(meeting.status)) {
    throw new MeetingInvitationError(
      `No se pueden generar invitaciones para una reunión en estado "${STATUS_LABEL[meeting.status]}".`
    );
  }

  const resolvedIds = await resolveAudienceIds(actor, spec);
  if (resolvedIds.length === 0) {
    throw new MeetingInvitationError("La audiencia elegida no incluye a ninguna persona activa.");
  }

  return db.transaction().execute(async (trx) => {
    // Lectura BLOQUEADA de las invitaciones existentes: un doble clic o un segundo operador esperan acá y ven el resultado ya aplicado.
    const existingRows: Array<{ id: string; person_id: string; withdrawn_at: Date | null; response_status: InvitationResponseStatus }> = [];
    for (const part of chunks(resolvedIds)) {
      existingRows.push(
        ...(await trx
          .selectFrom("meeting_invitations")
          .select(["id", "person_id", "withdrawn_at", "response_status"])
          .where("meeting_id", "=", meetingId)
          .where("person_id", "in", part)
          .forUpdate()
          .execute())
      );
    }

    const activeExistingIds = new Set(existingRows.filter((r) => !r.withdrawn_at).map((r) => r.person_id));
    const withdrawnRows = existingRows.filter((r) => r.withdrawn_at);
    const existingPersonIds = new Set(existingRows.map((r) => r.person_id));
    const brandNewIds = resolvedIds.filter((id) => !existingPersonIds.has(id));

    const idsNeedingNames = [...withdrawnRows.map((r) => r.person_id), ...brandNewIds];
    const nameById = new Map<string, string>();
    for (const part of chunks(idsNeedingNames)) {
      const people = await trx.selectFrom("people").select(["id", "first_name", "last_name"]).where("id", "in", part).execute();
      for (const p of people) nameById.set(p.id, `${p.first_name} ${p.last_name}`.trim());
    }

    const links: CreatedInvitationLink[] = [];
    const events: InvitationEventInput[] = [];
    const now = new Date(); // tomado DESPUÉS del bloqueo

    // 1) Se aplican primero las operaciones REALES (con batch_id aún sin asignar); recién después se crea la tanda con su contador.
    //    `inserted_count` mantiene su semántica histórica = invitaciones nuevas + reinvitaciones EFECTIVAMENTE realizadas por
    //    ESTA tanda (no el tamaño estimado de la audiencia ni un conteo previo a los bloqueos).
    const appliedIds: string[] = [];
    const eventDrafts: Array<Omit<InvitationEventInput, "batch_id">> = [];

    for (const row of withdrawnRows) {
      const token = generateInvitationToken();
      await trx
        .updateTable("meeting_invitations")
        .set({
          token_hash: hashInvitationToken(token),
          response_status: "pending",
          attendance_status: "unknown", // compatibilidad con el runtime anterior; campo deprecado (B3)
          invited_at: now,
          invited_by: actor.id,
          invitation_channel: channel,
          responded_at: null,
          responded_at_precision: null,
          response_channel: null,
          response_recorded_by: null,
          response_recorded_at: null,
          withdrawn_at: null,
          withdrawn_by: null,
        })
        .where("id", "=", row.id)
        .execute();
      appliedIds.push(row.id);
      links.push({ personId: row.person_id, personName: nameById.get(row.person_id) ?? "", token });
      eventDrafts.push({
        invitation_id: row.id,
        meeting_id: meetingId,
        person_id: row.person_id,
        event_type: "reinvited",
        occurred_at: now,
        recorded_by: actor.id,
        invitation_channel: channel,
        response_status_from: row.response_status, // lo que tenía antes de reiniciarse
        response_status_to: "pending",
      });
    }
    const revivedCount = withdrawnRows.length;

    let createdCount = 0;
    for (const part of chunks(brandNewIds)) {
      const prepared = part.map((personId) => {
        const token = generateInvitationToken();
        return {
          personId,
          token,
          row: { meeting_id: meetingId, person_id: personId, token_hash: hashInvitationToken(token), invited_by: actor.id, invitation_channel: channel, invited_at: now },
        };
      });
      // ON CONFLICT DO NOTHING: si otra solicitud ganó la carrera, esa persona no se cuenta ni genera evento acá.
      const inserted = await trx
        .insertInto("meeting_invitations")
        .values(prepared.map((p) => p.row))
        .onConflict((oc) => oc.columns(["meeting_id", "person_id"]).doNothing())
        .returning(["id", "person_id"])
        .execute();
      const byPerson = new Map(prepared.map((p) => [p.personId, p]));
      for (const row of inserted) {
        createdCount += 1;
        appliedIds.push(row.id);
        links.push({ personId: row.person_id, personName: nameById.get(row.person_id) ?? "", token: byPerson.get(row.person_id)!.token });
        eventDrafts.push({
          invitation_id: row.id,
          meeting_id: meetingId,
          person_id: row.person_id,
          event_type: "invited",
          occurred_at: now,
          recorded_by: actor.id,
          invitation_channel: channel,
          response_status_to: "pending",
        });
      }
    }

    // 2) La tanda se crea con el conteo REAL de lo aplicado; si algo falla, la transacción entera revierte (ni tanda ni contador parcial).
    const batch = await trx
      .insertInto("meeting_invitation_batches")
      .values({
        meeting_id: meetingId,
        criteria: toJsonb(spec as unknown as Json),
        resolved_count: resolvedIds.length,
        inserted_count: createdCount + revivedCount,
        created_by: actor.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // 3) Las invitaciones efectivamente aplicadas por esta tanda quedan asociadas a ella (batch_id) y se registran sus eventos.
    for (const part of chunks(appliedIds)) {
      await trx.updateTable("meeting_invitations").set({ batch_id: batch.id }).where("id", "in", part).execute();
    }
    for (const draft of eventDrafts) events.push({ ...draft, batch_id: batch.id });

    await insertInvitationEvents(trx, events);

    return {
      batchId: batch.id,
      resolvedCount: resolvedIds.length,
      createdCount,
      revivedCount,
      alreadyInvitedCount: activeExistingIds.size,
      links,
    };
  });
}

export interface InvitationRow {
  id: string;
  personId: string;
  firstName: string;
  lastName: string;
  responseStatus: string;
  /** DEPRECADO (legacy): campo `attendance_status` de la invitación. Ya no es fuente de asistencia; usar `attended`. */
  attendanceStatus: string;
  /** Asistencia presencial comprobada vigente (meeting_attendance), independiente de la invitación. */
  attended: boolean;
  invitedAt: Date;
  /** Canal de comunicación registrado (null = no registrado). Registrar un canal no significa que el CRM haya enviado algo. */
  invitationChannel: string | null;
  respondedAt: Date | null;
  respondedAtPrecision: "exact_datetime" | "date_only" | null;
  responseChannel: string | null;
  /** Cuándo guardó el sistema la respuesta. */
  responseRecordedAt: Date | null;
  /** Nombres de usuarios internos: solo con `meetings.manage_invitations` (null en caso contrario). */
  invitedByName: string | null;
  responseRecordedByName: string | null;
  /** true = respondió la propia persona por el enlace; false = la cargó un operador; null = sin respuesta. */
  respondedByPerson: boolean | null;
  withdrawn: boolean;
}

/** Solo invitaciones de personas DENTRO del alcance del usuario (además del acceso a la reunión). */
export async function listInvitations(actor: SessionUser, meetingId: string): Promise<InvitationRow[]> {
  if (!isUuid(meetingId)) return [];
  const canSeeNames = can(actor, "meetings.manage_invitations");
  // Acceso y lectura son independientes: una sola tanda; si no hay acceso, lo leído se descarta.
  const db = await getDb();
  const rowsQuery = db
    .selectFrom("meeting_invitations")
    .innerJoin("people", "people.id", "meeting_invitations.person_id")
    .leftJoin("users as inviter", "inviter.id", "meeting_invitations.invited_by")
    .leftJoin("users as recorder", "recorder.id", "meeting_invitations.response_recorded_by")
    .select([
      "meeting_invitations.id",
      "meeting_invitations.person_id",
      "people.first_name",
      "people.last_name",
      "meeting_invitations.response_status",
      "meeting_invitations.attendance_status",
      sql<boolean>`exists (select 1 from meeting_attendance ma where ma.meeting_id = meeting_invitations.meeting_id and ma.person_id = meeting_invitations.person_id and ${ATTENDANCE_ACTIVE})`.as("attended"),
      "meeting_invitations.invited_at",
      "meeting_invitations.invitation_channel",
      "meeting_invitations.responded_at",
      "meeting_invitations.responded_at_precision",
      "meeting_invitations.response_channel",
      "meeting_invitations.response_recorded_at",
      "meeting_invitations.response_recorded_by",
      "meeting_invitations.withdrawn_at",
      "inviter.full_name as inviter_name",
      "recorder.full_name as recorder_name",
    ])
    .where("meeting_invitations.meeting_id", "=", meetingId)
    .where(personInScope(actor, "meeting_invitations.person_id"))
    .orderBy("people.last_name", "asc");
  const [allowed, rows] = await Promise.all([canAccessMeeting(actor, meetingId), rowsQuery.execute()]);
  if (!allowed) return [];

  return rows.map((r) => ({
    id: r.id,
    personId: r.person_id,
    firstName: r.first_name,
    lastName: r.last_name,
    responseStatus: r.response_status,
    attendanceStatus: r.attendance_status,
    attended: r.attended,
    invitedAt: r.invited_at,
    invitationChannel: r.invitation_channel,
    respondedAt: r.responded_at,
    respondedAtPrecision: r.responded_at_precision,
    responseChannel: r.response_channel,
    responseRecordedAt: r.response_recorded_at,
    invitedByName: canSeeNames ? r.inviter_name : null,
    responseRecordedByName: canSeeNames ? r.recorder_name : null,
    respondedByPerson: r.response_status === "pending" ? null : r.response_recorded_by === null,
    withdrawn: r.withdrawn_at !== null,
  }));
}

/** Persona dentro del alcance del usuario (misma regla que el resto de las lecturas por persona). */
async function personIsInScope(trx: Trx, actor: SessionUser, personId: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`select ${personInScope(actor, "p.id")} as ok from people p where p.id = ${personId}::uuid`.execute(trx);
  return r.rows[0]?.ok === true;
}

/**
 * Nunca borra la fila (R8): siempre se marca, haya o no respondido (sección 11 del prompt). Exige permiso, acceso a la reunión y
 * que la persona esté DENTRO del alcance del usuario (si no, «la invitación no existe»: no se revela). Registra el evento
 * `withdrawn`. Ya retirada o inexistente = no-op.
 */
export async function withdrawInvitation(actor: SessionUser, invitationId: string): Promise<void> {
  assertPermission(actor, "meetings.manage_invitations");
  if (!isUuid(invitationId)) return;

  const db = await getDb();
  const probe = await db.selectFrom("meeting_invitations").select(["meeting_id"]).where("id", "=", invitationId).executeTakeFirst();
  if (!probe) return;
  if (!(await canAccessMeeting(actor, probe.meeting_id))) throw new MeetingInvitationError("La reunión no existe.");

  await db.transaction().execute(async (trx) => {
    const invitation = await trx.selectFrom("meeting_invitations").selectAll().where("id", "=", invitationId).forUpdate().executeTakeFirst();
    if (!invitation || invitation.withdrawn_at) return; // idempotente
    if (!(await personIsInScope(trx, actor, invitation.person_id))) throw new MeetingInvitationError("La invitación no existe.");

    const now = new Date();
    await trx.updateTable("meeting_invitations").set({ withdrawn_at: now, withdrawn_by: actor.id }).where("id", "=", invitationId).execute();
    await insertInvitationEvents(trx, [
      { invitation_id: invitation.id, meeting_id: invitation.meeting_id, person_id: invitation.person_id, event_type: "withdrawn", occurred_at: now, recorded_by: actor.id },
    ]);
  });
}

export type StaffResponseDate =
  | { kind: "exact"; at: Date }
  /** Solo se conoce el día (AAAA-MM-DD, Buenos Aires): se guarda la medianoche local con precisión `date_only`. */
  | { kind: "date_only"; day: string }
  /** La fecha real de la respuesta se desconoce: no se inventa una. */
  | { kind: "unknown" };

export interface RecordInvitationResponseInput {
  invitationId: string;
  response: "confirmed" | "declined";
  /** Canal real por el que llegó la respuesta (nunca `public_link`: eso es solo de la propia persona). */
  channel: string;
  respondedAt: StaffResponseDate;
}

export interface RecordInvitationResponseResult {
  /** false = ya estaba así (reintento / doble clic): no se escribió nada ni se registró evento. */
  changed: boolean;
  eventType: "responded" | "response_changed" | null;
}

const BA = "America/Argentina/Buenos_Aires";

/**
 * Respuesta CARGADA POR UN OPERADOR (la persona respondió por WhatsApp, teléfono, en persona…). Permiso temporal
 * `meetings.manage_invitations` (hasta la Fase C) + acceso a la reunión + persona dentro del alcance.
 *
 * - `response_recorded_by` = el operador; `response_recorded_at` = ahora (exacto). La fecha real (`responded_at`) puede ser
 *   exacta, solo el día, o NULL si se desconoce: NUNCA se inventa usando `response_recorded_at`.
 * - Pendiente → aceptó/rechazó: evento `responded`. Aceptó ↔ rechazó: `response_changed`. Mismo estado con otro canal o fecha:
 *   corrección explícita de metadata → `response_changed` con from = to. Mismo estado, canal y fecha: no-op.
 * - No se puede volver a «pendiente».
 */
export async function recordInvitationResponse(actor: SessionUser, input: RecordInvitationResponseInput): Promise<RecordInvitationResponseResult> {
  assertPermission(actor, "meetings.manage_invitations");

  if (input.response !== "confirmed" && input.response !== "declined") throw new MeetingInvitationError("La respuesta debe ser «Aceptó» o «Rechazó».");
  if (!isInvitationChannel(input.channel)) {
    throw new MeetingInvitationError(`Canal inválido. Opciones: ${INVITATION_CHANNELS.join(", ")}. El enlace público solo lo usa la propia persona.`);
  }
  const channel: InvitationChannel = input.channel;
  if (!isUuid(input.invitationId)) throw new MeetingInvitationError("La invitación no existe.");

  const db = await getDb();
  const probe = await db.selectFrom("meeting_invitations").select(["meeting_id"]).where("id", "=", input.invitationId).executeTakeFirst();
  if (!probe || !(await canAccessMeeting(actor, probe.meeting_id))) throw new MeetingInvitationError("La invitación no existe.");

  return db.transaction().execute(async (trx) => {
    const invitation = await trx.selectFrom("meeting_invitations").selectAll().where("id", "=", input.invitationId).forUpdate().executeTakeFirst();
    if (!invitation || invitation.withdrawn_at) throw new MeetingInvitationError("La invitación no existe.");
    if (!(await personIsInScope(trx, actor, invitation.person_id))) throw new MeetingInvitationError("La invitación no existe.");

    const meeting = await trx.selectFrom("meetings").select(["status"]).where("id", "=", invitation.meeting_id).executeTakeFirstOrThrow();
    if (!canManageInvitations(meeting.status)) {
      throw new MeetingInvitationError(`No se pueden registrar respuestas en una reunión en estado "${STATUS_LABEL[meeting.status]}".`);
    }

    const now = new Date(); // después del bloqueo: orden real de los eventos
    let respondedAt: Date | null = null;
    let precision: "exact_datetime" | "date_only" | null = null;
    if (input.respondedAt.kind === "exact") {
      if (!(input.respondedAt.at instanceof Date) || Number.isNaN(input.respondedAt.at.getTime())) throw new MeetingInvitationError("Fecha de respuesta inválida.");
      if (input.respondedAt.at.getTime() > now.getTime()) throw new MeetingInvitationError("La fecha de la respuesta no puede ser futura.");
      respondedAt = input.respondedAt.at;
      precision = "exact_datetime";
    } else if (input.respondedAt.kind === "date_only") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.respondedAt.day)) throw new MeetingInvitationError("Fecha de respuesta inválida.");
      let ts: Date | null = null;
      try {
        const midnight = await sql<{ ts: Date | null }>`select (${input.respondedAt.day}::date::timestamp at time zone ${BA}) as ts`.execute(trx);
        ts = midnight.rows[0]?.ts ?? null;
      } catch {
        ts = null;
      }
      if (!ts) throw new MeetingInvitationError("Fecha de respuesta inválida.");
      if (ts.getTime() > now.getTime()) throw new MeetingInvitationError("La fecha de la respuesta no puede ser futura.");
      respondedAt = ts;
      precision = "date_only";
    }

    const sameInstant = (a: Date | null, b: Date | null) => (a === null && b === null) || (a !== null && b !== null && a.getTime() === b.getTime());
    const unchanged =
      invitation.response_status === input.response &&
      invitation.response_channel === channel &&
      invitation.responded_at_precision === precision &&
      sameInstant(invitation.responded_at, respondedAt);
    if (unchanged) return { changed: false, eventType: null };

    const from = invitation.response_status;
    await trx
      .updateTable("meeting_invitations")
      .set({
        response_status: input.response,
        responded_at: respondedAt,
        responded_at_precision: precision,
        response_channel: channel,
        response_recorded_by: actor.id,
        response_recorded_at: now,
      })
      .where("id", "=", invitation.id)
      .execute();
    const eventType = from === "pending" ? ("responded" as const) : ("response_changed" as const);
    await insertInvitationEvents(trx, [
      {
        invitation_id: invitation.id,
        meeting_id: invitation.meeting_id,
        person_id: invitation.person_id,
        event_type: eventType,
        occurred_at: now,
        recorded_by: actor.id,
        response_status_from: from,
        response_status_to: input.response,
        response_channel: channel,
        responded_at: respondedAt,
        responded_at_precision: precision,
      },
    ]);
    return { changed: true, eventType };
  });
}

export interface InvitationEventRow {
  eventType: InvitationEventType;
  occurredAt: Date;
  /** Usuario que lo registró; null = la propia persona (enlace público). Nombre solo con `manage_invitations`. */
  recordedByName: string | null;
  recordedByPerson: boolean;
  invitationChannel: string | null;
  responseStatusFrom: string | null;
  responseStatusTo: string | null;
  responseChannel: string | null;
  respondedAt: Date | null;
  respondedAtPrecision: "exact_datetime" | "date_only" | null;
}

/** Historial de una invitación, en el orden real de inserción. Exige permiso, acceso a la reunión y persona en alcance. */
export async function listInvitationEvents(actor: SessionUser, invitationId: string): Promise<InvitationEventRow[]> {
  assertPermission(actor, "meetings.manage_invitations");
  if (!isUuid(invitationId)) return [];
  const db = await getDb();
  const inv = await db.selectFrom("meeting_invitations").select(["meeting_id", "person_id"]).where("id", "=", invitationId).executeTakeFirst();
  if (!inv || !(await canAccessMeeting(actor, inv.meeting_id))) return [];
  const [inScope, rows] = await Promise.all([
    sql<{ ok: boolean }>`select ${personInScope(actor, "p.id")} as ok from people p where p.id = ${inv.person_id}::uuid`.execute(db),
    db
      .selectFrom("meeting_invitation_events as e")
      .leftJoin("users as u", "u.id", "e.recorded_by")
      .select([
        "e.event_type", "e.occurred_at", "e.recorded_by", "u.full_name as recorder_name", "e.invitation_channel", "e.response_status_from",
        "e.response_status_to", "e.response_channel", "e.responded_at", "e.responded_at_precision",
      ])
      .where("e.invitation_id", "=", invitationId)
      .orderBy("e.seq", "asc")
      .execute(),
  ]);
  if (inScope.rows[0]?.ok !== true) return [];
  return rows.map((r) => ({
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    recordedByName: r.recorder_name,
    recordedByPerson: r.recorded_by === null,
    invitationChannel: r.invitation_channel,
    responseStatusFrom: r.response_status_from,
    responseStatusTo: r.response_status_to,
    responseChannel: r.response_channel,
    respondedAt: r.responded_at,
    respondedAtPrecision: r.responded_at_precision,
  }));
}
