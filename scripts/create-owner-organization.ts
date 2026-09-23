import { sql } from "kysely";
import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { assertApplyEnvironment, assertUuid, ImportAbortError } from "../lib/imports/gabriel/preflight.js";
import { ensureOwnerOrganization, OWNER_ORGANIZATION, planOwnerOrganization, readOwnerOrganizationState } from "../lib/organizations/owner-organization.js";

/**
 * Crea la organización RAÍZ del sindicato (SUTECBA) y su tipo `sindicato`, si no existen.
 *
 *   npm run org:owner                                        → dry-run (lee la base en una transacción READ ONLY)
 *   npm run org:owner -- --apply --created-by <UUID> --yes   → crea (rol sutecba_app, una transacción con lock)
 */
async function main() {
  const argv = process.argv.slice(2);
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  const env = loadEnv();
  const db = await getDb();
  try {
    if (!argv.includes("--apply")) {
      const state = await db.transaction().execute(async (trx) => {
        await sql`set transaction read only`.execute(trx);
        return readOwnerOrganizationState(trx);
      });
      const plan = planOwnerOrganization(state);
      console.log(JSON.stringify({ modo: "dry-run (solo lectura)", entorno: env.SUTECBA_ENV, organizacion: OWNER_ORGANIZATION, existe: Boolean(state.organization), ...plan }, null, 2));
      return;
    }
    const createdBy = assertUuid(value("created-by"), "--created-by");
    assertApplyEnvironment({ env, yes: argv.includes("--yes") });
    const result = await ensureOwnerOrganization(db, { createdBy });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeDb();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[org-owner] ${err instanceof ImportAbortError ? "ABORTADO" : "error"}: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
    process.exitCode = 1;
  });
}
