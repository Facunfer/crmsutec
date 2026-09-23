/**
 * ALTAS oficiales al catálogo organizacional aprobadas por SUTECBA (hoja `Altas_catalogo_propuestas` de
 * `nuevas_organismos_pendientes_DECISIONES_PROPUESTAS.xlsx`, 2026-09-22), para las nuevas bases de Gabriel.
 *
 * Cada una es una unidad OFICIAL verificada contra el organigrama publicado (columna `Fuente oficial`), no texto
 * libre de una fuente: por eso puede crearse. `parentKey` debe existir ya en el catálogo o en esta misma lista (el
 * planificador no depende del orden: resuelve el árbol completo antes de crear). Solo se agrega acá lo que SUTECBA
 * aprobó explícitamente; cualquier otra unidad candidata sigue sin crearse.
 */
import type { CatalogOrgRow } from "./types.js";

export interface ApprovedOrgAddition {
  /** `official_code` / `canonical_key`. */
  key: string;
  name: string;
  /** Texto de la columna `tipo` del catálogo (debe existir en CATALOG_TYPE_MAP). */
  tipo: string;
  parentKey: string;
  approvedBy: string;
  approvedOn: string;
  source: string;
  reason: string;
}

export const APPROVED_ORG_ADDITIONS: readonly ApprovedOrgAddition[] = [
  {
    key: "IVC",
    name: "Instituto de Vivienda de la Ciudad",
    tipo: "Ente autárquico",
    parentKey: "MDHYHGC",
    approvedBy: "SUTECBA",
    approvedOn: "2026-09-22",
    source: "https://buenosaires.gob.ar/organigrama/ministerio-de-desarrollo-humano-y-habitat-mdhyhgc",
    reason: "Organismo fuera de nivel vigente bajo Desarrollo Humano y Hábitat.",
  },
  {
    key: "SECD",
    name: "Secretaría de Deportes",
    tipo: "Secretaría",
    parentKey: "MJGGC",
    approvedBy: "SUTECBA",
    approvedOn: "2026-09-22",
    source: "https://buenosaires.gob.ar/organigrama/jefatura-de-gabinete-de-ministros-mjggc",
    reason: "Secretaría vigente bajo Jefatura de Gabinete.",
  },
  {
    key: "SECTE",
    name: "Secretaría de Trabajo y Empleo",
    tipo: "Secretaría",
    parentKey: "MJGC",
    approvedBy: "SUTECBA",
    approvedOn: "2026-09-22",
    source: "https://buenosaires.gob.ar/organigrama/ministerio-de-justicia-mjgc",
    reason: "Secretaría vigente bajo Ministerio de Justicia.",
  },
  {
    key: "SECSEG",
    name: "Secretaría de Seguridad",
    tipo: "Secretaría",
    parentKey: "MSEGC",
    approvedBy: "SUTECBA",
    approvedOn: "2026-09-22",
    source: "https://buenosaires.gob.ar/organigrama/ministerio-de-seguridad-msegc",
    reason: "Padre oficial de la Jefatura de Policía.",
  },
  {
    key: "SSRCYAIIS",
    name: "Subsecretaría Relaciones con la Comunidad y Asuntos Interjurisdiccionales e Internacionales en Seguridad",
    tipo: "Subsecretaría",
    parentKey: "SECSEG",
    approvedBy: "SUTECBA",
    approvedOn: "2026-09-22",
    source: "https://buenosaires.gob.ar/organigrama/ministerio-de-seguridad-msegc",
    reason: "Padre oficial de DGCOCAP.",
  },
  {
    key: "JPCDAD",
    name: "Jefatura de Policía de la Ciudad",
    tipo: "Dependencia",
    parentKey: "SECSEG",
    approvedBy: "SUTECBA",
    approvedOn: "2026-09-22",
    source: "https://buenosaires.gob.ar/organigrama/ministerio-de-seguridad-msegc",
    reason: "Permite mapear «Policía de la Ciudad» sin degradarla al ministerio.",
  },
  {
    key: "DGCOCAP",
    name: "Dirección General Coordinación Operativa del Cuerpo de Agentes de Prevención",
    tipo: "Dirección General",
    parentKey: "SSRCYAIIS",
    approvedBy: "SUTECBA",
    approvedOn: "2026-09-22",
    source: "https://buenosaires.gob.ar/organigrama/ministerio-de-seguridad-msegc",
    reason: "Unidad oficial vigente para «Cuerpo de Agentes de Prevención».",
  },
  {
    key: "HRR",
    name: 'Hospital de Rehabilitación "Manuel Rocca"',
    tipo: "Dependencia",
    parentKey: "MSGC",
    approvedBy: "SUTECBA",
    approvedOn: "2026-09-22",
    source: "https://buenosaires.gob.ar/salud/recursos-humanos/hospde-rehabilitacion-m-rocca-91",
    reason: "Unidad organizativa de destino dependiente del Ministerio de Salud.",
  },
  {
    key: "SSCIUI",
    name: "Subsecretaría Ciudad Inteligente",
    tipo: "Subsecretaría",
    parentKey: "SECITD",
    approvedBy: "SUTECBA",
    approvedOn: "2026-09-22",
    source: "https://buenosaires.gob.ar/organigrama/jefatura-de-gabinete-de-ministros-mjggc",
    reason: "Padre oficial de DGSACIU; aparece en una de las fuentes nuevas.",
  },
  {
    key: "DGSACIU",
    name: "Dirección General Sistemas de Atención Ciudadana",
    tipo: "Dirección General",
    parentKey: "SSCIUI",
    approvedBy: "SUTECBA",
    approvedOn: "2026-09-22",
    source: "https://buenosaires.gob.ar/organigrama/jefatura-de-gabinete-de-ministros-mjggc",
    reason: "Código oficial presente en una de las fuentes nuevas (texto «dgsaciu»).",
  },
];

/** Forma que exige el planificador del catálogo (misma estructura que una fila de `Organismos_Oficiales`). */
export function orgAdditionToCatalogRow(a: ApprovedOrgAddition): CatalogOrgRow {
  return {
    canonical_key: a.key,
    codigo_oficial: a.key,
    nombre_oficial: a.name,
    tipo: a.tipo,
    parent_key: a.parentKey,
    vigente: "Sí",
    nivel_fuente: null,
    fuente_oficial: a.source,
    verificado: "Sí",
    notas: `${a.approvedBy} ${a.approvedOn}: ${a.reason}`,
  };
}
