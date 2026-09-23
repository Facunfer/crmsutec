import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { applyLegacyReconciliation, DEFAULT_LEGACY_SOURCE_SYSTEM, planLegacyReconciliation } from "../lib/interactions/legacy-reconciliation.js";
import { assertApplyEnvironment, assertDatabasePreconditions, assertRuntimeRole, ImportAbortError } from "../lib/imports/gabriel/preflight.js";

/**
 * Reconciliación de las participaciones de la carga histórica inicial (decisión de negocio: ver migración 0028 y
 * lib/interactions/legacy-reconciliation.ts). Dry-run por defecto; requiere --apply, --yes y --created-by para
 * escribir. Transaccional, idempotente (segunda corrida: 0 cambios).
 *
 *   npm run legacy:reconcile-participations -- [--source-system gabriel-historical] [--apply --yes --created-by <uuid>]
 */
async function main() {
  const argv = process.argv.slice(2);
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  const sourceSystem = value("source-system") ?? DEFAULT_LEGACY_SOURCE_SYSTEM;
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
    const plan = await planLegacyReconciliation(db, { sourceSystem });
    console.log(JSON.stringify({ modo: "dry_run", ...plan }, null, 2));
  } else {
    const result = await applyLegacyReconciliation(db, { sourceSystem, actorUserId: createdBy! });
    console.log(JSON.stringify({ modo: "apply", ...result }, null, 2));
  }
  await closeDb();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[legacy:reconcile-participations] ${err instanceof ImportAbortError ? "ABORTADO" : "error"}: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
    process.exitCode = 1;
  });
}
