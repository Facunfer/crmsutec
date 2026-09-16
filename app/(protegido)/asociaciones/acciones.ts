"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import {
  createAssociation,
  AssociationCommandError,
  setAssociationActive,
  updateAssociation,
} from "@/lib/associations/commands";

export interface AssociationActionResult {
  ok: boolean;
  error?: string;
}

function toMessage(err: unknown, fallback: string): string {
  return err instanceof AssociationCommandError ? err.message : fallback;
}

export async function createAssociationAction(
  _prevState: AssociationActionResult,
  formData: FormData
): Promise<AssociationActionResult> {
  const actor = await requireUser();

  let createdId: string;
  try {
    const result = await createAssociation(actor, {
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? ""),
      typeId: String(formData.get("typeId") ?? ""),
    });
    createdId = result.id;
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo crear la asociación.") };
  }

  revalidatePath("/asociaciones");
  redirect(`/asociaciones/${createdId}`);
}

export async function updateAssociationAction(
  associationId: string,
  _prevState: AssociationActionResult,
  formData: FormData
): Promise<AssociationActionResult> {
  const actor = await requireUser();
  try {
    await updateAssociation(actor, associationId, {
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? ""),
      typeId: String(formData.get("typeId") ?? ""),
    });
    revalidatePath("/asociaciones");
    revalidatePath(`/asociaciones/${associationId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo guardar los cambios.") };
  }
}

export async function setAssociationActiveAction(
  associationId: string,
  active: boolean
): Promise<AssociationActionResult> {
  const actor = await requireUser();
  try {
    await setAssociationActive(actor, associationId, active);
    revalidatePath("/asociaciones");
    revalidatePath(`/asociaciones/${associationId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo actualizar el estado.") };
  }
}
