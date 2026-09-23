import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/auth/rate-limit.ts");

const WINDOW_MINUTES = 10;
const DEFAULT_PER_ACCOUNT_LIMIT = 5;
// Umbral por IP mucho más alto que por cuenta: varias personas pueden
// compartir red/NAT y no hay que bloquearlas a todas por los intentos
// fallidos de una sola cuenta (mismo espíritu que D13, aplicado a login).
const DEFAULT_PER_IP_LIMIT = 30;

async function getIntSetting(key: string, fallback: number): Promise<number> {
  const db = await getDb();
  const row = await db
    .selectFrom("app_settings")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  if (!row) return fallback;
  const parsed = typeof row.value === "number" ? row.value : Number(row.value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function recordLoginAttempt(
  identifier: string,
  ip: string,
  succeeded: boolean
): Promise<void> {
  const db = await getDb();
  await db
    .insertInto("login_attempts")
    .values({ identifier: identifier.toLowerCase(), ip_address: ip, succeeded })
    .execute();
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: "account" | "ip";
}

/** Combinado cuenta + IP, guardado en tabla (no en memoria de proceso, D4/D13). */
export async function checkLoginRateLimit(identifier: string, ip: string): Promise<RateLimitResult> {
  const db = await getDb();
  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);

  const [accountLimit, ipLimit] = await Promise.all([
    getIntSetting("login_rate_limit_per_account_per_10min", DEFAULT_PER_ACCOUNT_LIMIT),
    getIntSetting("login_rate_limit_per_ip_per_10min", DEFAULT_PER_IP_LIMIT),
  ]);

  const accountFailures = await db
    .selectFrom("login_attempts")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .where("identifier", "=", identifier.toLowerCase())
    .where("succeeded", "=", false)
    .where("created_at", ">=", windowStart)
    .executeTakeFirstOrThrow();

  if (Number(accountFailures.count) >= accountLimit) {
    return { allowed: false, reason: "account" };
  }

  const ipFailures = await db
    .selectFrom("login_attempts")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .where("ip_address", "=", ip)
    .where("succeeded", "=", false)
    .where("created_at", ">=", windowStart)
    .executeTakeFirstOrThrow();

  if (Number(ipFailures.count) >= ipLimit) {
    return { allowed: false, reason: "ip" };
  }

  return { allowed: true };
}

/**
 * MANTENIMIENTO PENDIENTE — no se ejecuta en runtime. Borra físicamente intentos de login viejos, y
 * `sutecba_app` NO tiene DELETE sobre `login_attempts` (a propósito: nada en la app la llama). Si
 * hace falta purgar, tiene que ser una tarea administrativa con la conexión de mantenimiento
 * (SUTECBA_MIGRATION_DATABASE_URL) o una decisión explícita posterior; no se amplían los GRANT del
 * rol runtime por esto.
 */
export async function purgeOldLoginAttempts(olderThanDays = 30): Promise<void> {
  const db = await getDb();
  await sql`delete from login_attempts where created_at < now() - (${olderThanDays} || ' days')::interval`.execute(
    db
  );
}
