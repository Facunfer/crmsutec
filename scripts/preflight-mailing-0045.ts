import { Pool } from "pg";
import { loadEnv } from "../lib/db/env.js";

/**
 * Preflight de la migración 0045 (Resend). SOLO LECTURA: sesión `read only`, ningún INSERT/UPDATE/DELETE/DDL. Nunca imprime
 * emails, nombres ni contenidos: solo cantidades, nombres de restricciones y valores del campo `provider`.
 *
 *   npx tsx scripts/preflight-mailing-0045.ts
 *
 * Resultado: `ok: true` solo si (a) hay exactamente una migración pendiente y es la 0045, (b) las dos restricciones existen con
 * el nombre esperado y solo admiten 'ses', (c) ninguna fila tiene un provider distinto de 'ses', (d) existe la tabla de eventos.
 */
const EXPECTED_PENDING = "0045_mailing_provider_resend.sql";

async function main() {
  const env = loadEnv();
  if (!env.SUTECBA_MIGRATION_DATABASE_URL) throw new Error("Falta SUTECBA_MIGRATION_DATABASE_URL (solo lectura).");
  const pool = new Pool({ connectionString: env.SUTECBA_MIGRATION_DATABASE_URL, max: 1 });
  try {
    await pool.query("set default_transaction_read_only = on");
    await pool.query("begin isolation level repeatable read read only");
    const one = async <T = Record<string, unknown>>(text: string) => (await pool.query(text)).rows as T[];

    const db = (await one<{ db: string; usr: string }>("select current_database() as db, current_user as usr"))[0]!;
    const system = (await one<{ system: string }>("select system from sutecba_meta where id = true"))[0]?.system ?? null;
    const applied = (await one<{ filename: string }>("select filename from sutecba_migrations order by filename")).map((r) => r.filename);

    const { readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const onDisk = readdirSync(join(process.cwd(), "db", "migrations")).filter((f) => f.endsWith(".sql")).sort();
    const pending = onDisk.filter((f) => !applied.includes(f));
    const unknownApplied = applied.filter((f) => !onDisk.includes(f));

    const constraints = await one<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('mailing_senders_provider_check', 'mailing_campaigns_provider_check') order by conname`
    );
    const counts = (
      await one<Record<string, string>>(`
        select
          (select count(*) from mailing_senders) as senders,
          (select count(*) from mailing_campaigns) as campaigns,
          (select count(*) from mailing_campaign_recipients) as recipients,
          (select count(*) from mailing_events) as events,
          (select count(*) from mailing_suppressions where lifted_at is null) as active_suppressions,
          (select count(*) from mailing_campaigns where status in ('scheduled', 'sending')) as campaigns_in_flight,
          (select count(*) from mailing_campaign_recipients where status in ('queued', 'sending')) as recipients_in_flight,
          (select count(*) from mailing_campaign_recipients where status = 'send_unknown') as recipients_send_unknown,
          (select count(*) from people) as people`)
    )[0]!;
    const providers = await one<{ source: string; provider: string; n: string }>(
      `select 'senders' as source, provider, count(*)::text as n from mailing_senders group by provider
       union all select 'campaigns', provider, count(*)::text from mailing_campaigns group by provider order by 1, 2`
    );
    const worker = await one<{ n: string; last_seen: string | null }>(
      "select count(*)::text as n, max(last_seen_at)::text as last_seen from mailing_worker_heartbeats where last_seen_at > now() - interval '2 minutes'"
    );
    await pool.query("commit");

    const onlySes = providers.every((p) => p.provider === "ses");
    const constraintsOk = constraints.length === 2 && constraints.every((c) => /'ses'/.test(c.def) && !/resend/.test(c.def));
    const ok = pending.length === 1 && pending[0] === EXPECTED_PENDING && unknownApplied.length === 0 && constraintsOk && onlySes;

    console.log(
      JSON.stringify(
        {
          ok,
          destino: { database: db.db, role: db.usr, system },
          migraciones: { aplicadas: applied.length, pendientes: pending, aplicadasQueNoEstanEnElRepo: unknownApplied },
          restricciones: constraints.map((c) => ({ nombre: c.conname, definicion: c.def })),
          providerPorTabla: providers,
          conteos: counts,
          workerActivoUltimos2Min: Number(worker[0]!.n) > 0,
          avisos: [
            ...(Number(counts.campaigns_in_flight) > 0 ? ["Hay campañas en curso: conviene aplicar con el worker en reposo."] : []),
            ...(Number(counts.recipients_send_unknown) > 0 ? ["Hay destinatarios en send_unknown pendientes de revisión humana (no los toca la migración)."] : []),
          ],
        },
        null,
        2
      )
    );
    process.exitCode = ok ? 0 : 2;
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(`[preflight-mailing-0045] error: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
  process.exitCode = 1;
});
