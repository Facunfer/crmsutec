import { assertServerOnly } from "../server-only.js";
import type { PermissionKey, RoleKey } from "./catalog.js";

assertServerOnly("lib/permissions/can.ts");

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  roleId: string;
  roleKey: RoleKey;
  mustChangePassword: boolean;
  permissions: ReadonlySet<PermissionKey>;
}

/** Único chequeo de permisos del sistema (D5): siempre por permiso, nunca por nombre de rol. */
export function can(user: SessionUser, permission: PermissionKey): boolean {
  return user.permissions.has(permission);
}

export function isMasterGlobal(user: SessionUser): boolean {
  return user.roleKey === "MASTER_GLOBAL";
}
