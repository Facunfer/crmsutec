import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { canAccessMeeting, isPersonInScope, isUuid } from "../scope/organizations.js";
import type { SessionUser } from "../permissions/can.js";
import type { AttendanceEventType, AttendancePrecision } from "../db/schema.js";
import { insertAttendanceEvents, type AttendanceTrx } from "./events.js";

assertServerOnly("lib/attendance/manual.ts");

export class ManualAttendanceError extends Error {}

/**
 * ACCIONES ADMINISTRATIVAS sobre la asistencia (permiso temporal `meetings.attendance_manual`, hasta la Fase C):
 * registrar a mano, revocar, restaurar y corregir la hora. Todas exigen además acceso a la reunión y que la PERSONA esté dentro
 * del alcance actual del usuario (si no, «no existe»: no se revela nada). Estado + evento en UNA transacción, con la fila
 * bloqueada. Nunca se borra. NO se crea ninguna interacción (la asistencia no es contacto). `meeting_invitations.attendance_status`
 * está deprecado: nada de acá lo lee ni lo escribe.
 *
 * Invariante de integridad del historial: ver lib/attendance/events.ts.
 */

const BA = "America/Argentina/Buenos_Aires";

/** Cuándo ocurrió la asistencia. `now` solo en una reunión en curso; en una finalizada hay que indicar cuándo ocurrió. */
export type AttendanceOccurred =
  | { kind: "now" }
  | { kind: "exact"; at: Date }
  /** Solo se conoce el día (AAAA-MM-DD, Buenos Aires): se guarda la medianoche local con precisión `date_only`. */
  | { kind: "date_only"; day: string }
  /** Se desconoce cuándo ocurrió: checked_in_at queda NULL. Nunca se inventa una fecha. */
  | { kind: "unknown" };

interface ResolvedTime {
  checkedInAt: Date | null;
  precision: AttendancePrecision;
}

async function resolveOccurred(trx: AttendanceTrx, occurred: AttendanceOccurred, now: Date, meetingStatus: string): Promise<ResolvedTime> {
  switch (occurred.kind) {
    case "now":
      if (meetingStatus !== "in_progress") {
        throw new ManualAttendanceError("En una reunión finalizada es una carga retroactiva: indicá cuándo ocurrió la asistencia (día y hora, solo el día, o que se desconoce).");
      }
      return { checkedInAt: now, precision: "exact_datetime" };
    case "exact": {
      if (!(occurred.at instanceof Date) || Number.isNaN(occurred.at.getTime())) throw new ManualAttendanceError("Fecha de asistencia inválida.");
      if (occurred.at.getTime() > now.getTime()) throw new ManualAttendanceError("La fecha de la asistencia no puede ser futura.");
      return { checkedInAt: occurred.at, precision: "exact_datetime" };
    }
    case "date_only": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(occurred.day)) throw new ManualAttendanceError("Fecha de asistencia inválida.");
      let ts: Date | null = null;
      try {
        const r = await sql<{ ts: Date | null }>`select (${occurred.day}::date::timestamp at time zone ${BA}) as ts`.execute(trx);
        ts = r.rows[0]?.ts ?? null;
      } catch {
        ts = null;
      }
      if (!ts) throw new ManualAttendanceError("Fecha de asistencia inválida.");
      if (ts.getTime() > now.getTime()) throw new ManualAttendanceError("La fecha de la asistencia no puede ser futura.");
      return { checkedInAt: ts, precision: "date_only" };
    }
    case "unknown":
      return { checkedInAt: null, precision: "unknown" };
    default:
      throw new ManualAttendanceError("Fecha de asistencia inválida.");
  }
}

function requireReason(reason: string, what: string): string {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) throw new ManualAttendanceError(`El motivo es obligatorio para ${what}.`);
  return trimmed;
}

async function authorize(actor: SessionUser, meetingId: string, personId: string): Promise<void> {
  assertPermission(actor, "meetings.attendance_manual");
  if (!isUuid(meetingId) || !isUuid(personId)) throw new ManualAttendanceError("La reunión no existe.");
  if (!(await canAccessMeeting(actor, meetingId))) throw new ManualAttendanceError("La reunión no existe.");
}

export interface AttendanceActionResult {
  /** false = ya estaba así (reintento / doble clic / otra solicitud ganó la carrera): no se escribió nada ni se registró evento. */
  changed: boolean;
}

/**
 * Registra a mano la asistencia de una persona (con o sin invitación previa: NO se crea ninguna invitación artificial; si hay una
 * vigente, se enlaza por referencia). Reunión en curso o finalizada (carga retroactiva); motivo obligatorio. Si ya hay una
 * asistencia vigente es un no-op; si existe pero fue REVOCADA no se registra de nuevo: hay que restaurarla.
 */
export async function registerAttendanceManually(
  actor: SessionUser,
  input: { meetingId: string; personId: string; reason: string; occurred: AttendanceOccurred }
): Promise<AttendanceActionResult> {
  await authorize(actor, input.meetingId, input.personId);
  const reason = requireReason(input.reason, "registrar una asistencia manual");

  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const meeting = await trx.selectFrom("meetings").select(["status"]).where("id", "=", input.meetingId).executeTakeFirst();
    if (!meeting) throw new ManualAttendanceError("La reunión no existe.");
    if (meeting.status !== "in_progress" && meeting.status !== "finished") {
      throw new ManualAttendanceError("Solo se puede registrar asistencia de una reunión en curso o finalizada.");
    }
    if (!(await isPersonInScope(trx, actor, input.personId))) throw new ManualAttendanceError("La persona no existe.");
    const person = await trx.selectFrom("people").select(["id", "status"]).where("id", "=", input.personId).executeTakeFirst();
    if (!person) throw new ManualAttendanceError("La persona no existe.");

    const now = new Date();
    const time = await resolveOccurred(trx, input.occurred, now, meeting.status);
    const invitation = await trx
      .selectFrom("meeting_invitations")
      .select("id")
      .where("meeting_id", "=", input.meetingId)
      .where("person_id", "=", input.personId)
      .where("withdrawn_at", "is", null)
      .executeTakeFirst();

    // UNIQUE(meeting_id, person_id) + ON CONFLICT: QR + manual a la vez, o doble clic, dejan UNA sola fila y UN solo evento.
    const inserted = await trx
      .insertInto("meeting_attendance")
      .values({
        meeting_id: input.meetingId,
        person_id: input.personId,
        invitation_id: invitation?.id ?? null,
        method: "manual",
        identification: null,
        checked_in_at: time.checkedInAt,
        occurred_precision: time.precision,
        recorded_at: now,
        registered_by: actor.id,
        correction_reason: reason,
      })
      .onConflict((oc) => oc.columns(["meeting_id", "person_id"]).doNothing())
      .returning("id")
      .executeTakeFirst();

    if (!inserted) {
      const existing = await trx
        .selectFrom("meeting_attendance")
        .select(["revoked_at"])
        .where("meeting_id", "=", input.meetingId)
        .where("person_id", "=", input.personId)
        .executeTakeFirst();
      if (existing?.revoked_at) {
        throw new ManualAttendanceError("La asistencia de esta persona fue revocada: restaurala (no se registra de nuevo).");
      }
      return { changed: false };
    }
    await insertAttendanceEvents(trx, [
      {
        attendance_id: inserted.id,
        meeting_id: input.meetingId,
        person_id: input.personId,
        event_type: "checked_in",
        occurred_at: now,
        recorded_by: actor.id,
        attendance_method: "manual",
        reason,
        checked_in_at: time.checkedInAt,
        occurred_precision: time.precision,
      },
    ]);
    return { changed: true };
  });
}

/** Carga una asistencia BLOQUEADA para cambiarla; valida que la persona esté en el alcance actual del usuario. */
async function lockAttendance(trx: AttendanceTrx, actor: SessionUser, meetingId: string, personId: string) {
  const row = await trx
    .selectFrom("meeting_attendance")
    .selectAll()
    .where("meeting_id", "=", meetingId)
    .where("person_id", "=", personId)
    .forUpdate()
    .executeTakeFirst();
  if (!row || !(await isPersonInScope(trx, actor, personId))) throw new ManualAttendanceError("No hay una asistencia registrada para esa persona.");
  return row;
}

/**
 * REVOCA una asistencia (el «undo» auditable): la fila queda, deja de ser vigente y deja de contar en el panel, la lista y las
 * métricas. Motivo y usuario obligatorios; ya revocada = no-op.
 */
export async function revokeAttendance(actor: SessionUser, input: { meetingId: string; personId: string; reason: string }): Promise<AttendanceActionResult> {
  await authorize(actor, input.meetingId, input.personId);
  const reason = requireReason(input.reason, "revocar una asistencia");
  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const row = await lockAttendance(trx, actor, input.meetingId, input.personId);
    if (row.revoked_at) return { changed: false };
    const now = new Date();
    await trx.updateTable("meeting_attendance").set({ revoked_at: now, revoked_by: actor.id, revoke_reason: reason }).where("id", "=", row.id).execute();
    await insertAttendanceEvents(trx, [
      { attendance_id: row.id, meeting_id: row.meeting_id, person_id: row.person_id, event_type: "revoked", occurred_at: now, recorded_by: actor.id, reason },
    ]);
    return { changed: true };
  });
}

/**
 * RESTAURA una asistencia revocada (acto administrativo; el QR nunca restaura). Motivo obligatorio. Limpia revoked_* en la fila
 * actual; quién/cuándo/por qué se revocó queda en el evento `revoked`. No revocada = no-op.
 */
export async function restoreAttendance(actor: SessionUser, input: { meetingId: string; personId: string; reason: string }): Promise<AttendanceActionResult> {
  await authorize(actor, input.meetingId, input.personId);
  const reason = requireReason(input.reason, "restaurar una asistencia");
  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const row = await lockAttendance(trx, actor, input.meetingId, input.personId);
    if (!row.revoked_at) return { changed: false };
    const now = new Date();
    await trx.updateTable("meeting_attendance").set({ revoked_at: null, revoked_by: null, revoke_reason: null }).where("id", "=", row.id).execute();
    await insertAttendanceEvents(trx, [
      { attendance_id: row.id, meeting_id: row.meeting_id, person_id: row.person_id, event_type: "restored", occurred_at: now, recorded_by: actor.id, reason },
    ]);
    return { changed: true };
  });
}

/**
 * CORRIGE únicamente la hora / precisión de una asistencia MANUAL vigente. No cambia persona, reunión, método, identificación ni
 * invitación (el trigger de 0039 también lo impide). Usuario y motivo obligatorios; mismo valor = no-op.
 */
export async function correctAttendance(
  actor: SessionUser,
  input: { meetingId: string; personId: string; reason: string; occurred: Exclude<AttendanceOccurred, { kind: "now" }> }
): Promise<AttendanceActionResult> {
  await authorize(actor, input.meetingId, input.personId);
  const reason = requireReason(input.reason, "corregir una asistencia");
  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const row = await lockAttendance(trx, actor, input.meetingId, input.personId);
    if (row.method !== "manual") throw new ManualAttendanceError("Solo se puede corregir la hora de una asistencia cargada manualmente.");
    if (row.revoked_at) throw new ManualAttendanceError("La asistencia está revocada: restaurala antes de corregirla.");
    const meeting = await trx.selectFrom("meetings").select(["status"]).where("id", "=", row.meeting_id).executeTakeFirstOrThrow();
    const now = new Date();
    const time = await resolveOccurred(trx, input.occurred, now, meeting.status);
    const sameInstant = (a: Date | null, b: Date | null) => (a === null && b === null) || (a !== null && b !== null && a.getTime() === b.getTime());
    if (row.occurred_precision === time.precision && sameInstant(row.checked_in_at, time.checkedInAt)) return { changed: false };
    await trx.updateTable("meeting_attendance").set({ checked_in_at: time.checkedInAt, occurred_precision: time.precision }).where("id", "=", row.id).execute();
    await insertAttendanceEvents(trx, [
      {
        attendance_id: row.id, meeting_id: row.meeting_id, person_id: row.person_id, event_type: "corrected", occurred_at: now,
        recorded_by: actor.id, reason, checked_in_at: time.checkedInAt, occurred_precision: time.precision,
      },
    ]);
    return { changed: true };
  });
}

export interface AttendanceEventRow {
  eventType: AttendanceEventType;
  occurredAt: Date;
  /** Usuario que lo registró; null = la propia persona (QR / enlace). */
  recordedByName: string | null;
  recordedByPerson: boolean;
  attendanceMethod: string | null;
  identification: string | null;
  reason: string | null;
  checkedInAt: Date | null;
  occurredPrecision: AttendancePrecision | null;
}

/** Historial de la asistencia de una persona en una reunión, en el orden real de inserción. Permiso + acceso + persona en alcance. */
export async function listAttendanceEvents(actor: SessionUser, meetingId: string, personId: string): Promise<AttendanceEventRow[]> {
  assertPermission(actor, "meetings.attendance_manual");
  if (!isUuid(meetingId) || !isUuid(personId)) return [];
  const db = await getDb();
  const [allowed, inScope, rows] = await Promise.all([
    canAccessMeeting(actor, meetingId),
    isPersonInScope(db, actor, personId),
    db
      .selectFrom("meeting_attendance_events as e")
      .leftJoin("users as u", "u.id", "e.recorded_by")
      .select(["e.event_type", "e.occurred_at", "e.recorded_by", "u.full_name as recorder_name", "e.attendance_method", "e.identification", "e.reason", "e.checked_in_at", "e.occurred_precision"])
      .where("e.meeting_id", "=", meetingId)
      .where("e.person_id", "=", personId)
      .orderBy("e.seq", "asc")
      .execute(),
  ]);
  if (!allowed || !inScope) return [];
  return rows.map((r) => ({
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    recordedByName: r.recorder_name,
    recordedByPerson: r.recorded_by === null,
    attendanceMethod: r.attendance_method,
    identification: r.identification,
    reason: r.reason,
    checkedInAt: r.checked_in_at,
    occurredPrecision: r.occurred_precision,
  }));
}
