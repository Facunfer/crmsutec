"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guard";
import { countAudience, type MeetingAudienceSpec } from "@/lib/meetings/audience";
import { createInvitationBatch, MeetingInvitationError, recordInvitationResponse, withdrawInvitation, type CreateInvitationBatchResult, type StaffResponseDate } from "@/lib/meetings/invitations";
import { searchAnyActivePeople } from "@/lib/associations/queries";
import { regenerateQrSecret, MeetingCommandError } from "@/lib/meetings/commands";
import {
  correctAttendance,
  listAttendanceEvents,
  ManualAttendanceError,
  registerAttendanceManually,
  restoreAttendance,
  revokeAttendance,
  type AttendanceOccurred,
} from "@/lib/attendance/manual";

export interface SimpleResult {
  ok: boolean;
  error?: string;
}

export async function countAudienceAction(spec: MeetingAudienceSpec): Promise<{ count: number }> {
  const actor = await requireUser();
  const count = await countAudience(actor, spec);
  return { count };
}

export async function createInvitationBatchAction(
  meetingId: string,
  spec: MeetingAudienceSpec,
  channel: string | null = null
): Promise<{ ok: true; result: CreateInvitationBatchResult } | { ok: false; error: string }> {
  const actor = await requireUser();
  try {
    const result = await createInvitationBatch(actor, meetingId, spec, { channel });
    revalidatePath(`/reuniones/${meetingId}`);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof MeetingInvitationError ? err.message : "No se pudieron generar las invitaciones." };
  }
}

export async function withdrawInvitationAction(meetingId: string, invitationId: string): Promise<SimpleResult> {
  const actor = await requireUser();
  try {
    await withdrawInvitation(actor, invitationId);
    revalidatePath(`/reuniones/${meetingId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "No se pudo quitar el invitado." };
  }
}

/**
 * Registrar la respuesta que la persona dio por otro medio (WhatsApp, llamada, en persona…). La fecha real puede ser exacta
 * (día + hora, hora de Buenos Aires), solo el día, o desconocida: nunca se inventa.
 */
export async function recordInvitationResponseAction(
  meetingId: string,
  invitationId: string,
  input: { response: "confirmed" | "declined"; channel: string; dateMode: "unknown" | "date_only" | "exact"; day?: string; time?: string }
): Promise<SimpleResult & { changed?: boolean }> {
  const actor = await requireUser();
  try {
    let respondedAt: StaffResponseDate = { kind: "unknown" };
    if (input.dateMode === "date_only") respondedAt = { kind: "date_only", day: input.day ?? "" };
    if (input.dateMode === "exact") {
      // Argentina no tiene horario de verano: UTC−03:00 fijo.
      const at = new Date(`${input.day ?? ""}T${input.time || "00:00"}:00-03:00`);
      respondedAt = { kind: "exact", at };
    }
    const result = await recordInvitationResponse(actor, { invitationId, response: input.response, channel: input.channel, respondedAt });
    revalidatePath(`/reuniones/${meetingId}`);
    return { ok: true, changed: result.changed };
  } catch (err) {
    return { ok: false, error: err instanceof MeetingInvitationError ? err.message : "No se pudo registrar la respuesta." };
  }
}

export async function searchPersonForInvitationAction(search: string): Promise<{ results: Array<{ id: string; firstName: string; lastName: string }> }> {
  const actor = await requireUser();
  if (search.trim().length < 2) return { results: [] };
  const results = await searchAnyActivePeople(actor, search);
  return { results };
}

export async function regenerateQrSecretAction(meetingId: string): Promise<SimpleResult> {
  const actor = await requireUser();
  try {
    await regenerateQrSecret(actor, meetingId);
    revalidatePath(`/reuniones/${meetingId}/asistencia`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof MeetingCommandError ? err.message : "No se pudo regenerar el código QR." };
  }
}

/** Cuándo ocurrió la asistencia, tal como lo elige el operador (hora de Buenos Aires; Argentina no tiene horario de verano). */
export interface AttendanceWhenInput {
  mode: "now" | "date_only" | "exact" | "unknown";
  day?: string;
  time?: string;
}

function toOccurred(when: AttendanceWhenInput): AttendanceOccurred {
  if (when.mode === "now") return { kind: "now" };
  if (when.mode === "unknown") return { kind: "unknown" };
  if (when.mode === "date_only") return { kind: "date_only", day: when.day ?? "" };
  return { kind: "exact", at: new Date(`${when.day ?? ""}T${when.time || "00:00"}:00-03:00`) };
}

async function run(meetingId: string, work: () => Promise<{ changed: boolean }>): Promise<SimpleResult & { changed?: boolean }> {
  try {
    const result = await work();
    revalidatePath(`/reuniones/${meetingId}`);
    revalidatePath(`/reuniones/${meetingId}/asistencia`);
    return { ok: true, changed: result.changed };
  } catch (err) {
    return { ok: false, error: err instanceof ManualAttendanceError ? err.message : "No se pudo completar la acción." };
  }
}

/** Registrar a mano la asistencia (con o sin invitación). Motivo obligatorio; en una reunión finalizada hay que indicar cuándo ocurrió. */
export async function registerAttendanceAction(meetingId: string, personId: string, input: { reason: string; when: AttendanceWhenInput }) {
  const actor = await requireUser();
  return run(meetingId, () => registerAttendanceManually(actor, { meetingId, personId, reason: input.reason, occurred: toOccurred(input.when) }));
}

/** Revocar (undo auditable): la asistencia deja de contar; nunca se borra. Motivo obligatorio. */
export async function revokeAttendanceAction(meetingId: string, personId: string, reason: string) {
  const actor = await requireUser();
  return run(meetingId, () => revokeAttendance(actor, { meetingId, personId, reason }));
}

/** Restaurar una asistencia revocada (acto administrativo). Motivo obligatorio. */
export async function restoreAttendanceAction(meetingId: string, personId: string, reason: string) {
  const actor = await requireUser();
  return run(meetingId, () => restoreAttendance(actor, { meetingId, personId, reason }));
}

/** Corregir SOLO la hora/precisión de una asistencia manual. Motivo obligatorio. */
export async function correctAttendanceAction(meetingId: string, personId: string, input: { reason: string; when: Exclude<AttendanceWhenInput, { mode: "now" }> }) {
  const actor = await requireUser();
  return run(meetingId, () => correctAttendance(actor, { meetingId, personId, reason: input.reason, occurred: toOccurred(input.when) as Exclude<AttendanceOccurred, { kind: "now" }> }));
}

export interface AttendanceHistoryItem {
  eventType: string;
  occurredAt: string;
  recordedBy: string;
  method: string | null;
  identification: string | null;
  reason: string | null;
  checkedInAt: string | null;
  precision: string | null;
}

/** Historial de la asistencia de una persona (solo con permiso, acceso a la reunión y persona en alcance). */
export async function listAttendanceHistoryAction(meetingId: string, personId: string): Promise<{ ok: true; events: AttendanceHistoryItem[] } | { ok: false; error: string }> {
  const actor = await requireUser();
  try {
    const events = await listAttendanceEvents(actor, meetingId, personId);
    return {
      ok: true,
      events: events.map((e) => ({
        eventType: e.eventType,
        occurredAt: e.occurredAt.toISOString(),
        recordedBy: e.recordedByPerson ? "la propia persona" : (e.recordedByName ?? "un operador"),
        method: e.attendanceMethod,
        identification: e.identification,
        reason: e.reason,
        checkedInAt: e.checkedInAt ? e.checkedInAt.toISOString() : null,
        precision: e.occurredPrecision,
      })),
    };
  } catch {
    return { ok: false, error: "No se pudo leer el historial." };
  }
}
