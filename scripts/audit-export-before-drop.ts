import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { loadEnv } from "../lib/db/env.js";

/**
 * Exporta (SOLO LECTURA) el contenido de `audit_logs` a un JSON FUERA de Git, antes de aprobar la migración 0025
 * (que elimina la tabla). Imprime cantidad de filas, resumen por acción y SHA-256; no imprime el contenido.
 *
 *   npm run audit:export-before-drop -- --out "C:\Users\usuario\Documents\sutecba-fuentes\backups\audit_logs.json"
 */
async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--out");
  const out = i !== -1 ? resolve(argv[i + 1] ?? "") : undefined;
  if (!out) throw new Error("Falta --out <archivo.json>.");
  const rel = relative(process.cwd(), out);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error("El archivo debe quedar FUERA del repositorio.");
  if (existsSync(out)) throw new Error("El archivo ya existe: no se sobrescribe.");
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.SUTECBA_MIGRATION_DATABASE_URL ?? env.SUTECBA_DATABASE_URL, max: 1 });
  try {
    await pool.query("set default_transaction_read_only = on");
    const table = await pool.query("select to_regclass('public.audit_logs') as t");
    if (!table.rows[0]?.t) {
      console.log(JSON.stringify({ existe_audit_logs: false }));
      return;
    }
    const rows = (await pool.query("select * from public.audit_logs order by created_at, id")).rows;
    const body = JSON.stringify(rows, null, 1);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, body, { encoding: "utf-8", flag: "wx" });
    const porAccion: Record<string, number> = {};
    for (const r of rows) porAccion[r.action] = (porAccion[r.action] ?? 0) + 1;
    console.log(JSON.stringify({ archivo: out, filas: rows.length, por_accion: porAccion, sha256: createHash("sha256").update(body).digest("hex") }, null, 2));
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[audit-export] error: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
    process.exitCode = 1;
  });
}
