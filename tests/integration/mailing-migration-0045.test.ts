import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, applyMigration, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { assertNoDestructiveWithoutFlag } = await import("../../lib/db/guards.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const FILE = "0045_mailing_provider_resend.sql";
const SOURCE = readFileSync(join(process.cwd(), "db", "migrations", FILE), "utf-8");

/** Estado anterior a 0045: exactamente el rollback documentado en docs/MAILING-RESEND-RUNBOOK.md §8. */
const ROLLBACK = [
  "ALTER TABLE public.mailing_senders  DROP CONSTRAINT mailing_senders_provider_check",
  "ALTER TABLE public.mailing_senders  ADD  CONSTRAINT mailing_senders_provider_check  CHECK (provider IN ('ses'))",
  "ALTER TABLE public.mailing_campaigns DROP CONSTRAINT mailing_campaigns_provider_check",
  "ALTER TABLE public.mailing_campaigns ADD  CONSTRAINT mailing_campaigns_provider_check CHECK (provider IN ('ses'))",
];

let userId: string;

/** En una transacción, igual que el runbook: si el ADD falla (hay filas resend) se deshace también el DROP. */
async function runRollback() {
  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    for (const s of ROLLBACK) await sql.raw(s).execute(trx);
  });
}

async function reapply0045() {
  const db = await getDb();
  await sql`delete from sutecba_migrations where filename = ${FILE}`.execute(db);
  await applyMigration(db, FILE, SOURCE, false); // sin --allow-destructive: 0045 no lo necesita
}

async function snapshot() {
  const db = await getDb();
  const tables = ["mailing_senders", "mailing_campaigns", "mailing_campaign_recipients", "mailing_suppressions", "mailing_events"];
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = (await sql.raw(`select * from public.${t} order by 1`).execute(db)).rows as unknown[];
  return JSON.stringify(out);
}

async function seedHistory() {
  const db = await getDb();
  const sender = (
    await sql<{ id: string }>`insert into mailing_senders (name, from_name, from_email, verified_status) values ('Hist', 'Hist', ${`hist-${randomUUID().slice(0, 6)}@sutecba.test`}, 'verified') returning id`.execute(db)
  ).rows[0]!.id;
  const campaign = (
    await sql<{ id: string }>`insert into mailing_campaigns (name, created_by, status, sender_id, subject, html_body) values ('Campaña histórica', ${userId}::uuid, 'completed', ${sender}::uuid, 'Asunto', '<p>x</p>') returning id`.execute(db)
  ).rows[0]!.id;
  const recipient = (
    await sql<{ id: string }>`insert into mailing_campaign_recipients (campaign_id, normalized_email, email_snapshot, status, provider_message_id) values (${campaign}::uuid, 'historico@example.test', 'historico@example.test', 'delivered', 'ses-historico-1') returning id`.execute(db)
  ).rows[0]!.id;
  await sql`insert into mailing_events (campaign_id, recipient_id, provider_event_key, provider_message_id, event_type, event_at) values (${campaign}::uuid, ${recipient}::uuid, 'ses:ses-historico-1:delivery:abc', 'ses-historico-1', 'delivery', now())`.execute(db);
  await sql`insert into mailing_suppressions (normalized_email, reason, source) values ('baja@example.test', 'unsubscribe', 'unsubscribe_link')`.execute(db);
  return { sender, campaign };
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  userId = (await db.insertInto("users").values({ email: "mig0045@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "M", role_id: role.id }).returning("id").executeTakeFirstOrThrow()).id;
});

afterAll(async () => {
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("migración 0045 sobre datos históricos", () => {
  it("no es una migración destructiva para el guardia: se aplica SIN --allow-destructive (DROP CONSTRAINT solo reemplaza un CHECK)", () => {
    expect(() => assertNoDestructiveWithoutFlag(FILE, SOURCE, false)).not.toThrow();
    expect(SOURCE).not.toMatch(/drop\s+(table|column)|truncate|delete\s+from/i);
  });

  it("conserva TODAS las filas históricas de SES, byte a byte, y admite resend recién después", async () => {
    await runRollback(); // estado de producción hoy: solo 'ses'
    const db = await getDb();
    await expect(sql`insert into mailing_senders (name, from_name, from_email, provider) values ('R', 'R', 'r@sutecba.test', 'resend')`.execute(db)).rejects.toThrow();

    await seedHistory();
    const before = await snapshot();
    expect(before).toContain("ses-historico-1");

    await reapply0045();

    expect(await snapshot()).toBe(before);
    const provs = await sql<{ provider: string }>`select distinct provider from mailing_senders union select distinct provider from mailing_campaigns`.execute(db);
    expect(provs.rows.map((r) => r.provider)).toEqual(["ses"]);

    await sql`insert into mailing_senders (name, from_name, from_email, provider) values ('R', 'R', ${`r-${randomUUID().slice(0, 6)}@sutecba.test`}, 'resend')`.execute(db);
    await expect(sql`insert into mailing_senders (name, from_name, from_email, provider) values ('X', 'X', 'x@sutecba.test', 'sendgrid')`.execute(db)).rejects.toThrow();
    await expect(sql`insert into mailing_campaigns (name, created_by, provider) values ('X', ${userId}::uuid, 'sendgrid')`.execute(db)).rejects.toThrow();
  });

  it("el código anterior sigue funcionando: insertar sin provider usa 'ses' y 'ses' explícito es válido", async () => {
    const db = await getDb();
    const r = await sql<{ provider: string }>`insert into mailing_campaigns (name, created_by) values ('Sin provider', ${userId}::uuid) returning provider`.execute(db);
    expect(r.rows[0]!.provider).toBe("ses");
    const s = await sql<{ provider: string }>`insert into mailing_campaigns (name, created_by, provider) values ('Con ses', ${userId}::uuid, 'ses') returning provider`.execute(db);
    expect(s.rows[0]!.provider).toBe("ses");
  });

  it("es idempotente: aplicarla de nuevo no falla ni cambia datos", async () => {
    const before = await snapshot();
    await reapply0045();
    expect(await snapshot()).toBe(before);
  });

  it("el rollback documentado se niega mientras existan filas con resend (no destruye datos) y funciona si no las hay", async () => {
    const db = await getDb();
    // hay un remitente 'resend' del test anterior: el rollback debe fallar y dejar todo igual
    const before = await snapshot();
    await expect(runRollback()).rejects.toThrow();
    expect(await snapshot()).toBe(before);

    // sin filas resend, el rollback es posible y 0045 se puede volver a aplicar
    await sql`update mailing_senders set provider = 'ses' where provider = 'resend'`.execute(db);
    await runRollback();
    await expect(sql`insert into mailing_senders (name, from_name, from_email, provider) values ('R2', 'R2', 'r2@sutecba.test', 'resend')`.execute(db)).rejects.toThrow();
    await reapply0045();
    await sql`insert into mailing_senders (name, from_name, from_email, provider) values ('R3', 'R3', 'r3@sutecba.test', 'resend')`.execute(db);
  });
});
