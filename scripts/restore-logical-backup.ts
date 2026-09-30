import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PRUEBA DE RESTAURACIÓN (solo local, aislada): restaura un respaldo lógico (`npm run backup:logical`) en un PGlite
 * temporal, compara tabla por tabla, y aplica encima las migraciones pendientes (p. ej. 0031–0033).
 * NUNCA toca producción: fuerza SUTECBA_ENV=test y un directorio PGlite temporal. No imprime datos personales.
 *
 *   npx tsx scripts/restore-logical-backup.ts --backup <carpeta> [--keep] [--extra-migrations-from db/migrations]
 *       [--rehearse-plan-hash <hash> --extracted data/tandas/extracted]   # ensayo completo del apply sobre la copia
 */
const argv = process.argv.slice(2);
const value = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};

const stable = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
};

async function main() {
  const backupDir = resolve(value("backup") ?? "");
  if (!value("backup") || !existsSync(join(backupDir, "MANIFEST.json"))) throw new Error("Falta --backup <carpeta con MANIFEST.json>.");
  const manifest = JSON.parse(readFileSync(join(backupDir, "MANIFEST.json"), "utf-8")) as { migraciones: string[]; tablas: Record<string, { filas: number; sha256: string }> };

  const work = mkdtempSync(join(tmpdir(), "sutecba-restore-"));
  const migSrc = resolve("db/migrations");
  const projectRoot = process.cwd();
  process.env.SUTECBA_ENV = "test";
  process.env.SUTECBA_PGLITE_DATA_DIR = join(work, "pglite");
  // El runner lee `db/migrations` del cwd: se le da un directorio con SOLO las migraciones que tenía el respaldo.
  mkdirSync(join(work, "db", "migrations"), { recursive: true });
  for (const f of manifest.migraciones) copyFileSync(join(migSrc, f), join(work, "db", "migrations", f));
  process.chdir(work);

  const { applyMigrations } = await import(pathToFileURL(join(projectRoot, "scripts/migrate.ts")).href);
  const { closeDb, getDb } = await import(pathToFileURL(join(projectRoot, "lib/db/client.ts")).href);
  const { sql } = await import("kysely");
  const report: Record<string, unknown> = { respaldo_migraciones: manifest.migraciones.length, tablas_en_respaldo: Object.keys(manifest.tablas).length };
  try {
    // 1. esquema del respaldo (las mismas migraciones) en una base nueva
    await applyMigrations({ yes: true, allowDestructive: true });
    const db = await getDb();

    // 2. verificar los archivos del respaldo contra el MANIFEST
    const manifestErrors: string[] = [];
    for (const [t, info] of Object.entries(manifest.tablas)) {
      const body = readFileSync(join(backupDir, `${t}.json`), "utf-8");
      if (createHash("sha256").update(body).digest("hex") !== info.sha256 || (JSON.parse(body) as unknown[]).length !== info.filas) manifestErrors.push(t);
    }
    report.archivos_vs_manifest = manifestErrors.length === 0 ? "OK (hash y filas de las tablas)" : { con_diferencias: manifestErrors };

    // 3. restaurar
    const notRestored: Array<{ tabla: string; motivo: string }> = [];
    await db.transaction().execute(async (trx: any) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      // Un único TRUNCATE de todas las tablas ANTES de insertar (un TRUNCATE ... CASCADE por tabla vaciaría lo ya restaurado).
      await sql.raw(`truncate table ${Object.keys(manifest.tablas).map((t) => `public."${t}"`).join(", ")} cascade`).execute(trx);
      for (const t of Object.keys(manifest.tablas)) {
        const exists = await sql<{ n: number }>`select count(*)::int n from information_schema.tables where table_schema='public' and table_name=${t}`.execute(trx);
        if (!exists.rows[0]!.n) {
          notRestored.push({ tabla: t, motivo: "la tabla no existe en el esquema reconstruido" });
          continue;
        }
        const rows = JSON.parse(readFileSync(join(backupDir, `${t}.json`), "utf-8")) as unknown[];
        for (let i = 0; i < rows.length; i += 500) {
          try {
            await sql.raw(`insert into public."${t}" select * from jsonb_populate_recordset(null::public."${t}", '${JSON.stringify(rows.slice(i, i + 500)).replace(/'/g, "''")}'::jsonb)`).execute(trx);
          } catch (e) {
            notRestored.push({ tabla: t, motivo: String((e as Error).message).slice(0, 160) });
            throw e;
          }
        }
      }
    });
    report.tablas_no_restauradas = notRestored;

    // 4. comparar contenido tabla por tabla (filas ordenadas y canonizadas)
    const diffs: Array<{ tabla: string; filas_backup: number; filas_restauradas: number; filas_distintas: number }> = [];
    let identical = 0;
    for (const t of Object.keys(manifest.tablas)) {
      // Las columnas `date` se serializan como Date: el driver de producción las devuelve a medianoche LOCAL y PGlite a
      // medianoche UTC. Es solo la representación: se comparan por el día calendario (AAAA-MM-DD).
      const dateCols = (await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema='public' and table_name=${t} and data_type='date'`.execute(db)).rows.map((r) => r.column_name);
      const norm = (r: unknown) => {
        const o = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
        for (const c of dateCols) if (typeof o[c] === "string") o[c] = (o[c] as string).slice(0, 10);
        return stable(o);
      };
      const original = (JSON.parse(readFileSync(join(backupDir, `${t}.json`), "utf-8")) as unknown[]).map(norm).sort();
      const restored = ((await sql.raw(`select * from public."${t}"`).execute(db)) as { rows: unknown[] }).rows.map(norm).sort();
      const restoredSet = new Map<string, number>();
      for (const r of restored) restoredSet.set(r, (restoredSet.get(r) ?? 0) + 1);
      let different = 0;
      for (const r of original) {
        const n = restoredSet.get(r) ?? 0;
        if (n === 0) different += 1;
        else restoredSet.set(r, n - 1);
      }
      if (original.length !== restored.length || different) diffs.push({ tabla: t, filas_backup: original.length, filas_restauradas: restored.length, filas_distintas: different });
      else identical += 1;
    }
    report.tablas_identicas_fila_por_fila = `${identical} de ${Object.keys(manifest.tablas).length}`;
    report.tablas_con_diferencias = diffs;

    // 5. migraciones pendientes encima de la copia restaurada
    if (value("extra-migrations-from") !== "none") {
      const extras = readdirSync(migSrc).filter((f) => f.endsWith(".sql") && !manifest.migraciones.includes(f)).sort();
      for (const f of extras) copyFileSync(join(migSrc, f), join(work, "db", "migrations", f));
      await applyMigrations({ yes: true, allowDestructive: true });
      report.migraciones_aplicadas_sobre_la_copia = extras;
    }

    // 6. conteos críticos y CHECKs tras migrar
    const critical = ["people", "meeting_participations", "person_interactions", "organizations", "meetings", "import_batches", "import_rows", "tags"];
    const counts: Record<string, { respaldo: number; despues_de_migrar: number }> = {};
    for (const t of critical) {
      const n = Number(((await sql.raw(`select count(*)::int n from public."${t}"`).execute(db)) as { rows: Array<{ n: number }> }).rows[0]!.n);
      counts[t] = { respaldo: manifest.tablas[t]!.filas, despues_de_migrar: n };
    }
    report.conteos_criticos = counts;
    const checks = (await sql<{ conname: string }>`select conname from pg_constraint where conname in ('meeting_participations_basis_check','meeting_participations_participated_requires_basis_check','meeting_participations_source_rule_requires_evidence_check','people_name_split_status_check','people_name_split_consistency_check','person_observations_unique') order by 1`.execute(db)).rows.map((r) => r.conname);
    report.checks_presentes_tras_migrar = checks;
    report.personas_todas_split = (await sql<{ n: number }>`select count(*)::int n from people where name_split_status <> 'split' or full_name_original is not null`.execute(db)).rows[0]!.n === 0;

    // 7. ensayo del plan sobre la copia: el hash debe ser el aprobado
    if (value("rehearse-plan-hash")) {
      const { readTandasSnapshot } = await import(pathToFileURL(join(projectRoot, "lib/imports/tandas/snapshot.ts")).href);
      const { buildTandasPlan } = await import(pathToFileURL(join(projectRoot, "lib/imports/tandas/plan.ts")).href);
      const { parseTandaFile, TANDA_CODES } = await import(pathToFileURL(join(projectRoot, "lib/imports/tandas/sources.ts")).href);
      const files = TANDA_CODES.map((c: string) => JSON.parse(readFileSync(join(projectRoot, value("extracted") ?? "data/tandas/extracted", `${c}.json`), "utf-8")));
      const { snap } = await db.transaction().execute((trx: any) => readTandasSnapshot(trx));
      const plan = buildTandasPlan(files.map((f: unknown) => parseTandaFile(f)), snap);
      report.hash_del_plan_sobre_la_copia = plan.planHash;
      report.hash_coincide_con_el_aprobado = plan.planHash === value("rehearse-plan-hash");
    }
    // 8. ENSAYO COMPLETO del apply sobre la copia restaurada (nunca sobre producción): tiempos, conciliación e idempotencia
    if (argv.includes("--rehearse-apply") && value("rehearse-plan-hash")) {
      const { runTandasImport } = await import(pathToFileURL(join(projectRoot, "lib/imports/tandas/apply.ts")).href);
      const files = (await import(pathToFileURL(join(projectRoot, "lib/imports/tandas/sources.ts")).href)).TANDA_CODES.map((c: string) => JSON.parse(readFileSync(join(projectRoot, value("extracted") ?? "data/tandas/extracted", `${c}.json`), "utf-8")));
      const actor = (await sql<{ id: string }>`select created_by id from import_batches order by created_at limit 1`.execute(db)).rows[0]!.id;
      const owner = (await sql<{ id: string }>`select id from organizations where official_code = 'SUTECBA' and parent_id is null`.execute(db)).rows[0]!.id;
      const opts = { ownerOrganizationId: owner, createdBy: actor, confirmedPlanHash: value("rehearse-plan-hash")!, expectPeople: 2195, expectParticipations: 2032 };
      const count = async (q: string) => Number(((await sql.raw(q).execute(db)) as { rows: Array<{ n: number }> }).rows[0]!.n);
      const snapshot = async () => ({
        people: await count("select count(*)::int n from people"), unsplit: await count("select count(*)::int n from people where name_split_status='unsplit'"),
        participations: await count("select count(*)::int n from meeting_participations"), by_rule: await count("select count(*)::int n from meeting_participations where participation_basis='source_business_rule'"),
        registrations: await count("select count(*)::int n from meeting_participations where participation_kind='registration' and participation_basis='standard' and evidence like 'Inscripción según%'"),
        interactions: await count("select count(*)::int n from person_interactions"), attendance: await count("select count(*)::int n from meeting_attendance"),
        meetings: await count("select count(*)::int n from meetings"), tags: await count("select count(*)::int n from tags"), person_tags: await count("select count(*)::int n from person_tags"),
        observations: await count("select count(*)::int n from person_observations"), import_rows: await count("select count(*)::int n from import_rows"), import_files: await count("select count(*)::int n from import_files"),
        import_batches_applied: await count("select count(*)::int n from import_batches where status='applied'"), entity_links: await count("select count(*)::int n from import_entity_links"),
        people_without_org: await count("select count(*)::int n from people where organization_id is null"),
      });
      const before = await snapshot();
      const t0 = Date.now();
      const first = await runTandasImport(db, files, opts);
      const seconds1 = Math.round((Date.now() - t0) / 1000);
      const after = await snapshot();
      const t1 = Date.now();
      const second = await runTandasImport(db, files, opts);
      const again = await snapshot();
      report.ensayo_apply = {
        primera_corrida: { resultado: first.outcome, segundos: seconds1, creado: first.summary.created_this_run },
        antes: before, despues: after,
        segunda_corrida: { resultado: second.outcome, segundos: Math.round((Date.now() - t1) / 1000) },
        segunda_corrida_no_cambia_nada: JSON.stringify(after) === JSON.stringify(again),
      };
    }
    console.log(JSON.stringify(report, null, 2));
    await closeDb();
  } finally {
    process.chdir(projectRoot);
    if (!argv.includes("--keep")) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((e) => {
  console.error(String((e as Error).message ?? e).replace(/postgres(ql)?:\/\/\S+/gi, "[url]"));
  process.exitCode = 1;
});
