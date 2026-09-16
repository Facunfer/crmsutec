"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { createMeeting, MeetingCommandError, updateMeeting, changeMeetingStatus, setMeetingAssociations } from "@/lib/meetings/commands";
import { parseMeetingForm } from "@/lib/meetings/schema";
import type { MeetingStatus } from "@/lib/meetings/state-machine";
import { z } from "zod";

export interface MeetingActionResult {
  ok: boolean;
  error?: string;
}

function toMessage(err: unknown, fallback: string): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message ?? fallback;
  if (err instanceof MeetingCommandError) return err.message;
  return fallback;
}

export async function createMeetingAction(
  _prevState: MeetingActionResult,
  formData: FormData
): Promise<MeetingActionResult> {
  const actor = await requireUser();

  let createdId: string;
  try {
    const input = parseMeetingForm(formData);
    const result = await createMeeting(actor, input);
    createdId = result.id;

    const associationId = String(formData.get("associationId") ?? "");
    if (associationId) {
      await setMeetingAssociations(actor, createdId, [associationId]);
    }
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo crear la reunión.") };
  }

  revalidatePath("/reuniones");
  redirect(`/reuniones/${createdId}`);
}

export async function updateMeetingAction(
  meetingId: string,
  _prevState: MeetingActionResult,
  formData: FormData
): Promise<MeetingActionResult> {
  const actor = await requireUser();
  try {
    const input = parseMeetingForm(formData);
    await updateMeeting(actor, meetingId, input);
    revalidatePath("/reuniones");
    revalidatePath(`/reuniones/${meetingId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo guardar los cambios.") };
  }
}

export async function changeMeetingStatusAction(
  meetingId: string,
  targetStatus: MeetingStatus
): Promise<MeetingActionResult> {
  const actor = await requireUser();
  try {
    await changeMeetingStatus(actor, meetingId, targetStatus);
    revalidatePath("/reuniones");
    revalidatePath(`/reuniones/${meetingId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo cambiar el estado.") };
  }
}

export async function setMeetingAssociationsAction(
  meetingId: string,
  associationIds: string[]
): Promise<MeetingActionResult> {
  const actor = await requireUser();
  try {
    await setMeetingAssociations(actor, meetingId, associationIds);
    revalidatePath(`/reuniones/${meetingId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo guardar las asociaciones.") };
  }
}
