"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guard";
import {
  createOrganization,
  OrganizationCommandError,
  setOrganizationActive,
  updateOrganization,
} from "@/lib/organizations/commands";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function toMessage(err: unknown, fallback: string): string {
  return err instanceof OrganizationCommandError ? err.message : fallback;
}

export async function createOrganizationAction(
  _prevState: ActionResult,
  formData: FormData
): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    const parentId = String(formData.get("parentId") ?? "");
    await createOrganization(actor, {
      name: String(formData.get("name") ?? ""),
      typeId: String(formData.get("typeId") ?? ""),
      parentId: parentId || null,
    });
    revalidatePath("/administracion/organismos");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo crear el organismo.") };
  }
}

export async function updateOrganizationAction(
  organizationId: string,
  _prevState: ActionResult,
  formData: FormData
): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    const parentId = String(formData.get("parentId") ?? "");
    await updateOrganization(actor, organizationId, {
      name: String(formData.get("name") ?? ""),
      typeId: String(formData.get("typeId") ?? ""),
      parentId: parentId || null,
    });
    revalidatePath("/administracion/organismos");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo actualizar el organismo.") };
  }
}

export async function toggleOrganizationActiveAction(
  organizationId: string,
  nextActive: boolean,
  _prevState: ActionResult
): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await setOrganizationActive(actor, organizationId, nextActive);
    revalidatePath("/administracion/organismos");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo actualizar el estado.") };
  }
}
