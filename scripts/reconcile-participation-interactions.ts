import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { syncParticipationInteractions, type ParticipationSyncResult } from "../lib/interactions/participation-sync.js";
import { assertApplyEnvironment, assertMasterActor, assertUuid, ImportAbortError } from "../lib/imports/gabriel/preflight.js";

/**
 * Genera las interacciones automáticas de participaciones ya confirmadas (idempotente).
 *
 *   npm run interactions:reconcile                                   → DRY-RUN: cuenta lo que crearía y hace ROLLBACK
 *   npm run interactions:reconcile -- --apply --created-by <UUID> --yes
 */
async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const i = argv.indexOf("--created-by");
  const env = loadEnv();
  const db = await getDb();
  try {
    if (apply) assertApplyEnvironment({ env, yes: argv.includes("--yes") });
    const createdBy = apply ? assertUuid(argv[i + 1], "--created-by") : null;
    const rollback = new Error("rollback-dry-run");
    let result: ParticipationSyncResult | null = null;
    try {
      await db.transaction().execute(async (trx) => {
        if (createdBy) await assertMasterActor(trx, createdBy);
        const actor = createdBy ?? (await sql<{ id: string }>`select id from users order by created_at limit 1`.execute(trx)).rows[0]?.id ?? null;
        result = await syncParticipationInteractions(trx, { actorUserId: actor });
        if (!apply) throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
    }
    console.log(JSON.stringify({ modo: apply ? "apply" : "dry-run (rollback: no se escribió nada)", entorno: env.SUTECBA_ENV, ...(result as ParticipationSyncResult | null) }, null, 2));
  } finally {
    await closeDb();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[interactions:reconcile] ${err instanceof ImportAbortError ? "ABORTADO" : "error"}: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
    process.exitCode = 1;
  });
}
