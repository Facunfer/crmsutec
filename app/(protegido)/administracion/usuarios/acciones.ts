"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guard";
import {
  createUser,
  resetUserAccess,
  setUserActive,
  updateUser,
  UserCommandError,
} from "@/lib/users/commands";
import type { RoleKey } from "@/lib/permissions/catalog";

export interface ActionResult {
  ok: boolean;
  error?: string;
  temporaryPassword?: string;
}

function toMessage(err: unknown, fallback: string): string {
  return err instanceof UserCommandError ? err.message : fallback;
}

export async function createUserAction(
  _prevState: ActionResult,
  formData: FormData
): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    const { temporaryPassword } = await createUser(actor, {
      email: String(formData.get("email") ?? ""),
      fullName: String(formData.get("fullName") ?? ""),
      roleKey: String(formData.get("roleKey") ?? "") as RoleKey,
    });
    revalidatePath("/administracion/usuarios");
    return { ok: true, temporaryPassword };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo crear el usuario.") };
  }
}

export async function updateRoleAction(
  userId: string,
  _prevState: ActionResult,
  formData: FormData
): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await updateUser(actor, userId, { roleKey: String(formData.get("roleKey") ?? "") as RoleKey });
    revalidatePath("/administracion/usuarios");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo cambiar el rol.") };
  }
}

export async function toggleActiveAction(
  userId: string,
  nextActive: boolean,
  _prevState: ActionResult
): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await setUserActive(actor, userId, nextActive);
    revalidatePath("/administracion/usuarios");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo actualizar el estado.") };
  }
}

export async function resetAccessAction(
  userId: string,
  _prevState: ActionResult
): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    const { temporaryPassword } = await resetUserAccess(actor, userId);
    revalidatePath("/administracion/usuarios");
    return { ok: true, temporaryPassword };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo resetear el acceso.") };
  }
}
