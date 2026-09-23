"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guard";
import {
  createUser,
  grantUserModule,
  grantUserScope,
  resetUserAccess,
  revokeUserModule,
  revokeUserScope,
  setUserActive,
  setUserPrimaryOrganization,
  updateUser,
  UserCommandError,
  type ScopeGrantInput,
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

/**
 * Los valores del formulario son solo una propuesta: cada comando vuelve a
 * validar rol, alcances y módulos contra la base y contra el actor de la sesión.
 */
function parseScopes(formData: FormData): ScopeGrantInput[] {
  return formData.getAll("scopeOrg").map((value) => {
    const organizationId = String(value);
    return {
      organizationId,
      includeDescendants: formData.get(`scopeDesc:${organizationId}`) === "on",
    };
  });
}

/**
 * Área → Repartición del alta: la unidad elegida es la AFILIACIÓN del usuario y, si no se indican alcances explícitos,
 * también su ALCANCE inicial (esa unidad; con dependientes salvo que se destilde). Elegir solo un Área da el alcance del
 * Área completa. Un MASTER_GLOBAL no lleva alcances.
 */
function scopesFromAffiliation(formData: FormData, roleKey: string): ScopeGrantInput[] {
  const explicit = parseScopes(formData);
  if (explicit.length > 0 || roleKey === "MASTER_GLOBAL") return explicit;
  const organizationId = String(formData.get("primaryOrganizationId") ?? "");
  if (!organizationId) return [];
  return [{ organizationId, includeDescendants: formData.getAll("includeDescendants").includes("on") }];
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
      scopes: scopesFromAffiliation(formData, String(formData.get("roleKey") ?? "")),
      moduleKeys: formData.getAll("moduleKey").map(String),
      primaryOrganizationId: String(formData.get("primaryOrganizationId") ?? "") || null,
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

export async function grantScopeAction(
  userId: string,
  _prevState: ActionResult,
  formData: FormData
): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await grantUserScope(actor, userId, {
      organizationId: String(formData.get("organizationId") ?? ""),
      includeDescendants: formData.get("includeDescendants") === "on",
    });
    revalidatePath("/administracion/usuarios");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo otorgar el alcance.") };
  }
}

export async function revokeScopeAction(
  userId: string,
  scopeId: string,
  _prevState: ActionResult
): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await revokeUserScope(actor, userId, scopeId);
    revalidatePath("/administracion/usuarios");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo revocar el alcance.") };
  }
}

export async function grantModuleAction(
  userId: string,
  _prevState: ActionResult,
  formData: FormData
): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await grantUserModule(actor, userId, String(formData.get("moduleKey") ?? ""));
    revalidatePath("/administracion/usuarios");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo habilitar el módulo.") };
  }
}

export async function revokeModuleAction(
  userId: string,
  moduleId: string,
  _prevState: ActionResult
): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await revokeUserModule(actor, userId, moduleId);
    revalidatePath("/administracion/usuarios");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo quitar el módulo.") };
  }
}

export async function updateAffiliationAction(userId: string, _prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await setUserPrimaryOrganization(actor, userId, String(formData.get("primaryOrganizationId") ?? "") || null);
    revalidatePath("/administracion/usuarios");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo guardar la afiliación.") };
  }
}
