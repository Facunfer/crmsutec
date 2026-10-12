import { sql, type Kysely, type Transaction } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import type { Database } from "../db/schema.js";
import { can, type SessionUser } from "../permissions/can.js";
import { isValidEmail, maskEmail, normalizeEmail } from "./email.js";
import { loadMailConfig } from "./config.js";
import { verifyUnsubscribeToken } from "./tokens.js";

assertServerOnly("lib/mailing/suppressions.ts");

type Db = Kysely<Database> | Transaction<Database>;

export type SuppressionReason = "hard_bounce" | "complaint" | "unsubscribe" | "invalid" | "manual";

export class SuppressionError extends Error {}

/**
 * Registra una supresión ACTIVA para el email (idempotente: si ya hay una activa no hace nada) y saca de circulación los envíos
 * todavía no realizados de cualquier campaña (pending/queued → suppressed). NO borra nada ni toca `people`.
 */
export async function suppressEmail(
  db: Db,
  input: { email: string; reason: SuppressionReason; source: string; campaignId?: string | null; createdBy?: string | null; providerEventId?: string | null }
): Promise<{ created: boolean }> {
  const normalized = normalizeEmail(input.email);
  if (!normalized) throw new SuppressionError("Email vacío.");
  const inserted = await sql<{ id: string }>`
    insert into mailing_suppressions (normalized_email, reason, source, campaign_id, created_by, provider_event_id)
    values (${normalized}, ${input.reason}, ${input.source}, ${input.campaignId ?? null}, ${input.createdBy ?? null}, ${input.providerEventId ?? null})
    on conflict (normalized_email) where lifted_at is null do nothing
    returning id`.execute(db);
  await sql`
    update mailing_campaign_recipients
       set status = 'suppressed', status_detail = ${input.reason}, updated_at = now()
     where normalized_email = ${normalized} and status in ('pending', 'queued')`.execute(db);
  return { created: inserted.rows.length > 0 };
}

export async function isSuppressed(db: Db, normalizedEmail: string): Promise<boolean> {
  const r = await sql<{ n: number }>`select 1 as n from mailing_suppressions where normalized_email = ${normalizedEmail} and lifted_at is null limit 1`.execute(db);
  return r.rows.length > 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Baja pública (enlace firmado)
// ---------------------------------------------------------------------------------------------------------------------
export interface UnsubscribePreview {
  valid: boolean;
  alreadyUnsubscribed: boolean;
  maskedEmail: string | null;
  campaignName: string | null;
}

async function loadRecipientByToken(token: string) {
  const config = loadMailConfig();
  if (!config.unsubscribeSecret) return null;
  const recipientId = verifyUnsubscribeToken(token, config.unsubscribeSecret);
  if (!recipientId) return null;
  const db = await getDb();
  const r = await sql<{ id: string; campaign_id: string; normalized_email: string; campaign_name: string; status: string }>`
    select r.id, r.campaign_id, r.normalized_email, c.name as campaign_name, r.status
    from mailing_campaign_recipients r join mailing_campaigns c on c.id = r.campaign_id
    where r.id = ${recipientId}::uuid`.execute(db);
  return r.rows[0] ?? null;
}

/** GET: muestra la confirmación. NO modifica nada (los escáneres de enlaces de los clientes de correo hacen GET). */
export async function previewUnsubscribe(token: string): Promise<UnsubscribePreview> {
  const row = await loadRecipientByToken(token);
  if (!row) return { valid: false, alreadyUnsubscribed: false, maskedEmail: null, campaignName: null };
  const db = await getDb();
  return {
    valid: true,
    alreadyUnsubscribed: await isSuppressed(db, row.normalized_email),
    maskedEmail: maskEmail(row.normalized_email),
    campaignName: row.campaign_name,
  };
}

/** POST: confirma la baja. Idempotente: repetirla no duplica supresiones ni eventos. */
export async function confirmUnsubscribe(token: string): Promise<{ ok: boolean; alreadyUnsubscribed: boolean }> {
  const row = await loadRecipientByToken(token);
  if (!row) return { ok: false, alreadyUnsubscribed: false };
  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const { created } = await suppressEmail(trx, { email: row.normalized_email, reason: "unsubscribe", source: "unsubscribe_link", campaignId: row.campaign_id });
    // El destinatario de ESTA campaña queda como «de baja», salvo que ya haya rebotado o se haya quejado (esos estados mandan).
    await sql`
      update mailing_campaign_recipients
         set status = 'unsubscribed', unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now()
       where id = ${row.id}::uuid and status in ('sent', 'delivered', 'sending', 'queued', 'pending', 'send_unknown')`.execute(trx);
    await sql`
      insert into mailing_events (campaign_id, recipient_id, provider_event_key, event_type, event_at, payload_safe)
      values (${row.campaign_id}::uuid, ${row.id}::uuid, ${"unsubscribe:" + row.id}, 'unsubscribe', now(), '{}'::jsonb)
      on conflict (provider_event_key) do nothing`.execute(trx);
    return { ok: true, alreadyUnsubscribed: !created };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Administración (UI)
// ---------------------------------------------------------------------------------------------------------------------
export interface SuppressionRow {
  id: string;
  email: string;
  reason: SuppressionReason;
  source: string;
  createdAt: Date;
  active: boolean;
  liftedAt: Date | null;
  liftReason: string | null;
}

export async function listSuppressions(actor: SessionUser, options: { search?: string; page?: number; pageSize?: number; onlyActive?: boolean } = {}) {
  assertPermission(actor, "mailing.manage_suppressions");
  const db = await getDb();
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 200);
  const offset = Math.max((options.page ?? 1) - 1, 0) * pageSize;
  const search = options.search?.trim().toLowerCase();
  const sensitive = can(actor, "people.view_sensitive");
  const filter = sql`${options.onlyActive ? sql`lifted_at is null` : sql`true`} and ${search ? sql`normalized_email like ${"%" + search.replace(/[\\%_]/g, (c) => "\\" + c) + "%"}` : sql`true`}`;
  const [rows, total] = await Promise.all([
    sql<{ id: string; normalized_email: string; reason: SuppressionReason; source: string; created_at: Date; lifted_at: Date | null; lift_reason: string | null }>`
      select id, normalized_email, reason, source, created_at, lifted_at, lift_reason
      from mailing_suppressions where ${filter} order by created_at desc, id limit ${pageSize} offset ${offset}`.execute(db),
    sql<{ n: number }>`select count(*)::int as n from mailing_suppressions where ${filter}`.execute(db),
  ]);
  return {
    total: Number(total.rows[0]!.n),
    rows: rows.rows.map<SuppressionRow>((r) => ({
      id: r.id,
      email: sensitive ? r.normalized_email : maskEmail(r.normalized_email),
      reason: r.reason,
      source: r.source,
      createdAt: r.created_at,
      active: r.lifted_at === null,
      liftedAt: r.lifted_at,
      liftReason: r.lift_reason,
    })),
  };
}

export async function addManualSuppression(actor: SessionUser, emailRaw: string): Promise<{ created: boolean }> {
  assertPermission(actor, "mailing.manage_suppressions");
  const email = normalizeEmail(emailRaw);
  if (!isValidEmail(email)) throw new SuppressionError("El email no es válido.");
  const db = await getDb();
  return db.transaction().execute((trx) => suppressEmail(trx, { email, reason: "manual", source: "manual", createdBy: actor.id }));
}

export async function liftSuppression(actor: SessionUser, suppressionId: string, reason: string): Promise<void> {
  assertPermission(actor, "mailing.manage_suppressions");
  const why = reason.trim();
  if (why.length < 5) throw new SuppressionError("Indicá el motivo (mínimo 5 caracteres).");
  const db = await getDb();
  const updated = await sql<{ id: string }>`
    update mailing_suppressions set lifted_at = now(), lifted_by = ${actor.id}::uuid, lift_reason = ${why}
    where id = ${suppressionId}::uuid and lifted_at is null returning id`.execute(db);
  if (updated.rows.length === 0) throw new SuppressionError("La supresión no existe o ya fue levantada.");
}
