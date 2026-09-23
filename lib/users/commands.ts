import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { hashPassword } from "../auth/passwords.js";
import { bumpPermissionsVersion, revokeAllSessionsForUser } from "../auth/session.js";
import type { SessionUser } from "../permissions/can.js";
import type { RoleKey } from "../permissions/catalog.js";
import { isOwnerOrganization, OWNER_AS_WORK_UNIT_MESSAGE } from "../organizations/areas.js";
import { canActorOwnInOrganization } from "../organizations/ownership.js";
import { countActiveMasterGlobal } from "./queries.js";
import { isUserAdministrable, requireUserAdminMode, type UserAdminMode } from "./administration.js";

assertServerOnly("lib/users/commands.ts");

export class UserCommandError extends Error {}

function generateTempPassword(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Las reglas de contención viven también en la base (triggers de user_scopes /
 * user_modules y `create_scoped_user_checks`, migraciones 0012/0013) y las
 * violan con `RAISE EXCEPTION` (SQLSTATE P0001). Se traducen a un error de
 * negocio con el mensaje de la base; cualquier otro error se propaga tal cual.
 */
async function withDbRuleErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P0001" && err instanceof Error) throw new UserCommandError(err.message);
    throw err;
  }
}

export interface ScopeGrantInput {
  organizationId: string;
  includeDescendants: boolean;
}

/** Un delegado solo administra usuarios dentro de sus alcances y nunca a un MASTER_GLOBAL. */
async function assertTargetAdministrable(
  actor: SessionUser,
  mode: Exclude<UserAdminMode, "none">,
  targetUserId: string
): Promise<void> {
  if (mode === "global") return;
  if (!(await isUserAdministrable(actor, targetUserId))) {
    throw new UserCommandError("Ese usuario no existe o está fuera de tus alcances.");
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validación de la base para lo que un delegado puede conceder: rol con
 * permisos ⊆ los del actor (y nunca MASTER_GLOBAL), alcances ⊆ los del actor y
 * módulos ⊆ los del actor. Se reutiliza tal cual `create_scoped_user_checks`.
 */
async function assertDelegatedGrantAllowed(
  actor: SessionUser,
  roleId: string,
  scopes: ScopeGrantInput[],
  moduleKeys: string[]
): Promise<void> {
  for (const scope of scopes) {
    if (!UUID_RE.test(scope.organizationId)) throw new UserCommandError("Unidad organizativa inválida.");
  }

  const db = await getDb();
  await withDbRuleErrors(async () => {
    await sql`
      select create_scoped_user_checks(
        ${actor.id}::uuid,
        ${roleId}::uuid,
        ${scopes.map((s) => s.organizationId)}::uuid[],
        ${scopes.map((s) => s.includeDescendants)}::boolean[],
        ${moduleKeys}::text[]
      )
    `.execute(db);
  });
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
  /** Alcances iniciales. Un delegado debe darle al menos uno. Se rechazan para MASTER_GLOBAL. */
  scopes?: ScopeGrantInput[];
  /** Módulos iniciales habilitados para el usuario. Se rechazan para MASTER_GLOBAL. */
  moduleKeys?: string[];
  /**
   * Afiliación organizativa (Área/Repartición donde PERTENECE el usuario). Es informativa: NO otorga acceso; lo que puede
   * ver lo definen únicamente sus alcances (`scopes`).
   */
  primaryOrganizationId?: string | null;
}

/** La afiliación debe ser una unidad activa, no la organización propietaria (SUTECBA), y estar al alcance de quien la asigna. */
async function assertAffiliationAllowed(actor: SessionUser, organizationId: string): Promise<void> {
  if (!UUID_RE.test(organizationId)) throw new UserCommandError("Unidad organizativa inválida.");
  if (await isOwnerOrganization(organizationId)) throw new UserCommandError(OWNER_AS_WORK_UNIT_MESSAGE);
  if (!(await canActorOwnInOrganization(actor.id, organizationId))) {
    throw new UserCommandError("La unidad no existe, está inactiva o está fuera de tus alcances.");
  }
}

/** Cambia la afiliación (Área/Repartición) de un usuario. NO toca sus alcances. */
export async function setUserPrimaryOrganization(actor: SessionUser, userId: string, organizationId: string | null): Promise<void> {
  const mode = requireUserAdminMode(actor);
  await assertTargetAdministrable(actor, mode, userId);
  if (organizationId !== null) await assertAffiliationAllowed(actor, organizationId);
  const db = await getDb();
  const updated = await db
    .updateTable("users")
    .set({ primary_organization_id: organizationId, updated_by: actor.id, updated_at: new Date() })
    .where("id", "=", userId)
    .returning("id")
    .executeTakeFirst();
  if (!updated) throw new UserCommandError("El usuario no existe.");
}

export async function createUser(
  actor: SessionUser,
  input: CreateUserInput
): Promise<{ userId: string; temporaryPassword: string }> {
  const mode = requireUserAdminMode(actor);
  assertCanTouchRole(actor, input.roleKey);

  const scopes = input.scopes ?? [];
  const moduleKeys = [...new Set(input.moduleKeys ?? [])];
  if (input.roleKey === "MASTER_GLOBAL" && (scopes.length > 0 || moduleKeys.length > 0)) {
    throw new UserCommandError("Un Master global no lleva alcances ni módulos: los tiene todos.");
  }
  if (mode === "scoped" && scopes.length === 0) {
    throw new UserCommandError("Indicá al menos un alcance para el usuario nuevo.");
  }
  // Conceder alcances exige scopes.manage (con su módulo); el trigger de user_scopes lo vuelve a exigir con el permiso crudo.
  if (scopes.length > 0) assertPermission(actor, "scopes.manage");
  if (input.primaryOrganizationId) await assertAffiliationAllowed(actor, input.primaryOrganizationId);

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

  if (mode === "scoped") {
    await assertDelegatedGrantAllowed(actor, role.id, scopes, moduleKeys);
  }

  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const created = await withDbRuleErrors(() =>
    db.transaction().execute(async (trx) => {
      const user = await trx
        .insertInto("users")
        .values({
          email,
          password_hash: passwordHash,
          full_name: input.fullName.trim(),
          role_id: role.id,
          must_change_password: true,
          primary_organization_id: input.primaryOrganizationId || null,
          created_by: actor.id,
          updated_by: actor.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      // Los triggers de user_scopes / user_modules vuelven a validar cada fila
      // e incrementan permissions_version del usuario nuevo.
      for (const scope of scopes) {
        await trx
          .insertInto("user_scopes")
          .values({
            user_id: user.id,
            organization_id: scope.organizationId,
            include_descendants: scope.includeDescendants,
            granted_by: actor.id,
          })
          .execute();
      }
      for (const moduleKey of moduleKeys) {
        await trx
          .insertInto("user_modules")
          .values({ user_id: user.id, module_key: moduleKey, granted_by: actor.id })
          .execute();
      }
      return user;
    })
  );


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
  const mode = requireUserAdminMode(actor);
  await assertTargetAdministrable(actor, mode, targetUserId);

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

    if (mode === "scoped") {
      const newRole = await db
        .selectFrom("roles")
        .select("id")
        .where("key", "=", input.roleKey!)
        .executeTakeFirst();
      if (!newRole) throw new UserCommandError(`Rol ${input.roleKey} no existe.`);
      await assertDelegatedGrantAllowed(actor, newRole.id, [], []);
    }

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
  } else {
  }
}

export async function setUserActive(
  actor: SessionUser,
  targetUserId: string,
  active: boolean
): Promise<void> {
  const mode = requireUserAdminMode(actor);

  if (targetUserId === actor.id && !active) {
    throw new UserCommandError("No podés desactivarte a vos mismo.");
  }
  await assertTargetAdministrable(actor, mode, targetUserId);

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

}

export async function resetUserAccess(
  actor: SessionUser,
  targetUserId: string
): Promise<{ temporaryPassword: string }> {
  const mode = requireUserAdminMode(actor);
  if (mode === "scoped" && targetUserId === actor.id) {
    throw new UserCommandError("No podés resetear tu propio acceso desde acá.");
  }
  await assertTargetAdministrable(actor, mode, targetUserId);

  const db = await getDb();
  const target = await db
    .selectFrom("users")
    .innerJoin("roles", "roles.id", "users.role_id")
    .select(["users.id", "roles.key as role_key"])
    .where("users.id", "=", targetUserId)
    .executeTakeFirst();
  if (!target) {
    throw new UserCommandError("El usuario no existe.");
  }
  assertCanTouchRole(actor, target.role_key as RoleKey);

  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  await db
    .updateTable("users")
    .set({ password_hash: passwordHash, must_change_password: true, updated_by: actor.id })
    .where("id", "=", targetUserId)
    .execute();

  await bumpPermissionsVersion(targetUserId);
  await revokeAllSessionsForUser(targetUserId);


  return { temporaryPassword };
}

/** Reglas comunes de los cambios de alcances/módulos de un usuario existente. */
async function assertCanChangeAccess(actor: SessionUser, targetUserId: string): Promise<void> {
  const mode = requireUserAdminMode(actor);
  if (targetUserId === actor.id) {
    throw new UserCommandError("No podés modificar tus propios alcances ni módulos.");
  }
  await assertTargetAdministrable(actor, mode, targetUserId);

  const db = await getDb();
  const target = await db
    .selectFrom("users")
    .innerJoin("roles", "roles.id", "users.role_id")
    .select("roles.key as role_key")
    .where("users.id", "=", targetUserId)
    .executeTakeFirst();
  if (!target) throw new UserCommandError("El usuario no existe.");
  if (target.role_key === "MASTER_GLOBAL") {
    throw new UserCommandError("Un Master global tiene todos los alcances y módulos; no se le asignan.");
  }
}

/**
 * Concede un alcance. Además de estas reglas, el trigger de `user_scopes`
 * exige `scopes.manage`, que el alcance esté dentro de los del actor y que no
 * sea el propio usuario, e incrementa `permissions_version` del destinatario
 * (invalida sus sesiones).
 */
export async function grantUserScope(
  actor: SessionUser,
  targetUserId: string,
  scope: ScopeGrantInput
): Promise<void> {
  assertPermission(actor, "scopes.manage");
  await assertCanChangeAccess(actor, targetUserId);
  const db = await getDb();

  await withDbRuleErrors(() =>
    db
      .insertInto("user_scopes")
      .values({
        user_id: targetUserId,
        organization_id: scope.organizationId,
        include_descendants: scope.includeDescendants,
        granted_by: actor.id,
      })
      .execute()
  );

}

/**
 * Revoca un alcance (no se borra: queda `revoked_at`). Mismas garantías que
 * `grantUserScope`, más una regla propia de los delegados: quien no es
 * MASTER_GLOBAL no puede revocar el ÚLTIMO alcance activo de un usuario (el
 * usuario quedaría sin dueño visible: solo lo vería un master). MASTER_GLOBAL sí
 * puede, deliberadamente.
 *
 * El conteo y la revocación van en una transacción que primero bloquea la fila
 * del usuario (`FOR UPDATE`): dos revocaciones simultáneas de los dos últimos
 * alcances se serializan y la segunda ve el estado real. Esta garantía vive solo
 * en el servidor y, desde la migración 0020, también en la base (trigger).
 */
export async function revokeUserScope(
  actor: SessionUser,
  targetUserId: string,
  scopeId: string
): Promise<void> {
  assertPermission(actor, "scopes.manage");
  await assertCanChangeAccess(actor, targetUserId);
  const db = await getDb();
  const mustKeepOneScope = actor.roleKey !== "MASTER_GLOBAL";

  const revoked = await withDbRuleErrors(() =>
    db.transaction().execute(async (trx) => {
      if (mustKeepOneScope) {
        await sql`select id from users where id = ${targetUserId}::uuid for update`.execute(trx);
        const remaining = await trx
          .selectFrom("user_scopes")
          .select("id")
          .where("user_id", "=", targetUserId)
          .where("revoked_at", "is", null)
          .where("id", "<>", scopeId)
          .executeTakeFirst();
        if (!remaining) {
          throw new UserCommandError(
            "No podés revocar el último alcance activo del usuario: debe conservar al menos uno."
          );
        }
      }

      return trx
        .updateTable("user_scopes")
        .set({ revoked_at: new Date(), revoked_by: actor.id })
        .where("id", "=", scopeId)
        .where("user_id", "=", targetUserId)
        .where("revoked_at", "is", null)
        .returning("id")
        .executeTakeFirst();
    })
  );
  if (!revoked) throw new UserCommandError("El alcance no existe o ya estaba revocado.");

}

/** Habilita un módulo. La base exige que el actor lo tenga habilitado y que no sea el propio usuario. */
export async function grantUserModule(
  actor: SessionUser,
  targetUserId: string,
  moduleKey: string
): Promise<void> {
  await assertCanChangeAccess(actor, targetUserId);
  const db = await getDb();

  await withDbRuleErrors(() =>
    db
      .insertInto("user_modules")
      .values({ user_id: targetUserId, module_key: moduleKey, granted_by: actor.id })
      .execute()
  );

}

export async function revokeUserModule(
  actor: SessionUser,
  targetUserId: string,
  moduleId: string
): Promise<void> {
  await assertCanChangeAccess(actor, targetUserId);
  const db = await getDb();

  const revoked = await withDbRuleErrors(() =>
    db
      .updateTable("user_modules")
      .set({ revoked_at: new Date(), revoked_by: actor.id })
      .where("id", "=", moduleId)
      .where("user_id", "=", targetUserId)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst()
  );
  if (!revoked) throw new UserCommandError("El módulo no existe o ya estaba revocado.");

}
