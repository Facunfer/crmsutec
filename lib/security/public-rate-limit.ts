import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/security/public-rate-limit.ts");

/**
 * Rate limit genérico para endpoints públicos basados en token (D13):
 * combinado identificador+IP, en tabla (no en memoria de proceso), con
 * umbrales altos porque cientos de personas pueden compartir la misma IP
 * (wifi de un acto, NAT de operadora).
 */
export async function recordPublicLinkAttempt(
  scope: string,
  identifier: string,
  ip: string,
  succeeded: boolean
): Promise<void> {
  const db = await getDb();
  await db.insertInto("public_link_attempts").values({ scope, identifier, ip_address: ip, succeeded }).execute();
}

export async function checkPublicLinkRateLimit(
  scope: string,
  identifier: string,
  ip: string,
  options: { perIdentifierLimit?: number; perIpLimit?: number; windowMinutes?: number } = {}
): Promise<{ allowed: boolean }> {
  const perIdentifierLimit = options.perIdentifierLimit ?? 20;
  const perIpLimit = options.perIpLimit ?? 200;
  const windowMinutes = options.windowMinutes ?? 10;

  const db = await getDb();
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

  const byIdentifier = await db
    .selectFrom("public_link_attempts")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .where("scope", "=", scope)
    .where("identifier", "=", identifier)
    .where("created_at", ">=", windowStart)
    .executeTakeFirstOrThrow();
  if (Number(byIdentifier.count) >= perIdentifierLimit) return { allowed: false };

  const byIp = await db
    .selectFrom("public_link_attempts")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .where("scope", "=", scope)
    .where("ip_address", "=", ip)
    .where("created_at", ">=", windowStart)
    .executeTakeFirstOrThrow();
  if (Number(byIp.count) >= perIpLimit) return { allowed: false };

  return { allowed: true };
}
