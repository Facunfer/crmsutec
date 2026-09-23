import { comparableText, cuilChecksumValid, nameTokens, nameTokensCompatible, phoneKey, resolveIdentity } from "./normalize.js";
import type { IdentityDecision, IdentityDecisionValue } from "./identity-decisions.js";
import { OrganizationResolver, type AliasEntry, type OrgResolution, type ResolutionKind } from "./organization-resolver.js";
import { parseSource } from "./sources.js";
import type {
  ContactRole,
  ExtractedFile,
  FileCode,
  ImportTarget,
  IssueCode,
  ParticipationKind,
  PlannedEvent,
  SourceIssue,
  SourceRecord,
} from "./types.js";

/**
 * Planificador (dry-run) de la importación histórica. Recibe los archivos extraídos y, opcionalmente,
 * una foto de lo que ya existe, y devuelve QUÉ pasaría: personas a crear/actualizar, conflictos, filas
 * sin DNI, eventos, participaciones e incidencias. No toca ninguna base.
 *
 * Reglas (GABRIEL_IMPORT_MAP.md): DNI canónico único; un CUIL válido deriva el DNI (con procedencia);
 * sin DNI no se crea persona; no se fusiona por nombre/email/teléfono; no se sobreescribe nada en
 * silencio (conflicto → incidencia); la asistencia nunca se infiere.
 */

/** Prioridad de fuentes para elegir el valor "principal" de cada dato: primero las que traen DNI explícito y campos separados. */
export const SOURCE_PRIORITY: FileCode[] = ["F09", "F06", "F07", "F10", "F04", "F02", "F05", "F01", "F03", "F08"];

export interface ExistingPerson {
  id?: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  cuilCuit: string | null;
}

export interface PlanOptions {
  /** Personas que ya existen, por DNI. Vacío en un dry-run sin base. */
  existingPeople?: ReadonlyMap<string, ExistingPerson>;
  /** Claves source_event_key de eventos ya importados. */
  existingEventKeys?: ReadonlySet<string>;
  /**
   * Alias de organización APROBADOS (AUTO_MAP) que apuntan a una unidad activa. Es la única fuente para asignar
   * organización: un texto resuelve solo si su clave determinística coincide con UN alias de UNA unidad. No hay
   * coincidencia por nombre de la unidad ni fuzzy matching; lo demás queda sin unidad con incidencia. Los alias
   * homónimos (DGTAL, UAI…) son CONTEXTUALES: `contextOrganizationId` es la jurisdicción bajo la que se interpretan.
   */
  organizationAliases?: ReadonlyArray<AliasEntry>;
  /** Jerarquía (id → padre) de las organizaciones activas: define cuándo una unidad está dentro de un contexto. */
  organizationParents?: ReadonlyMap<string, string | null>;
  /** Archivos que pertenecen inequívocamente a UNA jurisdicción (Padrón PG → Procuración). Nunca archivos mixtos. */
  fileJurisdictions?: Readonly<Partial<Record<FileCode, string>>>;
  /**
   * Decisiones humanas ya validadas sobre las identidades bloqueadas (ver identity-decisions.ts).
   * MERGE_SAME_PERSON: una sola persona con el nombre canónico decidido; las demás decisiones no crean persona.
   */
  identityDecisions?: ReadonlyArray<IdentityDecision>;
}

export type OrganizationStatus = "none" | "resolved" | "unmapped" | "ambiguous" | "context_missing" | "context_conflict" | "conflict";

export interface RowRef {
  fileCode: FileCode;
  sheet: string;
  rowNumber: number;
}

export type RowStatus = "normalized" | "in_review" | "skipped";

export interface PlannedRow {
  record: SourceRecord;
  normalizedDni: string | null;
  dniSource: "explicit" | "derived_from_cuil" | null;
  normalizedCuil: string | null;
  /** Incidencias de la fuente + las que agrega el planificador. */
  issues: SourceIssue[];
  status: RowStatus;
  /** DNI de la persona a la que apunta la fila (solo si se va a crear/actualizar). */
  personDni: string | null;
  /** Cómo resolvió esta fila su organización (global / contexto de fila / de archivo / de persona). */
  organization?: { organizationId: string; kind: ResolutionKind; contextOrganizationId: string | null };
  /** Decisión humana aplicada al DNI de esta fila (solo identidades que estaban bloqueadas). */
  identityDecision?: IdentityDecisionValue;
}

export interface PlannedPerson {
  dni: string;
  dniSource: "explicit" | "derived_from_cuil";
  cuilCuit: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  birthDate: string | null;
  organismText: string | null;
  /** Solo con correspondencia inequívoca contra `organizations`; si no, NULL (y hay incidencia). */
  organizationId: string | null;
  /** Cómo se resolvió: global, contexto de fila, de archivo o de persona (null si no se resolvió). */
  organizationResolution: { kind: ResolutionKind; contextOrganizationId: string | null } | null;
  organizationStatus: OrganizationStatus;
  /** Campos opcionales que quedan vacíos porque las fuentes se contradicen. */
  pendingFields: string[];
  hasNonBlockingConflicts: boolean;
  sources: FileCode[];
  rows: RowRef[];
}

export interface BlockedPerson {
  personKey: string;
  reason: string;
  /** Decisión humana que la mantiene sin crear (KEEP_BLOCKED / REVIEW_LATER / SOURCE_ERROR). Ausente si no hay decisión. */
  decision?: IdentityDecisionValue;
}

/** Resultado de cada decisión humana, sin datos personales (solo la clave interna de la persona). */
export interface IdentityDecisionResult {
  personKey: string;
  decision: IdentityDecisionValue;
  outcome: "person_created" | "person_existing" | "no_person_created";
  /** Filas fuente del DNI (todas quedan vinculadas a la misma persona o, si no se crea, en revisión). */
  sourceRows: number;
  /** Variantes distintas del nombre en las fuentes (trazabilidad; el nombre final es el canónico decidido). */
  nameVariants: number;
}

export interface PersonUpdate {
  dni: string;
  /** Campos que hoy están vacíos en el CRM y la fuente completa (candidate_fill). */
  fills: Array<"email" | "phone" | "cuil_cuit">;
  /** Valores inequívocos a escribir (solo sobre campos hoy vacíos). */
  values: { email?: string; phone?: string; cuil_cuit?: string };
}

export type ConflictField = "name" | "email" | "phone" | "organism" | "birth_date" | "cuil_cuit" | "existing_record";

export interface PlannedConflict {
  /** Sin el DNI en claro: solo un identificador interno estable dentro del informe. */
  personKey: string;
  field: ConflictField;
  severity: "warning" | "error";
  /** true = impide crear la persona (BLOCKED_IDENTITY_CONFLICT); false = el campo queda vacío. */
  blocking: boolean;
  code: Extract<IssueCode, "FIELD_CONFLICT" | "BLOCKED_IDENTITY_CONFLICT">;
  sources: FileCode[];
  rows: RowRef[];
}

export interface PlannedParticipation {
  target: ImportTarget & { type: "event" | "campaign" };
  dni: string;
  kind: ParticipationKind;
  /** Filas fuente que la sustentan; la primera es la "de origen". */
  rows: RowRef[];
}

export interface ImportPlan {
  files: Array<{ fileCode: FileCode; fileName: string; sha256: string }>;
  rows: PlannedRow[];
  people: { toCreate: PlannedPerson[]; toUpdate: PersonUpdate[]; blocked: BlockedPerson[] };
  conflicts: PlannedConflict[];
  events: { toCreate: PlannedEvent[]; existing: PlannedEvent[] };
  participations: PlannedParticipation[];
  /** Filas de F03: se conservan en staging, sin evento ni participación. */
  pendingClassificationRows: RowRef[];
  identityDecisionResults: IdentityDecisionResult[];
  counts: PlanCounts;
}

export interface PlanCounts {
  filas_fuente_total: number;
  filas_de_personas: number;
  filas_residuales: number;
  por_archivo: Record<string, { personas: number; residuales: number }>;
  dni_explicito: number;
  dni_derivado_de_cuil: number;
  con_dni_canonico: number;
  filas_sin_dni: number;
  filas_sin_dni_por_codigo: Record<string, number>;
  dni_canonicos_unicos: number;
  dni_en_mas_de_una_fila: number;
  /** Identidades canónicas (DNI únicos) que aparecen en las fuentes = people_insert_reales + personas bloqueadas. */
  identidades_canonicas_totales: number;
  /** INSERT reales de `people` que haría este apply (personas nuevas; sin las bloqueadas ni las ya existentes). */
  people_insert_reales: number;
  filas_de_identidades_bloqueadas: number;
  personas_a_crear: number;
  personas_listas_para_crear: number;
  personas_con_conflictos_no_bloqueantes: number;
  personas_bloqueadas_por_conflicto_de_identidad: number;
  /** Identidades que estaban bloqueadas y una decisión humana (MERGE_SAME_PERSON) unificó en una sola persona. */
  personas_unificadas_por_decision_humana: number;
  personas_a_actualizar: number;
  personas_con_organizacion_mapeada: number;
  personas_sin_organizacion: number;
  organizacion_resuelta_global: number;
  organizacion_resuelta_por_contexto_de_fila: number;
  organizacion_resuelta_por_contexto_embebido: number;
  organizacion_resuelta_por_contexto_de_archivo: number;
  organizacion_resuelta_por_contexto_de_persona: number;
  organizacion_con_contexto_insuficiente: number;
  organizacion_con_conflicto_de_contexto: number;
  conflictos: number;
  conflictos_bloqueantes: number;
  conflictos_no_bloqueantes: number;
  conflictos_por_campo: Record<string, number>;
  reuniones_a_crear: number;
  reuniones_ya_existentes: number;
  reuniones_por_fecha: { conocida: number; solo_dia: number; pendiente: number };
  inscripciones_a_vincular: number;
  inscripciones_a_evento: number;
  inscripciones_a_campana_sin_jornada: number;
  asistencias_acreditadas: number;
  incidencias: number;
  incidencias_por_codigo: Record<string, number>;
}

const ref = (r: SourceRecord): RowRef => ({ fileCode: r.fileCode, sheet: r.sheet, rowNumber: r.rowNumber });
const rank = (code: FileCode) => {
  const i = SOURCE_PRIORITY.indexOf(code);
  return i === -1 ? SOURCE_PRIORITY.length : i;
};

const increment = (map: Record<string, number>, key: string, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

interface Contribution {
  row: PlannedRow;
  rec: SourceRecord;
}

const comparableEmail = (value: string) => value.trim().toLowerCase();

const DATE_RANK = { exact_datetime: 3, date_only: 2, unknown: 1 } as const;

function mergeEvents(list: PlannedEvent[]): PlannedEvent[] {
  const merged = new Map<string, PlannedEvent>();
  for (const event of list) {
    const current = merged.get(event.key);
    if (!current) {
      merged.set(event.key, { ...event, sourceFiles: [...event.sourceFiles] });
      continue;
    }
    // Se conserva la definición más precisa (fecha conocida > solo día > pendiente); se unen las fuentes.
    const best = DATE_RANK[event.schedulePrecision] > DATE_RANK[current.schedulePrecision] ? event : current;
    merged.set(event.key, {
      ...best,
      sourceFiles: [...new Set([...current.sourceFiles, ...event.sourceFiles])].sort() as FileCode[],
    });
  }
  return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function buildPlan(files: ExtractedFile[], options: PlanOptions = {}): ImportPlan {
  const existingPeople = options.existingPeople ?? new Map<string, ExistingPerson>();
  const existingEventKeys = options.existingEventKeys ?? new Set<string>();

  // ---------------------------------------------------------------- 1. parseo
  const records: SourceRecord[] = [];
  const rawEvents: PlannedEvent[] = [];
  for (const file of files) {
    const parsed = parseSource(file);
    records.push(...parsed.records);
    rawEvents.push(...parsed.events);
  }

  // ---------------------------------------------------------------- 2. identidad por fila
  const rows: PlannedRow[] = records.map((record) => {
    const issues: SourceIssue[] = [...record.issues];
    if (record.kind === "residual") {
      return { record, normalizedDni: null, dniSource: null, normalizedCuil: null, issues, status: "skipped" as const, personDni: null };
    }

    const identity = resolveIdentity(record.person.dniRaw, record.person.cuilRaw);
    if (identity.invalidDni) issues.push({ code: "INVALID_DNI_FORMAT", severity: "warning", message: "El DNI de la fila no tiene 7 u 8 dígitos." });
    if (record.person.cuilRaw && identity.cuil && !identity.cuilValid) {
      issues.push({ code: "INVALID_CUIL_CHECKSUM", severity: "warning", message: "El CUIL/CUIT no tiene un dígito verificador válido: no se deriva el DNI." });
    }
    if (identity.dniCuilMismatch) {
      issues.push({ code: "HIGH_SEVERITY_CONFLICT", severity: "error", message: "El DNI y el DNI contenido en el CUIL/CUIT de la misma fila no coinciden: no se fusiona ni se crea nada." });
    }

    const unrecognized = issues.some((i) => i.code === "UNRECOGNIZED_LAYOUT");
    if (!identity.dni && !unrecognized && !identity.dniCuilMismatch) {
      issues.push({ code: "MISSING_CANONICAL_DNI", severity: "warning", message: "La fila no tiene DNI explícito ni un CUIL/CUIT válido del cual derivarlo: queda en revisión y no crea una persona." });
    }

    const hardBlock = issues.some((i) => i.severity === "error" || i.code === "UNRECOGNIZED_LAYOUT");
    const status: RowStatus = identity.dni && !hardBlock ? "normalized" : "in_review";
    return {
      record,
      normalizedDni: identity.dni,
      dniSource: identity.dniSource,
      normalizedCuil: identity.cuil,
      issues,
      status,
      personDni: null,
    };
  });

  // ---------------------------------------------------------------- 3. personas por DNI
  // Política de conflictos (no hay "último valor gana" ni "primer valor gana" para datos dudosos):
  //  - campo vacío + un único valor consistente  → completa el campo;
  //  - mismo valor normalizado en varias fuentes → no es conflicto;
  //  - valores distintos en un campo opcional    → conflicto NO bloqueante: el campo queda vacío
  //    (todas las fuentes se conservan en staging) y la persona se crea igual;
  //  - nombres materialmente distintos, o dos CUIL válidos → BLOCKED_IDENTITY_CONFLICT: no se crea.
  const byDni = new Map<string, Contribution[]>();
  for (const row of rows) {
    if (row.status !== "normalized" || !row.normalizedDni) continue;
    (byDni.get(row.normalizedDni) ?? byDni.set(row.normalizedDni, []).get(row.normalizedDni)!).push({ row, rec: row.record });
  }

  const resolver = new OrganizationResolver({ aliases: options.organizationAliases ?? [], parentOf: options.organizationParents, fileJurisdictions: options.fileJurisdictions });

  const conflicts: PlannedConflict[] = [];
  const toCreate: PlannedPerson[] = [];
  const toUpdate: PersonUpdate[] = [];
  const blockedPeople: BlockedPerson[] = [];
  const decisionByDni = new Map((options.identityDecisions ?? []).map((d) => [d.dni, d]));
  const identityDecisionResults: IdentityDecisionResult[] = [];
  let keyCounter = 0;

  for (const [dni, contributions] of [...byDni.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const personKey = `P${String(++keyCounter).padStart(5, "0")}`;
    const ordered = [...contributions].sort((a, b) => rank(a.rec.fileCode) - rank(b.rec.fileCode) || a.rec.rowNumber - b.rec.rowNumber);
    const rowsOf = (pred: (c: Contribution) => boolean) => ordered.filter(pred).map((c) => ref(c.rec));
    const sourcesOf = (pred: (c: Contribution) => boolean) => [...new Set(ordered.filter(pred).map((c) => c.rec.fileCode))].sort() as FileCode[];
    const personConflicts: PlannedConflict[] = [];
    const pendingFields: string[] = [];

    const flag = (field: ConflictField, blocking: boolean, involved: Contribution[]) => {
      const code = blocking ? "BLOCKED_IDENTITY_CONFLICT" : "FIELD_CONFLICT";
      const conflict: PlannedConflict = {
        personKey,
        field,
        severity: blocking ? "error" : "warning",
        blocking,
        code,
        sources: [...new Set(involved.map((c) => c.rec.fileCode))].sort() as FileCode[],
        rows: involved.map((c) => ref(c.rec)),
      };
      conflicts.push(conflict);
      personConflicts.push(conflict);
      for (const c of involved) {
        c.row.issues.push({
          code,
          severity: blocking ? "error" : "warning",
          message: blocking
            ? `Conflicto material de identidad en "${field}" entre las fuentes de un mismo DNI: la persona no se crea automáticamente.`
            : `Valores distintos para "${field}" entre las fuentes de un mismo DNI: el campo queda vacío hasta que se resuelva; se conservan todas las fuentes.`,
        });
      }
    };
    const block = (reason: string) => {
      blockedPeople.push({ personKey, reason });
      for (const c of ordered) c.row.status = "in_review";
    };

    // -- identidad: nombre (comparación por palabras, todos contra todos)
    const nameOf = (c: Contribution) => {
      const p = c.rec.person;
      return p.lastName && p.firstName ? nameTokens(`${p.lastName} ${p.firstName}`) : nameTokens(p.fullName);
    };
    const named = ordered.filter((c) => nameOf(c).length > 0);
    let nameClash: Contribution[] | null = null;
    outer: for (let i = 0; i < named.length; i += 1) {
      for (let j = i + 1; j < named.length; j += 1) {
        if (!nameTokensCompatible(nameOf(named[i]!), nameOf(named[j]!))) {
          nameClash = [named[i]!, named[j]!];
          break outer;
        }
      }
    }

    // -- identidad: dos CUIL/CUIT válidos distintos para el mismo DNI
    const cuils = new Map<string, Contribution>();
    for (const c of ordered) if (c.row.normalizedCuil && cuilChecksumValid(c.row.normalizedCuil) && !cuils.has(c.row.normalizedCuil)) cuils.set(c.row.normalizedCuil, c);
    const validCuils = [...cuils.entries()];

    // -- decisión humana (solo aplica a identidades que el plan bloquea por fuentes)
    const decision = decisionByDni.get(dni);
    const variantCount = new Set(named.map((c) => nameOf(c).join(" "))).size;
    let mergedByDecision: IdentityDecision | null = null;
    if (nameClash || validCuils.length > 1) {
      if (decision?.decision === "MERGE_SAME_PERSON") {
        // Una sola persona con el nombre canónico decidido; las variantes quedan en las filas fuente (raw_data).
        // Dos CUIL válidos distintos NO los resuelve la decisión de nombre: el campo queda vacío con conflicto no bloqueante.
        mergedByDecision = decision;
        if (validCuils.length > 1) flag("cuil_cuit", false, validCuils.map(([, c]) => c));
      } else {
        if (nameClash) flag("name", true, nameClash);
        if (validCuils.length > 1) flag("cuil_cuit", true, validCuils.map(([, c]) => c));
        block(nameClash ? "name" : "cuil_cuit");
        if (decision) {
          blockedPeople[blockedPeople.length - 1]!.decision = decision.decision;
          for (const c of ordered) c.row.identityDecision = decision.decision;
          identityDecisionResults.push({ personKey, decision: decision.decision, outcome: "no_person_created", sourceRows: ordered.length, nameVariants: variantCount });
        }
        continue;
      }
    }

    // -- campos opcionales: un único valor normalizado o vacío
    const resolveField = <T>(field: ConflictField, candidates: Array<{ key: string; value: T; c: Contribution }>): T | null => {
      const groups = new Map<string, { value: T; c: Contribution }>();
      for (const cand of candidates) if (cand.key && !groups.has(cand.key)) groups.set(cand.key, { value: cand.value, c: cand.c });
      if (groups.size === 0) return null;
      if (groups.size === 1) return [...groups.values()][0]!.value;
      flag(field, false, [...groups.values()].map((g) => g.c));
      pendingFields.push(field);
      return null;
    };
    const contactCandidates = (kind: "emails" | "phones", role: ContactRole) =>
      ordered.flatMap((c) =>
        c.rec.person[kind]
          .filter((item) => item.role === role)
          .map((item) => ({ key: kind === "emails" ? comparableEmail(item.value) : phoneKey(item.value), value: item.value, c }))
      );
    const firstRole = (field: ConflictField, roles: ContactRole[], kind: "emails" | "phones"): string | null => {
      // El primer rol que tenga algún valor decide; no se cae al siguiente si ese rol es ambiguo.
      for (const role of roles) {
        const candidates = contactCandidates(kind, role);
        if (candidates.length > 0) return resolveField(field, candidates);
      }
      return null;
    };
    const email = firstRole("email", ["personal", "work"], "emails");
    const phone = firstRole("phone", ["mobile", "landline"], "phones");
    const birthDate = resolveField(
      "birth_date",
      ordered.filter((c) => c.rec.person.birthDate).map((c) => ({ key: c.rec.person.birthDate!, value: c.rec.person.birthDate!, c }))
    );
    // -- organismo: alias aprobados globales o contextuales (ver organization-resolver.ts). Nunca se crean unidades ni
    //    se asigna por texto parecido; un área laboral libre no es contexto.
    const organismContribs = ordered
      // Un texto sin caracteres comparables ("?", ".", "-") es un placeholder, no un valor.
      .filter((c) => comparableText(c.rec.person.organismText));
    const results = new Map<Contribution, OrgResolution>();
    for (const c of organismContribs) results.set(c, resolver.resolveDirect(c.rec.person.organismText!, c.rec.fileCode));
    const evidence = [...results.values()].flatMap((r) => (r.status === "resolved" ? [r.organizationId] : []));
    for (const c of organismContribs) {
      const r = results.get(c)!;
      if (r.status === "needs_context") results.set(c, resolver.resolveByPersonEvidence(r.options, evidence));
    }
    // Evidencia contradictoria: el alias homónimo no se autoasigna y queda registrado en la fila.
    for (const c of organismContribs) {
      if (results.get(c)!.status === "context_conflict") {
        c.row.issues.push({ code: "ORGANISM_CONTEXT_CONFLICT", severity: "warning", message: "El texto es un nombre homónimo y la persona tiene evidencia de más de una jurisdicción: no se asigna hasta revisión." });
      }
    }
    // Varias unidades en una misma cadena jerárquica no son conflicto: se guarda la más específica comprobada.
    const resolvedOrgs = [...new Set([...results.values()].flatMap((r) => (r.status === "resolved" ? [r.organizationId] : [])))];
    const deepest = [...resolvedOrgs].sort((x, y) => resolver.depthOf(y) - resolver.depthOf(x) || x.localeCompare(y))[0] ?? null;
    const chain = deepest !== null && resolvedOrgs.every((o) => resolver.isWithin(deepest, o));
    const candidateOrder = [...organismContribs].sort((x, y) => {
      const rx = results.get(x)!;
      const ry = results.get(y)!;
      return Number(ry.status === "resolved" && ry.organizationId === deepest) - Number(rx.status === "resolved" && rx.organizationId === deepest);
    });
    const organism = resolveField(
      "organism",
      candidateOrder.map((c) => {
        const r = results.get(c)!;
        const text = c.rec.person.organismText!;
        const key = r.status === "resolved" ? `org:${chain ? deepest : r.organizationId}` : `text:${comparableText(text)}`;
        return { key, value: { text, resolution: r }, c };
      })
    );
    const organismText = organism?.text ?? null;
    let organizationId: string | null = null;
    let organizationResolution: PlannedPerson["organizationResolution"] = null;
    let organizationStatus: OrganizationStatus = organismContribs.length === 0 ? "none" : "conflict";
    if ([...results.values()].some((r) => r.status === "context_conflict")) organizationStatus = "context_conflict";
    for (const [c, r] of results) {
      if (r.status === "resolved") c.row.organization = { organizationId: r.organizationId, kind: r.kind, contextOrganizationId: r.contextOrganizationId };
    }
    if (organism) {
      const primary = ordered.find((c) => c.rec.person.organismText)!;
      const r = organism.resolution;
      if (r.status === "resolved") {
        organizationId = r.organizationId;
        organizationResolution = { kind: r.kind, contextOrganizationId: r.contextOrganizationId };
        organizationStatus = "resolved";
      } else if (r.status === "ambiguous") {
        organizationStatus = "ambiguous";
        primary.row.issues.push({ code: "ORGANISM_AMBIGUOUS", severity: "warning", message: "El organismo de la fuente coincide con más de una unidad organizativa: queda sin unidad." });
      } else if (r.status === "needs_context") {
        organizationStatus = "context_missing";
        primary.row.issues.push({ code: "ORGANISM_UNMAPPED", severity: "warning", message: "El texto es un nombre homónimo de varias unidades y no hay contexto de jurisdicción suficiente: queda sin unidad." });
      } else if (r.status === "context_conflict") {
        organizationStatus = "context_conflict";
      } else {
        organizationStatus = "unmapped";
        primary.row.issues.push({ code: "ORGANISM_UNMAPPED", severity: "warning", message: "El organismo de la fuente no tiene un alias aprobado hacia una unidad organizativa: queda sin unidad." });
      }
    }

    // -- nombre a guardar: entre los nombres compatibles, el más completo (más palabras); empate → prioridad de fuente
    const withBoth = ordered.filter((c) => c.rec.person.lastName && c.rec.person.firstName);
    const fullNameOnly = ordered.find((c) => c.rec.person.fullName);
    let lastName: string;
    let firstName: string;
    if (withBoth.length > 0) {
      const best = withBoth.reduce((a, b) => (nameOf(b).length > nameOf(a).length ? b : a));
      lastName = best.rec.person.lastName!;
      firstName = best.rec.person.firstName!;
    } else if (fullNameOnly) {
      // Apellido y nombre en una celda (PDF): no se separa automáticamente.
      lastName = fullNameOnly.rec.person.fullName!;
      firstName = "(sin separar)";
      for (const c of ordered) c.row.issues.push({ code: "NAME_NOT_SPLIT", severity: "info", message: "Apellido y nombre vienen juntos en la fuente; se conservan sin separar." });
    } else {
      lastName = "(sin apellido)";
      firstName = "(sin nombre)";
    }
    const cuilCuit = validCuils.length === 1 ? validCuils[0]![0] : null;
    const dniSource = ordered.some((c) => c.row.dniSource === "explicit") ? "explicit" : "derived_from_cuil";

    if (mergedByDecision) {
      lastName = mergedByDecision.canonicalLastName!;
      firstName = mergedByDecision.canonicalFirstName!;
    }

    const existing = existingPeople.get(dni);
    if (existing) {
      // Persona ya cargada en el CRM: solo se completan vacíos con valores inequívocos; nada se pisa ni se transfiere.
      const existingName = existing.lastName && existing.firstName ? nameTokens(`${existing.lastName} ${existing.firstName}`) : [];
      const sourceName = nameOf(ordered.find((c) => nameOf(c).length > 0) ?? ordered[0]!);
      const cuilClash = Boolean(existing.cuilCuit && cuilCuit && existing.cuilCuit !== cuilCuit);
      // Con decisión humana MERGE_SAME_PERSON el nombre ya fue resuelto por una persona: la persona guardada lleva el nombre
      // canónico y no tiene por qué coincidir con cada variante de las fuentes (si no, una segunda corrida la bloquearía).
      if ((!mergedByDecision && !nameTokensCompatible(existingName, sourceName)) || cuilClash) {
        flag(cuilClash ? "cuil_cuit" : "name", true, ordered);
        block("existing_record");
        continue;
      }
      const fills: PersonUpdate["fills"] = [];
      const values: PersonUpdate["values"] = {};
      if (!existing.email && email) {
        fills.push("email");
        values.email = email;
      }
      if (!existing.phone && phone) {
        fills.push("phone");
        values.phone = phone;
      }
      if (!existing.cuilCuit && cuilCuit) {
        fills.push("cuil_cuit");
        values.cuil_cuit = cuilCuit;
      }
      if (existing.email && email && comparableEmail(existing.email) !== comparableEmail(email)) flag("existing_record", false, ordered);
      else if (existing.phone && phone && phoneKey(existing.phone) !== phoneKey(phone)) flag("existing_record", false, ordered);
      if (fills.length > 0) toUpdate.push({ dni, fills, values });
    } else {
      toCreate.push({
        dni,
        dniSource,
        cuilCuit,
        firstName,
        lastName,
        email,
        phone,
        birthDate,
        organismText,
        organizationId,
        organizationResolution,
        organizationStatus,
        pendingFields: [...new Set(pendingFields)].sort(),
        hasNonBlockingConflicts: personConflicts.length > 0,
        sources: sourcesOf(() => true),
        rows: rowsOf(() => true),
      });
    }
    for (const c of ordered) c.row.personDni = dni;
    if (mergedByDecision) {
      for (const c of ordered) c.row.identityDecision = mergedByDecision.decision;
      identityDecisionResults.push({ personKey, decision: mergedByDecision.decision, outcome: existing ? "person_existing" : "person_created", sourceRows: ordered.length, nameVariants: variantCount });
    }
  }

  // ---------------------------------------------------------------- 4. eventos
  const allEvents = mergeEvents(rawEvents);
  const eventsToCreate = allEvents.filter((e) => !existingEventKeys.has(e.key));
  const eventsExisting = allEvents.filter((e) => existingEventKeys.has(e.key));

  // ---------------------------------------------------------------- 5. participaciones
  const participations = new Map<string, PlannedParticipation>();
  const pendingClassificationRows: RowRef[] = [];
  for (const row of rows) {
    const rec = row.record;
    if (rec.target.type === "pending_classification" && rec.kind === "person") pendingClassificationRows.push(ref(rec));
    if (rec.kind !== "person" || !row.personDni || !rec.participationKind) continue;
    if (rec.target.type !== "event" && rec.target.type !== "campaign") continue;
    const key = `${rec.target.type}|${rec.target.key}|${row.personDni}|${rec.participationKind}`;
    const current = participations.get(key);
    if (current) current.rows.push(ref(rec));
    else participations.set(key, { target: rec.target, dni: row.personDni, kind: rec.participationKind, rows: [ref(rec)] });
  }
  const participationList = [...participations.values()];

  // ---------------------------------------------------------------- 6. conteos
  const counts: PlanCounts = {
    filas_fuente_total: rows.length,
    filas_de_personas: 0,
    filas_residuales: 0,
    por_archivo: {},
    dni_explicito: 0,
    dni_derivado_de_cuil: 0,
    con_dni_canonico: 0,
    filas_sin_dni: 0,
    filas_sin_dni_por_codigo: {},
    dni_canonicos_unicos: 0,
    dni_en_mas_de_una_fila: 0,
    identidades_canonicas_totales: 0,
    people_insert_reales: toCreate.length,
    filas_de_identidades_bloqueadas: 0,
    personas_a_crear: toCreate.length,
    personas_listas_para_crear: toCreate.filter((p) => !p.hasNonBlockingConflicts).length,
    personas_con_conflictos_no_bloqueantes: toCreate.filter((p) => p.hasNonBlockingConflicts).length,
    personas_bloqueadas_por_conflicto_de_identidad: blockedPeople.length,
    personas_unificadas_por_decision_humana: identityDecisionResults.filter((r) => r.outcome !== "no_person_created").length,
    personas_a_actualizar: toUpdate.length,
    personas_con_organizacion_mapeada: toCreate.filter((p) => p.organizationId).length,
    personas_sin_organizacion: toCreate.filter((p) => !p.organizationId).length,
    organizacion_resuelta_global: toCreate.filter((p) => p.organizationResolution?.kind === "global").length,
    organizacion_resuelta_por_contexto_de_fila: toCreate.filter((p) => p.organizationResolution?.kind === "row_context").length,
    organizacion_resuelta_por_contexto_embebido: toCreate.filter((p) => p.organizationResolution?.kind === "embedded_context").length,
    organizacion_resuelta_por_contexto_de_archivo: toCreate.filter((p) => p.organizationResolution?.kind === "file_context").length,
    organizacion_resuelta_por_contexto_de_persona: toCreate.filter((p) => p.organizationResolution?.kind === "person_context").length,
    organizacion_con_contexto_insuficiente: toCreate.filter((p) => p.organizationStatus === "context_missing").length,
    organizacion_con_conflicto_de_contexto: toCreate.filter((p) => p.organizationStatus === "context_conflict").length,
    conflictos: conflicts.length,
    conflictos_bloqueantes: conflicts.filter((c) => c.blocking).length,
    conflictos_no_bloqueantes: conflicts.filter((c) => !c.blocking).length,
    conflictos_por_campo: {},
    reuniones_a_crear: eventsToCreate.length,
    reuniones_ya_existentes: eventsExisting.length,
    reuniones_por_fecha: { conocida: 0, solo_dia: 0, pendiente: 0 },
    inscripciones_a_vincular: participationList.length,
    inscripciones_a_evento: participationList.filter((p) => p.target.type === "event").length,
    inscripciones_a_campana_sin_jornada: participationList.filter((p) => p.target.type === "campaign").length,
    asistencias_acreditadas: participationList.filter((p) => p.kind === "attended").length,
    incidencias: 0,
    incidencias_por_codigo: {},
  };

  const canonicalCounts = new Map<string, number>();
  for (const row of rows) {
    const fileStats = (counts.por_archivo[row.record.fileCode] ??= { personas: 0, residuales: 0 });
    if (row.record.kind === "residual") {
      counts.filas_residuales += 1;
      fileStats.residuales += 1;
    } else {
      counts.filas_de_personas += 1;
      fileStats.personas += 1;
      if (row.normalizedDni) {
        counts.con_dni_canonico += 1;
        if (row.dniSource === "explicit") counts.dni_explicito += 1;
        else counts.dni_derivado_de_cuil += 1;
        canonicalCounts.set(row.normalizedDni, (canonicalCounts.get(row.normalizedDni) ?? 0) + 1);
      } else {
        counts.filas_sin_dni += 1;
        const code = row.issues.find((i) => i.code === "UNRECOGNIZED_LAYOUT" || i.code === "MISSING_CANONICAL_DNI" || i.code === "HIGH_SEVERITY_CONFLICT")?.code ?? "OTRO";
        increment(counts.filas_sin_dni_por_codigo, code);
      }
    }
    for (const i of row.issues) {
      if (i.severity === "info") continue; // encabezados/separadores: se conservan pero no cuentan como incidencia
      counts.incidencias += 1;
      increment(counts.incidencias_por_codigo, i.code);
    }
  }
  counts.dni_canonicos_unicos = canonicalCounts.size;
  counts.identidades_canonicas_totales = canonicalCounts.size;
  const blockedRowDnis = new Set(rows.filter((r) => r.issues.some((i) => i.code === "BLOCKED_IDENTITY_CONFLICT") && r.normalizedDni).map((r) => r.normalizedDni!));
  counts.filas_de_identidades_bloqueadas = rows.filter((r) => r.record.kind === "person" && r.normalizedDni !== null && blockedRowDnis.has(r.normalizedDni)).length;
  counts.dni_en_mas_de_una_fila = [...canonicalCounts.values()].filter((n) => n > 1).length;
  for (const c of conflicts) increment(counts.conflictos_por_campo, c.field);
  for (const e of allEvents) {
    if (e.schedulePrecision === "exact_datetime") counts.reuniones_por_fecha.conocida += 1;
    else if (e.schedulePrecision === "date_only") counts.reuniones_por_fecha.solo_dia += 1;
    else counts.reuniones_por_fecha.pendiente += 1;
  }

  return {
    files: files.map((f) => ({ fileCode: f.fileCode, fileName: f.fileName, sha256: f.sha256 })),
    rows,
    people: { toCreate, toUpdate, blocked: blockedPeople },
    conflicts,
    events: { toCreate: eventsToCreate, existing: eventsExisting },
    participations: participationList,
    pendingClassificationRows,
    identityDecisionResults,
    counts,
  };
}
