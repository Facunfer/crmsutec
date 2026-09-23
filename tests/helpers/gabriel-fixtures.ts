import { createHash } from "node:crypto";
import { cuilCheckDigit } from "../../lib/imports/gabriel/normalize.js";
import type { Cell, ExtractedFile, ExtractedRow, FileCode } from "../../lib/imports/gabriel/types.js";

/**
 * Fuentes SINTÉTICAS con la misma estructura que las de Gabriel (docs/importacion-gabriel-mapeo.md):
 * ningún dato real. Los DNI y CUIL se fabrican con dígito verificador válido.
 */

/** CUIL válido (prefijo 20/27) cuyo DNI contenido es `dni` (7 u 8 dígitos). */
export function cuilFor(dni: string, prefix = "20"): string {
  const middle = dni.padStart(8, "0");
  const first10 = `${prefix}${middle}`;
  return `${first10}${cuilCheckDigit(first10)}`;
}

export const date = (iso: string): Cell => ({ $date: iso });

let sequence = 0;
const sha = (name: string) => createHash("sha256").update(`${name}:${++sequence}`).digest("hex");

export function makeFile(fileCode: FileCode, fileName: string, sheets: Array<{ name: string; rows: Cell[][]; firstRow?: number }>): ExtractedFile {
  return {
    fileCode,
    fileName,
    sha256: sha(fileName),
    sizeBytes: 1000,
    sheets: sheets.map((s) => ({
      name: s.name,
      rows: s.rows.map((cells, i): ExtractedRow => ({ n: (s.firstRow ?? 1) + i, cells })),
    })),
  };
}

/** F06 fila L1: [ts, email, apellido, nombre, DNI, fnac, edad, obra social, ¿afiliado?, celular, ministerio] */
export const f06L1 = (p: { last: string; first: string; dni: string; email: string; phone?: string; affiliated?: string }): Cell[] => [
  date("2026-02-01"), p.email, p.last, p.first, p.dni, date("1980-05-05"), 46, "OBSBA", p.affiliated ?? "NO", p.phone ?? "1155550001", "Educación",
];
/** F06 fila L2 (Educación): [ts, apellido, nombre, email, DNI, fnac, edad, os, nº afiliado, ¿afiliado?, celular, ministerio, email2] */
export const f06L2 = (p: { last: string; first: string; dni: string; email: string }): Cell[] => [
  date("2026-02-01"), p.last, p.first, p.email, p.dni, date("1981-06-06"), 45, "OBSBA", "123", "SI", "1155550002", "Educación", null,
];
/** F06 fila L3 (Teatro Colón): [ts, email, apellido, nombre, email2, DNI, fnac, edad, os, nº, ¿afiliado?, celular, ministerio] */
export const f06L3 = (p: { last: string; first: string; dni: string; email: string }): Cell[] => [
  date("2026-02-01"), p.email, p.last, p.first, p.email, p.dni, date("1982-07-07"), 44, "OSDE", "999", "NO", "1155550003", "Cultura",
];
/** F06 fila L4 (Cruz Malta, sin marca temporal): [apellido, nombre, email, DNI, fnac, edad, os, nº, ¿afiliado?, celular, ministerio, email2] */
export const f06L4 = (p: { last: string; first: string; dni: string; email: string }): Cell[] => [
  p.last, p.first, p.email, p.dni, date("1983-08-08"), 43, "OBSBA", null, "SI", "1155550004", "Salud", null,
];

/** F02/F05: listado de cursada (bloque de título + encabezado en la fila 8 + datos desde la 9). */
export function courseListFile(
  fileCode: "F02" | "F05",
  fileName: string,
  header: { code?: string; when?: string },
  people: Array<{ cuil: string; last: string; first: string; email?: string; phone?: string; organism?: string }>
): ExtractedFile {
  const rows: Array<{ n: number; cells: Cell[] }> = [
    { n: 1, cells: [null, "Descargue el archivo para poder editarlo."] },
    { n: 2, cells: [null, "TODOS LOS DATOS SON DE CARÁCTER OBLIGATORIO"] },
    { n: 6, cells: [null, "Número de Cursada", header.code ? Number(header.code) : null] },
    { n: 7, cells: [null, "Fecha y hora:", header.when ?? null] },
    { n: 8, cells: [null, "CUIL (sin guiones)", "Apellidos", "Nombres", "Fecha de Ingreso", "Modalidad", "Repartición", "Área", "Jefe", "Email oficial", "Email alternativo", "Teléfono", "Régimen"] },
    ...people.map((p, i) => ({
      n: 9 + i,
      cells: [i + 1, p.cuil, p.last, p.first, date("2020-01-01"), "Planta", p.organism ?? "Ministerio X", "Área", "Jefe", p.email ?? null, null, p.phone ?? null, "General"] as Cell[],
    })),
  ];
  return { fileCode, fileName, sha256: sha(fileName), sizeBytes: 1000, sheets: [{ name: "Listado alumnos", rows }, { name: "Hoja 2", rows: [{ n: 1, cells: [null, "auxiliar"] }] }] };
}

/** PDF (F01/F03): encabezado + filas con "APELLIDO Y NOMBRE" en una sola celda. */
export function pdfResponsesFile(fileCode: "F01" | "F03", fileName: string, people: Array<{ cuil: string; fullName: string }>): ExtractedFile {
  const header: Cell[] = ["Marca temporal", "CUIL sin guiones", "APELLIDO Y NOMBRE", "FECHA DE INGRESO", "MODALIDAD", "REPARTICION", "AREA", "JEFE", "MAIL OFICIAL", "MAIL ALTERNATIVO", "TELEFONO", "ES AFILIADO A SUTECBA?"];
  return makeFile(fileCode, fileName, [
    { name: "p1", rows: [header, ...people.map((p): Cell[] => ["01/09/2026 10:00:00", p.cuil, p.fullName, "01/01/2020", "Planta", "Repartición", "Área", "Jefe", null, null, null, "SI"])] },
  ]);
}

/** F08: agenda de oftalmología. */
export function agendaFile(rows: Array<[string, string | null, string | null]>): ExtractedFile {
  const header: Cell[] = [null, "Fecha", "Repartición", "Dirección"];
  return makeFile("F08", "OFTALMO 2026.xlsx", [
    {
      name: "Hoja1",
      rows: [header, ...rows.map(([day, iso, sede]): Cell[] => [day, iso ? date(iso) : null, sede, null])],
    },
  ]);
}

/** F09: formulario con encabezado (13 columnas principales) + una fila residual. */
export function f09File(
  people: Array<{ last: string; first: string; dni: string; email: string; phone?: string; birth?: string; organism?: string }>,
  options: { residual?: boolean } = {}
): ExtractedFile {
  const header: Cell[] = ["Marca temporal", "Dirección de correo", "Apellido", "Nombre", "Correo Electrónico", "DNI", "Fecha de Nacimiento", "Edad", "Obra Social", "Nº Afiliado", "Es afiliado a SUTECBA", "Cel", "Ministerio"];
  const rows = people.map((p): Cell[] => [date("2026-02-02"), p.email, p.last, p.first, p.email, p.dni, date(p.birth ?? "1985-01-01"), 41, "OBSBA", "77", "SI", p.phone ?? "1155551111", p.organism ?? "Cultura"]);
  if (options.residual) rows.push([null, null, null, null, null, null, null, null, null, null, null, null, null, null, 5]);
  return makeFile("F09", "Oftalmo Teatro Colón (Respuestas).xlsx", [{ name: "Respuestas de formulario 1", rows: [header, ...rows] }]);
}

/** F10: padrón con encabezado y una sección de "referidos" sin CUIL. */
export function f10File(
  people: Array<{ last: string; first: string; cuil: string; phone?: string }>,
  referidos: Array<{ last: string; first: string; phone?: string }> = []
): ExtractedFile {
  const header: Cell[] = ["APELLIDO", "NOMBRE", "CUIL", "CELULAR"];
  const rows: Cell[][] = [header, ...people.map((p): Cell[] => [p.last, p.first, p.cuil, p.phone ?? null])];
  if (referidos.length > 0) {
    rows.push(["REFERIDOS DE PRUEBA"]);
    rows.push(...referidos.map((p): Cell[] => [p.last, p.first, null, p.phone ?? null]));
  }
  return makeFile("F10", "abogados unificado.xlsx", [{ name: "PADRON UNIFICADO", rows }]);
}

export function f07File(people: Array<{ last: string; first: string; cuil: string; email?: string; phone?: string; organism?: string }>): ExtractedFile {
  const header: Cell[] = ["Apellido", "Nombre", "Cuit/Cuil", "Telefono Particular", "Mail Personal", "Telefono Celular", "Profesión", "Mail GCBA", "Repartición", "Dirección", "Departamento", "Situación revista"];
  return makeFile("F07", "Padrón PG.xls", [
    {
      name: "Resultados Buda",
      rows: [header, ...people.map((p): Cell[] => [p.last, p.first, p.cuil, null, p.email ?? null, p.phone ?? null, "Abogado", null, p.organism ?? "Procuración", null, null, "Planta"])],
    },
  ]);
}
