"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getSessionUser } from "@/lib/auth/guard";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/lib/auth/passwords";
import { setSessionCookie } from "@/lib/auth/cookies";
import { bumpPermissionsVersion, createSession, revokeAllSessionsForUser } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit/log";

export interface ChangePasswordState {
  error?: string;
}

export async function changePassword(
  _prevState: ChangePasswordState,
  formData: FormData
): Promise<ChangePasswordState> {
  const user = await getSessionUser();
  if (!user) {
    redirect("/login?expirada=1");
  }

  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (newPassword !== confirmPassword) {
    return { error: "Las contraseñas nuevas no coinciden." };
  }

  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) {
    return { error: strengthError };
  }

  const db = await getDb();
  const row = await db
    .selectFrom("users")
    .select(["id", "password_hash"])
    .where("id", "=", user.id)
    .executeTakeFirstOrThrow();

  const validCurrent = await verifyPassword(currentPassword, row.password_hash);
  if (!validCurrent) {
    return { error: "La contraseña actual no es correcta." };
  }

  const newHash = await hashPassword(newPassword);
  await db
    .updateTable("users")
    .set({ password_hash: newHash, must_change_password: false, updated_by: user.id })
    .where("id", "=", user.id)
    .execute();

  // Cambiar la contraseña invalida todas las sesiones (D4), incluida la actual.
  await revokeAllSessionsForUser(user.id);
  await bumpPermissionsVersion(user.id);

  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
  const userAgent = hdrs.get("user-agent") ?? undefined;
  const { token, expiresAt } = await createSession(user.id, { ip, userAgent });
  await setSessionCookie(token, expiresAt);

  await writeAuditLog({
    actorUserId: user.id,
    actorType: "user",
    action: "PASSWORD_RESET",
    entityType: "user",
    entityId: user.id,
    metadata: { self_service: true },
  });

  redirect("/dashboard");
}
