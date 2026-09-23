import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { assertApplyEnvironment, assertUuid, ImportAbortError } from "../lib/imports/gabriel/preflight.js";
import { applyCatalog, dryRunAgainstDatabase } from "../lib/organizations/catalog/apply.js";
import { APPROVED_ADDITIONS } from "../lib/organizations/catalog/approved-additions.js";
import { APPROVED_ORG_ADDITIONS } from "../lib/organizations/catalog/approved-org-additions.js";
import { planCatalogFromSource, type CatalogPlan } from "../lib/organizations/catalog/plan.js";
import type { OrgCatalog } from "../lib/organizations/catalog/types.js";

/**
 * Carga de la estructura organizacional (organizations) y de los alias AUTO_MAP (organization_aliases).
 *
 *   npm run org:catalog -- [--catalog data/org-catalog/catalog.json] [--report-dir data/org-catalog/reports] [--db]
 *       DRY-RUN (por defecto). Sin --db: solo el archivo (sin base). Con --db: lee la base en una transacción
 *       READ ONLY con SUTECBA_DATABASE_URL (sutecba_app) y calcula qué se crearía / ya existe / conflictúa.
 *
 *   npm run org:catalog -- --apply --confirm-plan <PLAN_HASH> --created-by <UUID> --xlsx <catálogo.xlsx> [--yes]
 *       APPLY: mismas protecciones que el importador de Gabriel (hash del plan, SHA-256 del .xlsx original,
 *       rol runtime, identidad de la base/migraciones, actor MASTER_GLOBAL, una transacción con lock).
 */

function parseArgs(argv: string[]) {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  return {
    apply: argv.includes("--apply"),
    db: argv.includes("--db"),
    yes: argv.includes("--yes"),
    catalog: resolve(value("catalog") ?? "data/org-catalog/catalog.json"),
    reportDir: resolve(value("report-dir") ?? "data/org-catalog/reports"),
    xlsx: value("xlsx") ? resolve(value("xlsx")!) : undefined,
    confirmPlan: value("confirm-plan"),
    createdBy: value("created-by"),
  };
}

export const redact = (text: string) => text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/postgres(ql)?:\/\/\S+/gi, "[url]");

export function toReport(plan: CatalogPlan, planHash: string, mode: string) {
  return {
    generado: new Date().toISOString(),
    modo: mode,
    plan_hash: planHash,
    catalogo: plan.catalog,
    conteos: plan.counts,
    tipos_a_crear: plan.types.toCreate,
    organizaciones_a_crear_por_tipo: plan.organizations.toCreate.reduce<Record<string, number>>((acc, o) => ((acc[o.typeKey] = (acc[o.typeKey] ?? 0) + 1), acc), {}),
    organizaciones_a_crear_por_profundidad: plan.organizations.toCreate.reduce<Record<string, number>>((acc, o) => ((acc[String(o.depth)] = (acc[String(o.depth)] ?? 0) + 1), acc), {}),
    organizaciones_ya_existentes: plan.organizations.existing.length,
    familias_de_homonimos: plan.families,
    aliases_contextuales_a_crear: plan.aliases.toCreate.filter((a) => a.contextKey).map((a) => ({ alias: a.alias, contexto: a.contextKey, organizacion: a.organizationKey, origen: a.origin })),
    aliases_ambiguos: plan.aliases.ambiguous,
    aliases_no_cargados_por_tipo: plan.aliases.notLoaded,
    areas_internas: {
      total: plan.areaAliases.total,
      auto_map_area: plan.areaAliases.autoMapArea,
      por_estado: plan.areaAliases.byState,
      catalogadas_como_organizacion: plan.areaAliases.catalogedAsOrganization,
      conservadas_como_dato_de_origen: plan.areaAliases.preservedAsSourceData,
    },
    problemas: plan.issues,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = JSON.parse(readFileSync(args.catalog, "utf-8")) as OrgCatalog;
  const source = planCatalogFromSource(catalog, APPROVED_ADDITIONS, APPROVED_ORG_ADDITIONS);

  if (!args.apply) {
    let plan = source.plan;
    let mode = "dry-run sin base (solo el archivo)";
    if (args.db) {
      const env = loadEnv();
      const db = await getDb();
      try {
        // Solo lectura: una transacción READ ONLY con la conexión runtime (sutecba_app). No escribe nada.
        plan = (await dryRunAgainstDatabase(db, catalog, APPROVED_ADDITIONS, APPROVED_ORG_ADDITIONS)).plan;
        mode = `dry-run contra la base (solo lectura), entorno=${env.SUTECBA_ENV}`;
      } finally {
        await closeDb();
      }
    }
    mkdirSync(args.reportDir, { recursive: true });
    const target = join(args.reportDir, `dry-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(target, JSON.stringify(toReport(plan, source.planHash, mode), null, 2), "utf-8");
    console.log(JSON.stringify(plan.counts, null, 2));
    console.log(`[org-catalog] ${mode}`);
    console.log(`[org-catalog] plan_hash: ${source.planHash}`);
    console.log(`[org-catalog] informe: ${target}`);
    return;
  }

  // ---------------------------------------------------------------- APPLY
  if (!args.confirmPlan) throw new ImportAbortError("--apply requiere --confirm-plan <PLAN_HASH> (el que imprimió el dry-run).");
  if (args.confirmPlan !== source.planHash) throw new ImportAbortError("--confirm-plan no coincide con el plan_hash de este catálogo: no se aplica nada.");
  const createdBy = assertUuid(args.createdBy, "--created-by");
  if (!args.xlsx) throw new ImportAbortError("--apply requiere --xlsx con el catálogo original para verificar su SHA-256.");
  if (createHash("sha256").update(readFileSync(args.xlsx)).digest("hex") !== catalog.sha256) {
    throw new ImportAbortError("El .xlsx cambió desde la extracción (SHA-256 distinto). Repetí la extracción y el dry-run.");
  }
  const env = loadEnv();
  assertApplyEnvironment({ env, yes: args.yes });
  console.log(`[org-catalog] APPLY entorno=${env.SUTECBA_ENV} plan_hash=${source.planHash}`);
  // Nunca activateMigrationConnection(): se escribe con SUTECBA_DATABASE_URL (rol sutecba_app).
  const db = await getDb();
  try {
    const result = await applyCatalog(db, catalog, { createdBy, confirmedPlanHash: args.confirmPlan, additions: APPROVED_ADDITIONS, organizationAdditions: APPROVED_ORG_ADDITIONS });
    console.log(JSON.stringify({ resultado: result.outcome, rol_de_escritura: result.runtimeRole, resumen: result.summary }, null, 2));
  } finally {
    await closeDb();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[org-catalog] ${err instanceof ImportAbortError ? "ABORTADO" : "error"}: ${redact(message)}`);
    process.exitCode = 1;
  });
}
