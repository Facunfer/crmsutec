/** Catálogo organizacional extraído de SUTECBA_Estructura_Oficial_Alias_Gabriel_vN.xlsx (tools/org-catalog-extract.py). */

export interface CatalogOrgRow {
  canonical_key: string;
  codigo_oficial: string | null;
  nombre_oficial: string;
  tipo: string;
  parent_key: string | null;
  vigente: string | null;
  nivel_fuente: string | null;
  fuente_oficial: string | null;
  verificado: string | null;
  notas: string | null;
}

export interface CatalogAliasRow {
  reparticion_original: string | null;
  area_original_contexto: string | null;
  filas_origen: string | null;
  normalizado: string | null;
  canonical_key: string | null;
  codigo_oficial: string | null;
  nombre_oficial: string | null;
  match_type: string | null;
  confianza_pct: string | null;
  AUTO_MAP: string | null;
  fundamento: string | null;
  fuente_oficial: string | null;
}

export interface CatalogAreaAliasRow {
  reparticion_original: string | null;
  area_original: string | null;
  filas_origen: string | null;
  reparticion_codigo: string | null;
  estado_area: string | null;
  candidate_key: string | null;
  candidate_name: string | null;
  AUTO_MAP_AREA: string | null;
  nota: string | null;
}

export interface CatalogPendingRow {
  prioridad: string | null;
  reparticion_original: string | null;
  area_contexto: string | null;
  filas_origen: string | null;
  tipo_match: string | null;
  candidato_codigo: string | null;
  candidato_nombre: string | null;
  motivo: string | null;
}

export interface OrgCatalog {
  fileName: string;
  sha256: string;
  version: string | null;
  sheets: {
    Organismos_Oficiales: CatalogOrgRow[];
    Alias_Reparticion: CatalogAliasRow[];
    Alias_Area_Interna: CatalogAreaAliasRow[];
    Pendientes: CatalogPendingRow[];
    Decisiones_V2?: Array<Record<string, string | null>>;
  };
}

export const isYes = (value: string | null | undefined) => (value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase() === "si";
