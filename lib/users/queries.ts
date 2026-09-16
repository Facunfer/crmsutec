import { getDb } from "../db/client.js";
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
}

export async function listUsers(): Promise<UserListItem[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("users")
    .innerJoin("roles", "roles.id", "users.role_id")
    .select([
      "users.id",
      "users.email",
      "users.full_name",
      "roles.key as role_key",
      "users.status",
      "users.must_change_password",
      "users.created_at",
    ])
    .orderBy("users.created_at", "asc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    roleKey: r.role_key as RoleKey,
    status: r.status,
    mustChangePassword: r.must_change_password,
    createdAt: r.created_at,
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
