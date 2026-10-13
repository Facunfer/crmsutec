import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.MAIL_UNSUBSCRIBE_SECRET = "unit-test-unsubscribe-secret-0123456789abcdef";
process.env.PUBLIC_BASE_URL = "https://crm.test";
process.env.AWS_REGION = "us-east-1";
process.env.SES_CONFIGURATION_SET = "cfg-test";
process.env.MAIL_DAILY_SEND_LIMIT = "1000";
process.env.MAIL_MAX_SEND_RATE = "1000";
process.env.MAIL_WORKER_CONCURRENCY = "4";

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS, ROLE_PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const providers = await import("../../lib/mailing/providers/index.js");
const campaigns = await import("../../lib/mailing/campaigns.js");
const senders = await import("../../lib/mailing/senders.js");
const audience = await import("../../lib/mailing/audience.js");
const worker = await import("../../lib/mailing/worker.js");
const { runWorkerLoop } = await import("../../lib/mailing/worker-loop.js");
const { loadMailConfig } = await import("../../lib/mailing/config.js");
const events = await import("../../lib/mailing/events.js");
const supp = await import("../../lib/mailing/suppressions.js");
const queries = await import("../../lib/mailing/queries.js");
const tokens = await import("../../lib/mailing/tokens.js");
const template = await import("../../lib/mailing/template.js");
const emailLib = await import("../../lib/mailing/email.js");
const { getPersonTimeline, getPersonRelationship } = await import("../../lib/people/timeline.js");
const { PermissionError } = await import("../../lib/auth/guard.js");
const limiter = await import("../../lib/mailing/unsubscribe-limit.js");
const unsubRoute = await import("../../app/api/unsubscribe/[token]/route.js");
const { NextRequest } = await import("next/server");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const SECRET = process.env.MAIL_UNSUBSCRIBE_SECRET!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));

/** Proveedor falso: registra cada envío y permite forzar resultados. Nunca habla con AWS. */
class FakeProvider {
  readonly name = "ses" as const;
  calls: Array<{ to: string; subject: string; html: string; text: string; headers?: Record<string, string>; from: string }> = [];
  overrides = new Map<string, any>();
  onSend: (() => void) | null = null;
  sandbox = false;
  identity: "verified" | "pending" | "failed" | "unknown" = "verified";
  private n = 0;
  async send(message: any) {
    this.onSend?.();
    this.calls.push({ to: message.to, subject: message.subject, html: message.html, text: message.text, headers: message.headers, from: message.from });
    const o = this.overrides.get(message.to);
    if (o) return o;
    this.n += 1;
    return { kind: "accepted", messageId: `fake-${randomUUID()}-${this.n}` };
  }
  async getAccountStatus() {
    return { sandbox: this.sandbox, sendingEnabled: true, max24HourSend: 50000, maxSendRate: 14, sentLast24Hours: 0 };
  }
  async getIdentityStatus() {
    return this.identity;
  }
  async checkIdentity(identity: string) {
    const outcome = this.identity === "unknown" ? "error" : this.identity;
    return { identity, region: "us-east-1", outcome, message: `${identity}: ${outcome}` };
  }
}
let provider: FakeProvider;

let master: any;
let areaA: any;
let areaB: any;
let areaANoSensitive: any;
let readOnly: any;
let orgA: string;
let orgB: string;
let seq = 0;
let dni = 41000000;
let senderId: string;
let globalTagId: string;

function actorOf(id: string, roleKey: string, permissions: Set<string>): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions };
}
async function makeUser(email: string, roleKey: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id }).returning("id").executeTakeFirstOrThrow()).id;
}

async function person(email: string | null, opts: { org?: string; first?: string; last?: string; status?: string } = {}) {
  const db = await getDb();
  seq += 1;
  dni += 1;
  return (
    await db
      .insertInto("people")
      .values({
        first_name: opts.first ?? `Nom${seq}`, last_name: opts.last ?? `Ape${seq}`, dni: String(dni), email, organization_id: opts.org ?? orgA,
        origin: "manual", status: (opts.status ?? "active") as never,
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}
async function tagPeople(tagId: string, ids: string[]) {
  const db = await getDb();
  for (const id of ids) await db.insertInto("person_tags").values({ person_id: id, tag_id: tagId, assigned_by: master.id }).execute();
}
let emailSeq = 0;
const uniqueEmail = () => `dest${++emailSeq}-${randomUUID().slice(0, 6)}@example.test`;

async function sql1<T extends object>(q: ReturnType<typeof sql<T>>) {
  const db = await getDb();
  return (await q.execute(db)).rows;
}

async function newCampaign(n: number, opts: { actor?: any; org?: string; html?: string; subject?: string; people?: string[] } = {}) {
  const actor = opts.actor ?? master;
  const ids = opts.people ?? (await Promise.all(Array.from({ length: n }, () => person(uniqueEmail(), { org: opts.org }))));
  const { id } = await campaigns.createCampaign(actor, { name: `Camp ${++seq}`, spec: { kind: "manual_ids", ids } });
  await campaigns.updateCampaignDraft(actor, id, {
    subject: opts.subject ?? "Hola {{nombre}}", htmlBody: opts.html ?? "<p>Hola {{nombre}} {{apellido}}</p>", textBody: "", senderId,
  });
  await campaigns.markCampaignReady(actor, id);
  return { id, ids };
}
async function launched(n: number, opts: Parameters<typeof newCampaign>[1] = {}) {
  const c = await newCampaign(n, opts);
  await campaigns.launchCampaign(opts.actor ?? master, c.id, { confirmRecipients: n, acknowledgeSandbox: true });
  return c;
}
const recipients = async (campaignId: string) =>
  sql1(sql<{ id: string; normalized_email: string; status: string; provider_message_id: string | null; attempt_count: number; person_count: number; merge_vars: any }>`
    select id, normalized_email, status, provider_message_id, attempt_count, person_count, merge_vars from mailing_campaign_recipients where campaign_id = ${campaignId}::uuid order by normalized_email`);
const statusCounts = async (campaignId: string) => {
  const rows = await sql1(sql<{ status: string; n: number }>`select status, count(*)::int n from mailing_campaign_recipients where campaign_id = ${campaignId}::uuid group by status`);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
};
let dayCounter = 0;
const freshDay = () => `2031-${String(1 + Math.floor(dayCounter / 28)).padStart(2, "0")}-${String(1 + (dayCounter++ % 28)).padStart(2, "0")}`;

function sesEvent(type: string, messageId: string, extra: Record<string, unknown> = {}, ts = new Date().toISOString()) {
  const payload: Record<string, unknown> = { eventType: type, mail: { messageId, timestamp: ts, tags: {} }, ...extra };
  return JSON.stringify({ Type: "Notification", MessageId: randomUUID(), Message: JSON.stringify(payload) });
}
async function applyAll(body: string) {
  const parsed = events.parseSesNotification(body);
  const out = [];
  for (const e of parsed) out.push(await events.applyProviderEvent(e));
  return out;
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  orgA = await createTestOrganization("Mailing A");
  orgB = await createTestOrganization("Mailing B");
  const db = await getDb();
  master = actorOf(await makeUser("mail-master@sutecba.local", "MASTER_GLOBAL"), "MASTER_GLOBAL", ALL);
  const adminPerms = new Set<string>(ROLE_PERMISSIONS.ADMIN);
  const a = await makeUser("mail-a@sutecba.local", "ADMIN");
  const a2 = await makeUser("mail-a2@sutecba.local", "ADMIN");
  const b = await makeUser("mail-b@sutecba.local", "ADMIN");
  const ro = await makeUser("mail-ro@sutecba.local", "LECTURA");
  for (const [u, o] of [[a, orgA], [a2, orgA], [b, orgB], [ro, orgA]] as const) {
    await db.insertInto("user_scopes").values({ user_id: u, organization_id: o, include_descendants: true, granted_by: master.id } as never).execute();
  }
  areaA = actorOf(a, "ADMIN", adminPerms);
  areaANoSensitive = actorOf(a2, "ADMIN", new Set([...adminPerms].filter((p) => p !== "people.view_sensitive")));
  areaB = actorOf(b, "ADMIN", adminPerms);
  readOnly = actorOf(ro, "LECTURA", new Set<string>(ROLE_PERMISSIONS.LECTURA));
  globalTagId = (await db.insertInto("tags").values({ name: "Abogados mailing", category: null, owner_organization_id: null, created_by: master.id } as never).returning("id").executeTakeFirstOrThrow()).id;
});

beforeEach(async () => {
  provider = new FakeProvider();
  providers.setMailProviderForTests(provider as never);
  // aislamiento: lo que dejaron otros tests en curso no debe ser reclamado por este
  const db = await getDb();
  await sql`update mailing_campaigns set status = 'cancelled', cancelled_at = now(), cancel_reason = 'aislamiento de test', finished_at = now() where status in ('scheduled', 'sending', 'paused')`.execute(db);
});

afterAll(async () => {
  providers.setMailProviderForTests(null);
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("remitentes", () => {
  it("varios remitentes, uno por defecto, verificación contra el proveedor y alcance", async () => {
    const s1 = await senders.createSender(master, { name: "Comunicaciones", fromName: "SUTECBA Comunicaciones", fromEmail: "comunicaciones@sutecba.test", isDefault: true });
    senderId = s1.id;
    const s2 = await senders.createSender(master, { name: "Juventud", fromName: "SUTECBA Juventud", fromEmail: "juventud@sutecba.test", ownerOrganizationId: orgB });
    const s3 = await senders.createSender(master, { name: "Capacitaciones", fromName: "SUTECBA Cap", fromEmail: "cap@sutecba.test", ownerOrganizationId: orgA });
    // dos remitentes por defecto: el segundo desplaza al primero
    await senders.updateSender(master, s3.id, { name: "Capacitaciones", fromName: "SUTECBA Cap", fromEmail: "cap@sutecba.test", ownerOrganizationId: orgA, isDefault: true });
    const all = await senders.listSenders(master, { includeInactive: true });
    expect(all.filter((s) => s.isDefault)).toHaveLength(1);
    expect(all.find((s) => s.isDefault)!.id).toBe(s3.id);

    // alcance: el área A ve el global y el de A, no el de B
    const visibleA = (await senders.listSenders(areaA)).map((s) => s.id);
    expect(visibleA).toContain(s1.id);
    expect(visibleA).toContain(s3.id);
    expect(visibleA).not.toContain(s2.id);

    // recién creados: pendientes → no se pueden usar hasta verificarlos
    await expect(senders.requireUsableSender(master, s1.id)).rejects.toThrow(/no está verificado/);
    const verified = await senders.refreshSenderVerification(master, s1.id);
    expect(verified.verifiedStatus).toBe("verified");
    expect((await senders.requireUsableSender(master, s1.id)).id).toBe(s1.id);

    // un remitente inactivo no se puede usar
    await senders.refreshSenderVerification(master, s3.id);
    await senders.updateSender(master, s3.id, { name: "Capacitaciones", fromName: "SUTECBA Cap", fromEmail: "cap@sutecba.test", ownerOrganizationId: orgA, active: false });
    await expect(senders.requireUsableSender(master, s3.id)).rejects.toThrow(/inactivo/);
  });

  it("permisos y alcance al administrar remitentes; cabeceras a salvo de saltos de línea", async () => {
    await expect(senders.createSender(readOnly, { name: "x", fromName: "x", fromEmail: "x@x.test" })).rejects.toBeInstanceOf(PermissionError);
    await expect(senders.createSender(areaA, { name: "Global", fromName: "G", fromEmail: "global-a@sutecba.test" })).rejects.toThrow(/Master/);
    await expect(senders.createSender(areaA, { name: "De B", fromName: "G", fromEmail: "deb@sutecba.test", ownerOrganizationId: orgB })).rejects.toThrow(/alcance/);
    const ok = await senders.createSender(areaA, { name: "Local\r\nBcc: x@evil.test", fromName: "Nombre\r\nBcc: evil@evil.test", fromEmail: "local-a@sutecba.test", ownerOrganizationId: orgA });
    const row = await senders.getSender(areaA, ok.id);
    expect(row!.fromName).not.toMatch(/[\r\n]/);
    expect(row!.name).not.toMatch(/[\r\n]/);
    await expect(senders.createSender(master, { name: "Dup", fromName: "D", fromEmail: "LOCAL-A@sutecba.test" })).rejects.toThrow(/Ya existe/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("audiencia y snapshot", () => {
  it("manual: normaliza, deduplica el email compartido, cuenta inválidos, sin email y suprimidos", async () => {
    const shared = uniqueEmail();
    const supEmail = uniqueEmail();
    await supp.addManualSuppression(master, supEmail.toUpperCase());
    const ids = [
      await person(shared, { first: "Ana", last: "Uno" }),
      await person(`  ${shared.toUpperCase()}  `, { first: "Beto", last: "Dos" }),
      await person(uniqueEmail(), { first: "Cata", last: "Tres", org: orgA }),
      await person("no-es-un-email"),
      await person(null),
      await person(supEmail),
      await person(uniqueEmail(), { status: "inactive" }),
    ];
    const preview = await campaigns.previewAudience(master, { kind: "manual_ids", ids });
    expect(preview.stats).toMatchObject({ selected: 6, inactiveExcluded: 1, withEmail: 5, withoutEmail: 1, invalid: 1, duplicates: 1, suppressed: 1, finalRecipients: 2 });

    const { id, stats } = await campaigns.createCampaign(master, { name: "Snapshot", spec: { kind: "manual_ids", ids } });
    expect(stats.finalRecipients).toBe(2);
    const rows = await recipients(id);
    expect(rows).toHaveLength(4); // 2 finales + 1 suprimido + 1 inválido
    const sharedRow = rows.find((r) => r.normalized_email === shared.toLowerCase())!;
    expect(sharedRow.person_count).toBe(2);
    // email compartido → saludo neutro (sin nombre equivocado)
    expect(sharedRow.merge_vars).toMatchObject({ nombre: "", apellido: "" });
    const links = await sql1(sql<{ n: number }>`select count(*)::int n from mailing_campaign_recipient_people where recipient_id = ${sharedRow.id}::uuid`);
    expect(links[0]!.n).toBe(2);
    expect(rows.find((r) => r.status === "suppressed")).toBeTruthy();
    expect(rows.find((r) => r.status === "invalid")).toBeTruthy();
    // people.email original intacto
    const db = await getDb();
    const p2 = await db.selectFrom("people").select("email").where("id", "=", ids[1]!).executeTakeFirstOrThrow();
    expect(p2.email).toBe(`  ${shared.toUpperCase()}  `);
  });

  it("tag: se congela y NO se recalcula si el tag cambia después", async () => {
    const ids = await Promise.all([person(uniqueEmail()), person(uniqueEmail()), person(uniqueEmail())]);
    await tagPeople(globalTagId, ids);
    const { id } = await campaigns.createCampaign(master, { name: "Tag congelado", spec: { kind: "tag", tagIds: [globalTagId] } });
    const before = await recipients(id);
    expect(before.length).toBeGreaterThanOrEqual(3);
    // cambia la membresía del tag después de crear la campaña
    const db = await getDb();
    await db.updateTable("person_tags").set({ removed_at: new Date(), removed_by: master.id }).where("person_id", "=", ids[0]!).execute();
    const extra = await person(uniqueEmail());
    await tagPeople(globalTagId, [extra]);
    const after = await recipients(id);
    expect(after.map((r) => r.normalized_email)).toEqual(before.map((r) => r.normalized_email));
  });

  it("filtro de personas == todos los resultados; el alcance rige siempre", async () => {
    const orgC = await createTestOrganization("Mailing C");
    const ids = await Promise.all([person(uniqueEmail(), { org: orgC }), person(uniqueEmail(), { org: orgC }), person(null, { org: orgC })]);
    const spec = { kind: "people_filter" as const, filter: { organizationIds: [orgC] } };
    const preview = await campaigns.previewAudience(master, spec);
    expect(preview.stats).toMatchObject({ selected: 3, withEmail: 2, withoutEmail: 1, finalRecipients: 2 });
    // un usuario con alcance en A y B que filtra por la unidad C no ve nada (el filtro no amplía el alcance)
    const scoped = await campaigns.previewAudience(areaA, spec);
    expect(scoped.stats.selected).toBe(0);
    void ids;
  });

  it("alcance: no se puede armar una campaña con personas fuera del alcance (ids manuales manipulados)", async () => {
    const own = await person(uniqueEmail(), { org: orgB });
    const foreign = await person(uniqueEmail(), { org: orgA });
    await expect(campaigns.createCampaign(areaB, { name: "Manipulada", spec: { kind: "manual_ids", ids: [own, foreign] } })).rejects.toThrow(/fuera de tu alcance/);
    const ok = await campaigns.createCampaign(areaB, { name: "Propia", spec: { kind: "manual_ids", ids: [own] } });
    expect((await recipients(ok.id))).toHaveLength(1);
    // ids inexistentes también se rechazan
    await expect(campaigns.createCampaign(areaB, { name: "Fantasma", spec: { kind: "manual_ids", ids: [randomUUID()] } })).rejects.toThrow();
  });

  it("el spec se valida estrictamente y exige permisos", async () => {
    await expect(campaigns.previewAudience(master, { kind: "people_filter", filter: { organizationIds: ["no-uuid"] } } as never)).rejects.toThrow();
    await expect(campaigns.previewAudience(master, { kind: "people_filter", filter: { hack: "1=1" } } as never)).rejects.toThrow();
    await expect(campaigns.previewAudience(readOnly, { kind: "manual_ids", ids: [randomUUID()] })).rejects.toBeInstanceOf(PermissionError);
    expect(audience.audienceSpecSchema.safeParse({ kind: "manual_ids", ids: [] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("campaña: ciclo de vida", () => {
  it("borrador → lista → lanzada; no se edita lanzada; doble lanzamiento no duplica", async () => {
    const c = await newCampaign(3);
    const detail = await queries.getCampaignDetail(master, c.id);
    expect(detail!.campaign.status).toBe("ready");

    // confirmación de cantidad exacta
    await expect(campaigns.launchCampaign(master, c.id, { confirmRecipients: 99, acknowledgeSandbox: true })).rejects.toThrow(/cantidad exacta/);
    // dos operadores / doble clic a la vez
    const results = await Promise.allSettled([
      campaigns.launchCampaign(master, c.id, { confirmRecipients: 3, acknowledgeSandbox: true }),
      campaigns.launchCampaign(master, c.id, { confirmRecipients: 3, acknowledgeSandbox: true }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const batches = await sql1(sql<{ n: number }>`select count(*)::int n from mailing_campaign_batches where campaign_id = ${c.id}::uuid`);
    expect(batches[0]!.n).toBeGreaterThanOrEqual(1);
    expect(await statusCounts(c.id)).toEqual({ queued: 3 });
    await expect(campaigns.updateCampaignDraft(master, c.id, { subject: "x", htmlBody: "x", textBody: "" })).rejects.toThrow(/borrador/);
  });

  it("no se puede lanzar sin remitente verificado ni sin marcar lista; sandbox exige confirmación", async () => {
    const ids = [await person(uniqueEmail())];
    const { id } = await campaigns.createCampaign(master, { name: "Sin remitente", spec: { kind: "manual_ids", ids } });
    await campaigns.updateCampaignDraft(master, id, { subject: "S", htmlBody: "<p>x</p>", textBody: "" });
    await expect(campaigns.markCampaignReady(master, id)).rejects.toThrow(/remitente/i);
    await expect(campaigns.launchCampaign(master, id, { confirmRecipients: 1, acknowledgeSandbox: true })).rejects.toThrow(/lista/);

    const c = await newCampaign(1);
    provider.sandbox = true;
    await expect(campaigns.launchCampaign(master, c.id, { confirmRecipients: 1 })).rejects.toThrow(/Sandbox/);
    await campaigns.launchCampaign(master, c.id, { confirmRecipients: 1, acknowledgeSandbox: true });
  });

  it("pausar no reclama; reanudar continúa; cancelar conserva historia", async () => {
    const c = await launched(4);
    const day = freshDay();
    await campaigns.pauseCampaign(master, c.id);
    const paused = await worker.runSendCycle("w-pause", { provider: provider as never, today: day });
    expect(paused.claimed).toBe(0);
    expect(provider.calls).toHaveLength(0);

    await campaigns.resumeCampaign(master, c.id);
    const stats = await worker.runSendCycle("w-pause", { provider: provider as never, today: day });
    expect(stats.sent).toBe(4);
    await worker.advanceCampaigns();
    expect((await campaigns.getCampaign(master, c.id))!.status).toBe("completed");

    const c2 = await launched(2);
    await campaigns.cancelCampaign(master, c2.id, "error de audiencia");
    expect(await statusCounts(c2.id)).toEqual({ queued: 2 }); // historia intacta
    const cancelledCycle = await worker.runSendCycle("w-pause", { provider: provider as never, today: freshDay() });
    expect(cancelledCycle.claimed).toBe(0);
    await expect(campaigns.resumeCampaign(master, c2.id)).rejects.toThrow();
  });

  it("permisos: crear y enviar son distintos; el alcance limita la campaña", async () => {
    const operador = actorOf(areaA.id, "OPERADOR", new Set<string>(ROLE_PERMISSIONS.OPERADOR));
    const own = await person(uniqueEmail());
    const { id } = await campaigns.createCampaign(operador, { name: "Operador", spec: { kind: "manual_ids", ids: [own] } });
    await expect(campaigns.launchCampaign(operador, id, { confirmRecipients: 1 })).rejects.toBeInstanceOf(PermissionError);
    // otra área no la ve
    expect(await campaigns.getCampaign(areaB, id)).toBeNull();
    // lectura: ve la lista pero no crea
    await expect(campaigns.createCampaign(readOnly, { name: "x", spec: { kind: "manual_ids", ids: [own] } })).rejects.toBeInstanceOf(PermissionError);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("worker", () => {
  it("envía cada destinatario una vez, con baja firmada y cabeceras List-Unsubscribe", async () => {
    const c = await launched(5);
    const stats = await worker.runSendCycle("w1", { provider: provider as never, today: freshDay() });
    expect(stats).toMatchObject({ claimed: 5, sent: 5, unknown: 0, failed: 0 });
    expect(provider.calls).toHaveLength(5);
    const mine = provider.calls.filter((m) => m.html.includes("crm.test/unsubscribe/"));
    expect(mine).toHaveLength(5);
    const first = provider.calls[0]!;
    expect(first.headers!["List-Unsubscribe"]).toMatch(/^<https:\/\/crm\.test\/api\/unsubscribe\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+>$/);
    expect(first.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(first.subject).toMatch(/^Hola /);
    const rows = await recipients(c.id);
    expect(rows.every((r) => r.status === "sent" && r.provider_message_id)).toBe(true);
    expect(new Set(rows.map((r) => r.provider_message_id)).size).toBe(5);
  });

  it("dos workers a la vez no duplican; una pasada posterior no reenvía", async () => {
    const c = await launched(20);
    const day = freshDay();
    await Promise.all([worker.runSendCycle("wa", { provider: provider as never, today: day }), worker.runSendCycle("wb", { provider: provider as never, today: day })]);
    await worker.runSendCycle("wa", { provider: provider as never, today: day });
    const sent = provider.calls.map((m) => m.to);
    expect(sent).toHaveLength(20);
    expect(new Set(sent).size).toBe(20);
    expect(await statusCounts(c.id)).toEqual({ sent: 20 });
  });

  it("cuota diaria GLOBAL compartida entre campañas simultáneas y continuación al día siguiente", async () => {
    process.env.MAIL_DAILY_SEND_LIMIT = "5";
    try {
      const c1 = await launched(4);
      const c2 = await launched(4);
      const day1 = freshDay();
      const day2 = freshDay();
      const s1 = await worker.runSendCycle("wq", { provider: provider as never, today: day1, batchSize: 20 });
      expect(s1.sent).toBe(5);
      expect(provider.calls).toHaveLength(5);
      const s1b = await worker.runSendCycle("wq", { provider: provider as never, today: day1, batchSize: 20 });
      expect(s1b.quotaExhausted).toBe(true);
      expect(s1b.sent).toBe(0);
      const quota = await sql1(sql<{ reserved: number; daily_limit: number }>`select reserved, daily_limit from mailing_daily_quota where day = ${day1}::date`);
      expect(quota[0]).toMatchObject({ reserved: 5, daily_limit: 5 });

      const s2 = await worker.runSendCycle("wq", { provider: provider as never, today: day2, batchSize: 20 });
      expect(s2.sent).toBe(3);
      const total = ((await statusCounts(c1.id)).sent ?? 0) + ((await statusCounts(c2.id)).sent ?? 0);
      expect(total).toBe(8);
    } finally {
      process.env.MAIL_DAILY_SEND_LIMIT = "1000";
    }
  });

  it("respuesta incierta de SES: send_unknown y NUNCA se reintenta sola", async () => {
    const c = await launched(3);
    const rows = await recipients(c.id);
    const target = rows[0]!.normalized_email;
    provider.overrides.set(target, { kind: "unknown", code: "TimeoutError", message: "socket hang up" });
    const day = freshDay();
    const s1 = await worker.runSendCycle("wu", { provider: provider as never, today: day });
    expect(s1).toMatchObject({ sent: 2, unknown: 1 });
    await worker.runSendCycle("wu", { provider: provider as never, today: day });
    await worker.runSendCycle("wu", { provider: provider as never, today: freshDay() });
    expect(provider.calls.filter((m) => m.to === target)).toHaveLength(1);
    const after = (await recipients(c.id)).find((r) => r.normalized_email === target)!;
    expect(after.status).toBe("send_unknown");

    // revisión humana: marcar como no enviado
    await queries.resolveUnknownRecipient(master, after.id, "mark_failed");
    expect((await recipients(c.id)).find((r) => r.id === after.id)!.status).toBe("failed");
  });

  it("lease vencido en `sending` → send_unknown (no se reencola); un worker que cae no deja nada colgado", async () => {
    const c = await launched(2);
    const day = freshDay();
    await sql`update mailing_campaign_recipients set status = 'sending', lease_owner = 'muerto', lease_until = now() - interval '5 minutes', attempt_count = 1 where campaign_id = ${c.id}::uuid and normalized_email = (select min(normalized_email) from mailing_campaign_recipients where campaign_id = ${c.id}::uuid)`.execute(await getDb());
    expect(await worker.recoverExpiredLeases()).toBe(1);
    const s = await worker.runSendCycle("wl", { provider: provider as never, today: day });
    expect(s.sent).toBe(1); // solo el otro
    expect(await statusCounts(c.id)).toEqual({ sent: 1, send_unknown: 1 });
  });

  it("rechazo por ritmo: reencola con espera y libera cuota; rechazo definitivo: failed", async () => {
    const c = await launched(2);
    const rows = await recipients(c.id);
    provider.overrides.set(rows[0]!.normalized_email, { kind: "rejected", code: "TooManyRequestsException", message: "slow", retryable: true });
    provider.overrides.set(rows[1]!.normalized_email, { kind: "rejected", code: "MessageRejected", message: "Email address is not verified", retryable: false });
    const day = freshDay();
    const s = await worker.runSendCycle("wr", { provider: provider as never, today: day });
    expect(s).toMatchObject({ sent: 0, rejected: 2, requeued: 1, failed: 1 });
    const after = await recipients(c.id);
    expect(after.find((r) => r.normalized_email === rows[0]!.normalized_email)!.status).toBe("queued");
    expect(after.find((r) => r.normalized_email === rows[1]!.normalized_email)!.status).toBe("failed");
    const quota = await sql1(sql<{ reserved: number }>`select reserved from mailing_daily_quota where day = ${day}::date`);
    expect(quota[0]!.reserved).toBe(0); // nada salió: la cuota se devolvió
    // el reintento espera (next_attempt_at en el futuro)
    const s2 = await worker.runSendCycle("wr", { provider: provider as never, today: day });
    expect(s2.claimed).toBe(0);
  });

  it("rechazo a nivel cuenta (suspendida/pausada): pausa la campaña en vez de fallar uno por uno", async () => {
    const c = await launched(3);
    for (const r of await recipients(c.id)) provider.overrides.set(r.normalized_email, { kind: "rejected", code: "SendingPausedException", message: "paused", retryable: false });
    await worker.runSendCycle("wp", { provider: provider as never, today: freshDay(), batchSize: 1 });
    const camp = await campaigns.getCampaign(master, c.id);
    expect(camp!.status).toBe("paused");
    expect(camp!.cancelReason).toMatch(/SendingPaused/);
    expect((await statusCounts(c.id)).failed ?? 0).toBe(0);
  });

  it("una baja posterior al lanzamiento se respeta al enviar", async () => {
    const c = await launched(3);
    const rows = await recipients(c.id);
    await supp.addManualSuppression(master, rows[1]!.normalized_email);
    // addManualSuppression ya saca de circulación lo queued; probamos también el control al reclamar
    await sql`update mailing_campaign_recipients set status = 'queued', status_detail = null where id = ${rows[1]!.id}::uuid`.execute(await getDb());
    const s = await worker.runSendCycle("ws", { provider: provider as never, today: freshDay() });
    expect(s).toMatchObject({ sent: 2, suppressed: 1 });
    expect(provider.calls.map((m) => m.to)).not.toContain(rows[1]!.normalized_email);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("eventos de SES", () => {
  async function sentCampaign(n = 1) {
    const c = await launched(n);
    await worker.runSendCycle("we", { provider: provider as never, today: freshDay() });
    return { c, rows: await recipients(c.id) };
  }

  it("delivery, open y click actualizan el destinatario; repetir no modifica nada", async () => {
    const { c, rows } = await sentCampaign();
    const r = rows[0]!;
    const body = sesEvent("Delivery", r.provider_message_id!, { delivery: { timestamp: new Date().toISOString() } });
    expect(await applyAll(body)).toEqual(["applied"]);
    expect(await applyAll(body)).toEqual(["duplicate"]);
    // mismo evento reenviado por SNS con otro MessageId: la clave determinista lo detecta
    const ts = "2030-01-01T10:00:00.000Z";
    const o1 = sesEvent("Open", r.provider_message_id!, { open: { timestamp: ts } });
    const o2 = sesEvent("Open", r.provider_message_id!, { open: { timestamp: ts } });
    expect(await applyAll(o1)).toEqual(["applied"]);
    expect(await applyAll(o2)).toEqual(["duplicate"]);
    await applyAll(sesEvent("Click", r.provider_message_id!, { click: { timestamp: ts, link: "https://sutecba.test/a" } }));
    const [row] = await sql1(sql<{ status: string; open_count: number; click_count: number; delivered_at: Date | null }>`
      select status, open_count, click_count, delivered_at from mailing_campaign_recipients where id = ${r.id}::uuid`);
    expect(row).toMatchObject({ status: "delivered", open_count: 1, click_count: 1 });
    expect(row!.delivered_at).not.toBeNull();
    const detail = await queries.getCampaignDetail(master, c.id);
    expect(detail!.counts).toMatchObject({ delivered: 1, opened: 1, clicked: 1 });
  });

  it("bounce permanente suprime; transitorio solo cuenta; fuera de orden no retrocede", async () => {
    const { rows } = await sentCampaign(3);
    const [hard, soft, ooo] = rows;
    await applyAll(sesEvent("Bounce", hard!.provider_message_id!, { bounce: { bounceType: "Permanent", bounceSubType: "General", timestamp: new Date().toISOString(), feedbackId: "f1" } }));
    const sup = await sql1(sql<{ reason: string }>`select reason from mailing_suppressions where normalized_email = ${hard!.normalized_email} and lifted_at is null`);
    expect(sup[0]!.reason).toBe("hard_bounce");

    await applyAll(sesEvent("Bounce", soft!.provider_message_id!, { bounce: { bounceType: "Transient", bounceSubType: "MailboxFull", timestamp: new Date().toISOString(), feedbackId: "f2" } }));
    const [s] = await sql1(sql<{ status: string; soft_bounce_count: number }>`select status, soft_bounce_count from mailing_campaign_recipients where id = ${soft!.id}::uuid`);
    expect(s).toMatchObject({ status: "sent", soft_bounce_count: 1 });
    expect((await sql1(sql<{ n: number }>`select count(*)::int n from mailing_suppressions where normalized_email = ${soft!.normalized_email}`))[0]!.n).toBe(0);

    // fuera de orden: rebota y DESPUÉS llega una entrega → sigue rebotado
    await applyAll(sesEvent("Bounce", ooo!.provider_message_id!, { bounce: { bounceType: "Permanent", timestamp: new Date().toISOString(), feedbackId: "f3" } }));
    await applyAll(sesEvent("Delivery", ooo!.provider_message_id!, { delivery: { timestamp: new Date().toISOString() } }));
    const [o] = await sql1(sql<{ status: string }>`select status from mailing_campaign_recipients where id = ${ooo!.id}::uuid`);
    expect(o!.status).toBe("bounced");
  });

  it("queja: estado complained + supresión; evento de mensaje desconocido: unmatched; payload bruto no se guarda", async () => {
    const { rows } = await sentCampaign(1);
    const r = rows[0]!;
    await applyAll(sesEvent("Complaint", r.provider_message_id!, { complaint: { complaintFeedbackType: "abuse", timestamp: new Date().toISOString(), feedbackId: "c1", complainedRecipients: [{ emailAddress: r.normalized_email }] } }));
    const [row] = await sql1(sql<{ status: string }>`select status from mailing_campaign_recipients where id = ${r.id}::uuid`);
    expect(row!.status).toBe("complained");
    expect((await sql1(sql<{ reason: string }>`select reason from mailing_suppressions where normalized_email = ${r.normalized_email} and lifted_at is null`))[0]!.reason).toBe("complaint");
    const payload = await sql1(sql<{ payload_safe: any }>`select payload_safe from mailing_events where recipient_id = ${r.id}::uuid and event_type = 'complaint'`);
    expect(JSON.stringify(payload[0]!.payload_safe)).not.toContain(r.normalized_email);

    expect(await applyAll(sesEvent("Delivery", "mensaje-que-no-existe", { delivery: { timestamp: new Date().toISOString() } }))).toEqual(["unmatched"]);
    expect(events.parseSesNotification("no es json")).toEqual([]);
    expect(events.parseSesNotification(JSON.stringify({ hola: 1 }))).toEqual([]);
  });

  it("la cola: aplica, ignora basura y reintenta lo que llegó antes de guardarse el envío", async () => {
    const { rows } = await sentCampaign(1);
    const messages = [
      { id: "1", body: sesEvent("Delivery", rows[0]!.provider_message_id!, { delivery: { timestamp: new Date().toISOString() } }), receipt: "r1", receiveCount: 1 },
      { id: "2", body: "basura", receipt: "r2", receiveCount: 1 },
      { id: "3", body: sesEvent("Delivery", "aun-no-guardado", { delivery: { timestamp: new Date().toISOString() } }), receipt: "r3", receiveCount: 1 },
    ];
    const deleted: string[] = [];
    const queue = { receive: async () => messages, delete: async (r: string) => void deleted.push(r) };
    const out = await worker.pollEvents(queue as never, 10);
    expect(out).toMatchObject({ applied: 1, ignored: 1, unmatched: 1 });
    expect(deleted.sort()).toEqual(["r1", "r2"]); // r3 queda en la cola para reintentar
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("baja (unsubscribe) y supresiones", () => {
  it("GET no modifica; POST suprime; repetir es idempotente; token falso no sirve", async () => {
    const c = await launched(2);
    await worker.runSendCycle("wun", { provider: provider as never, today: freshDay() });
    const [r1, r2] = await recipients(c.id);
    const token = tokens.createUnsubscribeToken(r1!.id, SECRET);

    const preview = await supp.previewUnsubscribe(token);
    expect(preview).toMatchObject({ valid: true, alreadyUnsubscribed: false });
    expect(preview.maskedEmail).not.toContain(r1!.normalized_email);
    expect((await sql1(sql<{ n: number }>`select count(*)::int n from mailing_suppressions where normalized_email = ${r1!.normalized_email}`))[0]!.n).toBe(0);

    expect(await supp.confirmUnsubscribe(token)).toEqual({ ok: true, alreadyUnsubscribed: false });
    expect(await supp.confirmUnsubscribe(token)).toEqual({ ok: true, alreadyUnsubscribed: true });
    expect((await sql1(sql<{ n: number }>`select count(*)::int n from mailing_suppressions where normalized_email = ${r1!.normalized_email} and lifted_at is null`))[0]!.n).toBe(1);
    expect((await sql1(sql<{ n: number }>`select count(*)::int n from mailing_events where recipient_id = ${r1!.id}::uuid and event_type = 'unsubscribe'`))[0]!.n).toBe(1);
    expect((await recipients(c.id)).find((r) => r.id === r1!.id)!.status).toBe("unsubscribed");
    expect((await recipients(c.id)).find((r) => r.id === r2!.id)!.status).toBe("sent");

    // la siguiente campaña al mismo email lo excluye
    const person = await sql1(sql<{ id: string }>`select primary_person_id as id from mailing_campaign_recipients where id = ${r1!.id}::uuid`);
    const preview2 = await campaigns.previewAudience(master, { kind: "manual_ids", ids: [person[0]!.id] });
    expect(preview2.stats).toMatchObject({ suppressed: 1, finalRecipients: 0 });

    // tokens inválidos
    expect(await supp.confirmUnsubscribe("abc.def")).toEqual({ ok: false, alreadyUnsubscribed: false });
    expect(tokens.verifyUnsubscribeToken(token, "otro-secreto-distinto-0123456789abcdef")).toBeNull();
    expect(tokens.verifyUnsubscribeToken(token.slice(0, -2) + "xx", SECRET)).toBeNull();
    expect(tokens.verifyUnsubscribeToken(token, SECRET)).toBe(r1!.id);
  });

  it("supresión manual, levantar con motivo (sin DELETE) y permisos", async () => {
    const email = uniqueEmail();
    expect((await supp.addManualSuppression(master, email)).created).toBe(true);
    expect((await supp.addManualSuppression(master, email)).created).toBe(false);
    await expect(supp.addManualSuppression(master, "no-valido")).rejects.toThrow();
    await expect(supp.addManualSuppression(readOnly, email)).rejects.toBeInstanceOf(PermissionError);
    const list = await supp.listSuppressions(master, { search: email.slice(0, 8) });
    const row = list.rows.find((r) => r.email === email)!;
    await expect(supp.liftSuppression(master, row.id, "x")).rejects.toThrow(/motivo/);
    await supp.liftSuppression(master, row.id, "pidió volver a recibir");
    await expect(supp.liftSuppression(master, row.id, "pidió volver a recibir")).rejects.toThrow(/ya fue levantada/);
    // el historial se conserva y se puede volver a suprimir
    expect((await supp.addManualSuppression(master, email)).created).toBe(true);
    const db = await getDb();
    await expect(sql`delete from mailing_suppressions where normalized_email = ${email}`.execute(db)).resolves.toBeDefined();
  });
});

describe("rate limit de la baja pública", () => {
  it("limita el abuso por enlace e IP sin romper la baja legítima ni la idempotencia", async () => {
    const c = await launched(1);
    await worker.runSendCycle("wrl", { provider: provider as never, today: freshDay() });
    const [r] = await recipients(c.id);
    const token = tokens.createUnsubscribeToken(r!.id, SECRET);
    const post = () => unsubRoute.POST(new NextRequest(`https://crm.test/api/unsubscribe/${token}`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.9", "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }), { params: Promise.resolve({ token }) });
    const first = await post();
    expect(first.status).toBe(200);
    expect((await post()).status).toBe(200); // idempotente
    let blocked = 0;
    for (let i = 0; i < 40; i += 1) if ((await post()).status === 429) blocked += 1;
    expect(blocked).toBeGreaterThan(0);
    expect((await sql1(sql<{ n: number }>`select count(*)::int n from mailing_suppressions where normalized_email = ${r!.normalized_email} and lifted_at is null`))[0]!.n).toBe(1);
    // otro enlace desde la misma IP sigue andando
    const other = tokens.createUnsubscribeToken(randomUUID(), SECRET);
    expect(await limiter.allowUnsubscribeAttempt(other, "203.0.113.9")).toBe(true);
    // x-forwarded-for inválido no rompe la base (inet)
    expect(limiter.normalizeClientIp("no-es-una-ip, 1.1.1.1")).toBe("127.0.0.1");
    expect(limiter.normalizeClientIp("198.51.100.7, 10.0.0.1")).toBe("198.51.100.7");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("timeline B5 y semántica de contacto", () => {
  it("una línea agrupada por campaña, countsAsContact=false, sin interacciones ni cambio de semáforo", async () => {
    const pid = await person(uniqueEmail(), { first: "Lucía", last: "Mail" });
    const before = await getPersonRelationship(master, pid);
    expect(before!.lastContact).toBeNull();

    const c = await launched(1, { people: [pid] });
    await worker.runSendCycle("wt", { provider: provider as never, today: freshDay() });
    const [r] = await recipients(c.id);
    await applyAll(sesEvent("Delivery", r!.provider_message_id!, { delivery: { timestamp: new Date().toISOString() } }));
    await applyAll(sesEvent("Open", r!.provider_message_id!, { open: { timestamp: new Date().toISOString() } }));
    await applyAll(sesEvent("Click", r!.provider_message_id!, { click: { timestamp: new Date().toISOString(), link: "https://x.test" } }));

    const tl = await getPersonTimeline(master, pid);
    const mail = tl!.events.filter((e) => e.category === "mailing");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.countsAsContact).toBe(false);
    expect(mail[0]!.title).toMatch(/^Mailing — Camp/);
    expect(mail[0]!.description).toBe("Enviado · Entregado · Abierto · Click");
    expect(tl!.counts.mailing).toBe(1);

    const interactions = await sql1(sql<{ n: number }>`select count(*)::int n from person_interactions where person_id = ${pid}::uuid`);
    expect(interactions[0]!.n).toBe(0);
    const after = await getPersonRelationship(master, pid);
    expect(after!.lastContact).toBeNull();
    expect(after!.lastActivity).toBeNull();

    // sin mailing.view no se ve la línea
    const tl2 = await getPersonTimeline(readOnlyWithout(), pid);
    expect(tl2!.events.filter((e) => e.category === "mailing")).toHaveLength(0);
  });

  it("email compartido: la línea aparece en ambas personas y se marca como compartido", async () => {
    const shared = uniqueEmail();
    const [p1, p2] = [await person(shared), await person(shared)];
    const c = await launched(1, { people: [p1, p2] });
    await worker.runSendCycle("wsh", { provider: provider as never, today: freshDay() });
    expect(provider.calls.filter((m) => m.to === shared.toLowerCase())).toHaveLength(1);
    expect(provider.calls[provider.calls.length - 1]!.subject).toBe("Hola"); // saludo neutro
    for (const pid of [p1, p2]) {
      const tl = await getPersonTimeline(master, pid);
      const m = tl!.events.find((e) => e.category === "mailing")!;
      expect(m.details.join(" ")).toMatch(/compartido/);
    }
    void c;
  });
});
function readOnlyWithout() {
  return actorOf(readOnly.id, "LECTURA", new Set<string>(ROLE_PERMISSIONS.LECTURA.filter((p) => !p.startsWith("mailing."))));
}

// ---------------------------------------------------------------------------------------------------------------------
describe("seguridad", () => {
  it("sanitiza HTML: scripts, manejadores, javascript:, iframes y estilos peligrosos", () => {
    const dirty =
      '<p onclick="x()">Hola <script>alert(1)</script><a href="javascript:alert(1)">mal</a><a href=" jav&#x61;script:alert(1)">mal2</a>' +
      '<a href="https://ok.test/p?a=1&b=2" onmouseover="y()">bien</a><img src="data:text/html;base64,AAA"><img src="https://ok.test/i.png" onerror="z()">' +
      '<iframe src="https://evil.test"></iframe><div style="background:url(javascript:alert(1));color:red">x</div><svg onload="a()"><circle/></svg>' +
      '<style>body{display:none}</style><form action="https://evil.test"><input name=x></form></p>';
    const clean = template.sanitizeEmailHtml(dirty);
    expect(clean).not.toMatch(/script|onclick|onmouseover|onerror|onload|javascript:|<iframe|<svg|<style|<form|data:text/i);
    expect(clean).toContain('href="https://ok.test/p?a=1&amp;b=2"');
    expect(clean).toContain('rel="noopener noreferrer"');
    expect(clean).toContain("color:red");
  });

  it("variables escapadas (sin inyección) y saludo neutro cuando falta el dato", () => {
    const out = template.renderMessage({
      subject: "Hola {{nombre}}\r\nBcc: evil@evil.test",
      htmlBody: "<p>Hola {{nombre}}, soy {{organizacion|el sindicato}} {{variable_rara}}</p>",
      textBody: "",
      vars: { nombre: '<img src=x onerror=alert(1)>', apellido: "", nombre_completo: "", organizacion: "" },
      unsubscribeUrl: "https://crm.test/unsubscribe/t",
    });
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(out.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out.html).not.toContain("<img src=x");
    expect(out.html).toContain("soy el sindicato");
    expect(out.html).toContain("https://crm.test/unsubscribe/t");
    const neutral = template.renderMessage({ subject: "Hola {{nombre}}", htmlBody: "<p>Hola {{nombre}},</p>", textBody: "", vars: {}, unsubscribeUrl: "https://crm.test/u" });
    expect(neutral.subject).toBe("Hola");
    expect(neutral.html).toContain("<p>Hola,</p>");
  });

  it("cabeceras: el asunto y el remitente no admiten saltos de línea; email inválido o con espacios no pasa", () => {
    expect(emailLib.headerSafe("a\r\nBcc: x")).not.toMatch(/[\r\n]/);
    expect(emailLib.formatAddress('Ana "X"\r\nBcc: y', "a@b.test")).toBe('"Ana \\"X\\" Bcc: y" <a@b.test>');
    for (const bad of ["a@b", "a b@c.test", "@c.test", "a@@c.test", "a@c..test", "", "a@-c.test"]) expect(emailLib.isValidEmail(bad), bad).toBe(false);
    expect(emailLib.isValidEmail("ana.perez+x@sub.dominio.com.ar")).toBe(true);
  });

  it("sin people.view_sensitive los destinatarios salen enmascarados y no se puede buscar por email", async () => {
    const c = await launched(2, { actor: areaA });
    const rows = await recipients(c.id);
    const list = await queries.listRecipients(areaANoSensitive, c.id, { search: rows[0]!.normalized_email.slice(0, 6) });
    // areaANoSensitive no creó la campaña pero ve el alcance de A: ve los destinatarios enmascarados
    expect(list).not.toBeNull();
    const blob = JSON.stringify(list);
    for (const r of rows) expect(blob).not.toContain(r.normalized_email);
    expect(list!.total).toBe(2); // el término de búsqueda se ignora sin permiso
    const full = await queries.listRecipients(areaA, c.id, {});
    expect(JSON.stringify(full)).toContain(rows[0]!.normalized_email);
    // otra área no ve nada
    expect(await queries.listRecipients(areaB, c.id, {})).toBeNull();
  });

  it("la configuración se valida sin revelar secretos", async () => {
    const { describeMailConfig, validateMailConfig, loadMailConfig } = await import("../../lib/mailing/config.js");
    const cfg = loadMailConfig();
    expect(JSON.stringify(describeMailConfig(cfg))).not.toContain(SECRET);
    expect(validateMailConfig(cfg).filter((i) => i.blocking)).toEqual([]);
    const broken = { ...cfg, unsubscribeSecret: "corto", publicBaseUrl: null, region: null };
    expect(validateMailConfig(broken).filter((i) => i.blocking).map((i) => i.key).sort()).toEqual(["AWS_REGION", "MAIL_UNSUBSCRIBE_SECRET", "PUBLIC_BASE_URL"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("worker: 429 sostenido, registro operativo, apagado limpio y mantenimiento", () => {
  it("429 sostenido: nunca pasa a failed, devuelve la cuota, incrementa el intento y se envía al recuperarse", async () => {
    const c = await launched(1);
    const [r] = await recipients(c.id);
    provider.overrides.set(r!.normalized_email, { kind: "rejected", code: "TooManyRequestsException", message: "slow", retryable: true });
    const day = freshDay();
    for (let i = 0; i < 7; i += 1) {
      const s = await worker.runSendCycle("w429", { provider: provider as never, today: day });
      expect(s).toMatchObject({ sent: 0, rejected: 1, requeued: 1, failed: 0 });
      await sql`update mailing_campaign_recipients set next_attempt_at = null where id = ${r!.id}::uuid`.execute(await getDb());
    }
    const [after] = await sql1(sql<{ status: string; attempt_count: number; last_error: string | null }>`select status, attempt_count, last_error from mailing_campaign_recipients where id = ${r!.id}::uuid`);
    expect(after).toMatchObject({ status: "queued", attempt_count: 7, last_error: "TooManyRequestsException" });
    expect((await sql1(sql<{ reserved: number }>`select reserved from mailing_daily_quota where day = ${day}::date`))[0]!.reserved).toBe(0);
    provider.overrides.delete(r!.normalized_email);
    expect((await worker.runSendCycle("w429", { provider: provider as never, today: day })).sent).toBe(1);
    expect((await recipients(c.id))[0]!.provider_message_id).toBeTruthy();
  });

  it("registro operativo: ids y códigos, nunca emails, cuerpos ni tokens", async () => {
    const lines: Array<{ message: string; fields: Record<string, unknown> }> = [];
    worker.setWorkerLogger((message, fields) => lines.push({ message, fields }));
    try {
      const c = await launched(2);
      const rows = await recipients(c.id);
      provider.overrides.set(rows[1]!.normalized_email, { kind: "rejected", code: "MessageRejected", message: `Email ${rows[1]!.normalized_email} not verified`, retryable: false });
      await worker.runSendCycle("wlog", { provider: provider as never, today: freshDay() });
      const ok = lines.find((l) => l.message === "envío aceptado")!;
      expect(ok.fields).toMatchObject({ workerId: "wlog", campaignId: c.id, attempt: 1 });
      expect(typeof ok.fields.recipientId).toBe("string");
      expect(String(ok.fields.providerMessageId)).toMatch(/^fake-/);
      const bad = lines.find((l) => l.message === "envío rechazado")!;
      expect(bad.fields).toMatchObject({ workerId: "wlog", campaignId: c.id, errorCode: "MessageRejected", retryable: false });
      const blob = JSON.stringify(lines);
      for (const r of rows) expect(blob).not.toContain(r.normalized_email);
      expect(blob).not.toMatch(/@|unsubscribe|Hola|<p>|List-Unsubscribe|secret/i);
    } finally {
      worker.setWorkerLogger(null);
    }
  });

  it("apagado limpio: tras la señal no reclama más, termina lo reclamado y retira su latido", async () => {
    const c = await launched(40);
    await worker.heartbeat("wstop", new Date(), {});
    let stop = false;
    provider.onSend = () => {
      stop = true; // llega SIGTERM en pleno ciclo
    };
    const { cycles } = await runWorkerLoop({
      workerId: "wstop", startedAt: new Date(), config: loadMailConfig(), blockingIssues: [], queue: null,
      isStopping: () => stop, provider: provider as never, idleMs: 20, busyMs: 5,
    });
    expect(cycles).toBe(1);
    const counts = await statusCounts(c.id);
    // se terminó TODO lo reclamado (nada queda en `sending`) y el resto sigue en cola sin reclamar
    expect(counts.sending ?? 0).toBe(0);
    expect(counts.sent).toBe(16);
    expect(counts.queued).toBe(24);
    expect(provider.calls).toHaveLength(16);
    expect((await sql1(sql<{ n: number }>`select count(*)::int n from mailing_worker_heartbeats where worker_id = 'wstop'`))[0]!.n).toBe(0);
    // y una vez detenido no vuelve a reclamar nada por su cuenta
    expect((await worker.runSendCycle("wotro", { provider: provider as never, today: freshDay() })).claimed).toBeGreaterThan(0); // otro worker sí puede
  });

  it("poda de latidos: borra los de más de 24 h y conserva los recientes", async () => {
    const db = await getDb();
    await sql`insert into mailing_worker_heartbeats (worker_id, started_at, last_seen_at) values ('viejo-a', now() - interval '3 days', now() - interval '25 hours'), ('reciente', now() - interval '1 hour', now() - interval '5 minutes')`.execute(db);
    expect(await worker.pruneHeartbeats()).toBeGreaterThanOrEqual(1);
    const left = (await sql1(sql<{ worker_id: string }>`select worker_id from mailing_worker_heartbeats where worker_id in ('viejo-a', 'reciente')`)).map((r) => r.worker_id);
    expect(left).toEqual(["reciente"]);
  });
});

describe("clasificación de errores de SES", () => {
  it("429 sin tipo => rechazo reintentable; timeout/5xx => incierto; credenciales/cuenta => rechazo definitivo", async () => {
    const { classifySesError } = await import("../../lib/mailing/providers/ses.js");
    expect(classifySesError({ name: "Unknown", $fault: "client", $metadata: { httpStatusCode: 429 } })).toMatchObject({ kind: "rejected", retryable: true });
    expect(classifySesError({ name: "TooManyRequestsException" })).toMatchObject({ kind: "rejected", retryable: true });
    expect(classifySesError({ name: "TimeoutError" })).toMatchObject({ kind: "unknown" });
    expect(classifySesError({ name: "InternalFailure", $fault: "server", $metadata: { httpStatusCode: 500 } })).toMatchObject({ kind: "unknown" });
    expect(classifySesError({ name: "CredentialsProviderError" })).toMatchObject({ kind: "rejected", retryable: false });
    expect(classifySesError({ name: "MessageRejected" })).toMatchObject({ kind: "rejected", retryable: false });
  });
});

describe("prueba y reparto en lotes", () => {
  it("el correo de prueba usa el remitente elegido, no toca estados ni cuota y rechaza emails inválidos", async () => {
    const c = await newCampaign(2);
    const db = await getDb();
    const quotaBefore = await sql1(sql<{ n: number }>`select count(*)::int n from mailing_daily_quota`);
    const r = await campaigns.sendTestEmail(master, c.id, " Prueba@Example.TEST ");
    expect(r.outcome).toBe("accepted");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.subject.startsWith("[PRUEBA]")).toBe(true);
    expect(provider.calls[0]!.to).toBe("prueba@example.test");
    expect(provider.calls[0]!.headers).toBeUndefined();
    expect(await statusCounts(c.id)).toEqual({ pending: 2 });
    expect((await sql1(sql<{ n: number }>`select count(*)::int n from mailing_daily_quota`))[0]!.n).toBe(quotaBefore[0]!.n);
    await expect(campaigns.sendTestEmail(master, c.id, "no-valido")).rejects.toThrow(/válido/);
    void db;
  });

  it("planBatches reparte respetando lo que queda hoy y el tope diario (28.000 con 15.000)", () => {
    expect(campaigns.planBatches(28000, 15000, 15000, "2026-10-12", true)).toEqual([
      { sequence: 1, date: "2026-10-12", count: 15000 },
      { sequence: 2, date: "2026-10-13", count: 13000 },
    ]);
    expect(campaigns.planBatches(100, 50, 20, "2026-10-12", true)).toEqual([
      { sequence: 1, date: "2026-10-12", count: 20 },
      { sequence: 2, date: "2026-10-13", count: 50 },
      { sequence: 3, date: "2026-10-14", count: 30 },
    ]);
    expect(campaigns.planBatches(10, 50, 0, "2026-10-12", true)).toEqual([{ sequence: 1, date: "2026-10-13", count: 10 }]);
  });

  it("estimación de costo", () => {
    expect(campaigns.estimateCostUsd(7000, 0.1)).toBe(0.7);
    expect(campaigns.estimateCostUsd(15000, 0.1)).toBe(1.5);
  });
});
