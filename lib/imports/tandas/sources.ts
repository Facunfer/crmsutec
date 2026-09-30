import {
  cellToText,
  comparableText,
  cuilChecksumValid,
  deriveDniFromCuil,
  digitsOnly,
  normalizeContactEmail,
  normalizeContactPhone,
  normalizeCuilValue,
  normalizeDniValue,
  parseDateAndTimeRange,
} from "../gabriel/normalize.js";
import { parseBirthDate } from "../gabriel/nuevas.js";
import { validateBirthDate, type BirthDateRejection } from "../../people/birth-date.js";
import type { Cell, ExtractedFile } from "../gabriel/types.js";

/**
 * Fuentes de las tandas 1 y 2 (22 archivos, T01..T22). Parseo puro: no toca la base ni imprime datos personales.
 * El mapeo funcional de cada fuente (actividad, tipo, semántica de la participación) está confirmado por negocio; acá solo
 * se lee lo que la fuente REALMENTE trae. Las cabeceras se detectan por nombre en el archivo real, nunca por posición fija.
 */

export const TANDA_CODES = Array.from({ length: 22 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`) as string[];

/** Cómo se lee cada archivo. */
export type Layout = "form_dni" | "form_cuil" | "vaccine_antigripal" | "listado" | "padron_pg" | "padron_abogados";

/** Semántica del hecho que acredita cada fuente (decisión de negocio ya confirmada). */
export type FactSemantics =
  | "participation_by_rule" // la respuesta/listado acredita participación efectiva (NO asistencia, NO check-in)
  | "registration_only" // inscripción: no acredita participación (52016)
  | "none"; // padrones: identidad/laboral/etiqueta, sin actividad

export interface ActivityDef {
  /** `campaign`: participación con campaign_key; `meeting`: participación con reunión (source_event_key). */
  target: "campaign" | "meeting";
  key: string;
  name: string;
  type: "campana" | "capacitacion";
  /** Fecha real de la fuente (cabecera del listado). null = sin determinar. NUNCA el timestamp del formulario. */
  eventDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
}

export interface SourceDef {
  code: string;
  layout: Layout;
  semantics: FactSemantics;
  activity: ActivityDef | null;
  /** Copia física de otra fuente (misma cursada): procedencia adicional, mismo hecho lógico. */
  copyOf?: string;
  /** Archivos previamente cargados que podrían ser la misma fuente (por `import_files.original_name`). */
  previouslyLoadedAs?: string[];
  /** Campaña oftalmológica: los días de la fuente se cotejan con las jornadas existentes de la sede. */
  jornadaSede?: string;
}

const oft = (sede: string, name: string): ActivityDef => ({ target: "campaign", key: `ophthalmology:${sede}`, name, type: "campana" });
const training = (key: string, name: string, extra: Partial<ActivityDef> = {}): ActivityDef => ({ target: "meeting", key: `training:${key}`, name, type: "capacitacion", ...extra });

export const SOURCES: SourceDef[] = [
  { code: "T01", layout: "form_dni", semantics: "participation_by_rule", activity: { target: "campaign", key: "vaccination:2026", name: "Campaña de vacunación 2026", type: "campana" } },
  { code: "T02", layout: "form_cuil", semantics: "participation_by_rule", activity: training("primeros-auxilios-psicologicos-procuracion-general", "Primeros auxilios psicológicos — Procuración General") },
  { code: "T03", layout: "padron_pg", semantics: "none", activity: null, previouslyLoadedAs: ["Padrón PG.xls", "Padrón PG.xls.pdf"] },
  { code: "T04", layout: "padron_abogados", semantics: "none", activity: null },
  { code: "T05", layout: "form_dni", semantics: "participation_by_rule", activity: oft("teatro-colon", "Campaña oftalmológica — Teatro Colón"), jornadaSede: "teatro-colon", previouslyLoadedAs: ["Oftalmo Teatro Colón (Respuestas).xlsx", "Oftalmo Teatro Colón.pdf"] },
  { code: "T06", layout: "form_dni", semantics: "participation_by_rule", activity: oft("ss-trabajo", "Campaña oftalmológica — Subsecretaría de Trabajo"), jornadaSede: "ss-trabajo", previouslyLoadedAs: ["Oftalmo SS. Trabajo.pdf"] },
  { code: "T07", layout: "form_dni", semantics: "participation_by_rule", activity: oft("ivc", "Campaña oftalmológica — IVC"), jornadaSede: "ivc", previouslyLoadedAs: ["Oftalmo IVC (Respuestas) - Respuestas de formulario 1.pdf"] },
  { code: "T08", layout: "form_dni", semantics: "participation_by_rule", activity: oft("infraestructura-escolar", "Campaña oftalmológica — Infraestructura Escolar"), jornadaSede: "infraestructura-escolar" },
  { code: "T09", layout: "form_dni", semantics: "participation_by_rule", activity: oft("cruz-malta", "Campaña oftalmológica — Cruz Malta"), jornadaSede: "cruz-malta", previouslyLoadedAs: ["Oftalmo Cruz Malta.pdf"] },
  { code: "T10", layout: "form_dni", semantics: "participation_by_rule", activity: oft("centro-metropolitano-de-diseno", "Campaña oftalmológica — Centro Metropolitano de Diseño"), jornadaSede: "centro-metropolitano-de-diseno", previouslyLoadedAs: ["Oftalmo Centro Metropolitano de Diseño.pdf"] },
  { code: "T11", layout: "form_dni", semantics: "participation_by_rule", activity: oft("canale", "Campaña oftalmológica — Canale"), jornadaSede: "canale", previouslyLoadedAs: ["oftalmo CANALE.pdf"] },
  { code: "T12", layout: "form_dni", semantics: "participation_by_rule", activity: oft("asi", "Campaña oftalmológica — ASI"), jornadaSede: "asi", previouslyLoadedAs: ["Oftalmo Asi.pdf"] },
  { code: "T13", layout: "form_cuil", semantics: "participation_by_rule", activity: training("ley-6357-integridad-publica-cruz-malta", "Ley 6357 — Integridad pública — Cruz Malta") },
  { code: "T14", layout: "form_dni", semantics: "participation_by_rule", activity: oft("ministerio-de-justicia", "Campaña oftalmológica — Ministerio de Justicia"), jornadaSede: "ministerio-de-justicia" },
  { code: "T15", layout: "vaccine_antigripal", semantics: "participation_by_rule", activity: { target: "campaign", key: "vaccination:2026", name: "Campaña de vacunación 2026", type: "campana" } },
  { code: "T16", layout: "listado", semantics: "participation_by_rule", activity: training("53120", "Ley 6354 — Personas mayores, enfoque en derechos y prevención de las violencias — Teatro Colón") },
  { code: "T17", layout: "listado", semantics: "participation_by_rule", activity: training("53120", "Ley 6354 — Personas mayores, enfoque en derechos y prevención de las violencias — Teatro Colón"), copyOf: "T16" },
  { code: "T18", layout: "listado", semantics: "participation_by_rule", activity: training("primeros-auxilios-psicologicos-agc", "Primeros auxilios psicológicos — AGC"), previouslyLoadedAs: ["A.G.C - Primeros auxilio psicologicos (Respuestas).xlsx", "AGC-CAPACITACION 2026 (Respuestas).pdf"] },
  { code: "T19", layout: "listado", semantics: "participation_by_rule", activity: training("52976", "Competencias comunicacionales para el trabajo en equipo — Teatro Colón") },
  { code: "T20", layout: "listado", semantics: "registration_only", activity: training("52016", "Primeros auxilios — Cruz Malta") },
  { code: "T21", layout: "listado", semantics: "registration_only", activity: training("52016", "Primeros auxilios — Cruz Malta"), copyOf: "T20" },
  { code: "T22", layout: "form_cuil", semantics: "participation_by_rule", activity: training("primeros-auxilios-psicologicos-cruz-malta", "Primeros auxilios psicológicos — Cruz Malta") },
];

export const sourceDef = (code: string) => SOURCES.find((s) => s.code === code)!;

// ---------------------------------------------------------------- filas

export type IdentityProblem = "MISSING_IDENTIFIER" | "INVALID_DNI" | "INVALID_CUIL" | "DNI_CUIL_MISMATCH" | "DOC_TYPE_NOT_DNI" | "PRECISION_LOSS";

export interface IncomingRow {
  file: string;
  sheet: string;
  /** Fila FÍSICA (1-based) de la hoja original. */
  row: number;
  /** `person`: fila útil. `blank`: sin contenido. `header`/`residual`: cabecera, títulos, separadores. */
  rowKind: "person" | "blank" | "header" | "residual";
  last: string | null;
  first: string | null;
  full: string | null;
  dni: string | null;
  dniSource: "explicit" | "derived_from_cuil" | null;
  cuil: string | null;
  problem: IdentityProblem | null;
  email: string | null;
  phone: string | null;
  birthDate: string | null;
  birthIssue: BirthDateRejection | null;
  /** Textos de repartición/ministerio (organismo donde trabaja la persona según la fuente). */
  orgTexts: string[];
  /** Área/dirección/departamento libres: informativos, nunca resuelven ni sirven de contexto. */
  areaTexts: string[];
  /** Día de jornada informado por la fuente (texto o AAAA-MM-DD). */
  dayText: string | null;
  vaccines: string[];
  vaccineAnomalies: number;
  college: string | null;
  /** Para el padrón de abogados. */
  docType: string | null;
  sequence?: number;
}

const blankRow = (file: string, sheet: string, row: number, rowKind: IncomingRow["rowKind"]): IncomingRow => ({
  file, sheet, row, rowKind, last: null, first: null, full: null, dni: null, dniSource: null, cuil: null, problem: null, email: null, phone: null,
  birthDate: null, birthIssue: null, orgTexts: [], areaTexts: [], dayText: null, vaccines: [], vaccineAnomalies: 0, college: null, docType: null,
});

const txt = (c: Cell | undefined) => cellToText(c);

/** Índice de columnas por nombre comparable (prefijo). Devuelve -1 si no existe. */
class Headers {
  private readonly keys: string[];
  constructor(cells: Cell[]) {
    this.keys = cells.map((c) => comparableText(txt(c)));
  }
  find(...names: string[]): number {
    for (const n of names) {
      const k = comparableText(n);
      const i = this.keys.findIndex((h) => h === k);
      if (i !== -1) return i;
    }
    for (const n of names) {
      const k = comparableText(n);
      const i = this.keys.findIndex((h) => h !== "" && h.startsWith(k));
      if (i !== -1) return i;
    }
    return -1;
  }
}

interface RawIdentity {
  dni: string | null;
  dniSource: IncomingRow["dniSource"];
  cuil: string | null;
  problem: IdentityProblem | null;
}

/**
 * Identidad de una fila. DNI = solo dígitos, 7–8. CUIL = 11 dígitos con verificador válido; el DNI solo se deriva del CUIL
 * cuando no hay DNI explícito y con la regla del sistema. Contradicciones, valores truncados o inválidos NO se corrigen.
 */
export function identityOf(dniCell: Cell | undefined, cuilCell: Cell | undefined): RawIdentity {
  const dniText = txt(dniCell);
  const cuilText = txt(cuilCell);
  // Excel numérico con pérdida de precisión (p. ej. 2.7123456789E10 leído como 27123456788.999): no se adivina.
  const lossy = (c: Cell | undefined) => typeof c === "number" && !Number.isInteger(c);
  if (lossy(dniCell) || lossy(cuilCell)) return { dni: null, dniSource: null, cuil: null, problem: "PRECISION_LOSS" };

  let dniRaw = dniText;
  let cuilRaw = cuilText;
  // Un CUIL/CUIT escrito en la columna de DNI (11 dígitos) se trata como CUIL, sin perder la procedencia.
  if (dniRaw && /^[\d.\-\s]+$/.test(dniRaw) && digitsOnly(dniRaw).length === 11 && !cuilRaw) {
    cuilRaw = dniRaw;
    dniRaw = null;
  }
  if (!dniRaw && !cuilRaw) return { dni: null, dniSource: null, cuil: null, problem: "MISSING_IDENTIFIER" };

  const explicit = normalizeDniValue(dniRaw);
  const cuil = normalizeCuilValue(cuilRaw);
  const derived = cuil.valid && cuil.digits ? deriveDniFromCuil(cuil.digits) : null;
  if (dniRaw && explicit === null && !derived) return { dni: null, dniSource: null, cuil: cuil.valid ? cuil.digits : null, problem: "INVALID_DNI" };
  if (explicit && derived && explicit !== derived) return { dni: null, dniSource: null, cuil: cuil.digits, problem: "DNI_CUIL_MISMATCH" };
  if (explicit) return { dni: explicit, dniSource: "explicit", cuil: cuil.valid ? cuil.digits : null, problem: null };
  if (derived) return { dni: derived, dniSource: "derived_from_cuil", cuil: cuil.digits, problem: null };
  return { dni: null, dniSource: null, cuil: null, problem: cuilRaw ? "INVALID_CUIL" : "MISSING_IDENTIFIER" };
}

function birthOf(cell: Cell | undefined): { birthDate: string | null; birthIssue: BirthDateRejection | null } {
  if (cell === null || cell === undefined) return { birthDate: null, birthIssue: null };
  const iso = typeof cell === "object" ? ("$date" in cell ? cell.$date : cell.$datetime.slice(0, 10)) : parseBirthDate(txt(cell));
  if (!iso) return { birthDate: null, birthIssue: txt(cell) ? "INVALID_BIRTH_DATE" : null };
  const v = validateBirthDate(iso, "2026-09-30");
  return v.ok ? { birthDate: iso, birthIssue: null } : { birthDate: null, birthIssue: v.issue };
}

const VACCINES: Array<[string, RegExp]> = [
  ["antigripal", /^antigripal$/],
  ["antigripal_mayor_65", /^antigripal mayor de 65$/],
  ["prevenar_20", /^prevenar 20$/],
  ["covid", /^covid$/],
  ["hepatitis_b", /^hepatitis b$/],
  ["doble_adultos", /^doble adultos$/],
];

function isBlank(cells: Cell[]): boolean {
  return cells.every((c) => c === null || c === undefined || txt(c) === null);
}

export interface ParsedFile {
  code: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  sheets: Array<{ name: string; physicalRows: number }>;
  rows: IncomingRow[];
  headerRow: number | null;
  headerSheet: string | null;
  /** Fecha/hora informada en la cabecera del listado (texto crudo) y su interpretación. */
  listadoDate: { raw: string | null; date: string | null; start: string | null; end: string | null } | null;
  courseNumber: string | null;
  notes: string[];
}

function sheetOf(f: ExtractedFile, name: string) {
  return f.sheets.find((s) => s.name === name);
}

export function parseTandaFile(file: ExtractedFile): ParsedFile {
  const def = sourceDef(file.fileCode);
  const out: ParsedFile = {
    code: file.fileCode, fileName: file.fileName, sha256: file.sha256, sizeBytes: file.sizeBytes,
    sheets: file.sheets.map((s) => ({ name: s.name, physicalRows: s.rows.length })),
    rows: [], headerRow: null, headerSheet: null, listadoDate: null, courseNumber: null, notes: [],
  };
  const main = def.layout === "listado" ? sheetOf(file, "Listado alumnos") : def.layout === "padron_abogados" ? sheetOf(file, "Padron definitivo") : file.sheets[0];
  if (!main) throw new Error(`${file.fileCode}: hoja principal no encontrada`);
  // Hojas secundarias: solo se cuentan como residuales (plantilla de listado, estadísticas vacías).
  for (const s of file.sheets) if (s !== main) for (const r of s.rows) out.rows.push(blankRow(file.fileCode, s.name, r.n, isBlank(r.cells) ? "blank" : "residual"));

  // cabecera: primera fila que contiene las columnas de identidad del layout
  const wantsHeader = (cells: Cell[]) => {
    const h = new Headers(cells);
    switch (def.layout) {
      case "form_dni": return h.find("dni") !== -1 && h.find("apellido") !== -1;
      case "form_cuil": return h.find("cuil sin guiones") !== -1;
      case "vaccine_antigripal": return h.find("documento") !== -1 && h.find("nombre y apellido") !== -1;
      case "listado": return h.find("cuil sin guiones") !== -1 && h.find("apellidos") !== -1;
      case "padron_pg": return h.find("cuit cuil") !== -1 || h.find("cuit/cuil") !== -1;
      case "padron_abogados": return h.find("nro doc") !== -1;
    }
  };
  const headerIdx = main.rows.findIndex((r) => wantsHeader(r.cells));
  if (headerIdx === -1) throw new Error(`${file.fileCode}: no se encontró la fila de encabezados`);
  const H = new Headers(main.rows[headerIdx]!.cells);
  out.headerRow = main.rows[headerIdx]!.n;
  out.headerSheet = main.name;

  if (def.layout === "listado") {
    for (const r of main.rows.slice(0, headerIdx)) {
      const label = comparableText(txt(r.cells[1]));
      if (label === "numero de cursada") out.courseNumber = txt(r.cells[2]);
      if (label === "fecha y hora") {
        const raw = txt(r.cells[2]);
        out.listadoDate = raw ? { raw, ...parseDateAndTimeRange(raw.replace(/\s+/g, " ")) } : { raw: null, date: null, start: null, end: null };
      }
    }
  }

  const col = {
    last: H.find("apellido", "apellidos", "apellido y nombre"),
    first: H.find("nombre", "nombres"),
    dni: def.layout === "padron_abogados" ? H.find("nro doc") : H.find("dni", "documento"),
    cuil: H.find("cuil sin guiones", "cuit cuil", "cuit/cuil"),
    email: H.find("correo electronico", "direccion de correo electronico", "mail", "direccion mail oficial", "direccion de email oficial", "mail gcba"),
    email2: H.find("mail alternativo", "direccion de email alternativo", "mail personal"),
    phone: H.find("cel de contacto", "celular", "telefono", "telefono celular"),
    birth: H.find("fecha de nacimiento", "feha de nacimiento"),
    fullName: H.find("nombre y apellido"),
  };
  const orgCols: number[] = [];
  for (const names of [
    ["reparticion en la que presta servicios"],
    ["reparticion y ministerio en la que desempena funciones", "reparticion y ministerio"],
    ["ministerio"],
    ["reparticion nombre completo", "reparticion"],
  ]) {
    const i = H.find(...names);
    if (i !== -1 && !orgCols.includes(i)) orgCols.push(i);
  }
  const areaCols = ["area en la que se desempena", "area en la que se desempena nombre completo", "direccion", "departamento"].map((n) => H.find(n)).filter((i, k, a) => i !== -1 && a.indexOf(i) === k);
  const dayColFinal = def.code === "T09" ? 0 : def.jornadaSede ? H.find("columna 1") : -1;
  const vaccineCols = def.layout === "vaccine_antigripal" ? ["vacuna antigripal", "vac antigripal mayor de 65", "vac prevenar 20", "va covid", "vac hepatitis b", "vac doble adultos"].map((n) => H.find(n)) : [];
  const colegioCol = H.find("colegio donde vota");
  const tipoCol = H.find("tipo");
  const affCol = H.find("es afiliado a sutecba");
  void affCol;

  let seq = 0;
  for (const r of main.rows) {
    if (r.n <= out.headerRow) {
      out.rows.push(blankRow(file.fileCode, main.name, r.n, r.n === out.headerRow ? "header" : isBlank(r.cells) ? "blank" : "residual"));
      continue;
    }
    // Los listados vienen con el número de orden pre-cargado en filas sin datos: una fila con solo el ordinal está vacía.
    if (isBlank(def.layout === "listado" ? r.cells.slice(2) : r.cells)) {
      out.rows.push(blankRow(file.fileCode, main.name, r.n, "blank"));
      continue;
    }
    const c = r.cells;
    const row = blankRow(file.fileCode, main.name, r.n, "person");
    row.sequence = seq += 1;

    // nombres
    if (def.layout === "vaccine_antigripal") row.full = txt(c[col.fullName]);
    else if (def.layout === "padron_abogados") row.full = txt(c[col.last]);
    else {
      row.last = txt(c[col.last]);
      row.first = col.first !== -1 ? txt(c[col.first]) : null;
    }
    // identidad
    const id = identityOf(col.dni !== -1 ? c[col.dni] : undefined, col.cuil !== -1 ? c[col.cuil] : undefined);
    Object.assign(row, { dni: id.dni, dniSource: id.dniSource, cuil: id.cuil, problem: id.problem });
    if (def.layout === "padron_abogados") {
      row.docType = txt(c[tipoCol])?.toUpperCase() ?? null;
      if (row.docType && !["DNI", "DU"].includes(row.docType)) {
        row.problem = "DOC_TYPE_NOT_DNI";
      }
      row.college = colegioCol !== -1 ? txt(c[colegioCol]) : null;
    }
    // contacto
    if (col.email !== -1) row.email = normalizeContactEmail(txt(c[col.email]));
    if (!row.email && col.email2 !== -1) row.email = normalizeContactEmail(txt(c[col.email2]));
    if (col.phone !== -1) row.phone = normalizeContactPhone(txt(c[col.phone]));
    if (col.birth !== -1) Object.assign(row, birthOf(c[col.birth]));
    for (const i of orgCols) {
      const t = txt(c[i]);
      if (t) row.orgTexts.push(t);
    }
    for (const i of areaCols) {
      const t = txt(c[i]);
      if (t) row.areaTexts.push(t);
    }
    // día de jornada (solo oftalmología)
    if (def.code === "T09") {
      const d = c[0];
      row.dayText = d && typeof d === "object" ? ("$date" in d ? d.$date : d.$datetime.slice(0, 10)) : txt(d);
    } else if (dayColFinal !== -1 && def.jornadaSede) {
      const d = c[dayColFinal];
      row.dayText = d && typeof d === "object" ? ("$date" in d ? d.$date : d.$datetime.slice(0, 10)) : txt(d);
    }
    if (def.code === "T05") {
      // «martes 21» (Columna 1) / «jueves», «viernes» (Columna 3): solo días de semana → no prueban la jornada.
      const extra = [H.find("columna 1"), H.find("columna 3")].map((i) => (i === -1 ? null : txt(c[i]))).filter(Boolean);
      row.dayText = extra.length ? extra.join(" ") : null;
    }
    // vacunas: T01 es el formulario «Vacunación contra Dengue 2026» (la vacuna sale del título de la fuente, no de una columna)
    if (def.code === "T01") row.vaccines.push("dengue");
    if (vaccineCols.length) {
      vaccineCols.forEach((i, k) => {
        const t = i === -1 ? null : comparableText(txt(c[i]));
        if (!t) return;
        const [name, re] = VACCINES[k]!;
        if (re.test(t)) row.vaccines.push(name);
        else if (t !== "no") row.vaccineAnomalies += 1;
      });
    }
    out.rows.push(row);
  }
  return out;
}

export { cuilChecksumValid };
