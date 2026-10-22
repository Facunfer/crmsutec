import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { sanitizeCsvCell } from "../people/export.js";
import type { SessionUser } from "../permissions/can.js";
import type { ActivityKind } from "./hub.js";
import { ATTENDANCE_CELL_LABEL, getAttendanceReport, type AttendanceRow } from "./attendance-report.js";

assertServerOnly("lib/activities/attendance-export.ts");

export class AttendanceExportError extends Error {}

/** Tope de filas por exportación (una campaña masiva se exporta por partes con el buscador y los filtros). */
const MAX_EXPORT_ROWS = 20_000;
const PAGE = 200;

/**
 * Exporta a CSV el registro de asistencia de una actividad (una fila por persona, una columna por fecha). Exige `meetings.edit` (quien gestiona
 * la actividad). Respeta el alcance del usuario y el enmascarado: DNI enmascarado sin `people.view_sensitive`. Cada celda pasa por
 * `sanitizeCsvCell` (anti-inyección de fórmulas en Excel). BOM UTF-8 para que Excel no rompa acentos.
 */
export async function exportAttendanceCsv(actor: SessionUser, kind: ActivityKind, id: string): Promise<string> {
  assertPermission(actor, "meetings.edit");

  const first = await getAttendanceReport(actor, kind, id, { page: 1, pageSize: PAGE });
  if (!first) throw new AttendanceExportError("La actividad no existe.");

  const rows: AttendanceRow[] = [...first.rows];
  for (let page = 2; rows.length < Math.min(first.totalRows, MAX_EXPORT_ROWS); page += 1) {
    const next = await getAttendanceReport(actor, kind, id, { page, pageSize: PAGE });
    if (!next || next.rows.length === 0) break;
    rows.push(...next.rows);
  }

  const dateHeaders = first.dates.map((d) => (kind === "campana" ? `Fecha ${d.number}` : "Asistencia"));
  const header = ["Apellido", "Nombre", "DNI", "Unidad", ...dateHeaders, "Asistió a", "Esperada en"];
  const lines = [header.map(sanitizeCsvCell).join(",")];
  for (const r of rows.slice(0, MAX_EXPORT_ROWS)) {
    const cells = first.dates.map((d) => ATTENDANCE_CELL_LABEL[r.cells[d.meetingId] ?? "none"]);
    lines.push([r.lastName, r.firstName, r.dni ?? "", r.organizationName ?? "", ...cells, `${r.attendedCount} de ${first.dates.length}`, String(r.expectedCount)].map(sanitizeCsvCell).join(","));
  }
  return `﻿${lines.join("\r\n")}`;
}
