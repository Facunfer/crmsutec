/**
 * Aliases GLOBALES aprobados por decisión humana de SUTECBA que no vienen como AUTO_MAP en el catálogo V2.
 * Cada uno resuelve, sin contexto, a UNA organización oficial ya catalogada; entran al plan como aliases aprobados y
 * cambian el `plan_hash` del catálogo. Solo se agrega acá lo que SUTECBA aprobó explícitamente; el resto de los
 * pendientes (PROBABLE / AMBIGUO / REVISAR) sigue sin cargarse.
 */
export interface ApprovedAliasAddition {
  /** Texto tal cual aparece en las bases de Gabriel. */
  alias: string;
  /** `official_code` / `canonical_key` de la organización destino (debe existir en el catálogo o en la base). */
  targetKey: string;
  approvedBy: string;
  approvedOn: string;
  reason: string;
}

export const APPROVED_ADDITIONS: readonly ApprovedAliasAddition[] = [
  {
    alias: "Ministerio de Espacio Publico",
    targetKey: "MEPHUGC",
    approvedBy: "SUTECBA",
    approvedOn: "2026-09-21",
    reason: "Única unidad oficial cuyo nombre comienza con «Ministerio de Espacio Público» (Ministerio de Espacio Público e Higiene Urbana).",
  },
  {
    alias: "Sindicatura General de la Ciudad",
    targetKey: "SGCBA",
    approvedBy: "SUTECBA",
    approvedOn: "2026-09-21",
    reason: "Única sindicatura del catálogo: nombre oficial sin «de Buenos Aires» (ya hay alias seguros «Sindicatura» y el nombre completo hacia SGCBA).",
  },

  // ---- 2026-09-22: nuevas_organismos_pendientes_DECISIONES_PROPUESTAS.xlsx, decisión APPROVE_ALIAS (21) ----
  { alias: "Ministerio de Justicia", targetKey: "MJGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Nombre oficial inequívoco." },
  { alias: "Seguridad", targetKey: "MSEGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "En el campo de repartición/ministerio se interpreta como el Ministerio de Seguridad." },
  { alias: "Desarrollo humano", targetKey: "MDHYHGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Equivalencia inequívoca con Ministerio de Desarrollo Humano y Hábitat." },
  { alias: "Desarrollo Humano y Ha", targetKey: "MDHYHGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Truncamiento inequívoco de Desarrollo Humano y Hábitat." },
  { alias: "Desarrollo social", targetKey: "MDHYHGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "En el contexto IVC corresponde al área de Desarrollo Humano y Hábitat." },
  { alias: "Desarrollo social y habita", targetKey: "MDHYHGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Variante histórica/informal de Desarrollo Humano y Hábitat." },
  { alias: "Desarrollo y habitad", targetKey: "MDHYHGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Error ortográfico inequívoco de Desarrollo Humano y Hábitat." },
  { alias: "Desarrollo y hábitat", targetKey: "MDHYHGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Variante abreviada de Desarrollo Humano y Hábitat." },
  { alias: "DESARROLLO ECONOMI", targetKey: "MDECGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Truncamiento inequívoco de Ministerio de Desarrollo Económico." },
  { alias: "Desarrollo Habitat y hum", targetKey: "MDHYHGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Mismas palabras de Desarrollo Humano y Hábitat en otro orden." },
  { alias: "Instituto de Estadística y", targetKey: "IDECBA", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Truncamiento inequívoco de Instituto de Estadística y Censos." },
  { alias: "MDH", targetKey: "MDHYHGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Abreviatura de Ministerio de Desarrollo Humano en contexto IVC." },
  { alias: "MdhA", targetKey: "MDHYHGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Abreviatura de Desarrollo Humano y Hábitat en contexto IVC." },
  { alias: "Min de justicia", targetKey: "MJGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Abreviatura inequívoca de Ministerio de Justicia." },
  { alias: "min. Justicia", targetKey: "MJGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Abreviatura inequívoca de Ministerio de Justicia." },
  { alias: "Ministerio de desarrollo y", targetKey: "MDHYHGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "En el operativo IVC, el texto truncado corresponde a Desarrollo Humano y Hábitat." },
  { alias: "Ministerio de justicia/ Dir", targetKey: "MJGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "La parte identificable y segura es Ministerio de Justicia." },
  { alias: "Ministerio desarollo hum", targetKey: "MDHYHGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Truncamiento/typo inequívoco de Ministerio de Desarrollo Humano." },
  { alias: "Ministerio Desarrollo y H", targetKey: "MDHYHGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Truncamiento inequívoco de Ministerio de Desarrollo Humano y Hábitat." },
  { alias: "PAIU", targetKey: "DGPPAU", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "PAIU es un programa bajo el área de Atención e Integración a personas con discapacidad (DGPPAU)." },
  { alias: "Salud", targetKey: "MSGC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "En el campo de repartición/ministerio se interpreta como el Ministerio de Salud." },

  // ---- 2026-09-22: decisión CREATE_ORGANIZATION — alias hacia la unidad recién creada (18) ----
  { alias: "IVC", targetKey: "IVC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Alta de catálogo aprobada: Instituto de Vivienda de la Ciudad." },
  { alias: "Instituto de la Vivienda d", targetKey: "IVC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Truncamiento inequívoco de Instituto de Vivienda de la Ciudad." },
  { alias: "Instituto de Vivienda", targetKey: "IVC", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Nombre inequívoco del Instituto de Vivienda de la Ciudad." },
  { alias: "Secretaria de Deportes", targetKey: "SECD", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Alta de catálogo aprobada: Secretaría de Deportes." },
  { alias: "SECD", targetKey: "SECD", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Código oficial de Secretaría de Deportes." },
  { alias: "SECRETARÍA DE DEPORT", targetKey: "SECD", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Truncamiento inequívoco de Secretaría de Deportes." },
  { alias: "secretaria Deporte", targetKey: "SECD", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Variante inequívoca de Secretaría de Deportes." },
  { alias: "Secretaria de trabajo y e", targetKey: "SECTE", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Alta de catálogo aprobada: Secretaría de Trabajo y Empleo." },
  { alias: "SECRETARIA DE TRABAJ", targetKey: "SECTE", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Truncamiento inequívoco de Secretaría de Trabajo y Empleo." },
  { alias: "Secretatoa de Trabajo", targetKey: "SECTE", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Error ortográfico inequívoco de Secretaría de Trabajo y Empleo." },
  { alias: "secte", targetKey: "SECTE", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Código oficial exacto." },
  { alias: "trabajo y empleo", targetKey: "SECTE", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Nombre inequívoco de Secretaría de Trabajo y Empleo." },
  { alias: "Policía ciudad", targetKey: "JPCDAD", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Alta de catálogo aprobada: Jefatura de Policía de la Ciudad." },
  { alias: "Policía de la ciudad", targetKey: "JPCDAD", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Crear Jefatura de Policía de la Ciudad y aprobar el alias por nombre completo." },
  { alias: "Cuerpo de agentes de pr", targetKey: "DGCOCAP", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Alta de catálogo aprobada: DG Coordinación Operativa del Cuerpo de Agentes de Prevención." },
  { alias: "DGCOCAP", targetKey: "DGCOCAP", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Código oficial exacto." },
  { alias: "Seguridad- Cuerpo agent", targetKey: "DGCOCAP", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "La referencia a Cuerpo de Agentes de Prevención permite ir más allá del ministerio." },
  { alias: "Hospital rocca", targetKey: "HRR", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Alta de catálogo aprobada: Hospital de Rehabilitación «Manuel Rocca»." },

  // ---- 2026-09-22: decisión humana pendiente resuelta — alias exacto y global hacia DGSACIU (código oficial) ----
  { alias: "dgsaciu", targetKey: "DGSACIU", approvedBy: "SUTECBA", approvedOn: "2026-09-22", reason: "Alias exacto del código oficial de Dirección General Sistemas de Atención Ciudadana (DGSACIU), alta ya incluida y validada en Altas_catalogo_propuestas." },
];
