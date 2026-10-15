import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { can, type SessionUser } from "../permissions/can.js";
import { isUuid, orgScope } from "../scope/organizations.js";
import { campaignVisible, estimateCostUsd, getCampaign, type CampaignRow } from "./campaigns.js";
import { loadMailConfig, validateMailConfig } from "./config.js";
import { maskEmail } from "./email.js";
import { getMailProvider } from "./providers/index.js";
import type { AccountStatus } from "./providers/types.js";
import { getQuota } from "./quota.js";
import { getSender } from "./senders.js";

assertServerOnly("lib/mailing/queries.ts");

export type RecipientStatus =
  | "pending" | "queued" | "sending" | "sent" | "delivered" | "bounced" | "complained" | "unsubscribed" | "failed" | "suppressed" | "invalid" | "send_unknown";

export const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  "pending", "queued", "sending", "sent", "delivered", "bounced", "complained", "unsubscribed", "failed", "suppressed", "invalid", "send_unknown",
];

export const RECIPIENT_STATUS_LABEL: Record<RecipientStatus, string> = {
  pending: "Pendiente",
  queued: "En cola",
  sending: "Enviando",
  sent: "Enviado",
  delivered: "Entregado",
  bounced: "Rebotado",
  complained: "Queja",
  unsubscribed: "Baja",
  failed: "Fallido",
  suppressed: "Suprimido",
  invalid: "Inválido",
  send_unknown: "Envío incierto (revisar)",
};

export const CAMPAIGN_STATUS_LABEL: Record<CampaignRow["status"], string> = {
  draft: "Borrador",
  ready: "Lista",
  scheduled: "Programada",
  sending: "Enviando",
  paused: "Pausada",
  completed: "Completada",
  cancelled: "Cancelada",
  failed: "Fallida",
};

export interface CampaignListItem {
  id: string;
  name: string;
  status: CampaignRow["status"];
  senderName: string | null;
  createdAt: Date;
  launchedAt: Date | null;
  totalRecipients: number;
  totalSelected: number;
  /** Solo con mailing.view_metrics. */
  metrics: { sent: number; delivered: number; bounced: number; failed: number } | null;
}

export async function listCampaigns(actor: SessionUser, options: { page?: number; pageSize?: number } = {}): Promise<{ rows: CampaignListItem[]; total: number }> {
  assertPermission(actor, "mailing.view");
  const db = await getDb();
  const pageSize = Math.min(Math.max(options.pageSize ?? 25, 1), 100);
  const offset = Math.max((options.page ?? 1) - 1, 0) * pageSize;
  const metrics = can(actor, "mailing.view_metrics");
  const [rows, total] = await Promise.all([
    sql<{
      id: string; name: string; status: CampaignRow["status"]; sender_name: string | null; created_at: Date; launched_at: Date | null;
      total_recipients: number; total_selected: number; sent: number; delivered: number; bounced: number; failed: number;
    }>`
      select c.id, c.name, c.status, s.name as sender_name, c.created_at, c.launched_at, c.total_recipients, c.total_selected,
             coalesce(a.sent, 0)::int as sent, coalesce(a.delivered, 0)::int as delivered, coalesce(a.bounced, 0)::int as bounced, coalesce(a.failed, 0)::int as failed
      from mailing_campaigns c
      left join mailing_senders s on s.id = c.sender_id
      left join lateral (
        select count(*) filter (where r.sent_at is not null) as sent,
               count(*) filter (where r.delivered_at is not null) as delivered,
               count(*) filter (where r.bounced_at is not null) as bounced,
               count(*) filter (where r.status in ('failed', 'send_unknown')) as failed
        from mailing_campaign_recipients r where r.campaign_id = c.id and ${metrics ? sql`true` : sql`false`}
      ) a on true
      where ${campaignVisible(actor)}
      order by c.created_at desc, c.id
      limit ${pageSize} offset ${offset}`.execute(db),
    sql<{ n: number }>`select count(*)::int as n from mailing_campaigns c where ${campaignVisible(actor)}`.execute(db),
  ]);
  return {
    total: Number(total.rows[0]!.n),
    rows: rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      senderName: r.sender_name,
      createdAt: r.created_at,
      launchedAt: r.launched_at,
      totalRecipients: r.total_recipients,
      totalSelected: r.total_selected,
      metrics: metrics ? { sent: r.sent, delivered: r.delivered, bounced: r.bounced, failed: r.failed } : null,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Detalle
// ---------------------------------------------------------------------------------------------------------------------
let accountCache: { at: number; value: AccountStatus } | null = null;

/** Estado de la cuenta del proveedor (sandbox / producción), con caché corta para no consultar en cada página. */
export async function getProviderAccountStatus(): Promise<AccountStatus> {
  if (accountCache && Date.now() - accountCache.at < 60_000) return accountCache.value;
  const config = loadMailConfig();
  let value: AccountStatus;
  if (config.provider === "ses" && !config.region) {
    value = { sandbox: null, sendingEnabled: null, max24HourSend: null, maxSendRate: null, sentLast24Hours: null, error: "Sin AWS_REGION" };
  } else {
    value = await getMailProvider().getAccountStatus();
  }
  accountCache = { at: Date.now(), value };
  return value;
}

export function clearProviderAccountCache(): void {
  accountCache = null;
}

export interface CampaignDetail {
  campaign: CampaignRow;
  sender: { id: string; name: string; fromName: string; fromEmail: string; verifiedStatus: string } | null;
  counts: Record<RecipientStatus, number> & { opened: number; clicked: number; sentTotal: number };
  batches: Array<{ sequence: number; scheduledDate: string; status: string; recipientCount: number; sentCount: number }>;
  quota: { day: string; limit: number; reserved: number; remaining: number };
  worker: { active: boolean; lastSeenAt: Date | null };
  estimatedCostUsd: number;
  configIssues: Array<{ key: string; message: string; blocking: boolean }>;
  /** Solo se llena con mailing.view_metrics; sin eso, los conteos van en 0. */
  metricsVisible: boolean;
}

export async function getCampaignDetail(actor: SessionUser, id: string): Promise<CampaignDetail | null> {
  const campaign = await getCampaign(actor, id);
  if (!campaign) return null;
  const db = await getDb();
  const config = loadMailConfig();
  const metricsVisible = can(actor, "mailing.view_metrics");

  const [statusRows, extras, batches, worker, sender, quota] = await Promise.all([
    metricsVisible
      ? sql<{ status: RecipientStatus; n: number }>`
          select status, count(*)::int as n from mailing_campaign_recipients where campaign_id = ${id}::uuid group by status`.execute(db)
      : Promise.resolve({ rows: [] as Array<{ status: RecipientStatus; n: number }> }),
    metricsVisible
      ? sql<{ opened: number; clicked: number; sent_total: number }>`
          select count(*) filter (where opened_at is not null)::int as opened, count(*) filter (where clicked_at is not null)::int as clicked,
                 count(*) filter (where sent_at is not null)::int as sent_total
          from mailing_campaign_recipients where campaign_id = ${id}::uuid`.execute(db)
      : Promise.resolve({ rows: [{ opened: 0, clicked: 0, sent_total: 0 }] }),
    sql<{ sequence: number; scheduled_date: string; status: string; recipient_count: number; sent_count: number }>`
      select sequence, to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date, status, recipient_count, sent_count
      from mailing_campaign_batches where campaign_id = ${id}::uuid order by sequence`.execute(db),
    sql<{ last_seen_at: Date }>`select max(last_seen_at) as last_seen_at from mailing_worker_heartbeats`.execute(db),
    campaign.senderId ? getSender(actor, campaign.senderId) : Promise.resolve(null),
    getQuota(db, config.dailySendLimit),
  ]);

  const counts = Object.fromEntries(RECIPIENT_STATUSES.map((s) => [s, 0])) as Record<RecipientStatus, number> & { opened: number; clicked: number; sentTotal: number };
  for (const r of statusRows.rows) counts[r.status] = r.n;
  counts.opened = extras.rows[0]?.opened ?? 0;
  counts.clicked = extras.rows[0]?.clicked ?? 0;
  counts.sentTotal = extras.rows[0]?.sent_total ?? 0;

  const lastSeen = worker.rows[0]?.last_seen_at ?? null;
  return {
    campaign,
    sender: sender ? { id: sender.id, name: sender.name, fromName: sender.fromName, fromEmail: sender.fromEmail, verifiedStatus: sender.verifiedStatus } : null,
    counts,
    batches: batches.rows.map((b) => ({ sequence: b.sequence, scheduledDate: b.scheduled_date, status: b.status, recipientCount: b.recipient_count, sentCount: b.sent_count })),
    quota,
    worker: { active: lastSeen !== null && Date.now() - new Date(lastSeen).getTime() < 60_000, lastSeenAt: lastSeen },
    estimatedCostUsd: estimateCostUsd(campaign.totalRecipients, config.costPer1000Usd),
    configIssues: validateMailConfig(config),
    metricsVisible,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Destinatarios (paginado, enmascarado)
// ---------------------------------------------------------------------------------------------------------------------
export interface RecipientListRow {
  id: string;
  email: string;
  status: RecipientStatus;
  statusDetail: string | null;
  lastError: string | null;
  personCount: number;
  personId: string | null;
  personName: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  bouncedAt: Date | null;
  attemptCount: number;
}

export async function listRecipients(
  actor: SessionUser,
  campaignId: string,
  options: { status?: RecipientStatus; search?: string; page?: number; pageSize?: number } = {}
): Promise<{ rows: RecipientListRow[]; total: number } | null> {
  assertPermission(actor, "mailing.view_metrics");
  if (!isUuid(campaignId)) return null;
  const campaign = await getCampaign(actor, campaignId);
  if (!campaign) return null;
  const db = await getDb();
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 200);
  const offset = Math.max((options.page ?? 1) - 1, 0) * pageSize;
  const sensitive = can(actor, "people.view_sensitive");
  const statusFilter = options.status && RECIPIENT_STATUSES.includes(options.status) ? sql`and r.status = ${options.status}` : sql``;
  // Buscar por email solo con permiso sensible (si no, la búsqueda permitiría reconstruir el email enmascarado).
  const term = sensitive ? options.search?.trim().toLowerCase() : undefined;
  const searchFilter = term ? sql`and r.normalized_email like ${"%" + term.replace(/[\\%_]/g, (c) => "\\" + c) + "%"}` : sql``;

  const [rows, total] = await Promise.all([
    sql<{
      id: string; email_snapshot: string; normalized_email: string; status: RecipientStatus; status_detail: string | null; last_error: string | null;
      person_count: number; person_id: string | null; first_name: string | null; last_name: string | null; sent_at: Date | null; delivered_at: Date | null;
      opened_at: Date | null; clicked_at: Date | null; bounced_at: Date | null; attempt_count: number;
    }>`
      select r.id, r.email_snapshot, r.normalized_email, r.status, r.status_detail, r.last_error, r.person_count,
             p.id as person_id, p.first_name, p.last_name, r.sent_at, r.delivered_at, r.opened_at, r.clicked_at, r.bounced_at, r.attempt_count
      from mailing_campaign_recipients r
      left join people p on p.id = r.primary_person_id and ${orgScope(actor, "p.organization_id")}
      where r.campaign_id = ${campaignId}::uuid ${statusFilter} ${searchFilter}
      order by r.normalized_email, r.id
      limit ${pageSize} offset ${offset}`.execute(db),
    sql<{ n: number }>`
      select count(*)::int as n from mailing_campaign_recipients r where r.campaign_id = ${campaignId}::uuid ${statusFilter} ${searchFilter}`.execute(db),
  ]);
  return {
    total: Number(total.rows[0]!.n),
    rows: rows.rows.map((r) => ({
      id: r.id,
      email: sensitive ? r.normalized_email : maskEmail(r.normalized_email),
      status: r.status,
      statusDetail: r.status_detail,
      // El mensaje de error del proveedor puede contener direcciones: solo se muestra el código.
      lastError: r.last_error ? r.last_error.split(":")[0]!.slice(0, 60) : null,
      personCount: r.person_count,
      personId: r.person_id,
      personName: r.person_id ? [r.first_name, r.last_name].filter(Boolean).join(" ") : null,
      sentAt: r.sent_at,
      deliveredAt: r.delivered_at,
      openedAt: r.opened_at,
      clickedAt: r.clicked_at,
      bouncedAt: r.bounced_at,
      attemptCount: r.attempt_count,
    })),
  };
}

/**
 * Resolución humana de un envío incierto. `mark_failed`: el operador verificó que NO salió (queda `failed`).
 * `requeue`: acepta el riesgo de duplicado y lo vuelve a poner en cola.
 */
export async function resolveUnknownRecipient(actor: SessionUser, recipientId: string, action: "requeue" | "mark_failed"): Promise<void> {
  assertPermission(actor, "mailing.send");
  if (!isUuid(recipientId)) throw new Error("Destinatario inválido.");
  const db = await getDb();
  const found = await sql<{ campaign_id: string }>`select campaign_id from mailing_campaign_recipients where id = ${recipientId}::uuid`.execute(db);
  const row = found.rows[0];
  if (!row || !(await getCampaign(actor, row.campaign_id))) throw new Error("Destinatario no encontrado.");
  const updated =
    action === "requeue"
      ? await sql<{ id: string }>`
          update mailing_campaign_recipients set status = 'queued', next_attempt_at = null, status_detail = 'Reencolado por un operador', updated_at = now()
          where id = ${recipientId}::uuid and status = 'send_unknown' returning id`.execute(db)
      : await sql<{ id: string }>`
          update mailing_campaign_recipients set status = 'failed', failed_at = now(), status_detail = 'Marcado como no enviado por un operador', updated_at = now()
          where id = ${recipientId}::uuid and status = 'send_unknown' returning id`.execute(db);
  if (updated.rows.length === 0) throw new Error("El destinatario ya no está en estado incierto.");
  if (action === "requeue") {
    // Si la campaña ya se había completado, vuelve a enviarse (y su lote vuelve a estar abierto).
    await sql`
      update mailing_campaign_batches set status = 'running', finished_at = null
       where id = (select batch_id from mailing_campaign_recipients where id = ${recipientId}::uuid) and status = 'completed'`.execute(db);
    await sql`update mailing_campaigns set status = 'sending', finished_at = null, updated_at = now() where id = ${row.campaign_id}::uuid and status = 'completed'`.execute(db);
  }
}
