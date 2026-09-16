"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { bulkSetActive } from "@/lib/people/bulk";
import {
  createPerson,
  PersonCommandError,
  setPersonActive,
  updatePerson,
  type DuplicateWarning,
} from "@/lib/people/commands";
import { parsePersonForm } from "@/lib/people/schema";
import { listAllMatchingIds, type PeopleFilterSpec } from "@/lib/people/queries";
import { bulkAddMembers } from "@/lib/associations/members";
import { z } from "zod";

export interface PersonActionResult {
  ok: boolean;
  error?: string;
  blockedByPersonId?: string;
  needsConfirmation?: boolean;
  warnings?: DuplicateWarning[];
  personId?: string;
}

function toMessage(err: unknown, fallback: string): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message ?? fallback;
  if (err instanceof PersonCommandError) return err.message;
  return fallback;
}

export async function createPersonAction(
  _prevState: PersonActionResult,
  formData: FormData
): Promise<PersonActionResult> {
  const actor = await requireUser();
  const confirmDuplicates = formData.get("confirmDuplicates") === "true";

  let createdId: string;
  try {
    const input = parsePersonForm(formData);
    const result = await createPerson(actor, input, { confirmDuplicates });
    if ("needsConfirmation" in result) {
      return { ok: false, needsConfirmation: true, warnings: result.warnings };
    }
    createdId = result.id;
  } catch (err) {
    return {
      ok: false,
      error: toMessage(err, "No se pudo crear la persona."),
      blockedByPersonId: err instanceof PersonCommandError ? err.blockedByPersonId : undefined,
    };
  }

  // redirect() usa un throw especial: tiene que quedar afuera del try/catch
  // de arriba o el catch lo atraparía como si fuera un error de negocio.
  revalidatePath("/personas");
  redirect(`/personas/${createdId}`);
}

export async function updatePersonAction(
  personId: string,
  expectedVersion: number,
  _prevState: PersonActionResult,
  formData: FormData
): Promise<PersonActionResult> {
  const actor = await requireUser();
  const confirmDuplicates = formData.get("confirmDuplicates") === "true";
  try {
    const input = parsePersonForm(formData);
    const result = await updatePerson(actor, personId, expectedVersion, input, { confirmDuplicates });
    if ("needsConfirmation" in result) {
      return { ok: false, needsConfirmation: true, warnings: result.warnings };
    }
    revalidatePath("/personas");
    revalidatePath(`/personas/${personId}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: toMessage(err, "No se pudo guardar los cambios."),
      blockedByPersonId: err instanceof PersonCommandError ? err.blockedByPersonId : undefined,
    };
  }
}

export async function setPersonActiveAction(
  personId: string,
  active: boolean
): Promise<{ ok: boolean; error?: string }> {
  const actor = await requireUser();
  try {
    await setPersonActive(actor, personId, active);
    revalidatePath("/personas");
    revalidatePath(`/personas/${personId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "No se pudo actualizar." };
  }
}

export type BulkSelection = { mode: "ids"; ids: string[] } | { mode: "filter"; filter: PeopleFilterSpec };

export async function bulkSetActiveAction(
  selection: BulkSelection,
  active: boolean
): Promise<{ ok: boolean; error?: string; count?: number }> {
  const actor = await requireUser();
  try {
    const ids = selection.mode === "ids" ? selection.ids : await listAllMatchingIds(selection.filter);
    const count = await bulkSetActive(actor, ids, active);
    revalidatePath("/personas");
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "No se pudo actualizar." };
  }
}

/** "Alta masiva desde una selección/filtro de Personas" hacia una asociación (sección 10 del prompt). */
export async function bulkAddToAssociationAction(
  selection: BulkSelection,
  associationId: string
): Promise<{ ok: boolean; error?: string; count?: number }> {
  const actor = await requireUser();
  try {
    const ids = selection.mode === "ids" ? selection.ids : await listAllMatchingIds(selection.filter);
    const count = await bulkAddMembers(actor, associationId, ids);
    revalidatePath("/personas");
    revalidatePath(`/asociaciones/${associationId}`);
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "No se pudo agregar a la asociación." };
  }
}
