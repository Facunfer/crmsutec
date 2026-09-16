import { redirect } from "next/navigation";
import { assertServerOnly } from "../server-only.js";
import { can, type SessionUser } from "../permissions/can.js";
import type { PermissionKey } from "../permissions/catalog.js";
import { getSessionCookie } from "./cookies.js";
import { loadSessionUser } from "./session.js";

assertServerOnly("lib/auth/guard.ts");

/**
 * Capa 2 y 3 de permisos (sección R5): esto es lo único que valida sesión
 * de verdad. El middleware (capa barata en Edge) solo mira si existe la
 * cookie; layouts, páginas y Server Actions llaman siempre a estas
 * funciones, nunca confían en que el middleware ya filtró.
 */

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = await getSessionCookie();
  if (!token) return null;
  return loadSessionUser(token);
}

/** Para layouts/páginas: corta al login si no hay sesión válida. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect("/login?expirada=1");
  }
  return user;
}

/** Para layouts/páginas: además exige un permiso puntual. */
export async function requirePermission(permission: PermissionKey): Promise<SessionUser> {
  const user = await requireUser();
  if (!can(user, permission)) {
    redirect("/sin-permiso");
  }
  return user;
}

export class PermissionError extends Error {}

/** Para Server Actions: mismo chequeo, pero sin redirigir (la acción decide qué responder). */
export function assertPermission(user: SessionUser, permission: PermissionKey): void {
  if (!can(user, permission)) {
    throw new PermissionError(`Falta el permiso "${permission}".`);
  }
}
