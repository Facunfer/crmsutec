import type { MeetingStatus } from "../db/schema.js";

export type { MeetingStatus };

/**
 * Máquina de estados de reuniones (sección 11 del prompt). `overdue_unclosed`
 * no es un destino de transición manual: es una etiqueta derivada que se
 * calcula al leer (`isOverdueUnclosed`) para una reunión `scheduled`/
 * `in_progress` cuya `ends_at` ya pasó — nadie la finaliza sola (regla
 * explícita del prompt), así que no hay ningún job que escriba ese status.
 */
export const MEETING_TRANSITIONS: Record<MeetingStatus, MeetingStatus[]> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["finished", "cancelled"],
  finished: [],
  cancelled: [],
  overdue_unclosed: [],
};

export function canTransition(from: MeetingStatus, to: MeetingStatus): boolean {
  return MEETING_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Nombre, descripción, fechas, lugar: solo mientras no arrancó. */
export function canEditCoreFields(status: MeetingStatus): boolean {
  return status === "draft" || status === "scheduled";
}

/** Generar/quitar invitaciones: desde que está programada hasta que termina. */
export function canManageInvitations(status: MeetingStatus): boolean {
  return status === "scheduled" || status === "in_progress";
}

/** El público puede confirmar/rechazar solo mientras la reunión no arrancó (D9/D11). */
export function isPubliclyRespondable(status: MeetingStatus): boolean {
  return status === "scheduled";
}

/** Una actividad importada sin hora de fin (fecha pendiente o solo el día) nunca cuenta como "vencida sin cerrar". */
export function isOverdueUnclosed(status: MeetingStatus, endsAt: Date | null): boolean {
  return (status === "scheduled" || status === "in_progress") && endsAt !== null && endsAt.getTime() < Date.now();
}

export const STATUS_LABEL: Record<MeetingStatus, string> = {
  draft: "Borrador",
  scheduled: "Programada",
  in_progress: "En curso",
  finished: "Finalizada",
  cancelled: "Cancelada",
  overdue_unclosed: "Vencida sin cerrar",
};
