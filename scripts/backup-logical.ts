import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { loadEnv } from "../lib/db/env.js";

/**
 * Respaldo LÓGICO de todas las tablas de `public` (solo lectura, conexión de migración), fuera de Git.
 * Un JSON por tabla + MANIFEST.json (filas y SHA-256 por tabla, migraciones aplicadas). Verifica releyendo cada archivo.
 * Nunca imprime datos: solo cantidades y hashes. El respaldo contiene datos personales y hashes de contraseña: guardarlo
 * fuera del repositorio y con cuidado.
 *
 *   npm run backup:logical -- --out-dir "C:\Users\usuario\Documents\sutecba-fuentes\backups" --label pre-cambios-0024
 */
async function main() {
  const argv = process.argv.slice(2);
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  const outRoot = resolve(value("out-dir") ?? "");
  if (!value("out-dir")) throw new Error("Falta --out-dir.");
  const rel = relative(process.cwd(), outRoot);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error("El respaldo debe quedar FUERA del repositorio.");
  const env = loadEnv();
  if (!env.SUTECBA_MIGRATION_DATABASE_URL) throw new Error("Falta SUTECBA_MIGRATION_DATABASE_URL (solo lectura).");
  const pool = new Pool({ connectionString: env.SUTECBA_MIGRATION_DATABASE_URL, max: 1 });
  try {
    await pool.query("set default_transaction_read_only = on");
    // Una sola foto consistente de todas las tablas.
    await pool.query("begin isolation level repeatable read read only");
    const dir = join(outRoot, `${value("label") ?? "backup"}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    if (existsSync(dir)) throw new Error("La carpeta de respaldo ya existe.");
    mkdirSync(dir, { recursive: true });
    const ident = (await pool.query("select current_database() as db")).rows[0];
    const system = (await pool.query("select system from sutecba_meta where id = true")).rows[0]?.system;
    const migrations = (await pool.query("select filename from sutecba_migrations order by filename")).rows.map((r) => r.filename as string);
    const tables = (await pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1")).rows.map((r) => r.table_name as string);
    const manifest: Record<string, { filas: number; sha256: string }> = {};
    for (const t of tables) {
      const rows = (await pool.query(`select * from public."${t}"`)).rows;
      const body = JSON.stringify(rows);
      writeFileSync(join(dir, `${t}.json`), body, { encoding: "utf-8", flag: "wx" });
      manifest[t] = { filas: rows.length, sha256: createHash("sha256").update(body).digest("hex") };
    }
    await pool.query("commit");
    writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ generado: new Date().toISOString(), database: ident.db, sistema: system, migraciones: migrations, tablas: manifest }, null, 2), { encoding: "utf-8", flag: "wx" });
    // Verificación: se relee cada archivo y se compara filas y hash con el manifiesto.
    let ok = true;
    for (const t of tables) {
      const body = readFileSync(join(dir, `${t}.json`), "utf-8");
      if (createHash("sha256").update(body).digest("hex") !== manifest[t]!.sha256 || (JSON.parse(body) as unknown[]).length !== manifest[t]!.filas) ok = false;
    }
    const required = ["people", "meetings", "meeting_participations", "person_interactions", "organizations", "organization_aliases", "users", "user_scopes", "import_batches", "import_files", "import_rows", "import_issues"];
    const missing = required.filter((t) => !(t in manifest));
    const manifestSha = createHash("sha256").update(readFileSync(join(dir, "MANIFEST.json"))).digest("hex");
    console.log(
      JSON.stringify(
        {
          directorio_fuera_de_git: dir,
          sistema: system,
          migraciones: migrations.length,
          tablas: tables.length,
          filas_totales: Object.values(manifest).reduce((a, b) => a + b.filas, 0),
          verificado_releyendo_cada_archivo: ok,
          tablas_requeridas_faltantes: missing,
          sha256_del_manifest: manifestSha,
          filas_clave: Object.fromEntries(required.filter((t) => t in manifest).map((t) => [t, manifest[t]!.filas])),
        },
        null,
        2
      )
    );
    if (!ok || missing.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[backup:logical] error: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
    process.exitCode = 1;
  });
}
