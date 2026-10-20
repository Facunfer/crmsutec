import { createHash } from "node:crypto";
import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/security/public-rate-limit.ts");

/**
 * Rate limit genérico para endpoints públicos (D13): combinado identificador+IP, en tabla (no en memoria de proceso), con
 * umbrales altos porque cientos de personas pueden compartir la misma IP (wifi de un acto, NAT de operadora).
 *
 * ATOMICIDAD (hallazgo S5). Antes: `check` (SELECT count) y `record` (INSERT) eran dos pasos separados por todo el trabajo del
 * endpoint, así que N pedidos simultáneos leían el mismo conteo, pasaban todos y recién después se registraban: el límite
 * se desbordaba exactamente cuando más se lo necesita (ráfagas). Ahora `consumePublicLinkAttempt` reserva el intento en UNA
 * transacción: toma un lock consultivo por cada clave (identificador, IP — siempre en el mismo orden, sin deadlock), cuenta e
 * inserta. Dos pedidos concurrentes de la misma clave se serializan: el N+1 ve al N reservado y es rechazado.
 *
 * Solo se registran los intentos PERMITIDOS (un bloqueo se levanta solo al pasar la ventana, sin "castigar" más al bloqueado ni
 * crecer la tabla bajo ataque). `succeeded` se completa después con `settlePublicLinkAttempt` (trazabilidad).
 */

const DEFAULT_PER_IDENTIFIER_LIMIT = 20;
const DEFAULT_PER_IP_LIMIT = 200;
const DEFAULT_WINDOW_MINUTES = 10;

/** Cuánto se conserva el rastro (la ventana de límite es de minutos; el resto es solo auditoría). */
export const PUBLIC_LINK_ATTEMPTS_RETENTION_DAYS = 30;
/** Fracción de intentos que, de paso, dispara la limpieza (≈1 de cada 200). */
const OPPORTUNISTIC_PURGE_RATE = 1 / 200;

export interface PublicLinkRateLimitOptions {
  perIdentifierLimit?: number;
  perIpLimit?: number;
  /**
   * Tope de intentos FALLIDOS (o todavía sin resultado) por identificador en la ventana. Permite un tope total holgado —un acto con
   * cientos de personas detrás de la misma IP— sin aflojar el freno a quien prueba y falla (adivinar DNI + apellido).
   */
  perIdentifierFailureLimit?: number;
  windowMinutes?: number;
}

/**
 * Identificador de límite derivado de un valor sensible (token de invitación, prefijo de un token de QR) — hallazgo S1.
 * Nunca se guarda el valor en claro: quien lea la tabla (backup, soporte, un dump) no obtiene un enlace reutilizable.
 * SHA-256 con separación de dominio por scope y prefijo `h1:` (versión del esquema; la migración 0046 usa la MISMA fórmula
 * para sanear lo histórico y el prefijo la hace idempotente). Los tokens son aleatorios de 192 bits: no hace falta un secreto.
 */
export function hashRateLimitIdentifier(scope: string, rawValue: string): string {
  return "h1:" + createHash("sha256").update(`sutecba:public-link:v1:${scope}:${rawValue}`, "utf8").digest("hex").slice(0, 32);
}

export interface PublicLinkAttempt {
  allowed: boolean;
  /** Id de la reserva (solo si `allowed`), para completar `succeeded` al terminar. */
  attemptId: string | null;
}

/**
 * Reserva atómicamente un intento. Si está dentro de los límites lo registra (con `succeeded = false` hasta que se complete)
 * y devuelve `allowed`; si no, no registra nada.
 */
export async function consumePublicLinkAttempt(
  scope: string,
  identifier: string,
  ip: string,
  options: PublicLinkRateLimitOptions = {}
): Promise<PublicLinkAttempt> {
  const perIdentifierLimit = options.perIdentifierLimit ?? DEFAULT_PER_IDENTIFIER_LIMIT;
  const perIpLimit = options.perIpLimit ?? DEFAULT_PER_IP_LIMIT;
  const windowMinutes = options.windowMinutes ?? DEFAULT_WINDOW_MINUTES;

  const db = await getDb();
  const result = await db.transaction().execute(async (trx): Promise<PublicLinkAttempt> => {
    // Orden fijo => dos transacciones que comparten claves nunca se esperan en ciclo.
    const lockKeys = [`public-link:${scope}:identifier:${identifier}`, `public-link:${scope}:ip:${ip}`].sort();
    for (const key of lockKeys) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
    }

    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);
    const byIdentifier = await trx
      .selectFrom("public_link_attempts")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("scope", "=", scope)
      .where("identifier", "=", identifier)
      .where("created_at", ">=", windowStart)
      .executeTakeFirstOrThrow();
    if (Number(byIdentifier.count) >= perIdentifierLimit) return { allowed: false, attemptId: null };

    if (options.perIdentifierFailureLimit !== undefined) {
      const failed = await trx
        .selectFrom("public_link_attempts")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("scope", "=", scope)
        .where("identifier", "=", identifier)
        .where("succeeded", "=", false)
        .where("created_at", ">=", windowStart)
        .executeTakeFirstOrThrow();
      if (Number(failed.count) >= options.perIdentifierFailureLimit) return { allowed: false, attemptId: null };
    }

    const byIp = await trx
      .selectFrom("public_link_attempts")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("scope", "=", scope)
      .where("ip_address", "=", ip)
      .where("created_at", ">=", windowStart)
      .executeTakeFirstOrThrow();
    if (Number(byIp.count) >= perIpLimit) return { allowed: false, attemptId: null };

    const row = await trx
      .insertInto("public_link_attempts")
      .values({ scope, identifier, ip_address: ip, succeeded: false })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { allowed: true, attemptId: row.id };
  });

  if (result.allowed && Math.random() < OPPORTUNISTIC_PURGE_RATE) {
    void purgePublicLinkAttempts().catch(() => undefined);
  }
  return result;
}

/**
 * Completa el resultado de un intento ya reservado. Es TRAZABILIDAD, no control: nunca debe romper la operación del usuario
 * (si la base todavía no tiene el permiso de la migración 0046, el intento queda con `succeeded = false`, que es inocuo).
 */
export async function settlePublicLinkAttempt(attemptId: string | null, succeeded: boolean): Promise<void> {
  if (!attemptId || !succeeded) return; // la reserva ya nace como fallida: solo hay algo que escribir si salió bien
  try {
    const db = await getDb();
    await db.updateTable("public_link_attempts").set({ succeeded: true }).where("id", "=", attemptId).execute();
  } catch {
    // best-effort
  }
}

/**
 * Borra el rastro más viejo que la retención. Usa la función de la migración 0046 (SECURITY DEFINER, solo borra filas con
 * más de 1 día): la app NO recibe DELETE directo sobre la tabla de auditoría.
 */
export async function purgePublicLinkAttempts(retentionDays: number = PUBLIC_LINK_ATTEMPTS_RETENTION_DAYS): Promise<number> {
  const db = await getDb();
  const { rows } = await sql<{ purged: number }>`select public.purge_public_link_attempts(${retentionDays}::int) as purged`.execute(db);
  return Number(rows[0]?.purged ?? 0);
}
