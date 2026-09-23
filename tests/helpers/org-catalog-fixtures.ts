import { createHash } from "node:crypto";
import type { CatalogAliasRow, CatalogAreaAliasRow, CatalogOrgRow, OrgCatalog } from "../../lib/organizations/catalog/types.js";

/** Catálogo SINTÉTICO con la misma forma que SUTECBA_Estructura_Oficial_Alias_Gabriel_vN.xlsx. */
export const org = (key: string, name: string, tipo: string, parent: string | null = null, over: Partial<CatalogOrgRow> = {}): CatalogOrgRow => ({
  canonical_key: key,
  codigo_oficial: key.includes(":") ? null : key,
  nombre_oficial: name,
  tipo,
  parent_key: parent,
  vigente: "Sí",
  nivel_fuente: "organigrama_web",
  fuente_oficial: "https://example.test/organigrama",
  verificado: "2026-09-21",
  notas: null,
  ...over,
});

export const alias = (text: string, key: string | null, over: Partial<CatalogAliasRow> = {}): CatalogAliasRow => ({
  reparticion_original: text,
  area_original_contexto: null,
  filas_origen: "3",
  normalizado: null,
  canonical_key: key,
  codigo_oficial: key,
  nombre_oficial: null,
  match_type: "ALIAS_SEGURO",
  confianza_pct: "98",
  AUTO_MAP: "Sí",
  fundamento: "Variante ortográfica",
  fuente_oficial: null,
  ...over,
});

export const notAuto = (text: string, matchType: string, key: string | null = null): CatalogAliasRow => alias(text, key, { match_type: matchType, AUTO_MAP: "No", confianza_pct: "40" });

export const area = (parent: string, text: string, candidate: string | null, autoMap = "No", state = "REVISAR"): CatalogAreaAliasRow => ({
  reparticion_original: parent,
  area_original: text,
  filas_origen: "2",
  reparticion_codigo: parent,
  estado_area: state,
  candidate_key: candidate,
  candidate_name: null,
  AUTO_MAP_AREA: autoMap,
  nota: null,
});

export function makeCatalog(parts: { orgs: CatalogOrgRow[]; aliases?: CatalogAliasRow[]; areas?: CatalogAreaAliasRow[]; sha?: string }): OrgCatalog {
  return {
    fileName: "catalogo-sintetico.xlsx",
    sha256: parts.sha ?? createHash("sha256").update(JSON.stringify(parts.orgs)).digest("hex"),
    version: "test",
    sheets: { Organismos_Oficiales: parts.orgs, Alias_Reparticion: parts.aliases ?? [], Alias_Area_Interna: parts.areas ?? [], Pendientes: [], Decisiones_V2: [] },
  };
}

/** Estructura mínima: Ministerio → Subsecretaría → Dirección General → Departamento (unidad interna catalogada). */
export const baseOrgs = (): CatalogOrgRow[] => [
  org("MCGC", "Ministerio de Cultura", "Ministerio"),
  org("SSPCGC", "Subsecretaría de Patrimonio", "Subsecretaría", "MCGC"),
  org("DGPAT", "Dirección General de Patrimonio", "Dirección General", "SSPCGC"),
  org("pg:dgpat:archivo", "Departamento Archivo", "Departamento", "DGPAT", { nivel_fuente: "normativa_interna" }),
  org("EATC", "Ente Autárquico Teatro Colón", "Ente autárquico"),
];

/** Ministerios y una dependencia, cada uno con su DGTAL y su UAI homónimas (más una familia de un solo miembro que NO lo es). */
export const homonymOrgs = (): CatalogOrgRow[] => [
  org("MCGC", "Ministerio de Cultura", "Ministerio"),
  org("MHFGC", "Ministerio de Hacienda y Finanzas", "Ministerio"),
  org("PG", "Procuración General", "Dependencia"),
  org("DGTALMC", "Dirección General Técnica, Administrativa y Legal", "Dirección General", "MCGC"),
  org("DGTALMHF", "Dirección General Técnica Administrativa y Legal", "Dirección General", "MHFGC"),
  org("DGTALPG", "Dirección General Técnica, Administrativa y Legal", "Dirección General", "PG"),
  org("UAIMC", "Unidad de Auditoría Interna MCGC", "Unidad de Auditoría Interna", "MCGC"),
  org("UAIPG", "Unidad de Auditoría Interna PG", "Unidad de Auditoría Interna", "PG"),
  org("DGPAT", "Dirección General de Patrimonio", "Dirección General", "MCGC"),
];
