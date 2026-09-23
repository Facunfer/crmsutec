import {
  cellToIsoDate,
  cellToText,
  digitsOnly,
  normalizeContactEmail,
  normalizeContactPhone,
  normalizeDniValue,
  parseDateAndTimeRange,
} from "./normalize.js";
import {
  emptyPerson,
  type Cell,
  type ExtractedFile,
  type ExtractedRow,
  type ExtractedSheet,
  type ImportTarget,
  type ParsedPerson,
  type PlannedEvent,
  type SourceIssue,
  type SourceRecord,
} from "./types.js";

/**
 * Interpretación de cada fuente. El mapeo de columnas está documentado (y confirmado) en
 * docs/importacion-gabriel-mapeo.md; cualquier fila que no encaje inequívocamente queda como
 * `UNRECOGNIZED_LAYOUT` en staging: no se adivina, no crea nada.
 */

// ---------------------------------------------------------------- utilidades

export function rawOf(cells: Cell[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  cells.forEach((cell, i) => {
    if (cell === null || cell === undefined) return;
    raw[`c${i}`] = typeof cell === "object" ? ("$date" in cell ? cell.$date : cell.$datetime) : cell;
  });
  return raw;
}

const text = (cells: Cell[], i: number): string | null => cellToText(cells[i]);

function affiliation(value: string | null): "SI" | "NO" | null {
  if (!value) return null;
  const v = value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase();
  return v === "SI" ? "SI" : v === "NO" ? "NO" : null;
}

function addEmail(person: ParsedPerson, raw: string | null, role: "work" | "personal") {
  const value = normalizeContactEmail(raw);
  if (value && !person.emails.some((e) => e.value === value && e.role === role)) person.emails.push({ value, role });
}

function addPhone(person: ParsedPerson, raw: string | null, role: "mobile" | "landline") {
  const value = normalizeContactPhone(raw);
  if (value && !person.phones.some((p) => p.value === value && p.role === role)) person.phones.push({ value, role });
}

function hasContent(cells: Cell[], from: number, to: number): boolean {
  for (let i = from; i <= to; i += 1) if (cellToText(cells[i]) !== null) return true;
  return false;
}

function issue(code: SourceIssue["code"], severity: SourceIssue["severity"], message: string): SourceIssue {
  return { code, severity, message };
}

interface RecordInput {
  file: ExtractedFile;
  sheet: ExtractedSheet;
  row: ExtractedRow;
  kind: SourceRecord["kind"];
  layout?: string | null;
  person?: ParsedPerson;
  target?: ImportTarget;
  participationKind?: SourceRecord["participationKind"];
  issues?: SourceIssue[];
}

function record(input: RecordInput): SourceRecord {
  return {
    fileCode: input.file.fileCode,
    sheet: input.sheet.name,
    rowNumber: input.row.n,
    rawData: rawOf(input.row.cells),
    kind: input.kind,
    layout: input.layout ?? null,
    person: input.person ?? emptyPerson(),
    target: input.target ?? { type: "none" },
    participationKind: input.participationKind ?? null,
    issues: input.issues ?? [],
  };
}

export interface ParsedSource {
  records: SourceRecord[];
  events: PlannedEvent[];
}

// ---------------------------------------------------------------- claves de evento

export const RCP_EVENT_KEY_PREFIX = "training:";

export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Sedes de oftalmología: "educacion 1"/"educación 2" son UNA sola sede (`educacion`). */
export function normalizeSedeSlug(raw: string): string {
  const slug = slugify(raw).replace(/-?\d+$/, "").replace(/-+$/, "");
  if (slug.startsWith("infraestructura")) return "infraestructura-escolar";
  if (slug === "ed-canale") return "canale";
  return slug;
}

const SEDE_LABEL: Record<string, string> = {
  procuracion: "Procuración",
  "cruz-malta": "Cruz Malta",
  educacion: "Educación",
  asi: "ASI",
  canale: "Canale",
  "teatro-colon": "Teatro Colón",
  "infraestructura-escolar": "Infraestructura escolar",
};

export function sedeLabel(slug: string): string {
  return SEDE_LABEL[slug] ?? slug;
}

export const OPHTHALMOLOGY_CAMPAIGN_PREFIX = "ophthalmology:";

/** Hoja de F06 → sede. */
const F06_SHEET_SEDE: Record<string, string> = {
  "Cruz Malta": "cruz-malta",
  ASI: "asi",
  "Educación": "educacion",
  "Teatro Colón": "teatro-colon",
  "Ed. Canale": "canale",
};

// ---------------------------------------------------------------- F02 / F05 (listado de cursada)

function courseCodeFromFileName(fileName: string): string | null {
  const m = /^(\d{5})-/.exec(fileName);
  return m ? m[1]! : null;
}

function parseCourseList(file: ExtractedFile): ParsedSource {
  const records: SourceRecord[] = [];
  const events: PlannedEvent[] = [];
  const main = file.sheets[0];
  if (!main) return { records, events };

  let headerN: number | null = null;
  let headerCode: string | null = null;
  let headerWhen: string | null = null;
  for (const row of main.rows) {
    const label = (text(row.cells, 1) ?? "").toLowerCase();
    if (label.startsWith("número de cursada") || label.startsWith("numero de cursada")) headerCode = digitsOnly(text(row.cells, 2)) || null;
    if (label.startsWith("fecha y hora")) headerWhen = text(row.cells, 2);
    if (label.startsWith("cuil")) {
      headerN = row.n;
      break;
    }
  }

  const fileCode = courseCodeFromFileName(file.fileName);
  const isRcp = file.fileCode === "F02";
  const code = headerCode || fileCode;
  const eventKey = code ? `${RCP_EVENT_KEY_PREFIX}${code}` : null;
  const eventIssues: SourceIssue[] = [];
  if (headerCode && fileCode && headerCode !== fileCode) {
    eventIssues.push(issue("EVENT_HEADER_MISMATCH", "warning", `El número de cursada de la hoja no coincide con el del nombre del archivo.`));
  }

  if (eventKey) {
    const when = parseDateAndTimeRange(headerWhen);
    const known = Boolean(when.date && when.start && when.end);
    events.push({
      key: eventKey,
      type: "capacitacion",
      subtype: null,
      name: isRcp ? "RCP Cruz Malta" : "Inteligencia emocional en la organización",
      description: isRcp ? null : "Unidad: AGC",
      schedulePrecision: known ? "exact_datetime" : when.date ? "date_only" : "unknown",
      eventDate: when.date,
      startTime: known ? when.start : null,
      endTime: known ? when.end : null,
      sourceTimeNote: headerWhen,
      sourceFiles: [file.fileCode],
    });
  }

  for (const sheet of file.sheets) {
    for (const row of sheet.rows) {
      const isMain = sheet === main;
      if (!isMain || headerN === null || row.n <= headerN) {
        records.push(
          record({
            file,
            sheet,
            row,
            kind: "residual",
            layout: "course-list",
            target: eventKey && isMain ? { type: "event", key: eventKey } : { type: "none" },
            issues: [issue(isMain ? "SECTION_HEADER" : "RESIDUAL_ROW", "info", isMain ? "Encabezado o leyenda del listado." : "Hoja auxiliar sin datos de personas.")],
          })
        );
        continue;
      }
      const c = row.cells;
      if (!hasContent(c, 1, 11)) {
        records.push(record({ file, sheet, row, kind: "residual", layout: "course-list", issues: [issue("RESIDUAL_ROW", "info", "Fila sin datos de persona.")] }));
        continue;
      }
      const person = emptyPerson();
      person.cuilRaw = text(c, 1);
      person.lastName = text(c, 2);
      person.firstName = text(c, 3);
      person.organismText = text(c, 6);
      addEmail(person, text(c, 9), "work");
      addEmail(person, text(c, 10), "personal");
      addPhone(person, text(c, 11), "mobile");
      records.push(
        record({
          file,
          sheet,
          row,
          kind: "person",
          layout: "course-list",
          person,
          target: eventKey ? { type: "event", key: eventKey } : { type: "none" },
          participationKind: eventKey ? "registration" : null,
          issues: [...eventIssues],
        })
      );
    }
  }
  return { records, events };
}

// ---------------------------------------------------------------- F01 / F03 (PDF) y F04 (formulario)

function parseTrainingResponses(file: ExtractedFile): ParsedSource {
  const records: SourceRecord[] = [];
  const events: PlannedEvent[] = [];
  const sheet = file.sheets[0];
  if (!sheet) return { records, events };

  const isF04 = file.fileCode === "F04";
  const isF03 = file.fileCode === "F03";
  // F01 (respuestas) se asocia por contexto al RCP 52010 (spec). F04 es Primeros auxilios psicológicos (AGC),
  // sin código de cursada. F03 NO se puede resolver a un curso: queda pendiente de clasificación humana.
  const target: ImportTarget = isF03
    ? { type: "pending_classification" }
    : isF04
      ? { type: "event", key: `${RCP_EVENT_KEY_PREFIX}primeros-auxilios-psicologicos-agc` }
      : { type: "event", key: `${RCP_EVENT_KEY_PREFIX}52010` };

  if (!isF03 && !isF04) {
    // F01: el evento lo define F02 (fecha y franja); si F02 no está, queda al menos declarado sin fecha.
    events.push({
      key: (target as { key: string }).key,
      type: "capacitacion",
      subtype: null,
      name: "RCP Cruz Malta",
      description: null,
      schedulePrecision: "unknown",
      eventDate: null,
      startTime: null,
      endTime: null,
      sourceTimeNote: null,
      sourceFiles: ["F01"],
    });
  }

  if (isF04) {
    events.push({
      key: (target as { key: string }).key,
      type: "capacitacion",
      subtype: null,
      name: "Primeros auxilios psicológicos",
      description: "Unidad: AGC",
      schedulePrecision: "unknown",
      eventDate: null,
      startTime: null,
      endTime: null,
      sourceTimeNote: null,
      sourceFiles: ["F04"],
    });
  }

  const [headerRow, ...dataRows] = sheet.rows;
  const layoutOk = headerRow ? (text(headerRow.cells, 1) ?? "").toLowerCase().startsWith("cuil") : false;

  if (headerRow) {
    records.push(record({ file, sheet, row: headerRow, kind: "residual", layout: isF04 ? "form-f04" : "form-pdf", issues: [issue("SECTION_HEADER", "info", "Encabezado de la tabla.")] }));
  }

  for (const row of dataRows) {
    if (!layoutOk) {
      records.push(record({ file, sheet, row, kind: "person", issues: [issue("UNRECOGNIZED_LAYOUT", "warning", "El encabezado de la tabla no coincide con el esperado.")] }));
      continue;
    }
    const c = row.cells;
    const person = emptyPerson();
    person.cuilRaw = text(c, 1);
    if (isF04) {
      person.lastName = text(c, 2);
      person.firstName = text(c, 3);
      person.organismText = text(c, 6);
      addEmail(person, text(c, 9), "work");
      addEmail(person, text(c, 10), "personal");
      addPhone(person, text(c, 11), "mobile");
      person.affiliatedSutecba = affiliation(text(c, 12));
    } else {
      // PDF: apellido y nombre en una sola celda; se conserva sin separar.
      person.fullName = text(c, 2);
      person.organismText = text(c, 5);
      addEmail(person, text(c, 8), "work");
      addEmail(person, text(c, 9), "personal");
      addPhone(person, text(c, 10), "mobile");
      person.affiliatedSutecba = affiliation(text(c, 11));
    }
    const issues: SourceIssue[] = [];
    if (isF03) issues.push(issue("PENDING_CLASSIFICATION", "warning", "El PDF no identifica el curso: pendiente de clasificación humana; no se crea ni vincula ninguna reunión."));
    records.push(
      record({
        file,
        sheet,
        row,
        kind: "person",
        layout: isF04 ? "form-f04" : "form-pdf",
        person,
        target,
        participationKind: isF03 ? null : "registration",
        issues,
      })
    );
  }
  return { records, events };
}

// ---------------------------------------------------------------- F06 (padrón por sede, SIN encabezado)

export type F06Layout = "L1" | "L2" | "L3" | "L4";

interface F06Columns {
  lastName: number;
  firstName: number;
  email: number;
  email2?: number;
  dni: number;
  birth: number;
  affiliated: number;
  phone: number;
  organism: number;
}

/** Layouts confirmados (docs/importacion-gabriel-mapeo.md §2). Índices desde 0. */
export const F06_COLUMNS: Record<F06Layout, F06Columns> = {
  L1: { email: 1, lastName: 2, firstName: 3, dni: 4, birth: 5, affiliated: 8, phone: 9, organism: 10 },
  L2: { lastName: 1, firstName: 2, email: 3, dni: 4, birth: 5, affiliated: 9, phone: 10, organism: 11, email2: 12 },
  L3: { email: 1, lastName: 2, firstName: 3, email2: 4, dni: 5, birth: 6, affiliated: 10, phone: 11, organism: 12 },
  L4: { lastName: 0, firstName: 1, email: 2, dni: 3, birth: 4, affiliated: 8, phone: 9, organism: 10, email2: 11 },
};

type CellKind = "blank" | "email" | "numeric" | "date" | "text";

function kindOf(cell: Cell | undefined): CellKind {
  const value = cellToText(cell);
  if (value === null) return "blank";
  if (typeof cell === "object" && cell !== null) return "date";
  if (normalizeContactEmail(value) !== null) return "email";
  if (cellToIsoDate(cell) !== null && /[/-]/.test(value)) return "date";
  if (/^[\d.\s]+$/.test(value)) return "numeric";
  return "text";
}

/**
 * `!` = obligatorio (debe ser de ese tipo); `?` = opcional (vacío o de ese tipo); `any` = no se mira.
 * Solo se exige lo que identifica el layout (nombres, posición del email y del DNI): la fecha de nacimiento,
 * la edad y la marca temporal pueden venir mal cargadas sin que la fila deje de ser reconocible.
 */
type Requirement = "text!" | "numeric!" | "email?" | "any";

const F06_SIGNATURES: Record<F06Layout, Requirement[]> = {
  L1: ["any", "email?", "text!", "text!", "numeric!"],
  L2: ["any", "text!", "text!", "email?", "numeric!"],
  L3: ["any", "email?", "text!", "text!", "email?", "numeric!"],
  L4: ["text!", "text!", "email?", "numeric!"],
};

function fits(kind: CellKind, requirement: Requirement): boolean {
  if (requirement === "any") return true;
  const expected = requirement.slice(0, -1) as CellKind;
  return requirement.endsWith("!") ? kind === expected : kind === "blank" || kind === expected;
}

/**
 * Detección de layout POR FILA (Cruz Malta mezcla L1 y L4): cada layout exige que los nombres y el DNI
 * estén donde corresponde y que los campos opcionales (email, fecha, edad) estén vacíos o sean del tipo
 * esperado. Los cuatro layouts son mutuamente excluyentes por diseño (posición de nombres, email y DNI);
 * aun así, solo si coincide EXACTAMENTE UNO se lo usa. Si coinciden varios o ninguno, la fila queda
 * `UNRECOGNIZED_LAYOUT`: nunca se elige a ciegas. El DNI se exige numérico, no necesariamente válido:
 * un DNI mal cargado se informa como INVALID_DNI_FORMAT en vez de descartar la fila como ilegible.
 */
export function detectF06Layout(cells: Cell[]): F06Layout | null {
  const kinds = Array.from({ length: 9 }, (_, i) => kindOf(cells[i]));
  const matches = (Object.keys(F06_SIGNATURES) as F06Layout[]).filter((layout) => F06_SIGNATURES[layout].every((req, i) => fits(kinds[i]!, req)));
  return matches.length === 1 ? matches[0]! : null;
}

function parseF06(file: ExtractedFile): ParsedSource {
  const records: SourceRecord[] = [];
  for (const sheet of file.sheets) {
    const sede = F06_SHEET_SEDE[sheet.name] ?? null;
    const target: ImportTarget = sede ? { type: "campaign", key: `${OPHTHALMOLOGY_CAMPAIGN_PREFIX}${sede}` } : { type: "none" };
    for (const row of sheet.rows) {
      const layout = detectF06Layout(row.cells);
      if (!layout) {
        records.push(
          record({
            file,
            sheet,
            row,
            kind: "person",
            layout: null,
            target,
            issues: [issue("UNRECOGNIZED_LAYOUT", "warning", "La fila no encaja inequívocamente en ninguno de los layouts L1–L4 de F06.")],
          })
        );
        continue;
      }
      const cols = F06_COLUMNS[layout];
      const c = row.cells;
      const person = emptyPerson();
      person.lastName = text(c, cols.lastName);
      person.firstName = text(c, cols.firstName);
      person.dniRaw = text(c, cols.dni);
      person.birthDate = cellToIsoDate(c[cols.birth]);
      person.organismText = text(c, cols.organism);
      person.affiliatedSutecba = affiliation(text(c, cols.affiliated));
      addEmail(person, text(c, cols.email), "personal");
      if (cols.email2 !== undefined) addEmail(person, text(c, cols.email2), "personal");
      addPhone(person, text(c, cols.phone), "mobile");
      // La marca temporal del formulario (columna 0 en L1–L3) NO es fecha de atención: queda en raw_data.
      records.push(record({ file, sheet, row, kind: "person", layout, person, target, participationKind: sede ? "registration" : null }));
    }
  }
  return { records, events: [] };
}

// ---------------------------------------------------------------- F07 / F09 / F10

function parseF07(file: ExtractedFile): ParsedSource {
  const records: SourceRecord[] = [];
  const sheet = file.sheets[0];
  if (!sheet) return { records, events: [] };
  const [headerRow, ...dataRows] = sheet.rows;
  const layoutOk = headerRow ? (text(headerRow.cells, 2) ?? "").toLowerCase().includes("cuil") : false;
  if (headerRow) records.push(record({ file, sheet, row: headerRow, kind: "residual", layout: "padron-pg", issues: [issue("SECTION_HEADER", "info", "Encabezado del padrón.")] }));

  for (const row of dataRows) {
    if (!layoutOk) {
      records.push(record({ file, sheet, row, kind: "person", issues: [issue("UNRECOGNIZED_LAYOUT", "warning", "El encabezado del padrón no coincide con el esperado.")] }));
      continue;
    }
    const c = row.cells;
    const person = emptyPerson();
    person.lastName = text(c, 0);
    person.firstName = text(c, 1);
    person.cuilRaw = text(c, 2);
    person.organismText = text(c, 8);
    addPhone(person, text(c, 3), "landline");
    addEmail(person, text(c, 4), "personal");
    addPhone(person, text(c, 5), "mobile");
    addEmail(person, text(c, 7), "work");
    records.push(record({ file, sheet, row, kind: "person", layout: "padron-pg", person }));
  }
  return { records, events: [] };
}

function parseF09(file: ExtractedFile): ParsedSource {
  const records: SourceRecord[] = [];
  const sheet = file.sheets[0];
  if (!sheet) return { records, events: [] };
  const target: ImportTarget = { type: "campaign", key: `${OPHTHALMOLOGY_CAMPAIGN_PREFIX}teatro-colon` };
  const [headerRow, ...dataRows] = sheet.rows;
  if (headerRow) records.push(record({ file, sheet, row: headerRow, kind: "residual", layout: "form-f09", issues: [issue("SECTION_HEADER", "info", "Encabezado del formulario.")] }));

  for (const row of dataRows) {
    const c = row.cells;
    // Fila residual: casi sin columnas principales (resto de planilla fuera de la tabla).
    let main = 0;
    for (let i = 0; i <= 12; i += 1) if (cellToText(c[i]) !== null) main += 1;
    if (main < 4) {
      records.push(record({ file, sheet, row, kind: "residual", layout: "form-f09", issues: [issue("RESIDUAL_ROW", "info", "Fila residual fuera de las columnas principales; no representa una persona.")] }));
      continue;
    }
    const person = emptyPerson();
    person.lastName = text(c, 2);
    person.firstName = text(c, 3);
    person.dniRaw = text(c, 5);
    person.birthDate = cellToIsoDate(c[6]);
    person.organismText = text(c, 12);
    person.affiliatedSutecba = affiliation(text(c, 10));
    addEmail(person, text(c, 1), "personal");
    addEmail(person, text(c, 4), "personal");
    addPhone(person, text(c, 11), "mobile");
    records.push(record({ file, sheet, row, kind: "person", layout: "form-f09", person, target, participationKind: "registration" }));
  }
  return { records, events: [] };
}

function parseF10(file: ExtractedFile): ParsedSource {
  const records: SourceRecord[] = [];
  const sheet = file.sheets[0];
  if (!sheet) return { records, events: [] };
  let inReferidos = false;
  let headerSeen = false;

  for (const row of sheet.rows) {
    const c = row.cells;
    if (!headerSeen) {
      headerSeen = true;
      const ok = (text(c, 2) ?? "").toLowerCase().includes("cuil");
      if (ok) {
        records.push(record({ file, sheet, row, kind: "residual", layout: "abogados", issues: [issue("SECTION_HEADER", "info", "Encabezado del padrón.")] }));
        continue;
      }
    }
    // Separador de la sección de referidos: no es una persona.
    const label = text(c, 0) ?? "";
    if (/referid/i.test(label) && !hasContent(c, 1, 3)) {
      inReferidos = true;
      records.push(record({ file, sheet, row, kind: "residual", layout: "abogados", issues: [issue("SECTION_HEADER", "info", "Separador de la sección de referidos; no es una persona.")] }));
      continue;
    }
    const person = emptyPerson();
    person.lastName = text(c, 0);
    person.firstName = text(c, 1);
    person.cuilRaw = text(c, 2);
    addPhone(person, text(c, 3), "mobile");
    records.push(record({ file, sheet, row, kind: "person", layout: inReferidos ? "abogados-referidos" : "abogados", person }));
  }
  return { records, events: [] };
}

// ---------------------------------------------------------------- F08 (agenda de jornadas de oftalmología)

function parseF08(file: ExtractedFile): ParsedSource {
  const records: SourceRecord[] = [];
  const events = new Map<string, PlannedEvent>();
  const sheet = file.sheets[0];
  if (!sheet) return { records, events: [] };

  for (const row of sheet.rows) {
    const c = row.cells;
    const isHeader = (text(c, 1) ?? "").toLowerCase() === "fecha";
    if (isHeader) {
      records.push(record({ file, sheet, row, kind: "residual", layout: "agenda", issues: [issue("SECTION_HEADER", "info", "Encabezado de la agenda.")] }));
      continue;
    }
    const date = cellToIsoDate(c[1]);
    const sedeRaw = text(c, 2);
    if (!date || !sedeRaw) {
      records.push(record({ file, sheet, row, kind: "residual", layout: "agenda", issues: [issue("MISSING_EVENT_DATE", "warning", "Fila de la agenda sin fecha o sin sede: no crea ningún evento.")] }));
      continue;
    }
    const sede = normalizeSedeSlug(sedeRaw);
    const key = `${OPHTHALMOLOGY_CAMPAIGN_PREFIX}${date}:${sede}`;
    if (!events.has(key)) {
      events.set(key, {
        key,
        type: "operativo_salud",
        subtype: "oftalmologia",
        name: `Oftalmología — ${sedeLabel(sede)}`,
        description: null,
        schedulePrecision: "date_only",
        eventDate: date,
        startTime: null,
        endTime: null,
        sourceTimeNote: null,
        sourceFiles: ["F08"],
      });
    }
    records.push(record({ file, sheet, row, kind: "residual", layout: "agenda", target: { type: "event", key } }));
  }
  return { records, events: [...events.values()] };
}

// ---------------------------------------------------------------- entrada

export function parseSource(file: ExtractedFile): ParsedSource {
  switch (file.fileCode) {
    case "F01":
    case "F03":
    case "F04":
      return parseTrainingResponses(file);
    case "F02":
    case "F05":
      return parseCourseList(file);
    case "F06":
      return parseF06(file);
    case "F07":
      return parseF07(file);
    case "F08":
      return parseF08(file);
    case "F09":
      return parseF09(file);
    case "F10":
      return parseF10(file);
  }
}
