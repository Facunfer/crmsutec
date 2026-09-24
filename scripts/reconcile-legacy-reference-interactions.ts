import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { applyLegacyReferenceInteractions, planLegacyReferenceInteractions } from "../lib/interactions/legacy-reference-interactions.js";
import { assertApplyEnvironment, assertDatabasePreconditions, assertRuntimeRole, ImportAbortError } from "../lib/imports/gabriel/preflight.js";

/**
 * Reconciliación de INTERACCIONES faltantes de la carga histórica inicial (decisión de negocio SUTECBA 2026-09-23,
 * ver lib/interactions/legacy-reference-interactions.ts y migración 0029). Dry-run por defecto (SOLO LECTURA);
 * requiere --apply, --yes y --created-by para escribir. Transaccional, idempotente (segunda corrida: 0 cambios).
 * Cubre los dos lotes históricos ya integrados, seleccionados por procedencia real, nunca por un WHERE genérico.
 *
 *   npm run legacy:reconcile-interactions -- [--apply --yes --created-by <uuid>]
 */
async function main() {
  const argv = process.argv.slice(2);
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  const apply = argv.includes("--apply");
  const yes = argv.includes("--yes");
  const createdBy = value("created-by");

  const env = loadEnv();
  if (apply) {
    assertApplyEnvironment({ env, yes });
    if (!yes) throw new ImportAbortError("--apply exige --yes explícito.");
    if (!createdBy) throw new ImportAbortError("--apply exige --created-by <uuid>.");
  }

  const db = await getDb();
  await assertRuntimeRole(db, env);
  await assertDatabasePreconditions(db, env);

  if (!apply) {
    const plan = await planLegacyReferenceInteractions(db);
    console.log(JSON.stringify({ modo: "dry_run", ...plan }, null, 2));
  } else {
    const result = await applyLegacyReferenceInteractions(db, { actorUserId: createdBy! });
    console.log(JSON.stringify({ modo: "apply", ...result }, null, 2));
  }
  await closeDb();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[legacy:reconcile-interactions] ${err instanceof ImportAbortError ? "ABORTADO" : "error"}: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
    process.exitCode = 1;
  });
}
