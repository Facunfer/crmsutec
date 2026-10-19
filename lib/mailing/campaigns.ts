import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import type { Database } from "../db/schema.js";
import { can, isMasterGlobal, type SessionUser } from "../permissions/can.js";
import { canAccessOrganization, getAccessibleOrganizationIds, isUuid, orgScope } from "../scope/organizations.js";
import { analyzeAudience, audienceSpecSchema, AudienceError, persistSnapshot, type AudienceSpec, type AudienceStats } from "./audience.js";
import { loadMailConfig, PROVIDER_LABEL, validateMailConfig } from "./config.js";
import { isValidEmail, normalizeEmail } from "./email.js";
import { buildOutboundMessage } from "./message.js";
import { getMailProvider } from "./providers/index.js";
import type { SendOutcome } from "./providers/types.js";
import { addDays, buenosAiresDay, getQuota } from "./quota.js";
import { requireUsableSender, getSender } from "./senders.js";
import { buildMergeVars, findUnknownVariables, renderMessage, sanitizeEmailHtml } from "./template.js";

assertServerOnly("lib/mailing/campaigns.ts");

export class CampaignError extends Error {}

export type CampaignStatus = "draft" | "ready" | "scheduled" | "sending" | "paused" | "completed" | "cancelled" | "failed";

export interface CampaignRow {
  id: string;
  name: string;
  subject: string;
  preheader: string | null;
  senderId: string | null;
  replyTo: string | null;
  htmlBody: string;
  textBody: string;
  status: CampaignStatus;
  ownerOrganizationId: string | null;
  audienceStats: AudienceStats;
  totalSelected: number;
  totalRecipients: number;
  dailyLimitSnapshot: number | null;
  scheduledAt: Date | null;
  launchedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  pausedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DbCampaign {
  id: string; name: string; subject: string; preheader: string | null; sender_id: string | null; reply_to: string | null; html_body: string;
  text_body: string; status: CampaignStatus; owner_organization_id: string | null; audience_stats: AudienceStats; total_selected: number;
  total_recipients: number; daily_limit_snapshot: number | null; scheduled_at: Date | null; launched_at: Date | null; started_at: Date | null;
  finished_at: Date | null; paused_at: Date | null; cancelled_at: Date | null; cancel_reason: string | null; created_by: string;
  created_at: Date; updated_at: Date;
}

const toRow = (r: DbCampaign): CampaignRow => ({
  id: r.id, name: r.name, subject: r.subject, preheader: r.preheader, senderId: r.sender_id, replyTo: r.reply_to, htmlBody: r.html_body,
  textBody: r.text_body, status: r.status, ownerOrganizationId: r.owner_organization_id, audienceStats: r.audience_stats, totalSelected: r.total_selected,
  totalRecipients: r.total_recipients, dailyLimitSnapshot: r.daily_limit_snapshot, scheduledAt: r.scheduled_at, launchedAt: r.launched_at,
  startedAt: r.started_at, finishedAt: r.finished_at, pausedAt: r.paused_at, cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Visibilidad de campañas: Master todas; el resto, las de su alcance o las que creó. */
export function campaignVisible(actor: SessionUser, alias = "c") {
  if (isMasterGlobal(actor)) return sql<boolean>`true`;
  return sql<boolean>`(${orgScope(actor, `${alias}.owner_organization_id`)} or ${sql.ref(`${alias}.created_by`)} = ${actor.id}::uuid)`;
}

export async function getCampaign(actor: SessionUser, id: string): Promise<CampaignRow | null> {
  if (!can(actor, "mailing.view") || !isUuid(id)) return null;
  const db = await getDb();
  const r = await sql<DbCampaign>`select c.* from mailing_campaigns c where c.id = ${id}::uuid and ${campaignVisible(actor)}`.execute(db);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

async function requireCampaign(actor: SessionUser, id: string): Promise<CampaignRow> {
  const c = await getCampaign(actor, id);
  if (!c) throw new CampaignError("Campaña no encontrada.");
  return c;
}

// ---------------------------------------------------------------------------------------------------------------------
// Crear (congela la audiencia)
// ---------------------------------------------------------------------------------------------------------------------
const nameSchema = z.string().trim().min(1, "Poné un nombre a la campaña.").max(160);

export async function previewAudience(actor: SessionUser, spec: AudienceSpec) {
  assertPermission(actor, "mailing.create");
  const analysis = await analyzeAudience(actor, spec);
  return { stats: analysis.stats };
}

export async function createCampaign(
  actor: SessionUser,
  input: { name: string; spec: AudienceSpec; ownerOrganizationId?: string | null }
): Promise<{ id: string; stats: AudienceStats }> {
  assertPermission(actor, "mailing.create");
  const name = nameSchema.safeParse(input.name);
  if (!name.success) throw new CampaignError(name.error.issues[0]!.message);
  const specParsed = audienceSpecSchema.safeParse(input.spec);
  if (!specParsed.success) throw new CampaignError("La especificación de la audiencia no es válida.");

  // Unidad dueña: la indicada (si está en el alcance) o la primera del alcance; el Master puede dejarla sin unidad.
  let owner: string | null = input.ownerOrganizationId ?? null;
  if (owner) {
    if (!isUuid(owner) || !(await canAccessOrganization(actor, owner))) throw new CampaignError("La unidad indicada no está dentro de tu alcance.");
  } else if (!isMasterGlobal(actor)) {
    const accessible = await getAccessibleOrganizationIds(actor);
    owner = accessible?.[0] ?? null;
    if (!owner) throw new CampaignError("No tenés unidades dentro de tu alcance para asociar la campaña.");
  }

  let analysis;
  try {
    analysis = await analyzeAudience(actor, specParsed.data);
  } catch (err) {
    if (err instanceof AudienceError) throw new CampaignError(err.message);
    throw err;
  }
  if (analysis.stats.finalRecipients + analysis.groups.filter((g) => g.status !== "pending").length === 0) {
    throw new CampaignError("La audiencia no tiene ningún email. Elegí otra selección.");
  }

  const db = await getDb();
  return db.transaction().execute(async (trx) => {
    const created = await sql<{ id: string }>`
      insert into mailing_campaigns (name, owner_organization_id, created_by, audience_spec, audience_stats, total_selected, total_recipients, provider)
      values (${name.data}, ${owner}::uuid, ${actor.id}::uuid, ${JSON.stringify(analysis.specSummary)}::jsonb,
              ${JSON.stringify(analysis.stats)}::jsonb, ${analysis.stats.selected}, ${analysis.stats.finalRecipients}, ${loadMailConfig().provider})
      returning id`.execute(trx);
    const id = created.rows[0]!.id;
    await persistSnapshot(trx, id, analysis.groups);
    return { id, stats: analysis.stats };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Editar borrador
// ---------------------------------------------------------------------------------------------------------------------
const contentSchema = z.object({
  name: nameSchema.optional(),
  subject: z.string().max(300),
  preheader: z.string().max(300).optional().nullable(),
  senderId: z.string().uuid().optional().nullable(),
  replyTo: z.string().max(254).optional().nullable(),
  htmlBody: z.string().max(400_000),
  textBody: z.string().max(200_000),
});
export type CampaignContentInput = z.input<typeof contentSchema>;

export async function updateCampaignDraft(actor: SessionUser, id: string, input: CampaignContentInput): Promise<{ warnings: string[] }> {
  assertPermission(actor, "mailing.create");
  const c = await requireCampaign(actor, id);
  if (c.status !== "draft" && c.status !== "ready") throw new CampaignError("Solo se puede editar una campaña en borrador.");
  const parsed = contentSchema.safeParse(input);
  if (!parsed.success) throw new CampaignError(parsed.error.issues[0]?.message ?? "Contenido inválido.");
  const v = parsed.data;

  if (v.senderId) {
    const sender = await getSender(actor, v.senderId);
    if (!sender || !sender.active) throw new CampaignError("El remitente no existe o no está disponible para vos.");
  }
  const replyTo = v.replyTo ? normalizeEmail(v.replyTo) : null;
  if (replyTo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(replyTo)) throw new CampaignError("El email de respuesta no es válido.");

  const subject = v.subject.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  const html = sanitizeEmailHtml(v.htmlBody);
  const warnings: string[] = [];
  const unknown = findUnknownVariables(`${subject} ${v.htmlBody} ${v.textBody}`);
  if (unknown.length > 0) warnings.push(`Variables desconocidas (se eliminarán): ${unknown.map((u) => `{{${u}}}`).join(", ")}`);
  if (v.htmlBody.trim() !== "" && html.trim() === "") warnings.push("El HTML quedó vacío después de quitar contenido no permitido.");

  const db = await getDb();
  const updated = await sql<{ id: string }>`
    update mailing_campaigns set
      name = ${v.name ?? c.name}, subject = ${subject}, preheader = ${v.preheader?.trim() ? v.preheader.trim() : null},
      sender_id = ${v.senderId ?? null}::uuid, reply_to = ${replyTo}, html_body = ${html}, text_body = ${v.textBody},
      status = 'draft', updated_at = now()
    where id = ${id}::uuid and status in ('draft', 'ready') returning id`.execute(db);
  if (updated.rows.length === 0) throw new CampaignError("La campaña ya no está en borrador.");
  return { warnings };
}

export async function markCampaignReady(actor: SessionUser, id: string): Promise<void> {
  assertPermission(actor, "mailing.create");
  const c = await requireCampaign(actor, id);
  if (c.status !== "draft" && c.status !== "ready") throw new CampaignError("La campaña ya no está en borrador.");
  if (c.subject.trim() === "") throw new CampaignError("Falta el asunto.");
  if (c.htmlBody.trim() === "" && c.textBody.trim() === "") throw new CampaignError("Falta el contenido.");
  await requireUsableSender(actor, c.senderId);
  if (c.totalRecipients <= 0) throw new CampaignError("La campaña no tiene destinatarios.");
  const db = await getDb();
  await sql`update mailing_campaigns set status = 'ready', updated_at = now() where id = ${id}::uuid and status in ('draft', 'ready')`.execute(db);
}

// ---------------------------------------------------------------------------------------------------------------------
// Lanzar / pausar / reanudar / cancelar
// ---------------------------------------------------------------------------------------------------------------------
export interface LaunchPlanDay {
  sequence: number;
  date: string;
  count: number;
}

/** Reparte N destinatarios en días respetando lo que queda hoy y el tope diario. Pura (testeable). */
export function planBatches(total: number, limit: number, remainingToday: number, startDay: string, startsToday: boolean): LaunchPlanDay[] {
  const days: LaunchPlanDay[] = [];
  let left = total;
  let seq = 1;
  let date = startDay;
  let capacity = startsToday ? Math.max(Math.min(remainingToday, limit), 0) : limit;
  let guard = 0;
  while (left > 0 && guard < 10_000) {
    guard += 1;
    if (capacity > 0) {
      const take = Math.min(left, capacity);
      days.push({ sequence: seq, date, count: take });
      seq += 1;
      left -= take;
    }
    date = addDays(date, 1);
    capacity = limit;
  }
  return days;
}

export async function launchCampaign(
  actor: SessionUser,
  id: string,
  options: { confirmRecipients: number; scheduledAt?: Date | null; acknowledgeSandbox?: boolean }
): Promise<{ batches: LaunchPlanDay[] }> {
  assertPermission(actor, "mailing.send");
  const c = await requireCampaign(actor, id);
  if (c.status !== "ready") throw new CampaignError(c.status === "draft" ? "Marcá la campaña como lista antes de lanzarla." : "La campaña ya fue lanzada o no está lista.");

  const config = loadMailConfig();
  const blocking = validateMailConfig(config).filter((i) => i.blocking);
  if (blocking.length > 0) throw new CampaignError(`Configuración de envío incompleta: ${blocking.map((b) => b.key).join(", ")}.`);
  await requireUsableSender(actor, c.senderId);

  const provider = getMailProvider();
  const account = await provider.getAccountStatus();
  const label = PROVIDER_LABEL[provider.name];
  if (account.error) throw new CampaignError(`No se pudo consultar ${label} (${account.error}). Revisá las credenciales y la configuración antes de lanzar.`);
  if (account.sendingEnabled === false) throw new CampaignError(`El envío está deshabilitado en la cuenta de ${label}.`);
  if (account.sandbox === true && !options.acknowledgeSandbox) {
    throw new CampaignError(`${label} está en modo Sandbox: solo se entrega a direcciones verificadas. Confirmá que lo sabés para lanzar igual.`);
  }

  const db = await getDb();
  const pending = await sql<{ n: number }>`select count(*)::int as n from mailing_campaign_recipients where campaign_id = ${id}::uuid and status = 'pending'`.execute(db);
  const total = Number(pending.rows[0]!.n);
  if (total <= 0) throw new CampaignError("La campaña no tiene destinatarios pendientes.");
  if (!Number.isInteger(options.confirmRecipients) || options.confirmRecipients !== total) {
    throw new CampaignError(`Confirmá la cantidad exacta de destinatarios (${total}).`);
  }
  const future = options.scheduledAt && options.scheduledAt.getTime() > Date.now() ? options.scheduledAt : null;

  const today = buenosAiresDay();
  const startDay = future ? buenosAiresDay(future) : today;
  const quota = await getQuota(db, config.dailySendLimit, startDay);
  const plan = planBatches(total, config.dailySendLimit, quota.remaining, startDay, true);

  return db.transaction().execute(async (trx) => {
    // Doble clic / dos operadores: solo uno pasa de `ready` a lanzada.
    const claimed = await sql<{ id: string }>`
      update mailing_campaigns
         set status = ${future ? "scheduled" : "sending"}, provider = ${provider.name}, launched_at = now(), launched_by = ${actor.id}::uuid,
             started_at = ${future ? null : sql`now()`}, scheduled_at = ${future}, daily_limit_snapshot = ${config.dailySendLimit},
             total_recipients = ${total}, updated_at = now()
       where id = ${id}::uuid and status = 'ready' returning id`.execute(trx);
    if (claimed.rows.length === 0) throw new CampaignError("La campaña ya fue lanzada.");

    for (const day of plan) {
      await sql`
        insert into mailing_campaign_batches (campaign_id, sequence, scheduled_date, recipient_count)
        values (${id}::uuid, ${day.sequence}, ${day.date}::date, ${day.count})`.execute(trx);
    }
    const cumulative: number[] = [];
    plan.reduce((acc, d) => {
      cumulative.push(acc + d.count);
      return acc + d.count;
    }, 0);
    await sql`
      update mailing_campaign_recipients r
         set status = 'queued', queued_at = now(), batch_id = b.id, updated_at = now()
        from (
          select x.id, (select min(u.seq) from unnest(${cumulative}::int[]) with ordinality as u(c, seq) where x.rn <= u.c) as seq
            from (select id, row_number() over (order by id) as rn
                    from mailing_campaign_recipients where campaign_id = ${id}::uuid and status = 'pending') x
        ) m
        join mailing_campaign_batches b on b.campaign_id = ${id}::uuid and b.sequence = m.seq
       where r.id = m.id`.execute(trx);
    return { batches: plan };
  });
}

async function setStatus(
  actor: SessionUser,
  id: string,
  permission: "mailing.send" | "mailing.create",
  from: CampaignStatus[],
  to: CampaignStatus,
  extra: ReturnType<typeof sql>
): Promise<CampaignRow> {
  assertPermission(actor, permission);
  const c = await requireCampaign(actor, id);
  if (!from.includes(c.status)) throw new CampaignError(`La campaña está en estado «${c.status}»: no se puede pasar a «${to}».`);
  const db = await getDb();
  const r = await sql<{ id: string }>`
    update mailing_campaigns set status = ${to}, updated_at = now(), ${extra}
    where id = ${id}::uuid and status = any(${from}::text[]) returning id`.execute(db);
  if (r.rows.length === 0) throw new CampaignError("El estado de la campaña cambió; reintentá.");
  return (await getCampaign(actor, id))!;
}

/** Pausar: el worker deja de reclamar. Los destinatarios ya reclamados terminan. */
export async function pauseCampaign(actor: SessionUser, id: string): Promise<CampaignRow> {
  return setStatus(actor, id, "mailing.send", ["sending", "scheduled"], "paused", sql`paused_at = now(), paused_by = ${actor.id}::uuid`);
}

export async function resumeCampaign(actor: SessionUser, id: string): Promise<CampaignRow> {
  assertPermission(actor, "mailing.send");
  const c = await requireCampaign(actor, id);
  if (c.status !== "paused") throw new CampaignError("La campaña no está pausada.");
  const future = c.scheduledAt && c.scheduledAt.getTime() > Date.now() && !c.startedAt;
  return setStatus(actor, id, "mailing.send", ["paused"], future ? "scheduled" : "sending", sql`paused_at = null, paused_by = null, cancel_reason = null, started_at = coalesce(started_at, ${future ? null : sql`now()`})`);
}

/** Cancelar: no borra historia. Lo no enviado queda como está y el worker ya no lo toma. */
export async function cancelCampaign(actor: SessionUser, id: string, reason: string): Promise<CampaignRow> {
  assertPermission(actor, "mailing.create");
  const c = await requireCampaign(actor, id);
  const launched = ["scheduled", "sending", "paused"].includes(c.status);
  if (launched) assertPermission(actor, "mailing.send");
  const why = reason.trim();
  if (why.length < 3) throw new CampaignError("Indicá el motivo de la cancelación.");
  const row = await setStatus(
    actor, id, launched ? "mailing.send" : "mailing.create", ["draft", "ready", "scheduled", "sending", "paused"], "cancelled",
    sql`cancelled_at = now(), cancelled_by = ${actor.id}::uuid, cancel_reason = ${why}, finished_at = now()`
  );
  const db = await getDb();
  await sql`update mailing_campaign_batches set status = 'cancelled', finished_at = now() where campaign_id = ${id}::uuid and status in ('pending', 'running')`.execute(db);
  return row;
}

// ---------------------------------------------------------------------------------------------------------------------
// Prueba y vista previa
// ---------------------------------------------------------------------------------------------------------------------
const DEMO_VARS = buildMergeVars({ firstName: "María", lastName: "Gómez", organizationName: "Área de ejemplo" });

export async function renderCampaignPreview(actor: SessionUser, id: string, options: { shared?: boolean } = {}) {
  assertPermission(actor, "mailing.view");
  const c = await requireCampaign(actor, id);
  const config = loadMailConfig();
  const rendered = renderMessage({
    subject: c.subject,
    preheader: c.preheader,
    htmlBody: c.htmlBody,
    textBody: c.textBody,
    vars: options.shared ? buildMergeVars(null) : DEMO_VARS,
    unsubscribeUrl: `${config.publicBaseUrl ?? "https://crm.example"}/unsubscribe/vista-previa`,
  });
  return { ...rendered, unknownVariables: findUnknownVariables(`${c.subject} ${c.htmlBody} ${c.textBody}`) };
}

export interface TestSendResult {
  outcome: SendOutcome["kind"];
  messageId?: string;
  code?: string;
  message?: string;
}

/** Prueba: no usa destinatarios reales, no toca estados ni cuota de campaña. En sandbox, SES solo entrega a verificados. */
export async function sendTestEmail(actor: SessionUser, id: string, toRaw: string): Promise<TestSendResult> {
  assertPermission(actor, "mailing.create");
  const c = await requireCampaign(actor, id);
  const to = normalizeEmail(toRaw);
  if (!isValidEmail(to)) throw new CampaignError("El email de prueba no es válido.");
  if (c.subject.trim() === "") throw new CampaignError("Falta el asunto.");
  if (c.htmlBody.trim() === "" && c.textBody.trim() === "") throw new CampaignError("Falta el contenido.");
  const sender = await requireUsableSender(actor, c.senderId);
  const config = loadMailConfig();
  const blocking = validateMailConfig(config).filter((i) => i.blocking);
  if (blocking.length > 0) throw new CampaignError(`Configuración de envío incompleta: ${blocking.map((b) => b.key).join(", ")}.`);

  const message = buildOutboundMessage(
    { id: c.id, subject: `[PRUEBA] ${c.subject}`, preheader: c.preheader, htmlBody: c.htmlBody, textBody: c.textBody, replyTo: c.replyTo },
    { fromName: sender.fromName, fromEmail: sender.fromEmail, replyTo: sender.replyTo },
    { id: "00000000-0000-0000-0000-000000000000", normalizedEmail: to, mergeVars: DEMO_VARS },
    config
  );
  // La baja de una prueba no corresponde a ningún destinatario: sin cabeceras de baja de un clic.
  delete message.headers;
  message.tags = { campaign_id: c.id, kind: "test" };
  const outcome = await getMailProvider().send(message, { configurationSet: config.configurationSet });
  if (outcome.kind === "accepted") return { outcome: "accepted", messageId: outcome.messageId };
  return { outcome: outcome.kind, code: outcome.code, message: outcome.message };
}

export type { Transaction, Database };
