import { sql } from "kysely";
import { redirect } from "next/navigation";
import { getDb } from "../db/client.js";
import { displayOf, loadOrgDisplayNames } from "../organizations/display.js";
import { assertServerOnly } from "../server-only.js";
import { PermissionError, requireUser } from "../auth/guard.js";
import { can, isMasterGlobal, type SessionUser } from "../permissions/can.js";
import type { PermissionKey, RoleKey } from "../permissions/catalog.js";
import { listOwnerOrganizationOptions } from "../organizations/ownership.js";
import type { OrganizationOption } from "../organizations/queries.js";
import type { UserListItem } from "./queries.js";

assertServerOnly("lib/users/administration.ts");

/**
 * Modelo de administración de usuarios:
 *  - global:  `users.manage` (MASTER_GLOBAL). Ve y administra a todos.
 *  - scoped:  `users.manage_scoped` (ADMIN y usuarios delegados). Solo ve y
 *             administra usuarios cuyos alcances quedan completamente dentro
 *             de los propios, y solo puede conceder lo que ya posee.
 *  - none:    sin ninguno de los dos permisos.
 *
 * La UI solo refleja esto; cada comando vuelve a validar (R5). Las reglas de
 * contención ya viven en la base (migraciones 0012/0013: triggers de
 * user_scopes/user_modules y `create_scoped_user_checks`) y acá se reutilizan.
 */
export type UserAdminMode = "global" | "scoped" | "none";

export function getUserAdminMode(actor: SessionUser): UserAdminMode {
  if (can(actor, "users.manage")) return "global";
  if (can(actor, "users.manage_scoped")) return "scoped";
  return "none";
}

/** Para Server Actions y comandos: exige alguno de los dos permisos y devuelve el modo. */
export function requireUserAdminMode(actor: SessionUser): Exclude<UserAdminMode, "none"> {
  const mode = getUserAdminMode(actor);
  if (mode === "none") {
    throw new PermissionError('Falta el permiso "users.manage" o "users.manage_scoped".');
  }
  return mode;
}

/** Para páginas: corta al login sin sesión y a /sin-permiso sin ninguno de los dos permisos. */
export async function requireUserAdminPage(): Promise<{ actor: SessionUser; mode: Exclude<UserAdminMode, "none"> }> {
  const actor = await requireUser();
  const mode = getUserAdminMode(actor);
  if (mode === "none") redirect("/sin-permiso");
  return { actor, mode };
}

/**
 * Usuarios que un actor delegado puede administrar: no son MASTER_GLOBAL y
 * TODOS sus alcances vigentes (expandidos a descendientes cuando corresponde)
 * caen dentro de las unidades accesibles del actor. Un usuario sin alcances no
 * es "contenido en" nada (evita el caso vacío que dejaría ver a cualquiera),
 * salvo que lo haya creado el propio actor y todavía no tenga ninguno.
 */
function administrableUserIdsQuery(actorId: string) {
  return sql<{ id: string }>`
    with actor_orgs as (
      select organization_id from user_accessible_organizations(${actorId}::uuid)
    ),
    active_scopes as (
      select user_id, organization_id, include_descendants
      from user_scopes
      where revoked_at is null
    ),
    covered as (
      select s.user_id, s.organization_id as organization_id
      from active_scopes s
      where s.include_descendants = false
      union
      select s.user_id, d.organization_id
      from active_scopes s
      cross join lateral organization_descendants(s.organization_id) d
      where s.include_descendants = true
    )
    select u.id
    from users u
    join roles r on r.id = u.role_id
    where r.key <> 'MASTER_GLOBAL'
      and (
        (
          exists (select 1 from active_scopes a where a.user_id = u.id)
          and not exists (
            select 1 from covered c
            where c.user_id = u.id
              and c.organization_id not in (select organization_id from actor_orgs)
          )
        )
        or (
          u.created_by = ${actorId}::uuid
          and not exists (select 1 from active_scopes a where a.user_id = u.id)
        )
      )
  `;
}

export async function isUserAdministrable(actor: SessionUser, targetUserId: string): Promise<boolean> {
  const mode = getUserAdminMode(actor);
  if (mode === "none") return false;

  const db = await getDb();
  if (mode === "global") {
    const row = await db.selectFrom("users").select("id").where("id", "=", targetUserId).executeTakeFirst();
    return Boolean(row);
  }

  const result = await sql<{ ok: boolean }>`
    select exists (
      select 1 from (${administrableUserIdsQuery(actor.id)}) a where a.id = ${targetUserId}::uuid
    ) as ok
  `.execute(db);
  return result.rows[0]?.ok === true;
}

/** Usuarios que el actor puede ver en /administracion/usuarios (siempre incluye al propio actor). */
export async function listAdministrableUsers(actor: SessionUser): Promise<UserListItem[]> {
  const mode = requireUserAdminMode(actor);
  return selectUsers(actor, mode === "scoped");
}

/**
 * Usuarios dentro del alcance del actor, para selectores (p. ej. responsables de
 * una asociación). No exige permisos de administración: MASTER_GLOBAL ve todos; el
 * resto, solo a quienes tienen todos sus alcances dentro de los propios (y a sí mismo).
 */
export async function listUsersInScope(actor: SessionUser): Promise<UserListItem[]> {
  return selectUsers(actor, !isMasterGlobal(actor));
}

async function selectUsers(actor: SessionUser, restrictToScope: boolean): Promise<UserListItem[]> {
  const db = await getDb();

  let query = db
    .selectFrom("users")
    .innerJoin("roles", "roles.id", "users.role_id")
    .leftJoin("organizations as unit_org", "unit_org.id", "users.primary_organization_id")
    .leftJoin("organizations as area_org", (join) => join.on(sql<boolean>`area_org.id = public.organization_area_id(users.primary_organization_id)`))
    .select([
      "users.id",
      "users.email",
      "users.full_name",
      "roles.key as role_key",
      "users.status",
      "users.must_change_password",
      "users.created_at",
      "users.primary_organization_id",
      "area_org.name as area_name",
      "area_org.id as area_id",
      "unit_org.id as unit_id",
      sql<string | null>`case when unit_org.parent_id is null then null else unit_org.name end`.as("reparticion_name"),
    ])
    .orderBy("users.created_at", "asc");

  if (restrictToScope) {
    const visible = await administrableUserIdsQuery(actor.id).execute(db);
    const ids = [...new Set([...visible.rows.map((r) => r.id), actor.id])];
    query = query.where("users.id", "in", ids);
  }

  const rows = await query.execute();
  const names = await loadOrgDisplayNames(db);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    roleKey: r.role_key as RoleKey,
    status: r.status,
    mustChangePassword: r.must_change_password,
    createdAt: r.created_at,
    primaryOrganizationId: r.primary_organization_id,
    areaName: displayOf(names, r.area_id, r.area_name),
    reparticionName: r.reparticion_name === null ? null : displayOf(names, r.unit_id, r.reparticion_name),
  }));
}

/**
 * Roles que el actor puede asignar. Global: cualquiera, y MASTER_GLOBAL solo si
 * el actor lo es. Delegado: nunca MASTER_GLOBAL y solo roles cuyos permisos son
 * subconjunto de los propios. (`create_scoped_user_checks` lo vuelve a exigir en la base.)
 */
export async function listAssignableRoles(actor: SessionUser): Promise<RoleKey[]> {
  const mode = requireUserAdminMode(actor);
  const db = await getDb();
  const rows = await db
    .selectFrom("roles")
    .leftJoin("role_permissions", "role_permissions.role_id", "roles.id")
    .leftJoin("permissions", "permissions.id", "role_permissions.permission_id")
    .select(["roles.key as role_key", "permissions.key as permission_key"])
    .orderBy("roles.key")
    .execute();

  const byRole = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byRole.get(r.role_key) ?? new Set<string>();
    if (r.permission_key) set.add(r.permission_key);
    byRole.set(r.role_key, set);
  }

  const result: RoleKey[] = [];
  for (const [roleKey, perms] of byRole) {
    if (roleKey === "MASTER_GLOBAL") {
      if (isMasterGlobal(actor)) result.push(roleKey);
      continue;
    }
    if (mode === "global" || [...perms].every((p) => actor.permissions.has(p as PermissionKey))) {
      result.push(roleKey as RoleKey);
    }
  }
  return result;
}

export interface ModuleOption {
  key: string;
  name: string;
}

/** Módulos que el actor puede otorgar: los que tiene habilitados (todos, si es MASTER_GLOBAL). */
export async function listGrantableModules(actor: SessionUser): Promise<ModuleOption[]> {
  requireUserAdminMode(actor);
  const db = await getDb();
  const result = await sql<ModuleOption>`
    select m.key, m.name
    from modules m
    join user_enabled_modules(${actor.id}::uuid) e on e.module_key = m.key
    order by m.sort_order
  `.execute(db);
  return result.rows;
}

/** Unidades que el actor puede conceder como alcance (las propias y descendientes; todas si es MASTER_GLOBAL). */
export async function listGrantableOrganizations(actor: SessionUser): Promise<OrganizationOption[]> {
  requireUserAdminMode(actor);
  return listOwnerOrganizationOptions(actor.id);
}

export interface UserAccessItem {
  scopes: Array<{
    id: string;
    organizationId: string;
    organizationName: string;
    includeDescendants: boolean;
  }>;
  modules: Array<{ id: string; moduleKey: string; moduleName: string }>;
}

/** Alcances y módulos vigentes (no revocados) de un usuario. */
export async function getUserAccess(userId: string): Promise<UserAccessItem> {
  const db = await getDb();
  const scopes = await db
    .selectFrom("user_scopes")
    .innerJoin("organizations", "organizations.id", "user_scopes.organization_id")
    .select([
      "user_scopes.id",
      "user_scopes.organization_id",
      "organizations.name as organization_name",
      "user_scopes.include_descendants",
    ])
    .where("user_scopes.user_id", "=", userId)
    .where("user_scopes.revoked_at", "is", null)
    .orderBy("organizations.name")
    .execute();
  const modules = await db
    .selectFrom("user_modules")
    .innerJoin("modules", "modules.key", "user_modules.module_key")
    .select(["user_modules.id", "user_modules.module_key", "modules.name as module_name"])
    .where("user_modules.user_id", "=", userId)
    .where("user_modules.revoked_at", "is", null)
    .orderBy("modules.sort_order")
    .execute();

  return {
    scopes: scopes.map((s) => ({
      id: s.id,
      organizationId: s.organization_id,
      organizationName: s.organization_name,
      includeDescendants: s.include_descendants,
    })),
    modules: modules.map((m) => ({ id: m.id, moduleKey: m.module_key, moduleName: m.module_name })),
  };
}
