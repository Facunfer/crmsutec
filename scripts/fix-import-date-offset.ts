import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { applyDateOffsetFix, findDateOffset } from "../lib/imports/gabriel/fix-date-offset.js";
import { planFromSources } from "../lib/imports/gabriel/plan-hash.js";
import { assertApplyEnvironment, assertUuid, ImportAbortError } from "../lib/imports/gabriel/preflight.js";
import { loadExtracted, loadIdentityDecisions } from "./import-gabriel.js";

/**
 * Corrige el desfase de UN DÍA que el primer import histórico dejó en `people.birth_date` y `meetings.event_date`
 * (ver lib/imports/gabriel/fix-date-offset.ts). Nunca imprime datos personales: solo cantidades.
 *
 *   npm run import:fix-dates -- --identity-decisions <json> [--extracted data/gabriel/extracted]
 *       → DRY-RUN (solo lectura): cuántas fechas de personas y de reuniones se corregirían.
 *
 *   ... --apply --created-by <UUID MASTER_GLOBAL> --expect-people 681 --expect-meetings 22 --yes
 *       → una transacción; aborta si las cantidades no son exactamente las esperadas.
 */
async function main() {
  const argv = process.argv.slice(2);
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  const apply = argv.includes("--apply");
  const env = loadEnv();
  const files = loadExtracted(resolve(value("extracted") ?? "data/gabriel/extracted"));
  const decisions = value("identity-decisions") ? loadIdentityDecisions(resolve(value("identity-decisions")!)) : undefined;
  const { plan } = planFromSources(files, { identityDecisionRows: decisions?.rows });
  const db = await getDb();
  try {
    if (!apply) {
      console.log(JSON.stringify({ modo: "dry-run (solo lectura)", entorno: env.SUTECBA_ENV, ...(await findDateOffset(db, plan)) }, null, 2));
      return;
    }
    assertApplyEnvironment({ env, yes: argv.includes("--yes") });
    const num = (n: string) => (value(n) === undefined ? undefined : Number(value(n)));
    const result = await applyDateOffsetFix(db, plan, { createdBy: assertUuid(value("created-by"), "--created-by"), expectPeople: num("expect-people"), expectMeetings: num("expect-meetings") });
    console.log(JSON.stringify({ modo: "apply", entorno: env.SUTECBA_ENV, ...result }, null, 2));
  } finally {
    await closeDb();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[import:fix-dates] ${err instanceof ImportAbortError ? "ABORTADO" : "error"}: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
    process.exitCode = 1;
  });
}
