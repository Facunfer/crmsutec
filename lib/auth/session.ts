import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import type { PermissionKey, RoleKey } from "../permissions/catalog.js";
import type { SessionUser } from "../permissions/can.js";

assertServerOnly("lib/auth/session.ts");

const SESSION_TTL_HOURS = 12;

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreateSessionMeta {
  ip?: string;
  userAgent?: string;
}

export async function createSession(
  userId: string,
  meta: CreateSessionMeta = {}
): Promise<{ token: string; expiresAt: Date }> {
  const db = await getDb();
  const user = await db
    .selectFrom("users")
    .select("permissions_version")
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();

  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);

  await db
    .insertInto("sessions")
    .values({
      user_id: userId,
      token_hash: hashToken(token),
      permissions_version_snapshot: user.permissions_version,
      ip_address: meta.ip ?? null,
      user_agent: meta.userAgent ?? null,
      expires_at: expiresAt,
    })
    .execute();

  // Limpieza oportunista: no hace falta un cron aparte para el MVP.
  await db
    .deleteFrom("sessions")
    .where("user_id", "=", userId)
    .where("expires_at", "<", new Date())
    .execute();

  return { token, expiresAt };
}

/**
 * Valida el token contra la base en cada request (nada de confiar en un
 * JWT autocontenido): revisa expiración, revocación, que el usuario siga
 * activo, y que `permissions_version` coincida con la del usuario actual
 * (decisión D4) — así desactivar/cambiar de rol corta el acceso al instante.
 */
export async function loadSessionUser(token: string): Promise<SessionUser | null> {
  const db = await getDb();
  const tokenHash = hashToken(token);

  const session = await db
    .selectFrom("sessions")
    .selectAll()
    .where("token_hash", "=", tokenHash)
    .executeTakeFirst();

  if (!session) return null;
  if (session.revoked_at) return null;
  if (session.expires_at.getTime() < Date.now()) return null;

  const user = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", session.user_id)
    .executeTakeFirst();

  if (!user) return null;
  if (user.status !== "active") return null;
  if (user.permissions_version !== session.permissions_version_snapshot) return null;

  const role = await db
    .selectFrom("roles")
    .select(["id", "key"])
    .where("id", "=", user.role_id)
    .executeTakeFirst();
  if (!role) return null;

  const permissionRows = await db
    .selectFrom("role_permissions")
    .innerJoin("permissions", "permissions.id", "role_permissions.permission_id")
    .select("permissions.key")
    .where("role_permissions.role_id", "=", role.id)
    .execute();

  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    roleId: role.id,
    roleKey: role.key as RoleKey,
    mustChangePassword: user.must_change_password,
    permissions: new Set(permissionRows.map((r) => r.key as PermissionKey)),
  };
}

export async function revokeSessionByToken(token: string): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("sessions")
    .set({ revoked_at: new Date() })
    .where("token_hash", "=", hashToken(token))
    .execute();
}

/** Usado al desactivar, cambiar de rol, o resetear el acceso de un usuario. */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("sessions")
    .set({ revoked_at: new Date() })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .execute();
}

/**
 * Incrementa permissions_version: toda sesión con un snapshot viejo queda
 * inválida en el próximo request, sin esperar el TTL de 12h (decisión D4).
 */
export async function bumpPermissionsVersion(userId: string): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("users")
    .set((eb) => ({ permissions_version: eb("permissions_version", "+", 1) }))
    .where("id", "=", userId)
    .execute();
}
