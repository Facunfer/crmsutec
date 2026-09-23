import type { FileCode } from "./types.js";

/**
 * Archivos que pertenecen INEQUÍVOCAMENTE a una sola jurisdicción: su contenido sirve como contexto para resolver
 * aliases homónimos (DGTAL, UAI…). Clave = código de archivo; valor = `official_code` de la organización.
 *
 *   F07 «Padrón PG.xls» — padrón de la Procuración General → PG.
 *
 * NUNCA agregar acá un archivo con varias jurisdicciones (padrones generales por repartición, listados de cursos,
 * formularios abiertos): ahí el contexto tiene que salir de la fila o de la persona, no del archivo.
 */
export const FILE_JURISDICTION_KEYS: Readonly<Partial<Record<FileCode, string>>> = { F07: "PG" };
