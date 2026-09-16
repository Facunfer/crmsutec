"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guard";
import { createNewFromCandidate, discardDuplicateCandidate, linkDuplicateCandidate, DuplicateResolutionError } from "@/lib/forms/duplicates";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function toMessage(err: unknown, fallback: string): string {
  return err instanceof DuplicateResolutionError ? err.message : fallback;
}

export async function linkCandidateAction(candidateId: string): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await linkDuplicateCandidate(actor, candidateId);
    revalidatePath("/formularios/revision");
    revalidatePath("/formularios");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo vincular.") };
  }
}

export async function createNewFromCandidateAction(candidateId: string): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await createNewFromCandidate(actor, candidateId);
    revalidatePath("/formularios/revision");
    revalidatePath("/formularios");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo crear la persona.") };
  }
}

export async function discardCandidateAction(candidateId: string): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await discardDuplicateCandidate(actor, candidateId);
    revalidatePath("/formularios/revision");
    revalidatePath("/formularios");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo descartar.") };
  }
}
