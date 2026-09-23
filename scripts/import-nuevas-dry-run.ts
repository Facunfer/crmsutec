import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { loadOrganizationContext } from "../lib/imports/gabriel/apply.js";
import { buildNuevasPlanWithDecisions, NUEVAS_CODES, type NuevasContext } from "../lib/imports/gabriel/nuevas.js";
import { ImportAbortError } from "../lib/imports/gabriel/preflight.js";
import type { ExtractedFile } from "../lib/imports/gabriel/types.js";
import { dryRunAgainstDatabase } from "../lib/organizations/catalog/apply.js";
import { APPROVED_ADDITIONS } from "../lib/organizations/catalog/approved-additions.js";
import { APPROVED_ORG_ADDITIONS } from "../lib/organizations/catalog/approved-org-additions.js";
import { simulateCatalogOrgContext } from "../lib/organizations/catalog/simulate.js";
import type { OrgCatalog } from "../lib/organizations/catalog/types.js";
import { loadIdentityDecisions, redact } from "./import-gabriel.js";

/**
 * DRY-RUN de las nuevas bases de Gabriel (2026-09-22). SOLO LECTURA: lee la base en transacciones READ ONLY y no
 * escribe nada. Nunca imprime DNI, nombres, emails ni teléfonos: solo cantidades, textos de organismo y hashes.
 *
 *   npm run import:nuevas -- [--extracted data/gabriel-nuevas/extracted] [--sources <carpeta con los PDF>]
 *       [--catalog data/org-catalog/catalog.json] [--identity-decisions <json>] [--report-dir ...]
 *
 * `--sources`: recalcula el SHA-256 de cada PDF original contra el extracto.
 * `--catalog`: si se indica, simula (en memoria) el catálogo ampliado — organizaciones y alias aprobados en
 *   approved-org-additions.ts/approved-additions.ts que TODAVÍA no están en Supabase — para proyectar cómo quedaría
 *   la resolución de organismos una vez cargado. Sin `--catalog`, usa tal cual el catálogo YA aplicado en la base.
 * `--identity-decisions`: extracto (tools/identity-decisions-extract.py) de las decisiones humanas sobre las
 *   identidades que ESTE lote bloquea. Sin él, esas identidades siguen bloqueadas y el plan no cambia.
 */
function loadNuevas(dir: string): ExtractedFile[] {
  return NUEVAS_CODES.map((code) => {
    const path = join(dir, `${code}.json`);
    if (!existsSync(path)) throw new ImportAbortError(`Falta ${code}.json en ${dir}. Corré tools/gabriel-extract-nuevas.py.`);
    return JSON.parse(readFileSync(path, "utf-8")) as ExtractedFile;
  });
}

/** Foto de SOLO LECTURA de la base para el dry-run: personas, reuniones, participaciones, alias/jerarquía y códigos. */
export async function readNuevasContext(db: Awaited<ReturnType<typeof getDb>>, f07: ExtractedFile | null): Promise<NuevasContext & { idByOfficialCode: Map<string, string> }> {
  return db.transaction().execute(async (trx) => {
    await sql`set transaction read only`.execute(trx);
    const people = await sql<{ dni: string; first_name: string; last_name: string; email: string | null; phone: string | null; cuil_cuit: string | null; organization_id: string | null; b: string | null }>`
      select dni, first_name, last_name, email, phone, cuil_cuit, organization_id, to_char(birth_date, 'YYYY-MM-DD') as b from people where status <> 'merged'
    `.execute(trx);
    const meetings = await sql<{ k: string; p: string; d: string | null }>`
      select source_event_key as k, schedule_precision as p, to_char(event_date, 'YYYY-MM-DD') as d from meetings where source_event_key is not null
    `.execute(trx);
    const parts = await sql<{ campaign_key: string | null; key: string | null; dni: string; kind: string }>`
      select mp.campaign_key, m.source_event_key as key, p.dni, mp.participation_kind as kind
      from meeting_participations mp join people p on p.id = mp.person_id left join meetings m on m.id = mp.meeting_id
    `.execute(trx);
    const org = await loadOrganizationContext(trx);
    const codes = await sql<{ id: string; official_code: string }>`select id, official_code from organizations where official_code is not null`.execute(trx);
    return {
      people: people.rows.map((r) => ({ dni: r.dni, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone, cuil: r.cuil_cuit, organizationId: r.organization_id, birthDate: r.b })),
      meetings: meetings.rows.map((r) => ({ key: r.k, precision: r.p, date: r.d })),
      participations: new Set(parts.rows.map((r) => (r.campaign_key ? `campaign|${r.campaign_key}|${r.dni}` : `meeting|${r.key}|${r.dni}`))),
      aliases: org.organizationAliases,
      organizationParents: org.organizationParents,
      f07,
      idByOfficialCode: new Map(codes.rows.map((r) => [r.official_code, r.id])),
      organizationCodeById: new Map(codes.rows.map((r) => [r.id, r.official_code])),
    };
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  const files = loadNuevas(resolve(value("extracted") ?? "data/gabriel-nuevas/extracted"));
  const sources = value("sources");
  if (sources) {
    for (const f of files) {
      const path = join(resolve(sources), f.fileName);
      if (!existsSync(path)) throw new ImportAbortError(`No se encuentra el original de ${f.fileCode}.`);
      if (createHash("sha256").update(readFileSync(path)).digest("hex") !== f.sha256) throw new ImportAbortError(`El original de ${f.fileCode} cambió (SHA-256 distinto).`);
    }
  }
  const f07Path = resolve(value("f07") ?? "data/gabriel/extracted/F07.json");
  const f07 = existsSync(f07Path) ? (JSON.parse(readFileSync(f07Path, "utf-8")) as ExtractedFile) : null;
  const loaded = value("identity-decisions") ? loadIdentityDecisions(resolve(value("identity-decisions")!), value("identity-decisions-xlsx") ? resolve(value("identity-decisions-xlsx")!) : undefined) : undefined;
  const catalogPath = value("catalog");

  const env = loadEnv();
  const db = await getDb();
  try {
    const { idByOfficialCode, ...ctxBase } = await readNuevasContext(db, f07);
    let ctx: NuevasContext = ctxBase;
    let catalogSimulation: Record<string, unknown> | null = null;
    if (catalogPath) {
      const catalog = JSON.parse(readFileSync(resolve(catalogPath), "utf-8")) as OrgCatalog;
      const { plan: catalogPlan, planHash: catalogPlanHash } = await dryRunAgainstDatabase(db, catalog, APPROVED_ADDITIONS, APPROVED_ORG_ADDITIONS);
      if ((catalogPlan.counts.errores ?? 0) > 0) throw new ImportAbortError(`El catálogo ampliado tiene ${catalogPlan.counts.errores} error(es): no se simula.`);
      const sim = simulateCatalogOrgContext(catalogPlan, { aliases: ctxBase.aliases, organizationParents: ctxBase.organizationParents ?? new Map(), idByOfficialCode });
      ctx = { ...ctxBase, aliases: sim.aliases, organizationParents: sim.organizationParents };
      catalogSimulation = {
        plan_hash: catalogPlanHash,
        organizaciones_nuevas: catalogPlan.organizations.toCreate.map((o) => ({ codigo: o.key, nombre: o.name, tipo: o.typeKey, padre: o.parentKey, profundidad: o.depth })),
        aliases_nuevos: catalogPlan.aliases.toCreate.length,
        errores: catalogPlan.counts.errores,
      };
    }

    const { plan, decisions } = buildNuevasPlanWithDecisions(files, ctx, loaded?.rows);
    const out = {
      generado: new Date().toISOString(),
      modo: "dry-run (solo lectura; no se escribió nada)",
      entorno: env.SUTECBA_ENV,
      base_actual: { personas: ctxBase.people.length, reuniones: ctxBase.meetings.length },
      catalogo_simulado: catalogSimulation,
      identity_decisions_file: loaded ? { archivo: loaded.source.fileName, sha256: loaded.source.sha256, decisiones: decisions?.length ?? 0 } : null,
      plan_hash: plan.planHash,
      ...plan.report,
    };
    const dir = resolve(value("report-dir") ?? "data/gabriel-nuevas/reports");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `dry-run-nuevas-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(target, JSON.stringify(out, null, 2), "utf-8");
    console.log(JSON.stringify(out, null, 2));
    console.log(`[import:nuevas] informe sin datos personales: ${target}`);
  } finally {
    await closeDb();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[import:nuevas] ${err instanceof ImportAbortError ? "ABORTADO" : "error"}: ${redact(String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]"))}`);
    process.exitCode = 1;
  });
}
