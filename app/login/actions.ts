"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { verifyPassword } from "@/lib/auth/passwords";
import { checkLoginRateLimit, recordLoginAttempt } from "@/lib/auth/rate-limit";
import { createSession } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/cookies";
import { resolveClientIp } from "@/lib/security/client-ip";
import { isUnsafeText } from "@/lib/security/text-safety";

export interface LoginState {
  error?: string;
}

const GENERIC_ERROR = "Email o contraseña incorrectos.";

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Completá email y contraseña." };
  }
  // Un email con texto que la base no guarda no puede ser de ninguna cuenta: mismo mensaje genérico, sin consulta ni error 500.
  if (isUnsafeText(email)) return { error: GENERIC_ERROR };

  const hdrs = await headers();
  const ip = resolveClientIp(hdrs);
  const userAgent = hdrs.get("user-agent") ?? undefined;

  const rateLimit = await checkLoginRateLimit(email, ip);
  if (!rateLimit.allowed) {
    return { error: "Demasiados intentos. Probá de nuevo en unos minutos." };
  }

  const db = await getDb();
  const user = await db
    .selectFrom("users")
    .selectAll()
    .where(({ fn }) => fn("lower", ["email"]), "=", email)
    .executeTakeFirst();

  if (!user || user.status !== "active") {
    await recordLoginAttempt(email, ip, false);
    if (user) {
    }
    return { error: GENERIC_ERROR };
  }

  const validPassword = await verifyPassword(password, user.password_hash);
  if (!validPassword) {
    await recordLoginAttempt(email, ip, false);
    return { error: GENERIC_ERROR };
  }

  await recordLoginAttempt(email, ip, true);
  const { token, expiresAt } = await createSession(user.id, { ip, userAgent });
  await setSessionCookie(token, expiresAt);

  redirect(user.must_change_password ? "/login/cambiar-contrasena" : "/dashboard");
}
