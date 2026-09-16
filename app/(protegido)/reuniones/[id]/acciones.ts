"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guard";
import { countAudience, type MeetingAudienceSpec } from "@/lib/meetings/audience";
import { createInvitationBatch, MeetingInvitationError, withdrawInvitation, type CreateInvitationBatchResult } from "@/lib/meetings/invitations";
import { searchAnyActivePeople } from "@/lib/associations/queries";

export interface SimpleResult {
  ok: boolean;
  error?: string;
}

export async function countAudienceAction(spec: MeetingAudienceSpec): Promise<{ count: number }> {
  await requireUser();
  const count = await countAudience(spec);
  return { count };
}

export async function createInvitationBatchAction(
  meetingId: string,
  spec: MeetingAudienceSpec
): Promise<{ ok: true; result: CreateInvitationBatchResult } | { ok: false; error: string }> {
  const actor = await requireUser();
  try {
    const result = await createInvitationBatch(actor, meetingId, spec);
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

export async function searchPersonForInvitationAction(search: string): Promise<{ results: Array<{ id: string; firstName: string; lastName: string }> }> {
  await requireUser();
  if (search.trim().length < 2) return { results: [] };
  const results = await searchAnyActivePeople(search);
  return { results };
}
