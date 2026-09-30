import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { runTandasImport, type TandasApplyResult } from "../lib/imports/tandas/apply.js";
import { assertApplyEnvironment, assertUuid, ImportAbortError } from "../lib/imports/gabriel/preflight.js";
import type { ExtractedFile } from "../lib/imports/gabriel/types.js";
import { TANDA_CODES } from "../lib/imports/tandas/sources.js";

/**
 * APPLY de las tandas 1 y 2 (22 fuentes). Envoltura segura: valida argumentos y llama a `runTandasImport()`.
 * Sin --apply NO escribe nada. Requiere las migraciones 0031–0033 ya aplicadas.
 *
 *   npx tsx scripts/apply-tandas.ts --apply --yes --confirm-plan <hash> --created-by <uuid> --owner-organization-id <uuid>
 *       [--expect-people N] [--expect-participations N] [--extracted data/tandas/extracted] [--sources <carpeta con los originales>]
 *
 * Es reanudable: si una corrida falla a mitad, repetir el MISMO comando continúa donde quedó (todas las fases son idempotentes).
 */
export interface ApplyTandasArgs {
  apply: boolean;
  yes: boolean;
  confirmPlan?: string;
  createdBy?: string;
  ownerOrganizationId?: string;
  extractedDir: string;
  sourcesDir?: string;
  expectPeople?: number;
  expectParticipations?: number;
}

export function parseApplyTandasArgs(argv: string[]): ApplyTandasArgs {
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  const num = (n: string) => (value(n) === undefined ? undefined : Number(value(n)));
  return {
    apply: argv.includes("--apply"), yes: argv.includes("--yes"), confirmPlan: value("confirm-plan"), createdBy: value("created-by"), ownerOrganizationId: value("owner-organization-id"),
    extractedDir: resolve(value("extracted") ?? "data/tandas/extracted"), sourcesDir: value("sources") ? resolve(value("sources")!) : undefined, expectPeople: num("expect-people"), expectParticipations: num("expect-participations"),
  };
}

export async function runApplyTandas(args: ApplyTandasArgs): Promise<TandasApplyResult> {
  if (!args.apply) throw new ImportAbortError("Este script requiere --apply explícito (para dry-run usá scripts/import-tandas-dry-run.ts).");
  if (!args.yes) throw new ImportAbortError("--apply exige --yes explícito.");
  if (!args.confirmPlan) throw new ImportAbortError("--apply exige --confirm-plan <PLAN_HASH> (el del dry-run aprobado).");
  const createdBy = assertUuid(args.createdBy, "--created-by");
  const ownerOrganizationId = assertUuid(args.ownerOrganizationId, "--owner-organization-id");
  const env = loadEnv();
  assertApplyEnvironment({ env, yes: args.yes });

  const files = TANDA_CODES.map((code) => {
    const p = join(args.extractedDir, `${code}.json`);
    if (!existsSync(p)) throw new ImportAbortError(`Falta ${code}.json en ${args.extractedDir}.`);
    return JSON.parse(readFileSync(p, "utf-8")) as ExtractedFile;
  });
  if (args.sourcesDir) {
    for (const f of files) {
      const p = join(args.sourcesDir, f.fileName);
      if (!existsSync(p)) throw new ImportAbortError(`No se encuentra el original de ${f.fileCode}.`);
      if (createHash("sha256").update(readFileSync(p)).digest("hex") !== f.sha256) throw new ImportAbortError(`El original de ${f.fileCode} cambió desde la extracción (SHA-256 distinto).`);
    }
  }
  const db = await getDb();
  console.log(`[tandas:apply] entorno=${env.SUTECBA_ENV} plan_hash=${args.confirmPlan}`);
  return runTandasImport(db, files, {
    ownerOrganizationId, createdBy, confirmedPlanHash: args.confirmPlan, expectPeople: args.expectPeople, expectParticipations: args.expectParticipations,
  });
}

async function main() {
  const result = await runApplyTandas(parseApplyTandasArgs(process.argv.slice(2)));
  console.log(JSON.stringify({ outcome: result.outcome, batch_id: result.batchId, plan_hash: result.planHash, summary: result.summary }, null, 2));
  await closeDb();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[tandas:apply] ${err instanceof ImportAbortError ? "ABORTADO" : "error"}: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
    process.exitCode = 1;
  });
}
