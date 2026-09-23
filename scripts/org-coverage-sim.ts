import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadOrganizationContext } from "../lib/imports/gabriel/apply.js";
import { FILE_JURISDICTION_KEYS } from "../lib/imports/gabriel/file-context.js";
import type { AliasEntry } from "../lib/imports/gabriel/organization-resolver.js";
import { sql } from "kysely";
import { comparableText } from "../lib/imports/gabriel/normalize.js";
import { buildPlan, type ImportPlan } from "../lib/imports/gabriel/plan.js";
import { FILE_CODES, type ExtractedFile, type FileCode } from "../lib/imports/gabriel/types.js";
import { APPROVED_ADDITIONS } from "../lib/organizations/catalog/approved-additions.js";
import { aliasKey, planCatalogFromSource } from "../lib/organizations/catalog/plan.js";
import { isYes, type OrgCatalog } from "../lib/organizations/catalog/types.js";

/**
 * Simulación EN MEMORIA: el catálogo organizacional contra el dry-run de Gabriel. No abre ninguna base ni escribe
 * nada. Compara ORGANISM_UNMAPPED antes/después de resolver con los alias AUTO_MAP y arma el Top de pendientes.
 *
 *   npm run org:coverage -- [--extracted data/gabriel/extracted] [--catalog data/org-catalog/catalog.json] [--top 30]
 *
 * El informe no contiene datos personales: solo textos de repartición (organismos), conteos y códigos.
 */

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const countOf = (plan: ImportPlan, code: string) => plan.counts.incidencias_por_codigo[code] ?? 0;

/** Origen de los alias/jerarquía: en memoria (desde el catálogo) o los reales leídos de la base (ids reales). */
export interface OrgSource {
  aliases: AliasEntry[];
  parents: Map<string, string | null>;
  fileJurisdictions: Partial<Record<FileCode, string>>;
  /** id → official_code, solo para informar (las métricas por código). */
  idToCode?: Map<string, string>;
}

export function simulateCoverage(files: ExtractedFile[], catalog: OrgCatalog, top = 30, source?: OrgSource) {
  const codeOf = (id: string | null | undefined) => (id ? source?.idToCode?.get(id) ?? id : "");
  const { plan: catalogPlan } = planCatalogFromSource(catalog, APPROVED_ADDITIONS);
  const before = buildPlan(files);
  // En memoria: el id de cada organización es su canonical_key.
  const aliases = catalogPlan.aliases.toCreate.map((a) => ({ alias: a.alias, organizationId: a.organizationKey, contextOrganizationId: a.contextKey }));
  const parents = new Map(catalog.sheets.Organismos_Oficiales.map((o) => [o.canonical_key, o.parent_key]));
  const after = source
    ? buildPlan(files, { organizationAliases: source.aliases, organizationParents: source.parents, fileJurisdictions: source.fileJurisdictions })
    : buildPlan(files, { organizationAliases: aliases, organizationParents: parents, fileJurisdictions: FILE_JURISDICTION_KEYS });

  const people = after.people.toCreate;
  const withText = people.filter((p) => p.organismText);
  const resolved = people.filter((p) => p.organizationId);
  const conflictOrganism = people.filter((p) => p.pendingFields.includes("organism"));
  const unresolvedWithText = withText.filter((p) => !p.organizationId);

  // Estado de cada texto sin resolver según el catálogo (Alias_Reparticion no-auto + Pendientes).
  const byKey = new Map<string, { matchType: string; candidateCode: string | null; candidateName: string | null; priority: string | null; reason: string | null }>();
  for (const r of catalog.sheets.Alias_Reparticion) if (!isYes(r.AUTO_MAP)) byKey.set(aliasKey(r.reparticion_original), { matchType: r.match_type ?? "REVISAR", candidateCode: r.canonical_key, candidateName: r.nombre_oficial, priority: null, reason: r.fundamento });
  for (const p of catalog.sheets.Pendientes) {
    const k = aliasKey(p.reparticion_original);
    const cur = byKey.get(k);
    byKey.set(k, { matchType: p.tipo_match ?? cur?.matchType ?? "REVISAR", candidateCode: p.candidato_codigo ?? cur?.candidateCode ?? null, candidateName: p.candidato_nombre ?? cur?.candidateName ?? null, priority: p.prioridad, reason: p.motivo ?? cur?.reason ?? null });
  }
  const groups = new Map<string, { text: string; people: number; status: ReturnType<typeof byKey.get> }>();
  for (const p of unresolvedWithText) {
    const k = comparableText(p.organismText);
    const g = groups.get(k) ?? { text: p.organismText!, people: 0, status: byKey.get(k) };
    g.people += 1;
    groups.set(k, g);
  }
  const ranking = [...groups.values()].sort((a, b) => b.people - a.people || a.text.localeCompare(b.text));
  const topRows = ranking.slice(0, top).map((g, i) => ({
    puesto: i + 1,
    texto: g.text,
    personas: g.people,
    estado_en_catalogo: g.status?.matchType ?? "SIN_ENTRADA",
    candidato: g.status?.candidateCode ? `${g.status.candidateCode}${g.status.candidateName ? ` — ${g.status.candidateName}` : ""}` : null,
    motivo: g.status?.reason ?? null,
  }));
  const placeholders = ranking.filter((g) => g.status?.matchType === "INVALIDO");
  const withCandidate = ranking.filter((g) => g.status?.candidateCode);

  // Refinamiento por área interna catalogada (solo referencia: no se aplica automáticamente).
  const areaAuto = catalog.sheets.Alias_Area_Interna.filter((r) => isYes(r.AUTO_MAP_AREA) && r.candidate_key);
  const areaByParent = new Map<string, Map<string, string>>();
  for (const r of areaAuto) {
    const m = areaByParent.get(r.reparticion_codigo ?? "") ?? new Map<string, string>();
    m.set(comparableText(r.area_original), r.candidate_key!);
    areaByParent.set(r.reparticion_codigo ?? "", m);
  }
  const refinable = new Set<string>();
  for (const row of after.rows) {
    if (row.record.fileCode !== "F07" || !row.personDni) continue;
    const person = after.people.toCreate.find((p) => p.dni === row.personDni);
    const areas = areaByParent.get(codeOf(person?.organizationId));
    if (!areas) continue;
    for (const col of ["c10", "c9"]) {
      const text = row.record.rawData[col];
      if (typeof text === "string" && areas.has(comparableText(text))) refinable.add(row.personDni);
    }
  }

  // Familias de homónimos y su efecto sobre las personas de las bases.
  const vocabKeys = new Map<string, string>();
  for (const f of catalogPlan.families) for (const v of f.vocabulary) vocabKeys.set(v.key, f.genericKey);
  const affected = new Map<string, Set<string>>();
  for (const row of after.rows) {
    if (row.record.kind !== "person" || !row.personDni) continue;
    const family = vocabKeys.get(comparableText(row.record.person.organismText));
    if (family) (affected.get(family) ?? affected.set(family, new Set()).get(family)!).add(row.personDni);
  }
  const personByDni = new Map(after.people.toCreate.map((p) => [p.dni, p]));
  const families = catalogPlan.families.map((f) => {
    const dnis = [...(affected.get(f.genericKey) ?? [])];
    const outcome: Record<string, number> = {};
    for (const dni of dnis) {
      const person = personByDni.get(dni);
      const key = person?.organizationResolution ? `resuelta:${person.organizationResolution.kind}` : (person?.organizationStatus ?? "sin_persona");
      outcome[key] = (outcome[key] ?? 0) + 1;
    }
    return {
      nombre_generico: f.genericKey,
      tipo: f.tipo,
      miembros: f.members.map((m) => ({ organizacion: m.key, contexto: m.parentKey, nombre: m.name })),
      textos_genericos: f.vocabulary.map((v) => `${v.display} [${v.kind}]`),
      filas_que_el_catalogo_v2_traia_como_alias_global: f.convertedCatalogRows,
      personas_en_las_bases: dnis.length,
      resultado_en_las_personas: outcome,
    };
  });

  // Casos puntuales: qué pasó con cada texto (por fila: su propia resolución; si no, el estado de la persona).
  const CASES: Array<{ nombre: string; test: (key: string, file: string) => boolean }> = [
    { nombre: "dgtal hacienda", test: (k) => k === "dgtal hacienda" },
    { nombre: "Dgtal MINISTERIO DE HACIENDA Y FINANZAS", test: (k) => k === "dgtal ministerio de hacienda y finanzas" },
    { nombre: "DGTAL del Padrón PG (F07: DG TECNICA ADMINISTRATIVA Y LEGAL)", test: (k, f) => f === "F07" && k === "dg tecnica administrativa y legal" },
    { nombre: "UAI del Padrón PG (F07: UNIDAD DE AUDITORIA INTERNA)", test: (k, f) => f === "F07" && k === "unidad de auditoria interna" },
    { nombre: "UAI sin contexto (fuera del Padrón PG)", test: (k, f) => f !== "F07" && (k === "uai" || k === "unidad de auditoria interna") },
  ];
  const specific = CASES.map((c) => {
    const dnis = new Set<string>();
    const outcome: Record<string, number> = {};
    const targets: Record<string, number> = {};
    for (const row of after.rows) {
      if (row.record.kind !== "person" || !row.personDni) continue;
      const text = row.record.person.organismText;
      if (!text || !c.test(comparableText(text), row.record.fileCode)) continue;
      const person = personByDni.get(row.personDni);
      const key = row.organization ? `resuelta:${row.organization.kind}` : (person?.organizationStatus ?? "sin_persona");
      outcome[key] = (outcome[key] ?? 0) + 1;
      if (row.organization) targets[codeOf(row.organization.organizationId)] = (targets[codeOf(row.organization.organizationId)] ?? 0) + 1;
      dnis.add(row.personDni);
    }
    return { caso: c.nombre, filas: Object.values(outcome).reduce((a, b) => a + b, 0), personas: dnis.size, resultado_por_fila: outcome, destino: targets };
  });

  return {
    casos_especificos: specific,
    familias_de_homonimos: families,
    antes: { organism_unmapped: countOf(before, "ORGANISM_UNMAPPED"), personas: before.people.toCreate.length },
    despues: {
      organism_unmapped: countOf(after, "ORGANISM_UNMAPPED"),
      organism_ambiguous: countOf(after, "ORGANISM_AMBIGUOUS"),
      personas: people.length,
      personas_con_texto_de_organismo: withText.length,
      personas_con_organizacion_resuelta: resolved.length,
      resueltas_global: after.counts.organizacion_resuelta_global,
      resueltas_por_contexto_de_fila: after.counts.organizacion_resuelta_por_contexto_de_fila,
      resueltas_por_contexto_embebido_en_el_texto: after.counts.organizacion_resuelta_por_contexto_embebido,
      resueltas_por_contexto_de_archivo: after.counts.organizacion_resuelta_por_contexto_de_archivo,
      resueltas_por_contexto_de_persona: after.counts.organizacion_resuelta_por_contexto_de_persona,
      organism_context_conflict: countOf(after, "ORGANISM_CONTEXT_CONFLICT"),
      personas_con_contexto_insuficiente: after.counts.organizacion_con_contexto_insuficiente,
      personas_con_conflicto_de_contexto: after.counts.organizacion_con_conflicto_de_contexto,
      personas_con_texto_sin_resolver: unresolvedWithText.length,
      personas_con_organismos_contradictorios: conflictOrganism.length,
      personas_sin_ningun_texto_de_organismo: people.length - withText.length - conflictOrganism.length,
      personas_sin_organizacion_total: people.length - resolved.length,
      cobertura_sobre_personas_con_texto_pct: Number(((resolved.length / (withText.length + conflictOrganism.length)) * 100).toFixed(1)),
      cobertura_sobre_todas_las_personas_pct: Number(((resolved.length / people.length) * 100).toFixed(1)),
      conflictos_de_organismo: after.conflicts.filter((c) => c.field === "organism").length,
      conflictos_de_organismo_antes: before.conflicts.filter((c) => c.field === "organism").length,
    },
    aliases_cargados: source ? source.aliases.length : aliases.length,
    organizaciones_destino_distintas: new Set(resolved.map((p) => p.organizationId)).size,
    personas_sin_organizacion_con_texto_pendiente_o_contradictorio: unresolvedWithText.length + conflictOrganism.length,
    textos_distintos_sin_resolver: ranking.length,
    textos_sin_resolver_que_son_placeholder: placeholders.length,
    textos_sin_resolver_con_candidato_en_catalogo: withCandidate.length,
    personas_en_textos_con_candidato: withCandidate.reduce((s, g) => s + g.people, 0),
    personas_refinables_a_unidad_interna_catalogada: refinable.size,
    top: topRows,
    personas_afectadas_top: topRows.reduce((s, r) => s + r.personas, 0),
  };
}

export async function readRealSource(): Promise<OrgSource> {
  const db = await getDb();
  try {
    // Solo lectura: transacción READ ONLY con la conexión runtime (sutecba_app).
    return await db.transaction().execute(async (trx) => {
      await sql`set transaction read only`.execute(trx);
      const ctx = await loadOrganizationContext(trx);
      const codes = await trx.selectFrom("organizations").select(["id", "official_code"]).execute();
      return {
        aliases: ctx.organizationAliases,
        parents: ctx.organizationParents,
        fileJurisdictions: ctx.fileJurisdictions,
        idToCode: new Map(codes.filter((c) => c.official_code).map((c) => [c.id, c.official_code!])),
      };
    });
  } finally {
    await closeDb();
  }
}

async function main() {
  const extracted = resolve(arg("extracted", "data/gabriel/extracted"));
  const useDb = process.argv.includes("--db");
  const catalog = JSON.parse(readFileSync(resolve(arg("catalog", "data/org-catalog/catalog.json")), "utf-8")) as OrgCatalog;
  const files = FILE_CODES.map((c) => JSON.parse(readFileSync(join(extracted, `${c}.json`), "utf-8")) as ExtractedFile);
  const simulated = simulateCoverage(files, catalog, Number(arg("top", "30")));
  const result = useDb ? simulateCoverage(files, catalog, Number(arg("top", "30")), await readRealSource()) : simulated;
  const dir = resolve("data/org-catalog/reports");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${useDb ? "coverage-real" : "coverage"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(target, JSON.stringify(result, null, 2), "utf-8");
  const { top, familias_de_homonimos: families, casos_especificos: cases, ...summary } = result;
  console.log(useDb ? "ORIGEN: alias y organizaciones REALES leídos de la base (solo lectura)" : "ORIGEN: simulación en memoria");
  console.log(JSON.stringify(summary, null, 2));
  if (useDb) {
    const diffs = Object.entries(summary.despues).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((simulated.despues as Record<string, unknown>)[k]));
    console.log(diffs.length === 0 ? "\nCOMPARACIÓN CON LA SIMULACIÓN: idéntica en todas las métricas" : `\nDIFERENCIAS CON LA SIMULACIÓN: ${JSON.stringify(diffs)}`);
    console.log(`Alias cargados: real=${summary.aliases_cargados} simulación=${simulated.aliases_cargados}`);
  }
  console.log("\nCASOS PUNTUALES:");
  for (const c of cases) console.log(`· ${c.caso}: ${c.filas} filas / ${c.personas} personas  ${JSON.stringify(c.resultado_por_fila)}  destino ${JSON.stringify(c.destino)}`);
  console.log("\nTOP pendientes (personas afectadas):");
  for (const r of top) console.log(`${String(r.puesto).padStart(2)}. ${String(r.personas).padStart(3)}  ${r.texto}  [${r.estado_en_catalogo}]${r.candidato ? `  → ${r.candidato}` : ""}`);
  console.log(`\n[org-coverage] informe: ${target}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error(String(e?.message ?? e).replace(/\d{6,}/g, "[n]")); process.exitCode = 1; });
