import type { Transaction } from "kysely";
import { assertServerOnly } from "../server-only.js";
import type { AttendanceEventType, AttendanceIdentification, AttendanceMethod, AttendancePrecision, Database } from "../db/schema.js";

assertServerOnly("lib/attendance/events.ts");

/**
 * INVARIANTE DE INTEGRIDAD DEL HISTORIAL DE ASISTENCIA (aplicación, no de base de datos):
 * toda mutación de estado de `meeting_attendance` (alta, revocación, restauración, corrección de hora) debe pasar EXCLUSIVAMENTE
 * por los comandos transaccionales de `lib/attendance/` (`recordCheckIn` en checkin.ts; `registerAttendanceManually`,
 * `revokeAttendance`, `restoreAttendance`, `correctAttendance` en manual.ts), que actualizan la fila Y registran su evento en
 * `meeting_attendance_events` en la MISMA transacción, con la fila bloqueada (FOR UPDATE) cuando corresponde. La base impone
 * combinaciones imposibles (0039) y que el historial sea append-only (0040), pero NO impone que exista un evento por cada cambio.
 * La asistencia NO crea interacciones (decisión B3 / Opción B): asistencia y contacto son dimensiones distintas.
 */
export type AttendanceTrx = Transaction<Database>;

export interface AttendanceEventInput {
  attendance_id: string;
  meeting_id: string;
  person_id: string;
  event_type: AttendanceEventType;
  occurred_at: Date;
  recorded_by: string | null;
  attendance_method?: AttendanceMethod | null;
  identification?: AttendanceIdentification | null;
  reason?: string | null;
  checked_in_at?: Date | null;
  occurred_precision?: AttendancePrecision | null;
}

/** Único punto de escritura del historial de asistencia. Se invoca SIEMPRE dentro de la transacción que cambia la fila. */
export async function insertAttendanceEvents(trx: AttendanceTrx, events: AttendanceEventInput[]): Promise<void> {
  if (events.length === 0) return;
  await trx
    .insertInto("meeting_attendance_events")
    .values(
      events.map((e) => ({
        attendance_id: e.attendance_id,
        meeting_id: e.meeting_id,
        person_id: e.person_id,
        event_type: e.event_type,
        occurred_at: e.occurred_at,
        recorded_by: e.recorded_by,
        attendance_method: e.attendance_method ?? null,
        identification: e.identification ?? null,
        reason: e.reason ?? null,
        checked_in_at: e.checked_in_at ?? null,
        occurred_precision: e.occurred_precision ?? null,
      }))
    )
    .execute();
}
