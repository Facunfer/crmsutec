/**
 * Tipos del importador de las fuentes históricas de Gabriel (F01–F10). Ver
 * docs/importacion-gabriel-mapeo.md para los layouts y GABRIEL_IMPORT_MAP.md para las reglas.
 *
 * Nada acá toca la base: el importador primero arma un PLAN (dry-run) a partir de los archivos
 * extraídos y recién después, y solo en un entorno permitido, lo aplica (apply.ts).
 */

export const FILE_CODES = ["F01", "F02", "F03", "F04", "F05", "F06", "F07", "F08", "F09", "F10"] as const;
export type FileCode = (typeof FILE_CODES)[number];

/** Celda tal como la deja tools/gabriel-extract.py: escalar JSON; las fechas vienen marcadas. */
export type Cell = string | number | boolean | null | { $date: string } | { $datetime: string };

export interface ExtractedRow {
  /** Número de fila FÍSICA (1-based) en la hoja/tabla original. */
  n: number;
  cells: Cell[];
}

export interface ExtractedSheet {
  name: string;
  rows: ExtractedRow[];
}

export interface ExtractedFile {
  fileCode: FileCode;
  fileName: string;
  /** SHA-256 del archivo original (huella del archivo). */
  sha256: string;
  sizeBytes: number;
  sheets: ExtractedSheet[];
}

export type ParticipationKind = "registration" | "invited" | "attended" | "absent" | "approved" | "unknown";

export type IssueCode =
  | "MISSING_CANONICAL_DNI"
  | "UNRECOGNIZED_LAYOUT"
  | "MISSING_EVENT_DATE"
  | "SECTION_HEADER"
  | "RESIDUAL_ROW"
  | "INVALID_CUIL_CHECKSUM"
  | "INVALID_DNI_FORMAT"
  | "HIGH_SEVERITY_CONFLICT"
  | "BLOCKED_IDENTITY_CONFLICT"
  | "ORGANISM_UNMAPPED"
  | "ORGANISM_CONTEXT_CONFLICT"
  | "ORGANISM_AMBIGUOUS"
  | "FIELD_CONFLICT"
  | "CANDIDATE_FILL"
  | "PENDING_CLASSIFICATION"
  | "NAME_NOT_SPLIT"
  | "EVENT_HEADER_MISMATCH";

export interface SourceIssue {
  code: IssueCode;
  severity: "info" | "warning" | "error";
  /** Sin datos personales: se guarda en import_issues.message. */
  message: string;
}

export type ContactRole = "work" | "personal" | "mobile" | "landline";

export interface ParsedPerson {
  lastName: string | null;
  firstName: string | null;
  /** Apellido y nombre en una sola celda (PDF): se conserva, nunca se separa automáticamente. */
  fullName: string | null;
  /** Valor crudo de DNI de la fuente (solo las fuentes que lo traen). */
  dniRaw: string | null;
  /** Valor crudo de CUIL/CUIT de la fuente (solo las fuentes que lo traen). */
  cuilRaw: string | null;
  emails: Array<{ value: string; role: ContactRole }>;
  phones: Array<{ value: string; role: ContactRole }>;
  /** AAAA-MM-DD */
  birthDate: string | null;
  /** Repartición / ministerio tal cual figura (texto libre; no se mapea a organizaciones). */
  organismText: string | null;
  affiliatedSutecba: "SI" | "NO" | null;
}

export type ImportTarget =
  | { type: "event"; key: string }
  | { type: "campaign"; key: string }
  | { type: "pending_classification" }
  | { type: "none" };

export interface SourceRecord {
  fileCode: FileCode;
  sheet: string;
  rowNumber: number;
  /** Fila cruda completa (columna → valor) para conservar la procedencia. */
  rawData: Record<string, unknown>;
  /** `person`: fila que representa a una persona. `residual`: encabezado, separador o resto de planilla. */
  kind: "person" | "residual";
  layout: string | null;
  person: ParsedPerson;
  target: ImportTarget;
  participationKind: ParticipationKind | null;
  issues: SourceIssue[];
}

export interface PlannedEvent {
  key: string;
  type: "capacitacion" | "operativo_salud" | "reunion" | "jornada" | "evento" | "otro";
  subtype: string | null;
  name: string;
  /** Texto libre (unidad, etc.) para `description`. */
  description: string | null;
  schedulePrecision: "exact_datetime" | "date_only" | "unknown";
  /** AAAA-MM-DD cuando se conoce el día. */
  eventDate: string | null;
  /** Solo si la fuente da la franja horaria (hora local de Buenos Aires). */
  startTime: string | null;
  endTime: string | null;
  sourceTimeNote: string | null;
  /** Códigos de archivo que sustentan el evento. */
  sourceFiles: FileCode[];
}

export function emptyPerson(): ParsedPerson {
  return {
    lastName: null,
    firstName: null,
    fullName: null,
    dniRaw: null,
    cuilRaw: null,
    emails: [],
    phones: [],
    birthDate: null,
    organismText: null,
    affiliatedSutecba: null,
  };
}
