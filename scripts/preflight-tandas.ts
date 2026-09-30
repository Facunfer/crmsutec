import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { sql } from "kysely";
import { Pool } from "pg";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import type { ExtractedFile } from "../lib/imports/gabriel/types.js";
import { buildTandasPlan } from "../lib/imports/tandas/plan.js";
import { readTandasSnapshot } from "../lib/imports/tandas/snapshot.js";
import { parseTandaFile, TANDA_CODES } from "../lib/imports/tandas/sources.js";

/**
 * PREFLIGHT de las tandas 1 y 2. SOLO LECTURA. No imprime UUID, DNI ni cadenas de conexión: solo OK/FALLA y cantidades.
 *   npx tsx scripts/preflight-tandas.ts --plan-hash <hash> [--sources <carpeta con los originales>] [--backup <carpeta>]
 *       [--expect-people 2195] [--expect-participations 2032] [--expect-migrations 30|33]
 */
const argv = process.argv.slice(2);
const value = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
const checks: Array<{ control: string; ok: boolean; detalle?: unknown }> = [];
const add = (control: string, ok: boolean, detalle?: unknown) => checks.push({ control, ok, detalle });

async function main() {
  const env = loadEnv();
  add("entorno", env.SUTECBA_ENV === "production", env.SUTECBA_ENV);
  const admin = new Pool({ connectionString: env.SUTECBA_MIGRATION_DATABASE_URL, max: 1, ssl: env.SUTECBA_MIGRATION_DATABASE_URL?.includes("supabase") ? { rejectUnauthorized: false } : undefined });
  let ledger: string[] = [];
  try {
    await admin.query("set default_transaction_read_only = on");
    add("sutecba_meta.system = sutecba-crm", (await admin.query("select system from sutecba_meta where id = true")).rows[0]?.system === "sutecba-crm");
    ledger = (await admin.query("select filename from sutecba_migrations order by filename")).rows.map((r) => r.filename as string);
    const files = readdirSync(resolve("db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    const pending = files.filter((f) => !ledger.includes(f));
    add("migraciones aplicadas", value("expect-migrations") ? ledger.length === Number(value("expect-migrations")) : true, { aplicadas: ledger.length, ultima: ledger[ledger.length - 1], pendientes: pending });
    const sessions = await admin.query("select count(*)::int n from pg_stat_activity where usename = 'sutecba_app' and state = 'active' and pid <> pg_backend_pid()");
    add("sin sesiones activas de sutecba_app", sessions.rows[0].n === 0, sessions.rows[0].n);
    const actor = await admin.query("select count(*)::int n from users u join roles r on r.id = u.role_id where r.key = 'MASTER_GLOBAL' and u.status = 'active' and public.user_has_permission(u.id, 'imports.run') and u.id in (select created_by from import_batches)");
    add("único MASTER_GLOBAL activo con imports.run que creó lotes previos", actor.rows[0].n === 1, actor.rows[0].n);
    const owner = await admin.query("select count(*)::int n from organizations o where official_code = 'SUTECBA' and parent_id is null and active and not exists (select 1 from organizations c where c.parent_id = o.id)");
    add("propietaria SUTECBA raíz activa y sin hijos", owner.rows[0].n === 1, owner.rows[0].n);
    const counts = (await admin.query("select (select count(*)::int from people) people, (select count(*)::int from meeting_participations) participations, (select count(*)::int from person_interactions) interactions")).rows[0];
    add("personas", value("expect-people") ? counts.people === Number(value("expect-people")) : true, counts.people);
    add("participaciones", value("expect-participations") ? counts.participations === Number(value("expect-participations")) : true, counts.participations);
    if (ledger.includes("0033_person_observations.sql")) {
      const chk = await admin.query("select count(*)::int n from pg_constraint where conname in ('meeting_participations_basis_check','meeting_participations_participated_requires_basis_check','meeting_participations_source_rule_requires_evidence_check','people_name_split_status_check','people_name_split_consistency_check','person_observations_unique')");
      add("CHECKs de 0031–0033 presentes (6)", chk.rows[0].n === 6, chk.rows[0].n);
      const priv = await admin.query("select array_agg(privilege_type order by privilege_type) p from information_schema.role_table_grants where grantee = 'sutecba_app' and table_name = 'person_observations'");
      add("sutecba_app solo SELECT/INSERT en person_observations", JSON.stringify(priv.rows[0].p) === JSON.stringify(["INSERT", "SELECT"]), priv.rows[0].p);
    }
  } finally {
    await admin.end();
  }
  // fuentes y hash del plan
  const dir = resolve("data/tandas/extracted");
  const extracted = TANDA_CODES.map((c) => JSON.parse(readFileSync(join(dir, `${c}.json`), "utf-8")) as ExtractedFile);
  if (value("sources")) {
    const bad = extracted.filter((f) => !existsSync(join(value("sources")!, f.fileName)) || createHash("sha256").update(readFileSync(join(value("sources")!, f.fileName))).digest("hex") !== f.sha256).map((f) => f.fileCode);
    add("22 originales = hashes del extracto", bad.length === 0, bad.length ? { con_diferencias: bad } : "22/22");
  }
  const db = await getDb();
  const { snap } = await db.transaction().execute(async (trx) => {
    await sql`set transaction read only`.execute(trx);
    return readTandasSnapshot(trx);
  });
  const plan = buildTandasPlan(extracted.map((f) => parseTandaFile(f)), snap);
  add("plan hash = aprobado", !value("plan-hash") || plan.planHash === value("plan-hash"), plan.planHash);
  add("cifras del plan", plan.persons.altas === 177436 && plan.totals.participaciones_nuevas === 3500 && plan.totals.inscripciones_nuevas === 49, { altas: plan.persons.altas, participaciones: plan.totals.participaciones_nuevas, inscripciones: plan.totals.inscripciones_nuevas, bloqueadas: plan.persons.bloqueadas });
  if (value("backup")) {
    const m = JSON.parse(readFileSync(join(resolve(value("backup")!), "MANIFEST.json"), "utf-8"));
    add("backup lógico: MANIFEST con 2.195 personas y 2.032 participaciones", m.tablas.people.filas === 2195 && m.tablas.meeting_participations.filas === 2032, { generado: m.generado, tablas: Object.keys(m.tablas).length });
  }
  console.log(JSON.stringify({ veredicto: checks.every((c) => c.ok) ? "PREFLIGHT OK" : "PREFLIGHT CON FALLAS", controles: checks }, null, 2));
  await closeDb();
  if (!checks.every((c) => c.ok)) process.exitCode = 1;
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")); process.exitCode = 1; });
