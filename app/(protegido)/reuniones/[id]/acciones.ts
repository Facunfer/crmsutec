"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guard";
import { countAudience, type MeetingAudienceSpec } from "@/lib/meetings/audience";
import { createInvitationBatch, MeetingInvitationError, recordInvitationResponse, withdrawInvitation, type CreateInvitationBatchResult, type StaffResponseDate } from "@/lib/meetings/invitations";
import { searchAnyActivePeople } from "@/lib/associations/queries";
import { regenerateQrSecret, MeetingCommandError } from "@/lib/meetings/commands";
import { setAttendanceManually, ManualAttendanceError } from "@/lib/attendance/manual";

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

export async function setAttendanceManuallyAction(
  meetingId: string,
  personId: string,
  attendanceStatus: "attended" | "absent",
  reason: string
): Promise<SimpleResult> {
  const actor = await requireUser();
  try {
    await setAttendanceManually(actor, meetingId, personId, attendanceStatus, reason);
    revalidatePath(`/reuniones/${meetingId}`);
    revalidatePath(`/reuniones/${meetingId}/asistencia`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ManualAttendanceError ? err.message : "No se pudo corregir la asistencia." };
  }
}
