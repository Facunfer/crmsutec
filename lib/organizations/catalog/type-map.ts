/**
 * Tipos de organización del catálogo → `organization_types`. Los cuatro niveles de la regla de jerarquía
 * (organismo padre → secretaría/subsecretaría → dirección general → unidad interna) ya existían; el resto de los
 * tipos oficiales del catálogo se agregan (idempotente, por `key`) sin reinterpretarlos como otro nivel.
 */
export interface OrgTypeDef {
  key: string;
  name: string;
  level: number;
}

const T = (key: string, name: string, level: number): OrgTypeDef => ({ key, name, level });

/** Texto de la columna `tipo` del catálogo → definición de tipo. */
export const CATALOG_TYPE_MAP: Readonly<Record<string, OrgTypeDef>> = {
  Jefatura: T("jefatura", "Jefatura", 0),
  Vicejefatura: T("vicejefatura", "Vicejefatura", 0),
  "Jefatura de Gabinete": T("jefatura_gabinete", "Jefatura de Gabinete", 1),
  Ministerio: T("ministerio", "Ministerio", 1),
  Agencia: T("agencia", "Agencia", 1),
  "Ente autárquico": T("ente_autarquico", "Ente autárquico", 1),
  "Organismo fuera de nivel": T("organismo_fuera_de_nivel", "Organismo fuera de nivel", 1),
  Dependencia: T("dependencia", "Dependencia", 2),
  Secretaría: T("secretaria", "Secretaría", 2),
  "Procuración Adjunta": T("procuracion_adjunta", "Procuración Adjunta", 2),
  Subsecretaría: T("subsecretaria", "Subsecretaría", 3),
  "Dirección General": T("direccion_general", "Dirección General", 4),
  "Subdirección General": T("subdireccion_general", "Subdirección General", 4),
  "Coordinación General": T("coordinacion_general", "Coordinación General", 4),
  Dirección: T("direccion", "Dirección", 5),
  Unidad: T("unidad", "Unidad", 5),
  "Unidad de Auditoría Interna": T("unidad_auditoria_interna", "Unidad de Auditoría Interna", 5),
  "Dirección/área artística": T("area_artistica", "Dirección/área artística", 5),
  "Unidad Operativa": T("unidad_operativa", "Unidad Operativa", 6),
  Departamento: T("departamento", "Departamento", 7),
  División: T("division", "División", 8),
};
