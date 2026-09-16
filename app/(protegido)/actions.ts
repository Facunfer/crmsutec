"use server";

import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/guard";
import { clearSessionCookie, getSessionCookie } from "@/lib/auth/cookies";
import { revokeSessionByToken } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit/log";

export async function logout(): Promise<void> {
  const user = await getSessionUser();
  const token = await getSessionCookie();

  if (token) {
    await revokeSessionByToken(token);
  }
  await clearSessionCookie();

  if (user) {
    await writeAuditLog({
      actorUserId: user.id,
      actorType: "user",
      action: "LOGOUT",
      entityType: "user",
      entityId: user.id,
    });
  }

  redirect("/login");
}
