import { comparableText, sha256Hex, stableStringify } from "../../imports/gabriel/normalize.js";
import { APPROVED_ADDITIONS, type ApprovedAliasAddition } from "./approved-additions.js";
import { APPROVED_ORG_ADDITIONS, orgAdditionToCatalogRow, type ApprovedOrgAddition } from "./approved-org-additions.js";
import { detectHomonymFamilies, type HomonymFamily } from "./homonyms.js";
import { CATALOG_TYPE_MAP, type OrgTypeDef } from "./type-map.js";
import { isYes, type CatalogAliasRow, type CatalogOrgRow, type OrgCatalog } from "./types.js";

/**
 * Planificador (dry-run) de la carga de estructura organizacional y aliases. No toca ninguna base.
 *
 * Reglas:
 *  - Solo `Organismos_Oficiales` crea `organizations` (una por fila, nunca desde texto libre). La clave de
 *    idempotencia es `official_code` = `canonical_key` del catálogo (`MCGC`, `slug:…`, `pg:dgtal:…`).
 *  - Solo los alias con AUTO_MAP = Sí se cargan, como `approved`; cada alias resuelve a UNA organización.
 *    PROBABLE / AMBIGUO / REVISAR / INVALIDO / INTERNO / histórico NO se cargan y no se resuelven solos.
 *  - Alias GLOBAL (sin contexto) solo si identifica inequívocamente una organización. Los nombres genéricos que
 *    comparten varias unidades homónimas (DGTAL, UAI…) son CONTEXTUALES: un alias por miembro de la familia, con la
 *    jurisdicción (padre) como `context_organization_id` (0022). La familia se deriva de la estructura oficial.
 *  - Sin fuzzy matching: las claves de comparación son determinísticas (minúsculas, sin acentos ni puntuación).
 *  - Alias_Area_Interna no crea organizaciones: una unidad interna es organización solo si ya figura en
 *    Organismos_Oficiales; el resto es dato de origen que se conserva en staging.
 */

export const CATALOG_PLAN_VERSION = "org-catalog-plan-v3";

export interface ExistingCatalogState {
  types: Array<{ id?: string; key: string; name: string; level: number }>;
  organizations: Array<{ id?: string; official_code: string | null; name: string; parent_id: string | null; parent_official_code?: string | null; type_key: string; active: boolean }>;
  aliases: Array<{ normalized_alias: string; alias?: string; organization_id: string; official_code?: string | null; context_official_code?: string | null; status: string }>;
  /** La base ya tiene la columna context_organization_id (0022). */
  contextSupported?: boolean;
}

export interface PlannedOrganization {
  key: string;
  name: string;
  typeKey: string;
  parentKey: string | null;
  depth: number;
  nivelFuente: string | null;
  /** «catalog» = viene del archivo oficial; «human_approved» = alta aprobada por decisión humana (approved-org-additions.ts). */
  origin: "catalog" | "human_approved";
}

export interface PlannedAlias {
  /** Texto original tal cual figura en las bases de Gabriel (primera aparición). */
  alias: string;
  /** Clave del catálogo de la organización destino. */
  organizationKey: string;
  /** Clave de la organización de contexto (jurisdicción); null = alias global. */
  contextKey: string | null;
  /** De dónde sale: una fila AUTO_MAP del catálogo, o la familia de homónimos derivada del organigrama oficial. */
  origin: "catalog_auto" | "homonym_family" | "human_approved";
  matchType: string;
  filasOrigen: number;
  /** Otros textos originales que normalizan igual (ya cubiertos por este alias). */
  variants: number;
}

export type CatalogIssueCode =
  | "DUPLICATE_KEY"
  | "DUPLICATE_OFFICIAL_CODE"
  | "MISSING_PARENT"
  | "HIERARCHY_CYCLE"
  | "UNMAPPED_TYPE"
  | "NOT_VIGENTE"
  | "ORG_CONFLICT_DB"
  | "ORG_NAME_COLLISION_DB"
  | "ALIAS_TARGET_MISSING"
  | "ALIAS_TARGET_NOT_VIGENTE"
  | "ALIAS_AMBIGUOUS_IN_CATALOG"
  | "ALIAS_CONFLICT_DB"
  | "ALIAS_BLANK"
  | "AUTO_MAP_WITH_NON_SAFE_MATCH"
  | "ALIAS_HOMONYM_TARGET_MISMATCH"
  | "HOMONYM_SAME_PARENT"
  | "HOMONYM_WITHOUT_PARENT"
  | "HOMONYM_VOCABULARY_COLLISION";

export interface CatalogIssue {
  code: CatalogIssueCode;
  severity: "error" | "warning";
  ref: string;
  detail: string;
}

export interface CatalogPlan {
  version: string;
  catalog: { fileName: string; sha256: string; version: string | null };
  types: { toCreate: OrgTypeDef[]; existing: number };
  organizations: { toCreate: PlannedOrganization[]; existing: string[] };
  aliases: {
    toCreate: PlannedAlias[];
    existing: number;
    /** Alias auto cuyo texto normaliza igual pero apunta a organizaciones distintas: no se cargan. */
    ambiguous: Array<{ alias: string; targets: string[] }>;
    notLoaded: Record<string, number>;
    notLoadedRows: number;
  };
  /** Familias de organizaciones homónimas detectadas en el organigrama oficial (contexto obligatorio). */
  families: Array<{
    genericKey: string;
    tipo: string;
    members: HomonymFamily["members"];
    vocabulary: HomonymFamily["vocabulary"];
    /** Textos que el catálogo V2 traía como AUTO_MAP globales y ahora pasan a contextuales. */
    convertedCatalogRows: Array<{ text: string; rows: number; target: string }>;
  }>;
  areaAliases: {
    total: number;
    autoMapArea: number;
    /** Áreas cuya unidad candidata figura en Organismos_Oficiales con su jerarquía. */
    catalogedAsOrganization: Array<{ parent: string; area: string; candidate: string; candidateIsChildOfParent: boolean }>;
    preservedAsSourceData: number;
    byState: Record<string, number>;
  };
  issues: CatalogIssue[];
  counts: Record<string, number>;
}

/** Igual que el trigger `sutecba_normalize_organization_alias` de 0012: minúsculas, sin acentos, espacios simples. */
export function aliasKeyForDb(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Clave determinística de comparación con el texto libre del padrón (sin puntuación). */
export const aliasKey = (text: string | null | undefined): string => comparableText(text ?? "");

const inc = (m: Record<string, number>, k: string, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};

export { APPROVED_ADDITIONS, APPROVED_ORG_ADDITIONS };

/** Una decisión humana entra al plan como una fila AUTO_MAP más (match_type HUMAN_APPROVED), con las mismas validaciones. */
const additionToRow = (a: ApprovedAliasAddition): CatalogAliasRow => ({
  reparticion_original: a.alias,
  area_original_contexto: null,
  filas_origen: "0",
  normalizado: null,
  canonical_key: a.targetKey,
  codigo_oficial: a.targetKey,
  nombre_oficial: null,
  match_type: "HUMAN_APPROVED",
  confianza_pct: "100",
  AUTO_MAP: "Sí",
  fundamento: `${a.approvedBy} ${a.approvedOn}: ${a.reason}`,
  fuente_oficial: null,
});

export function buildCatalogPlan(
  catalog: OrgCatalog,
  existing: ExistingCatalogState = { types: [], organizations: [], aliases: [] },
  additions: readonly ApprovedAliasAddition[] = [],
  organizationAdditions: readonly ApprovedOrgAddition[] = []
): CatalogPlan {
  const issues: CatalogIssue[] = [];
  const humanApprovedKeys = new Set(organizationAdditions.map((a) => a.key));
  const orgRows = [...catalog.sheets.Organismos_Oficiales, ...organizationAdditions.map(orgAdditionToCatalogRow)];
  const push = (code: CatalogIssueCode, severity: "error" | "warning", ref: string, detail: string) => issues.push({ code, severity, ref, detail });

  // ---------------------------------------------------------------- organizaciones
  const byKey = new Map<string, CatalogOrgRow>();
  const seenCodes = new Set<string>();
  for (const row of orgRows) {
    if (byKey.has(row.canonical_key)) {
      push("DUPLICATE_KEY", "error", row.canonical_key, "canonical_key repetido en Organismos_Oficiales.");
      continue;
    }
    byKey.set(row.canonical_key, row);
    if (row.codigo_oficial) {
      if (seenCodes.has(row.codigo_oficial)) push("DUPLICATE_OFFICIAL_CODE", "error", row.canonical_key, "codigo_oficial repetido.");
      seenCodes.add(row.codigo_oficial);
    }
    if (!isYes(row.vigente)) push("NOT_VIGENTE", "warning", row.canonical_key, "No figura como vigente: se carga como inactiva solo si se decide; hoy se omite.");
    if (!CATALOG_TYPE_MAP[row.tipo]) push("UNMAPPED_TYPE", "error", row.canonical_key, `Tipo "${row.tipo}" sin correspondencia en organization_types.`);
  }

  // Profundidad y ciclos; padres inexistentes.
  const depthOf = new Map<string, number>();
  const resolving = new Set<string>();
  const cyclic = new Set<string>();
  const depth = (key: string): number => {
    const cached = depthOf.get(key);
    if (cached !== undefined) return cached;
    if (resolving.has(key)) {
      cyclic.add(key);
      return -1;
    }
    resolving.add(key);
    const parent = byKey.get(key)?.parent_key;
    let d = 0;
    if (parent) {
      if (!byKey.has(parent)) d = -2;
      else {
        const pd = depth(parent);
        d = pd < 0 ? pd : pd + 1;
      }
    }
    resolving.delete(key);
    depthOf.set(key, d);
    return d;
  };
  for (const key of byKey.keys()) depth(key);
  for (const [key, row] of byKey) {
    const d = depthOf.get(key)!;
    if (row.parent_key && !byKey.has(row.parent_key)) push("MISSING_PARENT", "error", key, `Padre "${row.parent_key}" inexistente en el catálogo.`);
    else if (d === -1 || cyclic.has(key)) push("HIERARCHY_CYCLE", "error", key, "La jerarquía forma un ciclo.");
  }

  // Estado existente en la base (por official_code).
  const dbByCode = new Map(existing.organizations.filter((o) => o.official_code).map((o) => [o.official_code!, o]));
  const dbNames = new Map<string, number>();
  for (const o of existing.organizations) if (!o.official_code) dbNames.set(aliasKey(o.name), (dbNames.get(aliasKey(o.name)) ?? 0) + 1);
  const existingKeys: string[] = [];
  const toCreate: PlannedOrganization[] = [];
  const blockedKeys = new Set(issues.filter((i) => i.severity === "error" && ["DUPLICATE_KEY", "UNMAPPED_TYPE", "MISSING_PARENT", "HIERARCHY_CYCLE"].includes(i.code)).map((i) => i.ref));
  // Un hijo de una organización con error tampoco se carga.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [key, row] of byKey) if (!blockedKeys.has(key) && row.parent_key && blockedKeys.has(row.parent_key)) (blockedKeys.add(key), (grew = true));
  }

  for (const [key, row] of [...byKey].sort(([a], [b]) => (depthOf.get(a)! - depthOf.get(b)!) || a.localeCompare(b))) {
    if (blockedKeys.has(key) || !isYes(row.vigente)) continue;
    const dbOrg = dbByCode.get(key);
    if (dbOrg) {
      existingKeys.push(key);
      const typeKey = CATALOG_TYPE_MAP[row.tipo]!.key;
      const parentCode = dbOrg.parent_official_code ?? null;
      const diffs: string[] = [];
      if (aliasKey(dbOrg.name) !== aliasKey(row.nombre_oficial)) diffs.push("nombre");
      if (dbOrg.type_key !== typeKey) diffs.push("tipo");
      if ((parentCode ?? null) !== (row.parent_key ?? null)) diffs.push("padre");
      if (!dbOrg.active) diffs.push("inactiva");
      if (diffs.length) push("ORG_CONFLICT_DB", "error", key, `Ya existe con official_code igual pero difiere en: ${diffs.join(", ")}. No se modifica automáticamente.`);
      continue;
    }
    if (dbNames.get(aliasKey(row.nombre_oficial))) push("ORG_NAME_COLLISION_DB", "error", key, "Existe una organización sin official_code con el mismo nombre: podría ser un duplicado. Requiere decisión.");
    toCreate.push({ key, name: row.nombre_oficial, typeKey: CATALOG_TYPE_MAP[row.tipo]!.key, parentKey: row.parent_key, depth: depthOf.get(key)!, nivelFuente: row.nivel_fuente, origin: humanApprovedKeys.has(key) ? "human_approved" : "catalog" });
  }

  // Tipos
  const existingTypeKeys = new Set(existing.types.map((t) => t.key));
  const neededTypes = new Map<string, OrgTypeDef>();
  for (const o of toCreate) {
    const def = Object.values(CATALOG_TYPE_MAP).find((t) => t.key === o.typeKey)!;
    if (!existingTypeKeys.has(def.key)) neededTypes.set(def.key, def);
  }

  // ---------------------------------------------------------------- alias
  const targetKnown = (key: string) => byKey.has(key) || dbByCode.has(key);
  const willExist = (key: string) => (byKey.has(key) && !blockedKeys.has(key) && isYes(byKey.get(key)!.vigente)) || dbByCode.has(key);
  const auto: CatalogAliasRow[] = [];
  const notLoaded: Record<string, number> = {};
  let notLoadedRows = 0;
  for (const row of catalog.sheets.Alias_Reparticion) {
    const rows = Number(row.filas_origen ?? 0) || 0;
    if (!isYes(row.AUTO_MAP)) {
      inc(notLoaded, row.match_type ?? "SIN_TIPO");
      notLoadedRows += rows;
      continue;
    }
    if (!row.reparticion_original || !aliasKey(row.reparticion_original)) {
      push("ALIAS_BLANK", "error", String(row.reparticion_original), "Alias AUTO_MAP vacío o sin caracteres comparables.");
      continue;
    }
    if (!["ALIAS_SEGURO", "EXACT_CODE", "EXACT_NAME", "HUMAN_APPROVED"].includes(row.match_type ?? "")) {
      push("AUTO_MAP_WITH_NON_SAFE_MATCH", "error", row.reparticion_original, `AUTO_MAP=Sí con match_type "${row.match_type}": no se carga.`);
      continue;
    }
    auto.push(row);
  }
  for (const addition of additions) {
    if (!addition.alias.trim() || !aliasKey(addition.alias)) {
      push("ALIAS_BLANK", "error", addition.alias, "Alias aprobado por decisión humana vacío o sin caracteres comparables.");
      continue;
    }
    auto.push(additionToRow(addition));
  }

  // Familias de organizaciones homónimas (solo entre las que efectivamente se van a cargar o ya existen).
  const loadableOrgs = [...byKey.values()].filter((o) => willExist(o.canonical_key));
  const detected = detectHomonymFamilies(loadableOrgs);
  for (const problem of detected.problems) push(problem.code, "error", problem.keys.join(","), `Unidades homónimas "${problem.genericKey}" que no se pueden distinguir por su padre.`);
  const vocabIndex = new Map<string, HomonymFamily>();
  const collided = new Set<string>();
  for (const family of detected.families) {
    for (const v of family.vocabulary) {
      const other = vocabIndex.get(v.key);
      if (other && other !== family) {
        collided.add(v.key);
        push("HOMONYM_VOCABULARY_COLLISION", "error", v.key, `El texto pertenece a dos familias de homónimos ("${other.genericKey}" y "${family.genericKey}"): no se carga ninguna.`);
      } else vocabIndex.set(v.key, family);
    }
  }
  const usableFamilies = detected.families.filter((f) => f.vocabulary.every((v) => !collided.has(v.key)));

  // Un alias por texto comparable; si apunta a más de un destino, es ambiguo y no se carga.
  const groups = new Map<string, CatalogAliasRow[]>();
  for (const row of auto) {
    const k = aliasKey(row.reparticion_original);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(row);
  }
  const aliasesToCreate: PlannedAlias[] = [];
  const ambiguous: CatalogPlan["aliases"]["ambiguous"] = [];
  // Las aliases de la base se comparan por la misma clave determinística que usa el importador.
  const dbAliases = new Map<string, ExistingCatalogState["aliases"][number]>();
  const dbTextKeys = new Map<string, Array<ExistingCatalogState["aliases"][number]>>();
  for (const a of existing.aliases.filter((x) => x.status === "approved")) {
    const k = aliasKey(a.alias ?? a.normalized_alias);
    dbAliases.set(`${k}|${a.context_official_code ?? ""}`, a);
    (dbTextKeys.get(k) ?? dbTextKeys.set(k, []).get(k)!).push(a);
  }
  let existingAliases = 0;
  const catalogTextsByVocab = new Map<string, { display: string; rows: number; targets: Set<string> }>();
  const convertedByFamily = new Map<HomonymFamily, Array<{ text: string; rows: number; target: string }>>();

  for (const [k, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const targets = [...new Set(rows.map((r) => r.canonical_key ?? ""))];
    const first = rows[0]!;
    const family = usableFamilies.find((f) => f.vocabulary.some((v) => v.key === k));
    if (targets.length > 1 || targets.some((t) => !t)) {
      ambiguous.push({ alias: first.reparticion_original!, targets: targets.filter(Boolean) });
      push("ALIAS_AMBIGUOUS_IN_CATALOG", "error", first.reparticion_original!, `El mismo texto apunta a ${targets.length} destinos distintos (${targets.join(", ")}).`);
      continue;
    }
    const target = targets[0]!;
    if (!targetKnown(target)) {
      push("ALIAS_TARGET_MISSING", "error", first.reparticion_original!, `Destino "${target}" inexistente en el catálogo y en la base.`);
      continue;
    }
    if (!willExist(target)) {
      push("ALIAS_TARGET_NOT_VIGENTE", "error", first.reparticion_original!, `Destino "${target}" no se va a cargar (con error o no vigente).`);
      continue;
    }
    const totalRows = rows.reduce((s, r) => s + (Number(r.filas_origen ?? 0) || 0), 0);
    if (family) {
      // Texto genérico de una familia de homónimos: NUNCA global. El catálogo lo traía apuntando a un miembro
      // (contextual por archivo); pasa a ser un alias contextual por jurisdicción para todos los miembros.
      if (!family.members.some((m) => m.key === target)) {
        push("ALIAS_HOMONYM_TARGET_MISMATCH", "error", first.reparticion_original!, `El texto es genérico de "${family.genericKey}" pero el catálogo lo apunta a "${target}", que no es miembro de la familia.`);
        continue;
      }
      catalogTextsByVocab.set(k, { display: first.reparticion_original!.trim(), rows: totalRows, targets: new Set([target]) });
      const list = convertedByFamily.get(family) ?? [];
      list.push({ text: first.reparticion_original!.trim(), rows: totalRows, target });
      convertedByFamily.set(family, list);
      continue;
    }
    const conflicting = (dbTextKeys.get(k) ?? []).find((a) => (a.context_official_code ?? null) !== null || (a.official_code ?? null) !== target);
    if (conflicting) {
      push("ALIAS_CONFLICT_DB", "error", first.reparticion_original!, "Ya existe un alias aprobado con ese texto que apunta a otra organización o es contextual. No se pisa.");
      continue;
    }
    if (dbAliases.get(`${k}|`)) {
      existingAliases += 1;
      continue;
    }
    aliasesToCreate.push({
      alias: first.reparticion_original!.trim(),
      organizationKey: target,
      contextKey: null,
      origin: first.match_type === "HUMAN_APPROVED" ? "human_approved" : "catalog_auto",
      matchType: first.match_type!,
      filasOrigen: totalRows,
      variants: rows.length - 1,
    });
  }

  // Alias contextuales derivados de las familias: uno por (texto genérico, miembro), con el padre como contexto.
  for (const family of usableFamilies) {
    for (const v of family.vocabulary) {
      for (const m of family.members) {
        if (!willExist(m.key) || !willExist(m.parentKey)) continue;
        const shadow = (dbTextKeys.get(v.key) ?? []).find((a) => (a.context_official_code ?? null) === null);
        if (shadow) {
          push("ALIAS_CONFLICT_DB", "error", v.display, "Existe un alias GLOBAL aprobado con ese texto: haría sombra a los contextuales.");
          continue;
        }
        const present = dbAliases.get(`${v.key}|${m.parentKey}`);
        if (present) {
          if ((present.official_code ?? null) === m.key) existingAliases += 1;
          else push("ALIAS_CONFLICT_DB", "error", v.display, `Ya existe el alias contextual (${m.parentKey}) apuntando a otra organización. No se pisa.`);
          continue;
        }
        const fromCatalog = catalogTextsByVocab.get(v.key);
        aliasesToCreate.push({
          alias: fromCatalog?.display ?? v.display,
          organizationKey: m.key,
          contextKey: m.parentKey,
          origin: "homonym_family",
          matchType: fromCatalog ? "ALIAS_SEGURO_CONTEXTUAL" : "HOMONYM_FAMILY",
          filasOrigen: fromCatalog && fromCatalog.targets.has(m.key) ? fromCatalog.rows : 0,
          variants: 0,
        });
      }
    }
  }
  aliasesToCreate.sort((x, y) => (x.contextKey ?? "").localeCompare(y.contextKey ?? "") || x.alias.localeCompare(y.alias) || x.organizationKey.localeCompare(y.organizationKey));
  const familiesReport: CatalogPlan["families"] = usableFamilies.map((f) => ({ genericKey: f.genericKey, tipo: f.tipo, members: f.members, vocabulary: f.vocabulary, convertedCatalogRows: convertedByFamily.get(f) ?? [] }));

  // ---------------------------------------------------------------- áreas internas (solo se cruzan; no crean organizaciones)
  const areaRows = catalog.sheets.Alias_Area_Interna;
  const cataloged = areaRows
    .filter((r) => r.candidate_key && byKey.has(r.candidate_key))
    .map((r) => ({
      parent: r.reparticion_codigo ?? "",
      area: r.area_original ?? "",
      candidate: r.candidate_key!,
      candidateIsChildOfParent: isDescendant(byKey, r.candidate_key!, r.reparticion_codigo ?? ""),
    }));
  const byState: Record<string, number> = {};
  for (const r of areaRows) inc(byState, r.estado_area ?? "SIN_ESTADO");

  const errors = issues.filter((i) => i.severity === "error").length;
  const counts: Record<string, number> = {
    organizaciones_en_catalogo: byKey.size,
    organizaciones_a_crear: toCreate.length,
    organizaciones_ya_existentes: existingKeys.length,
    tipos_de_organizacion_a_crear: neededTypes.size,
    aliases_auto_map_en_catalogo: auto.length,
    organizaciones_por_decision_humana_a_crear: toCreate.filter((o) => o.origin === "human_approved").length,
    aliases_a_crear: aliasesToCreate.length,
    aliases_globales_a_crear: aliasesToCreate.filter((x) => x.contextKey === null).length,
    aliases_por_decision_humana_a_crear: aliasesToCreate.filter((x) => x.origin === "human_approved").length,
    aliases_contextuales_a_crear: aliasesToCreate.filter((x) => x.contextKey !== null).length,
    familias_de_homonimos: usableFamilies.length,
    aliases_ya_existentes: existingAliases,
    aliases_ambiguos: ambiguous.length,
    aliases_no_cargados_por_no_ser_auto_map: Object.values(notLoaded).reduce((a, b) => a + b, 0),
    errores: errors,
    advertencias: issues.length - errors,
  };

  return {
    version: CATALOG_PLAN_VERSION,
    catalog: { fileName: catalog.fileName, sha256: catalog.sha256, version: catalog.version },
    types: { toCreate: [...neededTypes.values()].sort((a, b) => a.level - b.level || a.key.localeCompare(b.key)), existing: existing.types.length },
    organizations: { toCreate, existing: existingKeys },
    aliases: { toCreate: aliasesToCreate, existing: existingAliases, ambiguous, notLoaded, notLoadedRows },
    families: familiesReport,
    areaAliases: {
      total: areaRows.length,
      autoMapArea: areaRows.filter((r) => isYes(r.AUTO_MAP_AREA)).length,
      catalogedAsOrganization: cataloged,
      preservedAsSourceData: areaRows.length - cataloged.length,
      byState,
    },
    issues,
    counts,
  };
}

function isDescendant(byKey: Map<string, CatalogOrgRow>, key: string, ancestor: string): boolean {
  let current = byKey.get(key)?.parent_key ?? null;
  for (let i = 0; current && i < 50; i += 1) {
    if (current === ancestor) return true;
    current = byKey.get(current)?.parent_key ?? null;
  }
  return false;
}

/** Hash del plan derivado SOLO del catálogo (sin estado de la base). Cambia si cambia el archivo o una regla. */
export function catalogPlanHash(plan: CatalogPlan): string {
  return sha256Hex(
    stableStringify({
      version: plan.version,
      catalogSha: plan.catalog.sha256,
      types: plan.types.toCreate,
      organizations: plan.organizations.toCreate,
      aliases: plan.aliases.toCreate,
      ambiguous: plan.aliases.ambiguous,
      issues: plan.issues,
    })
  );
}

/** Plan y hash sin depender de la base. */
export function planCatalogFromSource(
  catalog: OrgCatalog,
  additions: readonly ApprovedAliasAddition[] = [],
  organizationAdditions: readonly ApprovedOrgAddition[] = []
): { plan: CatalogPlan; planHash: string } {
  const plan = buildCatalogPlan(catalog, undefined, additions, organizationAdditions);
  return { plan, planHash: catalogPlanHash(plan) };
}
