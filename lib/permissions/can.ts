import { assertServerOnly } from "../server-only.js";
import { moduleOfPermission, type ModuleKey, type PermissionKey, type RoleKey } from "./catalog.js";

assertServerOnly("lib/permissions/can.ts");

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  roleId: string;
  roleKey: RoleKey;
  mustChangePassword: boolean;
  permissions: ReadonlySet<PermissionKey>;
  /**
   * Módulos habilitados para el usuario (`user_enabled_modules`, migración 0013),
   * cargados con la sesión. Para MASTER_GLOBAL son todos los activos, sin filas
   * en `user_modules`.
   */
  enabledModules: ReadonlySet<ModuleKey>;
}

/**
 * ¿Tiene el módulo habilitado? MASTER_GLOBAL siempre (bypass explícito, igual
 * que `user_enabled_modules` en la base); el resto solo si el módulo figura
 * entre los habilitados de su sesión.
 */
export function hasModule(user: SessionUser, moduleKey: ModuleKey): boolean {
  return isMasterGlobal(user) || user.enabledModules.has(moduleKey);
}

/**
 * Único chequeo de acceso del sistema (D5): siempre por permiso, nunca por
 * nombre de rol. Acceso efectivo = permiso del rol + módulo habilitado al que
 * ese permiso pertenece (derivado del catálogo). Es el único lugar donde se
 * combinan: Sidebar, páginas (`requirePermission`), comandos y Server Actions
 * (`assertPermission`) y endpoints (`can`) pasan todos por acá. El alcance
 * organizativo NO se resuelve acá: cada consulta lo aplica por separado.
 */
export function can(user: SessionUser, permission: PermissionKey): boolean {
  return user.permissions.has(permission) && hasModule(user, moduleOfPermission(permission));
}

export function isMasterGlobal(user: SessionUser): boolean {
  return user.roleKey === "MASTER_GLOBAL";
}
