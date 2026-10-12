import { sql, type Kysely, type Transaction } from "kysely";
import { assertServerOnly } from "../server-only.js";
import type { Database } from "../db/schema.js";

assertServerOnly("lib/mailing/quota.ts");

type Db = Kysely<Database> | Transaction<Database>;

const BA_TZ = "America/Argentina/Buenos_Aires";

/** Día calendario (AAAA-MM-DD) de Buenos Aires. La cuota se cuenta por este día, no por UTC. */
export function buenosAiresDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BA_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface QuotaState {
  day: string;
  limit: number;
  reserved: number;
  remaining: number;
}

export async function getQuota(db: Db, limit: number, day = buenosAiresDay()): Promise<QuotaState> {
  const r = await sql<{ reserved: number }>`select reserved from mailing_daily_quota where day = ${day}::date`.execute(db);
  const reserved = Number(r.rows[0]?.reserved ?? 0);
  return { day, limit, reserved, remaining: Math.max(limit - reserved, 0) };
}

/**
 * Reserva ATÓMICA de cuota GLOBAL del día. Devuelve cuántos envíos se otorgaron (0..want). La fila del día se bloquea
 * (`FOR UPDATE`) hasta el fin de la transacción: dos workers o dos campañas simultáneas no pueden superar el límite.
 * Debe llamarse dentro de la misma transacción que reclama a los destinatarios.
 */
export async function reserveQuota(trx: Transaction<Database>, limit: number, want: number, day = buenosAiresDay()): Promise<number> {
  if (want <= 0 || limit <= 0) return 0;
  await sql`insert into mailing_daily_quota (day, daily_limit, reserved) values (${day}::date, ${limit}, 0) on conflict (day) do nothing`.execute(trx);
  const row = await sql<{ reserved: number }>`select reserved from mailing_daily_quota where day = ${day}::date for update`.execute(trx);
  const reserved = Number(row.rows[0]!.reserved);
  const granted = Math.max(Math.min(want, limit - reserved), 0);
  await sql`update mailing_daily_quota set reserved = reserved + ${granted}, daily_limit = ${limit}, updated_at = now() where day = ${day}::date`.execute(trx);
  return granted;
}

/** Devuelve cuota reservada que no se usó (el mensaje no salió, seguro). */
export async function releaseQuota(db: Db, count: number, day = buenosAiresDay()): Promise<void> {
  if (count <= 0) return;
  await sql`update mailing_daily_quota set reserved = greatest(reserved - ${count}, 0), updated_at = now() where day = ${day}::date`.execute(db);
}
