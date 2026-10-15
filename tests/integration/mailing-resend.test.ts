import { createHmac, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.MAIL_UNSUBSCRIBE_SECRET = "unit-test-unsubscribe-secret-0123456789abcdef";
process.env.PUBLIC_BASE_URL = "https://crm.test";
process.env.AWS_REGION = "us-east-1";
process.env.MAIL_DAILY_SEND_LIMIT = "1000";
process.env.MAIL_MAX_SEND_RATE = "1000";
process.env.MAIL_WORKER_CONCURRENCY = "4";
const KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const WEBHOOK_SECRET = `whsec_${KEY.toString("base64")}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const providers = await import("../../lib/mailing/providers/index.js");
const campaigns = await import("../../lib/mailing/campaigns.js");
const senders = await import("../../lib/mailing/senders.js");
const worker = await import("../../lib/mailing/worker.js");
const events = await import("../../lib/mailing/events.js");
const { getPersonRelationship } = await import("../../lib/people/timeline.js");
const route = await import("../../app/api/mailing/webhooks/resend/route.js");
const { NextRequest } = await import("next/server");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));

class FakeProvider {
  constructor(readonly name: "ses" | "resend") {}
  calls: Array<{ to: string; idempotencyKey?: string; tags?: Record<string, string> }> = [];
  overrides = new Map<string, any>();
  private n = 0;
  async send(message: any) {
    this.calls.push({ to: message.to, idempotencyKey: message.idempotencyKey, tags: message.tags });
    const o = this.overrides.get(message.to);
    if (o) return o;
    this.n += 1;
    return { kind: "accepted", messageId: `${this.name}-${randomUUID()}-${this.n}` };
  }
  async getAccountStatus() {
    return { sandbox: null, sendingEnabled: null, max24HourSend: null, maxSendRate: null, sentLast24Hours: null };
  }
  async getIdentityStatus() {
    return "verified" as const;
  }
  async checkIdentity(identity: string) {
    return { identity, region: null, outcome: "verified" as const, message: `${identity}: verified` };
  }
}

let master: any;
let seq = 0;
let dni = 52000000;
let emailSeq = 0;
let dayCounter = 0;
let orgA: string;
const freshDay = () => `2033-${String(1 + Math.floor(dayCounter / 28)).padStart(2, "0")}-${String(1 + (dayCounter++ % 28)).padStart(2, "0")}`;
const uniqueEmail = () => `rs${++emailSeq}-${randomUUID().slice(0, 6)}@example.test`;

async function q<T extends object>(query: ReturnType<typeof sql<T>>) {
  const db = await getDb();
  return (await query.execute(db)).rows;
}

async function person(email: string) {
  const db = await getDb();
  seq += 1;
  dni += 1;
  return (
    await db
      .insertInto("people")
      .values({ first_name: `Nom${seq}`, last_name: `Ape${seq}`, dni: String(dni), email, organization_id: orgA, origin: "manual", status: "active" } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

async function makeSender(label: string): Promise<string> {
  const s = await senders.createSender(master, { name: label, fromName: `SUTECBA ${label}`, fromEmail: `${label.toLowerCase()}-${randomUUID().slice(0, 6)}@sutecba.test` });
  await senders.verifySenderIdentity(master, s.id);
  return s.id;
}

async function readyCampaign(n: number, senderId: string) {
  const ids = await Promise.all(Array.from({ length: n }, () => person(uniqueEmail())));
  const { id } = await campaigns.createCampaign(master, { name: `Camp ${++seq}`, spec: { kind: "manual_ids", ids } });
  await campaigns.updateCampaignDraft(master, id, { subject: "Hola {{nombre}}", htmlBody: "<p>Hola {{nombre}}</p>", textBody: "", senderId });
  await campaigns.markCampaignReady(master, id);
  return { id, ids };
}

const recipients = (campaignId: string) =>
  q(sql<{ id: string; normalized_email: string; status: string; provider_message_id: string | null }>`
    select id, normalized_email, status, provider_message_id from mailing_campaign_recipients where campaign_id = ${campaignId}::uuid order by normalized_email`);

function signed(payload: Record<string, unknown>, opts: { id?: string; timestamp?: string; key?: Buffer; tamper?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const id = opts.id ?? `msg_${randomUUID()}`;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", opts.key ?? KEY).update(`${id}.${timestamp}.${body}`).digest("base64");
  return new NextRequest("https://crm.test/api/mailing/webhooks/resend", {
    method: "POST",
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${sig}`, "content-type": "application/json" },
    body: opts.tamper ? body.replace("email.", "email.x") : body,
  });
}

const evt = (type: string, emailId: string, data: Record<string, unknown> = {}, createdAt = new Date().toISOString()) => ({
  type,
  created_at: createdAt,
  data: { email_id: emailId, ...data },
});

async function post(req: InstanceType<typeof NextRequest>) {
  const res = await route.POST(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let fake: FakeProvider;
const saved = { MAIL_PROVIDER: process.env.MAIL_PROVIDER, RESEND_API_KEY: process.env.RESEND_API_KEY };

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  orgA = await createTestOrganization("Resend A");
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const uid = (await db.insertInto("users").values({ email: "resend-master@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "M", role_id: role.id }).returning("id").executeTakeFirstOrThrow()).id;
  master = { id: uid, email: "resend-master@sutecba.local", fullName: "M", roleId: "n/a", roleKey: "MASTER_GLOBAL", mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions: ALL };
});

beforeEach(async () => {
  process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.RESEND_API_KEY = "re_test_key_not_real";
  process.env.MAIL_PROVIDER = "resend";
  fake = new FakeProvider("resend");
  providers.setMailProviderForTests(fake as never);
  const db = await getDb();
  await sql`update mailing_campaigns set status = 'cancelled', cancelled_at = now(), cancel_reason = 'aislamiento de test', finished_at = now() where status in ('scheduled', 'sending', 'paused')`.execute(db);
});

afterEach(() => {
  if (saved.MAIL_PROVIDER === undefined) delete process.env.MAIL_PROVIDER;
  else process.env.MAIL_PROVIDER = saved.MAIL_PROVIDER;
});

afterAll(async () => {
  providers.setMailProviderForTests(null);
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("migración 0045", () => {
  it("admite ses y resend, rechaza cualquier otro, y no altera lo histórico", async () => {
    process.env.MAIL_PROVIDER = "ses";
    const { id: historic } = await senders.createSender(master, { name: "Historico", fromName: "H", fromEmail: `h-${randomUUID().slice(0, 6)}@sutecba.test` });
    process.env.MAIL_PROVIDER = "resend";
    const { id: modern } = await senders.createSender(master, { name: "Moderno", fromName: "M", fromEmail: `m-${randomUUID().slice(0, 6)}@sutecba.test` });
    const rows = await q(sql<{ id: string; provider: string }>`select id, provider from mailing_senders where id in (${historic}::uuid, ${modern}::uuid)`);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.provider]))).toEqual({ [historic]: "ses", [modern]: "resend" });

    const db = await getDb();
    await expect(sql`update mailing_senders set provider = 'sendgrid' where id = ${modern}::uuid`.execute(db)).rejects.toThrow();
    await expect(sql`update mailing_campaigns set provider = 'sendgrid' where false returning id`.execute(db)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("worker con Resend", () => {
  it("envía con idempotencia por intento, guarda el id del mensaje y no toca campañas lanzadas con otro proveedor", async () => {
    // campaña lanzada con SES
    process.env.MAIL_PROVIDER = "ses";
    providers.setMailProviderForTests(new FakeProvider("ses") as never);
    const sesSender = await makeSender("Ses");
    const sesCampaign = await readyCampaign(2, sesSender);
    await campaigns.launchCampaign(master, sesCampaign.id, { confirmRecipients: 2, acknowledgeSandbox: true });

    // campaña lanzada con Resend
    process.env.MAIL_PROVIDER = "resend";
    providers.setMailProviderForTests(fake as never);
    const rsSender = await makeSender("Rs");
    const rsCampaign = await readyCampaign(3, rsSender);
    await campaigns.launchCampaign(master, rsCampaign.id, { confirmRecipients: 3, acknowledgeSandbox: true });
    const launchedRow = (await q(sql<{ provider: string }>`select provider from mailing_campaigns where id = ${rsCampaign.id}::uuid`))[0];
    expect(launchedRow?.provider).toBe("resend");

    // el worker de SES-campaign: la campaña de SES sigue en `sending` pero Resend activo no la reclama
    await sql`update mailing_campaigns set status = 'sending' where id = ${sesCampaign.id}::uuid`.execute(await getDb());
    const stats = await worker.runSendCycle("w-rs", { provider: fake as never, today: freshDay() });
    expect(stats.sent).toBe(3);
    expect(fake.calls).toHaveLength(3);
    expect(new Set(fake.calls.map((c) => c.idempotencyKey)).size).toBe(3);
    expect(fake.calls.every((c) => /^sutecba-mail-[0-9a-f-]{36}-1$/.test(c.idempotencyKey ?? ""))).toBe(true);
    expect(fake.calls.every((c) => c.tags?.campaign_id === rsCampaign.id)).toBe(true);

    const rs = await recipients(rsCampaign.id);
    expect(rs.every((r) => r.status === "sent" && r.provider_message_id?.startsWith("resend-"))).toBe(true);
    const ses = await recipients(sesCampaign.id);
    expect(ses.every((r) => r.status === "queued" && r.provider_message_id === null)).toBe(true);

    // una segunda pasada no reenvía nada de lo ya enviado
    const again = await worker.runSendCycle("w-rs", { provider: fake as never, today: freshDay() });
    expect(again.sent).toBe(0);
    expect(fake.calls).toHaveLength(3);
  });

  it("un error de cuenta de Resend (clave restringida) pausa la campaña: el destinatario vuelve a la cola y nadie queda como fallido", async () => {
    const sender = await makeSender("Cuenta");
    const c = await readyCampaign(1, sender);
    await campaigns.launchCampaign(master, c.id, { confirmRecipients: 1, acknowledgeSandbox: true });
    const [r] = await recipients(c.id);
    fake.overrides.set(r!.normalized_email, { kind: "rejected", code: "restricted_api_key", message: "key", retryable: false });
    await worker.runSendCycle("w-acc", { provider: fake as never, today: freshDay() });

    const [camp] = await q(sql<{ status: string; cancel_reason: string }>`select status, cancel_reason from mailing_campaigns where id = ${c.id}::uuid`);
    expect(camp!.status).toBe("paused");
    expect(camp!.cancel_reason).toContain("restricted_api_key");
    const [after] = await recipients(c.id);
    expect(after!.status).toBe("queued");

    // corregida la clave, se reanuda y se envía
    fake.overrides.clear();
    await campaigns.resumeCampaign(master, c.id);
    await worker.runSendCycle("w-acc", { provider: fake as never, today: freshDay() });
    expect((await recipients(c.id))[0]!.status).toBe("sent");
  });

  it("429 por ritmo reencola; respuesta incierta es send_unknown y no se reintenta sola; el resto se envía", async () => {
    const sender = await makeSender("Err");
    const c = await readyCampaign(3, sender);
    await campaigns.launchCampaign(master, c.id, { confirmRecipients: 3, acknowledgeSandbox: true });
    const [a, b, d] = await recipients(c.id);
    fake.overrides.set(a!.normalized_email, { kind: "rejected", code: "rate_limit_exceeded", message: "slow", retryable: true });
    fake.overrides.set(b!.normalized_email, { kind: "unknown", code: "NetworkError", message: "sin respuesta" });
    await worker.runSendCycle("w-err", { provider: fake as never, today: freshDay() });
    const final = Object.fromEntries((await recipients(c.id)).map((r) => [r.id, r.status]));
    expect(final[a!.id]).toBe("queued");
    expect(final[b!.id]).toBe("send_unknown");
    expect(final[d!.id]).toBe("sent");

    // otra pasada: lo incierto NO se reenvía
    fake.overrides.clear();
    await worker.runSendCycle("w-err", { provider: fake as never, today: freshDay() });
    const again = Object.fromEntries((await recipients(c.id)).map((r) => [r.id, r.status]));
    expect(again[b!.id]).toBe("send_unknown");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("remitentes: la verificación pertenece al proveedor con que se comprobó", () => {
  it("cambiar de proveedor exige volver a verificar; nunca se hereda", async () => {
    process.env.MAIL_PROVIDER = "ses";
    providers.setMailProviderForTests(new FakeProvider("ses") as never);
    const sesId = await makeSender("Heredado");
    await expect(senders.requireUsableSender(master, sesId)).resolves.toMatchObject({ provider: "ses", verifiedStatus: "verified" });

    process.env.MAIL_PROVIDER = "resend";
    providers.setMailProviderForTests(fake as never);
    await expect(senders.requireUsableSender(master, sesId)).rejects.toThrow(/verificado con Amazon SES.*Resend/);

    await senders.verifySenderIdentity(master, sesId);
    await expect(senders.requireUsableSender(master, sesId)).resolves.toMatchObject({ provider: "resend", verifiedStatus: "verified" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("webhook de Resend", () => {
  async function sentCampaign(n = 1) {
    const sender = await makeSender("Wh");
    const c = await readyCampaign(n, sender);
    await campaigns.launchCampaign(master, c.id, { confirmRecipients: n, acknowledgeSandbox: true });
    await worker.runSendCycle("w-wh", { provider: fake as never, today: freshDay() });
    return { c, rows: await recipients(c.id) };
  }

  it("rechaza sin secreto configurado (503), firma inválida, cuerpo alterado, secreto ajeno y timestamp viejo (401)", async () => {
    const e = evt("email.delivered", "no-importa");
    delete process.env.RESEND_WEBHOOK_SECRET;
    expect((await post(signed(e))).status).toBe(503);
    process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;

    expect((await post(signed(e, { tamper: true }))).status).toBe(401);
    expect((await post(signed(e, { key: Buffer.from("otro-secreto-otro-secreto-123456") }))).status).toBe(401);
    expect((await post(signed(e, { timestamp: String(Math.floor(Date.now() / 1000) - 3600) }))).status).toBe(401);
    const noHeaders = new NextRequest("https://crm.test/api/mailing/webhooks/resend", { method: "POST", body: JSON.stringify(e) });
    expect((await post(noHeaders)).status).toBe(401);
    expect((await q(sql<{ n: number }>`select count(*)::int n from mailing_events where provider_event_key like 'resend:no-importa%'`))[0]!.n).toBe(0);
  });

  it("delivery, open y click actualizan el destinatario; el reintento del proveedor es idempotente", async () => {
    const { rows } = await sentCampaign();
    const r = rows[0]!;
    const delivered = evt("email.delivered", r.provider_message_id!);
    expect((await post(signed(delivered))).body).toMatchObject({ status: "ok", applied: 1 });
    // mismo evento reenviado por Resend (mismo y distinto svix-id): colapsa
    expect((await post(signed(delivered))).body).toMatchObject({ status: "ok", duplicate: 1, applied: 0 });
    const ts = "2033-01-01T10:00:00.000Z";
    await post(signed(evt("email.opened", r.provider_message_id!, { open: { timestamp: ts } })));
    await post(signed(evt("email.opened", r.provider_message_id!, { open: { timestamp: ts } })));
    await post(signed(evt("email.clicked", r.provider_message_id!, { click: { link: "https://sutecba.com/a", timestamp: ts } })));
    const [row] = await q(sql<{ status: string; open_count: number; click_count: number; delivered_at: Date | null }>`
      select status, open_count, click_count, delivered_at from mailing_campaign_recipients where id = ${r.id}::uuid`);
    expect(row).toMatchObject({ status: "delivered", open_count: 1, click_count: 1 });
    expect(row!.delivered_at).not.toBeNull();
    const ev = await q(sql<{ event_type: string }>`select event_type from mailing_events where recipient_id = ${r.id}::uuid order by seq`);
    expect(ev.map((x) => x.event_type)).toEqual(["delivery", "open", "click"]);
  });

  it("bounce permanente suprime con origen resend_event; temporal solo cuenta; fuera de orden no retrocede", async () => {
    const { rows } = await sentCampaign(3);
    const [hard, soft, ooo] = rows;
    await post(signed(evt("email.bounced", hard!.provider_message_id!, { bounce: { type: "Permanent", subType: "Suppressed" } })));
    const [sup] = await q(sql<{ reason: string; source: string }>`select reason, source from mailing_suppressions where normalized_email = ${hard!.normalized_email} and lifted_at is null`);
    expect(sup).toEqual({ reason: "hard_bounce", source: "resend_event" });

    await post(signed(evt("email.bounced", soft!.provider_message_id!, { bounce: { type: "Temporary", subType: "MailboxFull" } })));
    const [s] = await q(sql<{ status: string; soft_bounce_count: number }>`select status, soft_bounce_count from mailing_campaign_recipients where id = ${soft!.id}::uuid`);
    expect(s).toMatchObject({ status: "sent", soft_bounce_count: 1 });
    expect((await q(sql<{ n: number }>`select count(*)::int n from mailing_suppressions where normalized_email = ${soft!.normalized_email}`))[0]!.n).toBe(0);

    await post(signed(evt("email.bounced", ooo!.provider_message_id!, { bounce: { type: "Permanent" } })));
    await post(signed(evt("email.delivered", ooo!.provider_message_id!)));
    const [o] = await q(sql<{ status: string }>`select status from mailing_campaign_recipients where id = ${ooo!.id}::uuid`);
    expect(o!.status).toBe("bounced");
  });

  it("queja: complained + supresión; sent tardío no pisa delivered; payload sin datos personales", async () => {
    const { rows } = await sentCampaign(2);
    const [c1, c2] = rows;
    await post(signed(evt("email.complained", c1!.provider_message_id!, { to: [c1!.normalized_email], subject: "Asunto privado" })));
    const [row] = await q(sql<{ status: string }>`select status from mailing_campaign_recipients where id = ${c1!.id}::uuid`);
    expect(row!.status).toBe("complained");
    const [sup] = await q(sql<{ reason: string }>`select reason from mailing_suppressions where normalized_email = ${c1!.normalized_email} and lifted_at is null`);
    expect(sup!.reason).toBe("complaint");
    const payloads = await q(sql<{ payload_safe: unknown }>`select payload_safe from mailing_events where recipient_id = ${c1!.id}::uuid`);
    expect(JSON.stringify(payloads)).not.toContain(c1!.normalized_email);
    expect(JSON.stringify(payloads)).not.toContain("Asunto privado");

    await post(signed(evt("email.delivered", c2!.provider_message_id!)));
    await post(signed(evt("email.sent", c2!.provider_message_id!)));
    const [d] = await q(sql<{ status: string }>`select status from mailing_campaign_recipients where id = ${c2!.id}::uuid`);
    expect(d!.status).toBe("delivered");
  });

  it("evento sin destinatario: se pide reintento si es reciente, se ignora si es viejo, y las pruebas del CRM no cuentan", async () => {
    const fresh = await post(signed(evt("email.delivered", `desconocido-${randomUUID()}`)));
    expect(fresh.status).toBe(503);
    expect(fresh.body).toMatchObject({ status: "retry", unmatched: 1 });

    const old = await post(signed(evt("email.delivered", `desconocido-${randomUUID()}`, {}, new Date(Date.now() - 3 * 3600 * 1000).toISOString())));
    expect(old.status).toBe(200);

    const probe = await post(signed(evt("email.delivered", `prueba-${randomUUID()}`, { tags: { kind: "verify" } })));
    expect(probe).toMatchObject({ status: 200, body: { ignored: 1 } });

    for (const type of ["email.received", "domain.updated", "contact.created"]) {
      expect(await post(signed(evt(type, "x")))).toMatchObject({ status: 200, body: { status: "ignored" } });
    }
    expect((await post(signed({ hola: 1 }))).status).toBe(200);
  });

  it("JSON inválido pero firmado => 400; cuerpo gigante => 413", async () => {
    const body = "esto no es json";
    const id = `msg_${randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", KEY).update(`${id}.${timestamp}.${body}`).digest("base64");
    const bad = new NextRequest("https://crm.test/api/mailing/webhooks/resend", {
      method: "POST",
      headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${sig}` },
      body,
    });
    expect((await post(bad)).status).toBe(400);
    const huge = new NextRequest("https://crm.test/api/mailing/webhooks/resend", { method: "POST", body: "x".repeat(300 * 1024) });
    expect((await post(huge)).status).toBe(413);
  });

  it("un evento solo modifica destinatarios del proveedor que lo emitió (aunque el id coincida)", async () => {
    // campaña de SES
    process.env.MAIL_PROVIDER = "ses";
    const sesProvider = new FakeProvider("ses");
    providers.setMailProviderForTests(sesProvider as never);
    const sesSender = await makeSender("Aisl");
    const sesCamp = await readyCampaign(1, sesSender);
    await campaigns.launchCampaign(master, sesCamp.id, { confirmRecipients: 1, acknowledgeSandbox: true });
    await worker.runSendCycle("w-iso-ses", { provider: sesProvider as never, today: freshDay() });
    const [sesRow] = await recipients(sesCamp.id);

    // campaña de Resend
    process.env.MAIL_PROVIDER = "resend";
    providers.setMailProviderForTests(fake as never);
    const rsSender = await makeSender("Aisl2");
    const rsCamp = await readyCampaign(1, rsSender);
    await campaigns.launchCampaign(master, rsCamp.id, { confirmRecipients: 1, acknowledgeSandbox: true });
    await worker.runSendCycle("w-iso-rs", { provider: fake as never, today: freshDay() });
    const [rsRow] = await recipients(rsCamp.id);

    // Resend firma un evento con el id de un envío de SES: no existe para Resend → nada cambia
    const forged = await post(signed(evt("email.bounced", sesRow!.provider_message_id!, { bounce: { type: "Permanent" } })));
    expect(forged.status).toBe(503);
    expect(forged.body).toMatchObject({ unmatched: 1, applied: 0 });
    const [sesAfter] = await recipients(sesCamp.id);
    expect(sesAfter!.status).toBe("sent");
    expect((await q(sql<{ n: number }>`select count(*)::int n from mailing_suppressions where normalized_email = ${sesRow!.normalized_email}`))[0]!.n).toBe(0);
    expect((await q(sql<{ n: number }>`select count(*)::int n from mailing_events where recipient_id = ${sesRow!.id}::uuid`))[0]!.n).toBe(0);

    // un evento de SES con el id de un envío de Resend tampoco lo toca
    const sesBodyForResend = JSON.stringify({ eventType: "Bounce", mail: { messageId: rsRow!.provider_message_id, timestamp: new Date().toISOString(), tags: {} }, bounce: { bounceType: "Permanent", timestamp: new Date().toISOString(), feedbackId: "x" } });
    for (const e of events.parseSesNotification(sesBodyForResend)) expect(await events.applyProviderEvent(e)).toBe("unmatched");
    expect((await recipients(rsCamp.id))[0]!.status).toBe("sent");

    // y cada proveedor sigue aplicando lo suyo, con su propia clave
    const sesBody = JSON.stringify({ eventType: "Delivery", mail: { messageId: sesRow!.provider_message_id, timestamp: new Date().toISOString(), tags: {} }, delivery: { timestamp: new Date().toISOString() } });
    for (const e of events.parseSesNotification(sesBody)) expect(await events.applyProviderEvent(e)).toBe("applied");
    expect((await post(signed(evt("email.delivered", rsRow!.provider_message_id!)))).body).toMatchObject({ applied: 1 });
    const sesKeys = await q(sql<{ provider_event_key: string }>`select provider_event_key from mailing_events where recipient_id = ${sesRow!.id}::uuid`);
    const rsKeys = await q(sql<{ provider_event_key: string }>`select provider_event_key from mailing_events where recipient_id = ${rsRow!.id}::uuid`);
    expect(sesKeys.every((k) => k.provider_event_key.startsWith("ses:"))).toBe(true);
    expect(rsKeys.every((k) => k.provider_event_key.startsWith("resend:"))).toBe(true);
  });

  it("el mailing nunca es contacto real: sin interacciones ni cambio de semáforo", async () => {
    const pid = await person(uniqueEmail());
    const sender = await makeSender("Sem");
    const { id } = await campaigns.createCampaign(master, { name: `Sem ${++seq}`, spec: { kind: "manual_ids", ids: [pid] } });
    await campaigns.updateCampaignDraft(master, id, { subject: "Hola", htmlBody: "<p>Hola</p>", textBody: "", senderId: sender });
    await campaigns.markCampaignReady(master, id);
    await campaigns.launchCampaign(master, id, { confirmRecipients: 1, acknowledgeSandbox: true });
    await worker.runSendCycle("w-sem", { provider: fake as never, today: freshDay() });
    const [r] = await recipients(id);

    await post(signed(evt("email.delivered", r!.provider_message_id!)));
    await post(signed(evt("email.opened", r!.provider_message_id!, { open: { timestamp: new Date().toISOString() } })));
    await post(signed(evt("email.clicked", r!.provider_message_id!, { click: { link: "https://x.test", timestamp: new Date().toISOString() } })));

    expect((await q(sql<{ n: number }>`select count(*)::int n from person_interactions where person_id = ${pid}::uuid`))[0]!.n).toBe(0);
    const rel = await getPersonRelationship(master, pid);
    expect(rel!.lastContact).toBeNull();
    expect(rel!.lastActivity).toBeNull();
  });
});
