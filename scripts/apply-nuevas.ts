import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { assertApplyEnvironment, assertDatabasePreconditions, assertMasterActor, assertRuntimeRole, assertUuid, ImportAbortError } from "../lib/imports/gabriel/preflight.js";
import { buildNuevasPlanWithDecisions, NUEVAS_CODES } from "../lib/imports/gabriel/nuevas.js";
import { runNuevasImport, type NuevasApplyResult } from "../lib/imports/gabriel/nuevas-apply.js";
import type { ExtractedFile } from "../lib/imports/gabriel/types.js";
import { loadIdentityDecisions } from "./import-gabriel.js";
import { readNuevasContext } from "./import-nuevas-dry-run.js";

/**
 * APPLY del segundo lote de Gabriel (nuevas bases). Envoltura segura: SOLO parsea/valida argumentos, carga los
 * mismos inputs que `npm run import:nuevas` (dry-run) y llama a `runNuevasImport()` (lib/imports/gabriel/nuevas-apply.ts),
 * que ya tiene toda la lógica de negocio (dedup, identidad, staging, provenance, interacciones). Este script no
 * reimplementa nada de eso.
 *
 *   npm run import:nuevas:apply -- --apply --yes --confirm-plan <hash> --created-by <uuid> --owner-organization-id <uuid>
 *       --identity-decisions <json> [--extracted data/gabriel-nuevas/extracted] [--f07 data/gabriel/extracted/F07.json]
 *
 * Sin --apply: NO escribe nada (falla con un mensaje claro). `npm run import:nuevas` (import-nuevas-dry-run.ts) sigue
 * siendo el único dry-run silencioso; este script exige --apply explícito incluso para reconstruir el plan.
 */

export interface ApplyNuevasArgs {
  apply: boolean;
  yes: boolean;
  confirmPlan?: string;
  createdBy?: string;
  ownerOrganizationId?: string;
  extractedDir: string;
  f07Path: string;
  identityDecisionsPath?: string;
  identityDecisionsXlsx?: string;
}

function loadNuevas(dir: string): ExtractedFile[] {
  return NUEVAS_CODES.map((code) => {
    const path = resolve(dir, `${code}.json`);
    if (!existsSync(path)) throw new ImportAbortError(`Falta ${code}.json en ${dir}.`);
    return JSON.parse(readFileSync(path, "utf-8")) as ExtractedFile;
  });
}

export function parseApplyNuevasArgs(argv: string[]): ApplyNuevasArgs {
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  return {
    apply: argv.includes("--apply"),
    yes: argv.includes("--yes"),
    confirmPlan: value("confirm-plan"),
    createdBy: value("created-by"),
    ownerOrganizationId: value("owner-organization-id"),
    extractedDir: resolve(value("extracted") ?? "data/gabriel-nuevas/extracted"),
    f07Path: resolve(value("f07") ?? "data/gabriel/extracted/F07.json"),
    identityDecisionsPath: value("identity-decisions"),
    identityDecisionsXlsx: value("identity-decisions-xlsx"),
  };
}

/**
 * Núcleo testeable (sin argv ni closeDb, para poder llamarlo desde tests de integración contra PGlite). El CLI
 * (`main`, más abajo) es una envoltura delgada sobre esto.
 */
export async function runApplyNuevas(args: ApplyNuevasArgs): Promise<NuevasApplyResult> {
  // 1. Validación de argumentos, ANTES de tocar la base.
  if (!args.apply) throw new ImportAbortError("Este script requiere --apply explícito (para dry-run usá `npm run import:nuevas`).");
  if (!args.yes) throw new ImportAbortError("--apply exige --yes explícito.");
  if (!args.confirmPlan) throw new ImportAbortError("--apply exige --confirm-plan <PLAN_HASH> (el que imprimió el dry-run).");
  const createdBy = assertUuid(args.createdBy, "--created-by");
  const ownerOrganizationId = assertUuid(args.ownerOrganizationId, "--owner-organization-id");
  if (!args.identityDecisionsPath) throw new ImportAbortError("--apply exige --identity-decisions <json> (extracto de las decisiones aprobadas).");
  if (!existsSync(args.f07Path)) throw new ImportAbortError(`Falta el padrón F07 en ${args.f07Path} (necesario para reconciliar N01).`);
  if (!existsSync(args.identityDecisionsPath)) throw new ImportAbortError(`Falta el archivo de decisiones en ${args.identityDecisionsPath}.`);

  const env = loadEnv();
  assertApplyEnvironment({ env, yes: args.yes });

  const db = await getDb();
  const runtime = await assertRuntimeRole(db, env);
  await assertDatabasePreconditions(db, env);
  await db.transaction().execute((trx) => assertMasterActor(trx, createdBy));

  // 2. Cargar EXACTAMENTE los mismos inputs que el dry-run.
  const files = loadNuevas(args.extractedDir);
  const f07 = JSON.parse(readFileSync(args.f07Path, "utf-8")) as ExtractedFile;
  const loaded = loadIdentityDecisions(resolve(args.identityDecisionsPath), args.identityDecisionsXlsx ? resolve(args.identityDecisionsXlsx) : undefined);

  // 3. Reconstruir y revalidar el plan ANTES de abrir escritura (además de la verificación interna de runNuevasImport).
  const { idByOfficialCode: _i, ...ctxBase } = await readNuevasContext(db, f07);
  const { plan } = buildNuevasPlanWithDecisions(files, ctxBase, loaded.rows);
  if (plan.planHash !== args.confirmPlan) {
    throw new ImportAbortError(`El plan recalculado (${plan.planHash}) no coincide con --confirm-plan (${args.confirmPlan}). ABORTADO antes de escribir.`);
  }

  console.log(`[import:nuevas:apply] entorno=${env.SUTECBA_ENV} rol=${runtime.role} plan_hash=${plan.planHash}`);

  // 4. Apply real — toda la lógica de negocio vive en runNuevasImport.
  return runNuevasImport(db, files, f07, {
    ownerOrganizationId,
    createdBy,
    confirmedPlanHash: args.confirmPlan,
    identityDecisionRows: loaded.rows,
    identityDecisionSource: { fileName: loaded.source.fileName, sha256: loaded.source.sha256 },
  });
}

async function main() {
  const args = parseApplyNuevasArgs(process.argv.slice(2));
  const result = await runApplyNuevas(args);

  // 5. Resultado sin PII (solo cantidades, códigos y hashes).
  console.log(
    JSON.stringify(
      {
        outcome: result.outcome,
        plan_hash: result.planHash,
        runtime_role: result.runtimeRole,
        batch_id: result.batchId,
        files_inserted: result.filesInserted,
        rows_inserted: result.rowsInserted,
        rows_already_imported: result.rowsAlreadyImported,
        issues_inserted: result.issuesInserted,
        entity_links_inserted: result.entityLinksInserted,
        people_created: result.peopleCreated,
        people_linked_to_existing: result.peopleLinkedToExisting,
        meetings_created: result.meetingsCreated,
        meetings_existing: result.meetingsExisting,
        participations_created: result.participationsCreated,
        participations_already_existing: result.participationsAlreadyExisting,
        interactions_created: result.interactionsCreated,
      },
      null,
      2
    )
  );

  // 6. Cerrar conexión.
  await closeDb();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[import:nuevas:apply] ${err instanceof ImportAbortError ? "ABORTADO" : "error"}: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
    process.exitCode = 1;
  });
}
