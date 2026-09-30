/* Backup independiente con pg_dump/pg_dumpall (client tools portables). SOLO LECTURA. No imprime credenciales.
 *   node scripts/backup-pgdump.cjs --bin <carpeta con pg_dump.exe> --out-dir <carpeta privada fuera del repo> [--label pre-tandas]
 */
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i + 1] : undefined; };
const bin = arg("bin"), outRoot = arg("out-dir"), label = arg("label") || "supabase-pre-tandas";
if (!bin || !outRoot) throw new Error("Faltan --bin y --out-dir");
if (!path.relative(process.cwd(), path.resolve(outRoot)).startsWith("..")) throw new Error("El backup debe quedar FUERA del repositorio.");
const u = new URL(process.env.SUTECBA_MIGRATION_DATABASE_URL);
const env = { ...process.env, PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1), PGSSLMODE: "require", PGOPTIONS: "-c default_transaction_read_only=on" };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = path.join(outRoot, `${label}-${stamp}`);
fs.mkdirSync(dir, { recursive: true });
const run = (exe, args, outFile) => {
  const r = spawnSync(path.join(bin, exe), args, { env, encoding: "utf-8", maxBuffer: 1 << 30 });
  const err = (r.stderr || "").replace(/postgres(ql)?:\/\/\S+/gi, "[url]").split("\n").filter((l) => !/password/i.test(l)).slice(0, 6).join(" | ");
  return { exe, ok: r.status === 0, status: r.status, stderr: err, outFile };
};
const steps = [
  run("pg_dump.exe", ["--schema-only", "--schema=public", "--no-owner", "--file", path.join(dir, "schema-public.sql")], "schema-public.sql"),
  run("pg_dump.exe", ["--data-only", "--schema=public", "--format=custom", "--no-owner", "--file", path.join(dir, "data-public.dump")], "data-public.dump"),
  run("pg_dump.exe", ["--schema=public", "--format=custom", "--file", path.join(dir, "full-public.dump")], "full-public.dump"),
  run("pg_dumpall.exe", ["--roles-only", "--no-role-passwords", "--file", path.join(dir, "roles.sql")], "roles.sql"),
];
const files = {};
for (const f of fs.readdirSync(dir)) { const b = fs.readFileSync(path.join(dir, f)); files[f] = { bytes: b.length, sha256: createHash("sha256").update(b).digest("hex") }; }
const version = spawnSync(path.join(bin, "pg_dump.exe"), ["--version"], { encoding: "utf-8" }).stdout.trim();
const manifest = {
  generado: new Date().toISOString(), herramienta: version, servidor_postgres: "17.x (Supabase)", base: u.pathname.slice(1), host_clase: u.hostname.replace(/^[^.]+\./, "*."),
  alcance: { esquema: "public", roles: "pg_dumpall --roles-only --no-role-passwords (si el rol de migración puede leerlos)", no_incluye: ["schemas auth/storage/realtime/extensions de Supabase", "contraseñas de roles", "configuración del proyecto", "Edge Functions / secretos"] },
  pasos: steps.map((s) => ({ archivo: s.outFile, ok: s.ok, status: s.status, error: s.ok ? undefined : s.stderr })), archivos: files,
};
fs.writeFileSync(path.join(dir, "MANIFEST-pgdump.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ directorio: dir, ...manifest }, null, 2));
if (steps.some((s) => !s.ok && s.outFile !== "roles.sql")) process.exitCode = 1;
