import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import type { PermissionKey, RoleKey } from "./catalog.js";

assertServerOnly("lib/permissions/queries.ts");

export interface RolePermissionMatrix {
  roles: Array<{ key: RoleKey; name: string }>;
  permissions: Array<{ key: PermissionKey; description: string }>;
  /** true si el rol (por key) tiene el permiso (por key), leído de la base real. */
  grants: Record<string, boolean>;
}

export async function loadRolePermissionMatrix(): Promise<RolePermissionMatrix> {
  const db = await getDb();

  const roles = await db.selectFrom("roles").select(["id", "key", "name"]).orderBy("name").execute();
  const permissions = await db
    .selectFrom("permissions")
    .select(["id", "key", "description"])
    .orderBy("key")
    .execute();
  const links = await db.selectFrom("role_permissions").selectAll().execute();

  const linkSet = new Set(links.map((l) => `${l.role_id}:${l.permission_id}`));
  const grants: Record<string, boolean> = {};
  for (const role of roles) {
    for (const permission of permissions) {
      grants[`${role.key}:${permission.key}`] = linkSet.has(`${role.id}:${permission.id}`);
    }
  }

  return {
    roles: roles.map((r) => ({ key: r.key as RoleKey, name: r.name })),
    permissions: permissions.map((p) => ({ key: p.key as PermissionKey, description: p.description })),
    grants,
  };
}
