import { randomBytes } from "node:crypto";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { hashPassword } from "../auth/passwords.js";
import { bumpPermissionsVersion, revokeAllSessionsForUser } from "../auth/session.js";
import { writeAuditLog } from "../audit/log.js";
import type { SessionUser } from "../permissions/can.js";
import type { RoleKey } from "../permissions/catalog.js";
import { countActiveMasterGlobal } from "./queries.js";

assertServerOnly("lib/users/commands.ts");

export class UserCommandError extends Error {}

function generateTempPassword(): string {
  return randomBytes(18).toString("base64url");
}

/** Solo un MASTER_GLOBAL puede crear o tocar el rol de otro MASTER_GLOBAL (sección 8). */
function assertCanTouchRole(actor: SessionUser, roleKey: RoleKey): void {
  if (roleKey === "MASTER_GLOBAL" && actor.roleKey !== "MASTER_GLOBAL") {
    throw new UserCommandError("Solo un Master global puede asignar ese rol.");
  }
}

export interface CreateUserInput {
  email: string;
  fullName: string;
  roleKey: RoleKey;
}

export async function createUser(
  actor: SessionUser,
  input: CreateUserInput
): Promise<{ userId: string; temporaryPassword: string }> {
  assertPermission(actor, "users.manage");
  assertCanTouchRole(actor, input.roleKey);

  const db = await getDb();
  const email = input.email.trim().toLowerCase();

  const existing = await db
    .selectFrom("users")
    .select("id")
    .where(({ fn }) => fn("lower", ["email"]), "=", email)
    .executeTakeFirst();
  if (existing) {
    throw new UserCommandError("Ya existe un usuario con ese email.");
  }

  const role = await db
    .selectFrom("roles")
    .select("id")
    .where("key", "=", input.roleKey)
    .executeTakeFirst();
  if (!role) {
    throw new UserCommandError(`Rol ${input.roleKey} no existe.`);
  }

  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const created = await db
    .insertInto("users")
    .values({
      email,
      password_hash: passwordHash,
      full_name: input.fullName.trim(),
      role_id: role.id,
      must_change_password: true,
      created_by: actor.id,
      updated_by: actor.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await writeAuditLog({
    actorUserId: actor.id,
    action: "USER_CREATED",
    entityType: "user",
    entityId: created.id,
    after: { email, full_name: input.fullName, role_key: input.roleKey },
  });

  return { userId: created.id, temporaryPassword };
}

export interface UpdateUserInput {
  fullName?: string;
  roleKey?: RoleKey;
}

export async function updateUser(
  actor: SessionUser,
  targetUserId: string,
  input: UpdateUserInput
): Promise<void> {
  assertPermission(actor, "users.manage");

  const db = await getDb();
  const target = await db
    .selectFrom("users")
    .innerJoin("roles", "roles.id", "users.role_id")
    .select(["users.id", "users.full_name", "roles.key as role_key", "users.status"])
    .where("users.id", "=", targetUserId)
    .executeTakeFirst();
  if (!target) {
    throw new UserCommandError("El usuario no existe.");
  }

  const roleChanging = input.roleKey && input.roleKey !== target.role_key;

  if (roleChanging && targetUserId === actor.id) {
    throw new UserCommandError("No podés cambiar tu propio rol.");
  }

  if (roleChanging) {
    assertCanTouchRole(actor, target.role_key as RoleKey);
    assertCanTouchRole(actor, input.roleKey!);

    if (target.role_key === "MASTER_GLOBAL") {
      const activeMasters = await countActiveMasterGlobal();
      if (activeMasters <= 1) {
        throw new UserCommandError(
          "No se puede quitar el rol Master global al último usuario que lo tiene."
        );
      }
    }
  }

  const before = { full_name: target.full_name, role_key: target.role_key };

  await db.transaction().execute(async (trx) => {
    const patch: Record<string, unknown> = { updated_by: actor.id };
    if (input.fullName !== undefined) patch.full_name = input.fullName.trim();
    if (roleChanging) {
      const role = await trx
        .selectFrom("roles")
        .select("id")
        .where("key", "=", input.roleKey!)
        .executeTakeFirstOrThrow();
      patch.role_id = role.id;
    }

    await trx.updateTable("users").set(patch).where("id", "=", targetUserId).execute();
  });

  if (roleChanging) {
    await bumpPermissionsVersion(targetUserId);
    await writeAuditLog({
      actorUserId: actor.id,
      action: "USER_ROLE_CHANGED",
      entityType: "user",
      entityId: targetUserId,
      before,
      after: { role_key: input.roleKey ?? null },
    });
  } else {
    await writeAuditLog({
      actorUserId: actor.id,
      action: "USER_UPDATED",
      entityType: "user",
      entityId: targetUserId,
      before,
      after: { full_name: input.fullName ?? null },
    });
  }
}

export async function setUserActive(
  actor: SessionUser,
  targetUserId: string,
  active: boolean
): Promise<void> {
  assertPermission(actor, "users.manage");

  if (targetUserId === actor.id && !active) {
    throw new UserCommandError("No podés desactivarte a vos mismo.");
  }

  const db = await getDb();
  const target = await db
    .selectFrom("users")
    .innerJoin("roles", "roles.id", "users.role_id")
    .select(["users.id", "roles.key as role_key", "users.status"])
    .where("users.id", "=", targetUserId)
    .executeTakeFirst();
  if (!target) {
    throw new UserCommandError("El usuario no existe.");
  }

  if (!active && target.role_key === "MASTER_GLOBAL") {
    if (actor.roleKey !== "MASTER_GLOBAL") {
      throw new UserCommandError("Solo un Master global puede desactivar a otro Master global.");
    }
    const activeMasters = await countActiveMasterGlobal();
    if (activeMasters <= 1) {
      throw new UserCommandError("No se puede desactivar al último Master global.");
    }
  }

  await db
    .updateTable("users")
    .set({ status: active ? "active" : "inactive", updated_by: actor.id })
    .where("id", "=", targetUserId)
    .execute();

  if (!active) {
    await bumpPermissionsVersion(targetUserId);
    await revokeAllSessionsForUser(targetUserId);
  }

  await writeAuditLog({
    actorUserId: actor.id,
    action: active ? "USER_UPDATED" : "USER_DEACTIVATED",
    entityType: "user",
    entityId: targetUserId,
    after: { status: active ? "active" : "inactive" },
  });
}

export async function resetUserAccess(
  actor: SessionUser,
  targetUserId: string
): Promise<{ temporaryPassword: string }> {
  assertPermission(actor, "users.manage");

  const db = await getDb();
  const target = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", targetUserId)
    .executeTakeFirst();
  if (!target) {
    throw new UserCommandError("El usuario no existe.");
  }

  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  await db
    .updateTable("users")
    .set({ password_hash: passwordHash, must_change_password: true, updated_by: actor.id })
    .where("id", "=", targetUserId)
    .execute();

  await bumpPermissionsVersion(targetUserId);
  await revokeAllSessionsForUser(targetUserId);

  await writeAuditLog({
    actorUserId: actor.id,
    action: "PASSWORD_RESET",
    entityType: "user",
    entityId: targetUserId,
    metadata: { self_service: false },
  });

  return { temporaryPassword };
}
