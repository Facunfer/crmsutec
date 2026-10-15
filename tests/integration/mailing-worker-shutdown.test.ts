import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.MAIL_UNSUBSCRIBE_SECRET = "unit-test-unsubscribe-secret-0123456789abcdef";
process.env.PUBLIC_BASE_URL = "https://crm.test";
process.env.AWS_REGION = "us-east-1";
process.env.MAIL_DAILY_SEND_LIMIT = "1000";
process.env.MAIL_MAX_SEND_RATE = "1000";
process.env.MAIL_WORKER_CONCURRENCY = "4";

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const providers = await import("../../lib/mailing/providers/index.js");
const campaigns = await import("../../lib/mailing/campaigns.js");
const senders = await import("../../lib/mailing/senders.js");
const { runWorkerLoop } = await import("../../lib/mailing/worker-loop.js");
const { installWorkerShutdown } = await import("../../lib/mailing/worker-shutdown.js");
const { loadMailConfig } = await import("../../lib/mailing/config.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Proveedor que NO responde hasta que el test lo libera: simula un envío en curso. */
class GatedProvider {
  readonly name = "ses" as const;
  calls = 0;
  private release!: () => void;
  private gate = new Promise<void>((r) => (this.release = r));
  private firstCallResolve!: () => void;
  firstCall = new Promise<void>((r) => (this.firstCallResolve = r));
  open() {
    this.release();
  }
  async send() {
    this.calls += 1;
    this.firstCallResolve();
    await this.gate;
    return { kind: "accepted" as const, messageId: `gated-${randomUUID()}` };
  }
  async getAccountStatus() {
    return { sandbox: null, sendingEnabled: true, max24HourSend: null, maxSendRate: null, sentLast24Hours: null };
  }
  async getIdentityStatus() {
    return "verified" as const;
  }
  async checkIdentity(identity: string) {
    return { identity, region: null, outcome: "verified" as const, message: "ok" };
  }
}

let master: any;
let seq = 0;
let dni = 61000000;
let orgA: string;
let senderId: string;
const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
const savedListeners: Record<string, NodeJS.SignalsListener[]> = {};

async function q<T extends object>(query: ReturnType<typeof sql<T>>) {
  const db = await getDb();
  return (await query.execute(db)).rows;
}

async function launchedCampaign(n: number) {
  const db = await getDb();
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    dni += 1;
    ids.push(
      (
        await db
          .insertInto("people")
          .values({ first_name: `N${seq}`, last_name: `A${seq}`, dni: String(dni), email: `sd${seq}-${randomUUID().slice(0, 6)}@example.test`, organization_id: orgA, origin: "manual", status: "active" } as never)
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id
    );
  }
  const { id } = await campaigns.createCampaign(master, { name: `Apagado ${++seq}`, spec: { kind: "manual_ids", ids } });
  await campaigns.updateCampaignDraft(master, id, { subject: "Hola", htmlBody: "<p>Hola</p>", textBody: "", senderId });
  await campaigns.markCampaignReady(master, id);
  await campaigns.launchCampaign(master, id, { confirmRecipients: n, acknowledgeSandbox: true });
  return id;
}

const statusCounts = async (campaignId: string) =>
  Object.fromEntries(
    (await q(sql<{ status: string; n: number }>`select status, count(*)::int n from mailing_campaign_recipients where campaign_id = ${campaignId}::uuid group by status`)).map((r) => [r.status, r.n])
  );
const heartbeatRows = async (workerId: string) => (await q(sql<{ n: number }>`select count(*)::int n from mailing_worker_heartbeats where worker_id = ${workerId}`))[0]!.n;

beforeAll(async () => {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    savedListeners[sig] = process.listeners(sig) as NodeJS.SignalsListener[];
    process.removeAllListeners(sig);
  }
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  orgA = await createTestOrganization("Apagado A");
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const uid = (await db.insertInto("users").values({ email: "shutdown-master@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "M", role_id: role.id }).returning("id").executeTakeFirstOrThrow()).id;
  master = { id: uid, email: "shutdown-master@sutecba.local", fullName: "M", roleId: "n/a", roleKey: "MASTER_GLOBAL", mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions: ALL };
  providers.setMailProviderForTests(new GatedProvider() as never);
  const s = await senders.createSender(master, { name: "Apagado", fromName: "SUTECBA", fromEmail: `ap-${randomUUID().slice(0, 6)}@sutecba.test` });
  await senders.verifySenderIdentity(master, s.id);
  senderId = s.id;
});

beforeEach(async () => {
  exitSpy.mockClear();
  const db = await getDb();
  await sql`update mailing_campaigns set status = 'cancelled', cancelled_at = now(), cancel_reason = 'aislamiento de test', finished_at = now() where status in ('scheduled', 'sending', 'paused')`.execute(db);
});

afterAll(async () => {
  providers.setMailProviderForTests(null);
  await closeDb();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.removeAllListeners(sig);
    for (const l of savedListeners[sig] ?? []) process.on(sig, l);
  }
  exitSpy.mockRestore();
  await sleep(100);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function startLoop(workerId: string, provider: GatedProvider) {
  const shutdown = installWorkerShutdown(() => undefined);
  const loop = runWorkerLoop({
    workerId,
    startedAt: new Date(),
    config: loadMailConfig(),
    blockingIssues: [],
    queue: null,
    isStopping: shutdown.isStopping,
    provider: provider as never,
    idleMs: 20,
    busyMs: 20,
  });
  return { shutdown, loop };
}

// Primero el escenario CON envío en curso para cada señal: cada una pasa por el gancho genérico de la base la primera vez que llega.
describe.each(["SIGTERM", "SIGINT"] as const)("apagado ordenado del worker ante %s", (signal) => {
  it("con un envío en curso: termina el ciclo, persiste cada resultado, no reclama más, retira el latido y la base queda utilizable", async () => {
    const provider = new GatedProvider();
    const workerId = `w-shutdown-${signal}-${randomUUID().slice(0, 6)}`;
    const { shutdown, loop } = startLoop(workerId, provider);
    try {
      // 1) un ciclo ocioso real: el worker escribe su latido (el latido se escribe al final de cada ciclo)
      for (let i = 0; i < 150 && (await heartbeatRows(workerId)) === 0; i += 1) await sleep(20);
      expect(await heartbeatRows(workerId)).toBe(1);

      // 2) aparece trabajo: lote de 16 (concurrencia 4 × 4) sobre 20 destinatarios
      const campaignId = await launchedCampaign(20);
      await provider.firstCall; // el envío está en curso: la llamada al proveedor no responde todavía

      // 3) llega la señal con el envío en vuelo
      process.emit(signal);
      await sleep(150);
      expect(exitSpy).not.toHaveBeenCalled(); // nadie cortó el proceso
      expect((await statusCounts(campaignId)).sending).toBe(16); // lo reclamado sigue en vuelo, no se abandonó
      expect(await heartbeatRows(workerId)).toBe(1); // el worker sigue vivo

      // 4) el proveedor responde: el bucle termina por sí solo
      provider.open();
      await loop;
      shutdown.dispose();

      const counts = await statusCounts(campaignId);
      expect(counts.sent).toBe(16); // todo lo reclamado se envió y se persistió
      expect(counts.queued).toBe(4); // y NO se reclamó nada más después de la señal
      expect(counts.sending ?? 0).toBe(0); // ninguno quedó colgado
      expect(counts.send_unknown ?? 0).toBe(0); // ninguno pasó a incierto
      expect(provider.calls).toBe(16); // ni un envío extra ni duplicado
      expect(await heartbeatRows(workerId)).toBe(0); // latido retirado
      expect(exitSpy).not.toHaveBeenCalled(); // el gancho genérico tampoco cortó al terminar
      expect(await (await getDb()).selectFrom("people").select("id").limit(1).execute()).toHaveLength(1); // la base sigue abierta
    } finally {
      provider.open();
      await loop.catch(() => undefined);
      shutdown.dispose();
    }
  });

  it("sin envíos: se detiene enseguida, retira el latido y no deja nada en proceso", async () => {
    const provider = new GatedProvider();
    const workerId = `w-idle-${signal}-${randomUUID().slice(0, 6)}`;
    const { shutdown, loop } = startLoop(workerId, provider);
    try {
      for (let i = 0; i < 150 && (await heartbeatRows(workerId)) === 0; i += 1) await sleep(20);
      expect(await heartbeatRows(workerId)).toBe(1);

      const started = Date.now();
      process.emit(signal);
      await loop;
      shutdown.dispose();

      expect(Date.now() - started).toBeLessThan(2000);
      expect(provider.calls).toBe(0);
      expect(await heartbeatRows(workerId)).toBe(0);
      expect(exitSpy).not.toHaveBeenCalled();
      expect((await q(sql<{ n: number }>`select count(*)::int n from mailing_campaign_recipients where status in ('sending', 'send_unknown')`))[0]!.n).toBe(0);
    } finally {
      provider.open();
      await loop.catch(() => undefined);
      shutdown.dispose();
    }
  });
});
