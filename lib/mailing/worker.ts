import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { loadMailConfig, validateMailConfig, type MailConfig } from "./config.js";
import { applyProviderEvent, parseSesNotification } from "./events.js";
import { buildOutboundMessage } from "./message.js";
import { getMailProvider } from "./providers/index.js";
import type { MailProvider, SendOutcome } from "./providers/types.js";
import { buenosAiresDay, releaseQuota, reserveQuota } from "./quota.js";
import type { MergeVars } from "./template.js";

assertServerOnly("lib/mailing/worker.ts");

/**
 * WORKER DE ENVÍO. Proceso aparte (scripts/mail-worker.ts, PM2): nunca corre dentro de un request de Next.js.
 *
 * Garantías:
 *  - Un destinatario lo toma UN solo worker (`FOR UPDATE SKIP LOCKED`) con lease.
 *  - La cuota diaria GLOBAL se reserva en la MISMA transacción que el reclamo (atómica).
 *  - La respuesta INCIERTA de SES (timeout/corte/5xx) NUNCA se reintenta sola: `send_unknown`, requiere revisión humana.
 *  - Un lease vencido en `sending` tampoco se reencola: no sabemos si SES aceptó → `send_unknown`.
 *  - Solo se reintenta un rechazo por ritmo (throttling), donde SES garantiza que NO envió.
 *  - Si el email entró en la lista de supresión después del lanzamiento, no se envía.
 *  - El estado vive en PostgreSQL: si PM2 reinicia, continúa.
 */
export interface ClaimedRecipient {
  id: string;
  campaignId: string;
  batchId: string | null;
  normalizedEmail: string;
  mergeVars: MergeVars;
  attemptCount: number;
}

export interface CycleStats {
  claimed: number;
  sent: number;
  rejected: number;
  failed: number;
  unknown: number;
  suppressed: number;
  requeued: number;
  quotaExhausted: boolean;
}

/**
 * Registro operativo opcional (lo conecta scripts/mail-worker.ts). Cada línea lleva ids (campaña, destinatario, worker, id de mensaje del
 * proveedor, intento, código de error) y NUNCA emails, cuerpos, tokens ni secretos.
 */
type WorkerLogger = (message: string, fields: Record<string, unknown>) => void;
let logger: WorkerLogger | null = null;
export function setWorkerLogger(fn: WorkerLogger | null): void {
  logger = fn;
}
const logEvent: WorkerLogger = (message, fields) => logger?.(message, fields);
/** Para el bucle del worker (mismo registro operativo). */
export const workerLog: WorkerLogger = logEvent;

const emptyStats = (): CycleStats => ({ claimed: 0, sent: 0, rejected: 0, failed: 0, unknown: 0, suppressed: 0, requeued: 0, quotaExhausted: false });

/** Rechazos que afectan a TODA la cuenta/identidad, no a un destinatario: se pausa la campaña en vez de fallar uno por uno. */
const ACCOUNT_LEVEL_CODES = new Set([
  "AccountSuspendedException",
  "SendingPausedException",
  "MailFromDomainNotVerifiedException",
  "NotConfigured",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "ExpiredTokenException",
  "CredentialsProviderError",
  "CredentialsError",
  "CredentialProviderError",
]);

// ---------------------------------------------------------------------------------------------------------------------
// Reclamo (cuota + SKIP LOCKED en una transacción)
// ---------------------------------------------------------------------------------------------------------------------
export async function claimRecipients(workerId: string, config: MailConfig, want: number, today = buenosAiresDay()): Promise<{ claimed: ClaimedRecipient[]; suppressed: number; quotaExhausted: boolean }> {
  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const granted = await reserveQuota(trx, config.dailySendLimit, want, today);
    if (granted === 0) return { claimed: [], suppressed: 0, quotaExhausted: true };

    const rows = await sql<{ id: string; campaign_id: string; batch_id: string | null; normalized_email: string; merge_vars: MergeVars; attempt_count: number }>`
      with c as (
        select r.id
          from mailing_campaign_recipients r
          join mailing_campaigns k on k.id = r.campaign_id and k.status = 'sending'
          join mailing_campaign_batches b on b.id = r.batch_id and b.scheduled_date <= ${today}::date and b.status in ('pending', 'running')
         where r.status = 'queued' and (r.next_attempt_at is null or r.next_attempt_at <= now())
         order by b.scheduled_date, r.campaign_id, r.id
         limit ${granted}
         for update of r skip locked
      )
      update mailing_campaign_recipients r
         set status = 'sending', lease_owner = ${workerId}, lease_until = now() + make_interval(secs => ${config.leaseSeconds}),
             attempt_count = r.attempt_count + 1, updated_at = now()
        from c
       where r.id = c.id
      returning r.id, r.campaign_id, r.batch_id, r.normalized_email, r.merge_vars, r.attempt_count`.execute(trx);

    // Lo no reclamado no consume cuota.
    await releaseQuota(trx, granted - rows.rows.length, today);

    const batchIds = [...new Set(rows.rows.map((r) => r.batch_id).filter((b): b is string => b !== null))];
    if (batchIds.length > 0) {
      await sql`update mailing_campaign_batches set status = 'running', started_at = coalesce(started_at, now()) where id = any(${batchIds}::uuid[]) and status = 'pending'`.execute(trx);
    }

    // Supresión vigente al momento de enviar (una baja posterior al lanzamiento se respeta).
    let suppressedCount = 0;
    let claimed = rows.rows;
    if (claimed.length > 0) {
      const emails = [...new Set(claimed.map((r) => r.normalized_email))];
      const sup = await sql<{ normalized_email: string }>`
        select normalized_email from mailing_suppressions where lifted_at is null and normalized_email = any(${emails}::text[])`.execute(trx);
      if (sup.rows.length > 0) {
        const blocked = new Set(sup.rows.map((r) => r.normalized_email));
        const toDrop = claimed.filter((r) => blocked.has(r.normalized_email)).map((r) => r.id);
        await sql`
          update mailing_campaign_recipients
             set status = 'suppressed', status_detail = 'suppressed_before_send', lease_owner = null, lease_until = null, updated_at = now()
           where id = any(${toDrop}::uuid[])`.execute(trx);
        await releaseQuota(trx, toDrop.length, today);
        suppressedCount = toDrop.length;
        claimed = claimed.filter((r) => !blocked.has(r.normalized_email));
      }
    }
    return {
      claimed: claimed.map((r) => ({
        id: r.id, campaignId: r.campaign_id, batchId: r.batch_id, normalizedEmail: r.normalized_email, mergeVars: r.merge_vars ?? {}, attemptCount: r.attempt_count,
      })),
      suppressed: suppressedCount,
      quotaExhausted: false,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Envío de un destinatario
// ---------------------------------------------------------------------------------------------------------------------
interface CampaignContext {
  campaign: { id: string; subject: string; preheader: string | null; htmlBody: string; textBody: string; replyTo: string | null };
  sender: { fromName: string; fromEmail: string; replyTo: string | null } | null;
}

async function loadCampaignContext(campaignId: string): Promise<CampaignContext | null> {
  const db = await getDb();
  const r = await sql<{
    id: string; subject: string; preheader: string | null; html_body: string; text_body: string; reply_to: string | null;
    from_name: string | null; from_email: string | null; sender_reply_to: string | null;
  }>`
    select c.id, c.subject, c.preheader, c.html_body, c.text_body, c.reply_to, s.from_name, s.from_email, s.reply_to as sender_reply_to
    from mailing_campaigns c left join mailing_senders s on s.id = c.sender_id where c.id = ${campaignId}::uuid`.execute(db);
  const row = r.rows[0];
  if (!row) return null;
  return {
    campaign: { id: row.id, subject: row.subject, preheader: row.preheader, htmlBody: row.html_body, textBody: row.text_body, replyTo: row.reply_to },
    sender: row.from_email && row.from_name ? { fromName: row.from_name, fromEmail: row.from_email, replyTo: row.sender_reply_to } : null,
  };
}

function backoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(attempt - 1, 0), 900);
}

async function recordOutcome(workerId: string, r: ClaimedRecipient, outcome: SendOutcome, today: string, stats: CycleStats): Promise<void> {
  const db = await getDb();
  if (outcome.kind === "accepted") {
    // También corrige un `send_unknown` marcado por un lease vencido: ahora SABEMOS que SES aceptó.
    await sql`
      update mailing_campaign_recipients
         set status = 'sent', provider_message_id = ${outcome.messageId}, sent_at = now(), last_error = null, status_detail = null,
             lease_owner = null, lease_until = null, updated_at = now()
       where id = ${r.id}::uuid and status in ('sending', 'send_unknown')`.execute(db);
    if (r.batchId) await sql`update mailing_campaign_batches set sent_count = sent_count + 1 where id = ${r.batchId}::uuid`.execute(db);
    stats.sent += 1;
    logEvent("envío aceptado", { workerId, campaignId: r.campaignId, recipientId: r.id, batchId: r.batchId, providerMessageId: outcome.messageId, attempt: r.attemptCount });
    return;
  }

  if (outcome.kind === "unknown") {
    // La cuota queda consumida (puede haber salido). Nada de reintentos automáticos.
    await sql`
      update mailing_campaign_recipients
         set status = 'send_unknown', last_error = ${`${outcome.code}: ${outcome.message}`.slice(0, 500)},
             status_detail = 'Respuesta incierta de SES: requiere revisión', lease_owner = null, lease_until = null, updated_at = now()
       where id = ${r.id}::uuid and status = 'sending'`.execute(db);
    stats.unknown += 1;
    logEvent("envío incierto (no se reintenta)", { workerId, campaignId: r.campaignId, recipientId: r.id, attempt: r.attemptCount, errorCode: outcome.code });
    return;
  }

  // rejected: SES garantiza que NO envió → se libera la cuota.
  await releaseQuota(db, 1, today);
  stats.rejected += 1;
  logEvent("envío rechazado", { workerId, campaignId: r.campaignId, recipientId: r.id, attempt: r.attemptCount, errorCode: outcome.code, retryable: outcome.retryable });
  if (ACCOUNT_LEVEL_CODES.has(outcome.code)) {
    await db.transaction().execute(async (trx) => {
      await sql`
        update mailing_campaign_recipients
           set status = 'queued', attempt_count = greatest(attempt_count - 1, 0), lease_owner = null, lease_until = null, updated_at = now()
         where id = ${r.id}::uuid and status = 'sending'`.execute(trx);
      await sql`
        update mailing_campaigns set status = 'paused', paused_at = now(), cancel_reason = ${`Pausada automáticamente: ${outcome.code}`}, updated_at = now()
         where id = ${r.campaignId}::uuid and status = 'sending'`.execute(trx);
    });
    stats.requeued += 1;
    return;
  }
  // Rechazo por ritmo/cuota (429, throttling): SES garantiza que NO envió, así que se reencola con backoff (30 s, 60 s … tope 15 min)
  // y NUNCA pasa a `failed` por insistir: mientras el proveedor limite, espera. La cuota ya se devolvió arriba.
  if (outcome.retryable) {
    await sql`
      update mailing_campaign_recipients
         set status = 'queued', next_attempt_at = now() + make_interval(secs => ${backoffSeconds(r.attemptCount)}),
             last_error = ${outcome.code}, lease_owner = null, lease_until = null, updated_at = now()
       where id = ${r.id}::uuid and status = 'sending'`.execute(db);
    stats.requeued += 1;
    return;
  }
  await sql`
    update mailing_campaign_recipients
       set status = 'failed', failed_at = now(), last_error = ${`${outcome.code}: ${outcome.message}`.slice(0, 500)},
           lease_owner = null, lease_until = null, updated_at = now()
     where id = ${r.id}::uuid and status = 'sending'`.execute(db);
  stats.failed += 1;
}

async function processRecipient(
  workerId: string,
  r: ClaimedRecipient,
  provider: MailProvider,
  config: MailConfig,
  contexts: Map<string, Promise<CampaignContext | null>>,
  today: string,
  stats: CycleStats
): Promise<void> {
  let ctxPromise = contexts.get(r.campaignId);
  if (!ctxPromise) {
    ctxPromise = loadCampaignContext(r.campaignId);
    contexts.set(r.campaignId, ctxPromise);
  }
  const ctx = await ctxPromise;
  if (!ctx || !ctx.sender) {
    await recordOutcome(workerId, r, { kind: "rejected", code: "NoSender", message: "La campaña no tiene remitente.", retryable: false }, today, stats);
    return;
  }
  let message;
  try {
    message = buildOutboundMessage(ctx.campaign, ctx.sender, { id: r.id, normalizedEmail: r.normalizedEmail, mergeVars: r.mergeVars }, config);
  } catch (err) {
    await recordOutcome(workerId, r, { kind: "rejected", code: "BuildError", message: err instanceof Error ? err.message : "error", retryable: false }, today, stats);
    return;
  }
  const outcome = await provider.send(message, { configurationSet: config.configurationSet });
  await recordOutcome(workerId, r, outcome, today, stats);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Un ciclo: reclama (hasta `batchSize`) y envía con concurrencia y ritmo máximos configurados. */
export async function runSendCycle(
  workerId: string,
  options: { config?: MailConfig; provider?: MailProvider; batchSize?: number; today?: string } = {}
): Promise<CycleStats> {
  const config = options.config ?? loadMailConfig();
  const provider = options.provider ?? getMailProvider();
  const today = options.today ?? buenosAiresDay();
  const stats = emptyStats();
  const { claimed, suppressed, quotaExhausted } = await claimRecipients(workerId, config, options.batchSize ?? config.workerConcurrency * 4, today);
  stats.claimed = claimed.length + suppressed;
  stats.suppressed = suppressed;
  stats.quotaExhausted = quotaExhausted;
  if (claimed.length === 0) return stats;

  const contexts = new Map<string, Promise<CampaignContext | null>>();
  const minGapMs = Math.ceil(1000 / config.maxSendRate);
  let next = 0;
  let nextStart = Date.now();
  const lane = async () => {
    while (true) {
      const index = next++;
      if (index >= claimed.length) return;
      // Ritmo global: nunca más de maxSendRate inicios por segundo.
      const wait = nextStart - Date.now();
      nextStart = Math.max(nextStart, Date.now()) + minGapMs;
      if (wait > 0) await sleep(wait);
      await processRecipient(workerId, claimed[index]!, provider, config, contexts, today, stats);
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.workerConcurrency, claimed.length) }, lane));
  return stats;
}

// ---------------------------------------------------------------------------------------------------------------------
// Mantenimiento
// ---------------------------------------------------------------------------------------------------------------------
/** Lease vencido en `sending` → `send_unknown` (jamás se reencola: puede haber salido). */
export async function recoverExpiredLeases(): Promise<number> {
  const db = await getDb();
  const r = await sql<{ id: string; campaign_id: string }>`
    update mailing_campaign_recipients
       set status = 'send_unknown', last_error = 'lease_expired', status_detail = 'Lease vencido: no se sabe si SES aceptó. Requiere revisión',
           lease_owner = null, lease_until = null, updated_at = now()
     where status = 'sending' and lease_until < now() returning id, campaign_id`.execute(db);
  for (const row of r.rows) logEvent("lease vencido → send_unknown", { campaignId: row.campaign_id, recipientId: row.id });
  return r.rows.length;
}

/** scheduled → sending cuando llega su hora; sending → completed cuando no queda nada por enviar. */
export async function advanceCampaigns(): Promise<{ started: number; completed: number }> {
  const db = await getDb();
  const started = await sql<{ id: string }>`
    update mailing_campaigns set status = 'sending', started_at = coalesce(started_at, now()), updated_at = now()
     where status = 'scheduled' and scheduled_at <= now() returning id`.execute(db);
  const completed = await sql<{ id: string }>`
    update mailing_campaigns k set status = 'completed', finished_at = now(), updated_at = now()
     where k.status = 'sending'
       and not exists (select 1 from mailing_campaign_recipients r where r.campaign_id = k.id and r.status in ('queued', 'sending'))
     returning k.id`.execute(db);
  if (completed.rows.length > 0) {
    await sql`
      update mailing_campaign_batches set status = 'completed', finished_at = now()
       where campaign_id = any(${completed.rows.map((c) => c.id)}::uuid[]) and status in ('pending', 'running')`.execute(db);
  }
  return { started: started.rows.length, completed: completed.rows.length };
}

export async function heartbeat(workerId: string, startedAt: Date, info: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  await sql`
    insert into mailing_worker_heartbeats (worker_id, started_at, last_seen_at, info)
    values (${workerId}, ${startedAt}, now(), ${JSON.stringify(info)}::jsonb)
    on conflict (worker_id) do update set last_seen_at = now(), info = excluded.info`.execute(db);
}

/** Mantenimiento best-effort: borra latidos de workers que no se ven hace más de 24 h. Nunca lanza. */
export async function pruneHeartbeats(): Promise<number> {
  try {
    const db = await getDb();
    const r = await sql<{ worker_id: string }>`delete from mailing_worker_heartbeats where last_seen_at < now() - interval '24 hours' returning worker_id`.execute(db);
    return r.rows.length;
  } catch {
    return 0;
  }
}

/** Apagado limpio: el latido propio se retira para que la UI vea «no activo» enseguida. Best-effort. */
export async function removeHeartbeat(workerId: string): Promise<void> {
  try {
    const db = await getDb();
    await sql`delete from mailing_worker_heartbeats where worker_id = ${workerId}`.execute(db);
  } catch {
    // sin latido: no es crítico
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Eventos (cola)
// ---------------------------------------------------------------------------------------------------------------------
export interface QueuedMessage {
  id: string;
  body: string;
  receipt: string;
  receiveCount: number;
}

export interface EventQueue {
  receive(max: number): Promise<QueuedMessage[]>;
  delete(receipt: string): Promise<void>;
}

const MAX_UNMATCHED_RECEIVES = 5;

/** Consume eventos de la cola. Un evento sin destinatario (llegó antes de guardarse el envío) se deja para reintento. */
export async function pollEvents(queue: EventQueue, max = 10): Promise<{ applied: number; duplicate: number; unmatched: number; ignored: number }> {
  const out = { applied: 0, duplicate: 0, unmatched: 0, ignored: 0 };
  const messages = await queue.receive(max);
  for (const m of messages) {
    const events = parseSesNotification(m.body);
    if (events.length === 0) {
      out.ignored += 1;
      await queue.delete(m.receipt);
      continue;
    }
    let keep = false;
    for (const e of events) {
      const result = await applyProviderEvent(e);
      if (result === "applied") out.applied += 1;
      else if (result === "duplicate") out.duplicate += 1;
      else {
        out.unmatched += 1;
        if (!e.isTest && m.receiveCount < MAX_UNMATCHED_RECEIVES) keep = true;
      }
    }
    if (!keep) await queue.delete(m.receipt);
  }
  return out;
}

export function describeWorkerReadiness(config: MailConfig = loadMailConfig()) {
  return validateMailConfig(config);
}
