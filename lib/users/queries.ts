import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { displayOf, loadOrgDisplayNames } from "../organizations/display.js";
import { assertServerOnly } from "../server-only.js";
import type { RoleKey } from "../permissions/catalog.js";

assertServerOnly("lib/users/queries.ts");

export interface UserListItem {
  id: string;
  email: string;
  fullName: string;
  roleKey: RoleKey;
  status: "active" | "inactive";
  mustChangePassword: boolean;
  createdAt: Date;
  /** Afiliación organizativa (informativa; NO da acceso). Área = ancestro raíz; Repartición = la unidad (null si solo se conoce el Área). */
  primaryOrganizationId: string | null;
  areaName: string | null;
  reparticionName: string | null;
}


export async function listUsers(): Promise<UserListItem[]> {
  const db = await getDb();
  const rows = await db
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
    .orderBy("users.created_at", "asc")
    .execute();

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

export async function countActiveMasterGlobal(): Promise<number> {
  const db = await getDb();
  const row = await db
    .selectFrom("users")
    .innerJoin("roles", "roles.id", "users.role_id")
    .select(({ fn }) => fn.count<number>("users.id").as("count"))
    .where("roles.key", "=", "MASTER_GLOBAL")
    .where("users.status", "=", "active")
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
