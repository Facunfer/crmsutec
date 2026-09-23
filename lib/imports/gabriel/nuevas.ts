import { canonicalIdentityDecisions, parseIdentityDecisions, type IdentityDecision, type RawDecisionRow } from "./identity-decisions.js";
import { comparableText, nameTokens, nameTokensCompatible, phoneKey, sha256Hex, stableStringify } from "./normalize.js";
import { OrganizationResolver, type AliasEntry } from "./organization-resolver.js";
import { parseSource } from "./sources.js";
import type { Cell, ExtractedFile } from "./types.js";
import { validateBirthDate, type BirthDateRejection } from "../../people/birth-date.js";

/**
 * Nuevas bases de Gabriel (2026-09-21): 7 formularios de oftalmología (PDF) y el Padrón PG (PDF).
 * DRY-RUN puro: recibe los archivos extraídos y una FOTO de solo lectura de la base; no escribe nada.
 *
 * Reglas (las del primer import, más las de esta tanda):
 *  - DNI canónico = identidad. Se compara contra las personas YA cargadas: nunca se crean duplicados.
 *  - La marca temporal del formulario es fecha de INSCRIPCIÓN, nunca de asistencia real. Pero por decisión de negocio
 *    EXCLUSIVA de la carga histórica inicial (migración 0028, no una regla general del CRM): estar incluido en estas
 *    fuentes se considera participación. Todas las participaciones nacen participation_kind='participated' con
 *    participation_basis='legacy_initial_import'; nunca 'attended' (eso exigiría evidencia real de asistencia, que
 *    esta fuente no tiene). Genera interacción solo cuando hay jornada con fecha real determinada (nunca inventada).
 *  - Una fila se vincula a una JORNADA solo si su texto de día es explícito (día de semana + número de día, coherentes
 *    con el calendario) y coincide con UNA sola jornada de esa sede. Si no: participación de campaña «sin jornada».
 *  - Obra social / prepaga / nº de afiliado son datos sensibles del operativo: NO se copian a campos de contacto ni a
 *    custom fields (solo se informa cuántas filas los traen; el crudo queda en la fuente/staging).
 *  - No se crean organizaciones: el organismo se resuelve solo por alias aprobados; lo demás es un reporte de pendientes.
 *  - Nada del Padrón PG se importa como personas nuevas si ya está en el padrón cargado: se reconcilia.
 */

export const NUEVAS_CODES = ["N01", "N02", "N03", "N04", "N05", "N06", "N07", "N08"] as const;
export type NuevaCode = (typeof NUEVAS_CODES)[number];

interface Sede {
  key: string;
  name: string;
  /** Jornadas nuevas con fecha (solo Cruz Malta). */
  newJornadas?: Array<{ date: string }>;
  /** Sin jornada comprobable: se crea el operativo con fecha desconocida. */
  unknownOperativo?: boolean;
}

export const SEDES: Record<Exclude<NuevaCode, "N01">, Sede> = {
  N02: { key: "teatro-colon", name: "Oftalmología - Teatro Colón" },
  N03: { key: "ss-trabajo", name: "Oftalmología - SS. Trabajo", unknownOperativo: true },
  N04: { key: "ivc", name: "Oftalmología - IVC", unknownOperativo: true },
  N05: { key: "cruz-malta", name: "Oftalmología - Cruz Malta", newJornadas: [{ date: "2026-07-08" }, { date: "2026-07-14" }] },
  N06: { key: "centro-metropolitano-de-diseno", name: "Oftalmología - Centro Metropolitano de Diseño", unknownOperativo: true },
  N07: { key: "canale", name: "Oftalmología - Canale" },
  N08: { key: "asi", name: "Oftalmología - ASI" },
};

const CAMPAIGN_PREFIX = "ophthalmology:";
function canonicalOrganizationKey(ctx: NuevasContext, id: string): string {
  const code = ctx.organizationCodeById?.get(id) ?? (id.startsWith("new:") ? id.slice(4) : null);
  if (!code) throw new Error("Organización resuelta sin referencia canónica de catálogo");
  return code;
}
export const campaignKeyOf = (sede: string) => `${CAMPAIGN_PREFIX}${sede}`;
export const jornadaKeyOf = (date: string, sede: string) => `${CAMPAIGN_PREFIX}${date}:${sede}`;
export const unknownOperativoKeyOf = (sede: string) => `${CAMPAIGN_PREFIX}sin-fecha:${sede}`;

// ---------------------------------------------------------------- foto de la base (solo lectura)

export interface ExistingPersonRow {
  dni: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  cuil: string | null;
  organizationId: string | null;
  birthDate: string | null;
}
export interface ExistingMeetingRow {
  key: string;
  date: string | null;
  precision: string;
}
export interface NuevasContext {
  /** Stable catalog identity, never a runtime UUID in the canonical plan. */
  organizationCodeById?: ReadonlyMap<string, string>;
  people: ExistingPersonRow[];
  meetings: ExistingMeetingRow[];
  /** «campaign|<campaign_key>|<dni>» y «meeting|<source_event_key>|<dni>» — sin el kind: cualquier participación ya
   * registrada para ese destino+persona cuenta como existente, sea cual sea su participation_kind actual. */
  participations: Set<string>;
  aliases: ReadonlyArray<AliasEntry>;
  organizationParents?: ReadonlyMap<string, string | null>;
  /** Padrón cargado (F07): registros ya extraídos del original. */
  f07: ExtractedFile | null;
  /** Decisiones humanas ya validadas sobre las identidades bloqueadas de ESTE lote (ver identity-decisions.ts). */
  identityDecisions?: ReadonlyArray<IdentityDecision>;
}

// ---------------------------------------------------------------- parseo

const norm = (s: string | null | undefined) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export interface NuevaRow {
  file: NuevaCode;
  sheet: string;
  rowNumber: number;
  /** Celdas crudas de la fila (procedencia): lo que llegó de tools/gabriel-extract-nuevas.py, sin normalizar. */
  rawCells: Cell[];
  timestamp: string | null;
  last: string | null;
  first: string | null;
  dni: string | null;
  dniProblem: "missing" | "invalid" | null;
  email: string | null;
  phone: string | null;
  birthDate: string | null;
  /** Por qué se descartó birthDate (queda en null) si la fuente traía un valor implausible: ver lib/people/birth-date.ts. */
  birthDateIssue: BirthDateRejection | null;
  organismText: string | null;
  dayText: string | null;
  affiliated: string | null;
  hasHealthInsurance: boolean;
  /** Ya hubo otra fila con el mismo DNI en este mismo archivo (no afecta la identidad; solo se informa). */
  duplicateInFile: boolean;
}

/** Clave estable de una fila para provenance (staging): coincide con (file_id, sheet, row_number) en import_rows. */
export const nuevaRowKey = (file: string, sheet: string, rowNumber: number) => `${file}|${sheet}|${rowNumber}`;

const MONTHS: Record<string, number> = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

/** «15/6/1985», «15 Mayo 1985» → AAAA-MM-DD (null si no se puede leer de forma inequívoca). */
export function parseBirthDate(text: string | null): string | null {
  if (!text) return null;
  const t = norm(text);
  let m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(t);
  let d: number, mo: number, y: number;
  if (m) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  else if ((m = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/.exec(t)) && MONTHS[m[2]!]) [d, mo, y] = [Number(m[1]), MONTHS[m[2]!]!, Number(m[3])] as [number, number, number];
  else return null;
  // padStart en el año: sin esto, un año de la fuente por debajo de 1000 (p. ej. "0099") pierde los ceros a la
  // izquierda al pasar por Number() y el ISO reconstruido deja de tener 4 dígitos: la fecha se descartaría en
  // silencio (null) SIN pasar por validateBirthDate ni generar ninguna incidencia.
  const iso = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** El DNI de un PDF viene a veces pegado a restos de la celda vecina («o 12345678»): se toma el último bloque de 7–8 dígitos. */
function extractDni(cell: string | null): { dni: string | null; problem: NuevaRow["dniProblem"] } {
  if (!cell || !/\d/.test(cell)) return { dni: null, problem: "missing" };
  const compact = cell.replace(/(?<=\d)[.\s](?=\d{3}\b)/g, "");
  const runs = compact.match(/\d{7,8}/g);
  if (!runs) return { dni: null, problem: "invalid" };
  return { dni: runs[runs.length - 1]!, problem: null };
}

const isHeaderRow = (cells: Array<string | null>) => cells.some((c) => norm(c) === "dni") && cells.some((c) => norm(c) === "apellido");

export function parseNuevaForm(file: ExtractedFile): NuevaRow[] {
  const code = file.fileCode as NuevaCode;
  const rows: NuevaRow[] = [];
  let map: Record<string, number> | null = null;
  const extraIdx: number[] = [];
  for (const sheet of file.sheets) {
    for (const row of sheet.rows) {
      const cells = row.cells.map((c) => (typeof c === "string" ? c : c === null ? null : String(c)));
      if (isHeaderRow(cells)) {
        map = {};
        extraIdx.length = 0;
        cells.forEach((h, i) => {
          const n = norm(h);
          if (n.startsWith("marca tem")) map!.ts = i;
          else if (n.startsWith("direccion de correo")) map!.emailAcc = i;
          else if (n === "apellido") map!.last = i;
          else if (n === "nombre") map!.first = i;
          else if (n.startsWith("correo electronico")) map!.emailContact = i;
          else if (n === "dni") map!.dni = i;
          else if (n.startsWith("fecha de nacimiento") || n.startsWith("feha de nacimi")) map!.birth = i;
          else if (n.startsWith("obra soci")) map!.os = i;
          else if (n.startsWith("numero de afiliado")) map!.osNum = i;
          else if (n.startsWith("es afiliad")) map!.aff = i;
          else if (n.startsWith("cel")) map!.phone = i;
          else if (n.startsWith("ministerio") || n.startsWith("reparticion")) map!.org = i;
          else if (n.startsWith("column")) extraIdx.push(i);
        });
        continue;
      }
      if (!map || map.dni === undefined) continue;
      const at = (k: string) => (map![k] === undefined ? null : (cells[map![k]!] ?? null));
      const dni = extractDni(at("dni"));
      const emailRaw = at("emailContact") ?? at("emailAcc");
      const dayText = extraIdx.map((i) => cells[i]).find((v) => v && /(lunes|martes|miercoles|jueves|viernes|sabado|domingo)/.test(norm(v))) ?? null;
      rows.push({
        file: code,
        sheet: sheet.name,
        rowNumber: row.n,
        rawCells: row.cells,
        timestamp: at("ts"),
        last: at("last"),
        first: at("first"),
        dni: dni.dni,
        dniProblem: dni.problem,
        email: emailRaw && emailRaw.includes("@") ? emailRaw.trim().toLowerCase() : null,
        phone: at("phone"),
        birthDate: parseBirthDate(at("birth")),
        birthDateIssue: null,
        organismText: at("org"),
        dayText: dayText?.trim() ?? null,
        affiliated: at("aff"),
        hasHealthInsurance: Boolean(at("os") || at("osNum")),
        duplicateInFile: false,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------- día explícito

const WEEKDAYS: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };

/** «miercoles 8/7», «jueves 9-4», «martes 21» → { weekday, day, month? }. Solo día de semana + número de día. */
export function parseExplicitDay(text: string | null): { weekday: number; day: number; month: number | null } | null {
  if (!text) return null;
  const m = /(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\s*(\d{1,2})(?:\s*[\/-]\s*(\d{1,2}))?/.exec(norm(text));
  if (!m) return null;
  return { weekday: WEEKDAYS[m[1]!]!, day: Number(m[2]), month: m[3] ? Number(m[3]) : null };
}

const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** Jornadas de la sede que coinciden EXACTAMENTE con el día explícito; se resuelve solo si hay una. */
export function matchJornada(text: string | null, dates: string[]): { date: string | null; reason: "ok" | "no_day" | "no_match" | "ambiguous" } {
  const day = parseExplicitDay(text);
  if (!day) return { date: null, reason: "no_day" };
  const hits = dates.filter((iso) => weekdayOf(iso) === day.weekday && Number(iso.slice(8, 10)) === day.day && (day.month === null || Number(iso.slice(5, 7)) === day.month));
  if (hits.length === 1) return { date: hits[0]!, reason: "ok" };
  return { date: null, reason: hits.length === 0 ? "no_match" : "ambiguous" };
}

// ---------------------------------------------------------------- plan

export interface PlannedNuevaParticipation {
  destination: { type: "meeting"; key: string } | { type: "campaign"; key: string };
  dni: string;
}

export interface NuevaIdentityDecisionResult {
  dni: string;
  decision: IdentityDecision["decision"];
  /** «existing»: se vincula a la persona ya cargada (no se crea otra); «new»: crea una persona con el nombre canónico. */
  outcome: "linked_to_existing" | "person_created" | "no_person_created";
  sourceRows: number;
}

export interface NuevasPlan {
  files: Array<{ code: NuevaCode; fileName: string; sha256: string; tablas: number; filasFuente: number }>;
  rows: NuevaRow[];
  peopleToCreate: Array<{ dni: string; first: string; last: string; email: string | null; phone: string | null; birthDate: string | null; organizationKey: string | null; organismText: string | null; files: NuevaCode[] }>;
  blocked: Array<{ dni: string; reason: string; files: NuevaCode[]; decision?: IdentityDecision["decision"] }>;
  identityDecisionResults: NuevaIdentityDecisionResult[];
  meetingsToCreate: Array<{ key: string; name: string; precision: "date_only" | "unknown"; date: string | null; sede: string }>;
  meetingsReused: Array<{ key: string; sede: string }>;
  participations: PlannedNuevaParticipation[];
  /** Destino (reunión o campaña) de cada fila de N02-N08, por `nuevaRowKey(file, sheet, rowNumber)`; null = sin DNI o identidad bloqueada. */
  rowDestinations: Map<string, PlannedNuevaParticipation["destination"] | null>;
  incidents: Record<string, number>;
  report: Record<string, unknown>;
  planHash: string;
}

function isTruncationOf(short: string | null, long: string | null): boolean {
  if (!short || !long) return false;
  return long.toLowerCase().startsWith(short.toLowerCase()) || short.toLowerCase().startsWith(long.toLowerCase());
}

export function buildNuevasPlan(files: ExtractedFile[], ctx: NuevasContext): NuevasPlan {
  const incidents: Record<string, number> = {};
  const inc = (code: string, n = 1) => (incidents[code] = (incidents[code] ?? 0) + n);
  const existing = new Map(ctx.people.map((p) => [p.dni, p]));
  const meetingByKey = new Map(ctx.meetings.map((m) => [m.key, m]));
  const resolver = new OrganizationResolver({ aliases: ctx.aliases, parentOf: ctx.organizationParents, fileJurisdictions: {} });

  // 1. filas de los 7 formularios
  const formFiles = files.filter((f) => (f.fileCode as string) !== "N01");
  const rows: NuevaRow[] = [];
  for (const f of formFiles) rows.push(...parseNuevaForm(f));

  // Plausibilidad de nacimiento (dominio, no calendario): un año de 2 dígitos ("0064"/"0070"/"0077") u otro valor
  // implausible NUNCA llega a peopleToCreate ni a people.birth_date. Se descarta acá, en la fuente, con incidencia.
  const today = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    if (!r.birthDate) continue;
    const check = validateBirthDate(r.birthDate, today);
    if (!check.ok) {
      r.birthDateIssue = check.issue;
      r.birthDate = null;
    }
  }

  const perFile: Record<string, { filas: number; validas: number; sinDni: number; dniInvalido: number; dniUnicos: Set<string>; obraSocial: number; repetidas: number }> = {};
  for (const r of rows) {
    const s = (perFile[r.file] ??= { filas: 0, validas: 0, sinDni: 0, dniInvalido: 0, dniUnicos: new Set(), obraSocial: 0, repetidas: 0 });
    s.filas += 1;
    if (r.hasHealthInsurance) s.obraSocial += 1;
    if (r.birthDateIssue) inc(r.birthDateIssue);
    if (r.dniProblem === "missing") {
      s.sinDni += 1;
      inc("MISSING_CANONICAL_DNI");
    } else if (r.dniProblem === "invalid") {
      s.dniInvalido += 1;
      inc("INVALID_DNI_FORMAT");
    } else {
      s.validas += 1;
      if (s.dniUnicos.has(r.dni!)) {
        s.repetidas += 1;
        r.duplicateInFile = true;
        inc("DUPLICATE_ROW_SAME_DNI_IN_FILE");
      }
      s.dniUnicos.add(r.dni!);
    }
  }

  // 2. identidades por DNI
  const byDni = new Map<string, NuevaRow[]>();
  for (const r of rows) if (r.dni) (byDni.get(r.dni) ?? byDni.set(r.dni, []).get(r.dni)!).push(r);
  const nameOf = (r: NuevaRow) => nameTokens(`${r.last ?? ""} ${r.first ?? ""}`);

  const decisionByDni = new Map((ctx.identityDecisions ?? []).map((d) => [d.dni, d]));
  const identityDecisionResults: NuevaIdentityDecisionResult[] = [];
  const blockedDnis = new Set<string>();
  const blocked: NuevasPlan["blocked"] = [];
  const peopleToCreate: NuevasPlan["peopleToCreate"] = [];
  const contacts = { emailNuevoParaExistente: 0, emailDistintoDeExistente: 0, emailIgual: 0, telefonoNuevoParaExistente: 0, telefonoDistintoDeExistente: 0, telefonoIgual: 0, nacimientoNuevoParaExistente: 0, nacimientoDistinto: 0, nacimientoDistintoPorExactamenteUnDia: 0 };
  const orgPending = new Map<string, { texto: string; personas: Set<string>; archivos: Set<string>; motivo: string }>();
  let resolvedNew = 0;
  let unresolvedNew = 0;
  let noTextNew = 0;
  let sugerenciaOrgParaExistentesSinOrg = 0;
  let existentesConOrgDistinta = 0;
  let existingMatched = 0;

  for (const [dni, list] of [...byDni.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const filesOf = [...new Set(list.map((r) => r.file))].sort() as NuevaCode[];
    const named = list.filter((r) => nameOf(r).length > 0);
    let clash = false;
    for (let i = 0; i < named.length && !clash; i += 1) for (let j = i + 1; j < named.length; j += 1) if (!nameTokensCompatible(nameOf(named[i]!), nameOf(named[j]!))) clash = true;
    const ex = existing.get(dni);
    if (ex && !clash) {
      const exTokens = nameTokens(`${ex.lastName} ${ex.firstName}`);
      if (named.some((r) => !nameTokensCompatible(exTokens, nameOf(r)))) clash = true;
    }
    let mergeDecision: IdentityDecision | null = null;
    if (clash) {
      const decision = decisionByDni.get(dni);
      if (decision?.decision === "MERGE_SAME_PERSON") {
        // Decisión humana aprobada: no se bloquea. Si la persona ya existe, sus filas se vinculan a ella (no se crea
        // otra); si no existe, se crea con el nombre canónico decidido (nunca con el «más completo» de las fuentes).
        mergeDecision = decision;
      } else {
        blockedDnis.add(dni);
        blocked.push({ dni, reason: ex ? "nombre incompatible con la persona ya cargada" : "nombres incompatibles entre las filas fuente", files: filesOf, decision: decision?.decision });
        inc("BLOCKED_IDENTITY_CONFLICT", list.length);
        if (decision) identityDecisionResults.push({ dni, decision: decision.decision, outcome: "no_person_created", sourceRows: list.length });
        continue;
      }
    }

    const emails = [...new Set(list.map((r) => r.email).filter((e): e is string => Boolean(e)))];
    const phones = [...new Set(list.map((r) => r.phone).filter((p): p is string => Boolean(p)))];
    const births = [...new Set(list.map((r) => r.birthDate).filter((b): b is string => Boolean(b)))];
    const orgTexts = list.filter((r) => comparableText(r.organismText));
    const orgResult = orgTexts.length ? resolver.resolveDirect(orgTexts[0]!.organismText!, "F09" as never) : null;
    const orgId = orgResult && orgResult.status === "resolved" ? orgResult.organizationId : null;
    const notePending = (motivo: string) => {
      const text = orgTexts[0]!.organismText!.trim().toLowerCase();
      const entry = orgPending.get(text) ?? { texto: text, personas: new Set<string>(), archivos: new Set<string>(), motivo };
      entry.personas.add(dni);
      for (const f of filesOf) entry.archivos.add(f);
      orgPending.set(text, entry);
    };

    if (ex) {
      existingMatched += 1;
      // Cambios demostrables sobre una persona existente: solo se INFORMAN (nada se pisa).
      if (emails.length) {
        if (!ex.email) contacts.emailNuevoParaExistente += 1;
        else if (emails.some((e) => e.toLowerCase() === ex.email!.toLowerCase() || isTruncationOf(e, ex.email))) contacts.emailIgual += 1;
        else contacts.emailDistintoDeExistente += 1;
      }
      if (phones.length) {
        if (!ex.phone) contacts.telefonoNuevoParaExistente += 1;
        else if (phones.some((p) => phoneKey(p) && (phoneKey(p) === phoneKey(ex.phone) || phoneKey(ex.phone).endsWith(phoneKey(p)) || phoneKey(p).endsWith(phoneKey(ex.phone!))))) contacts.telefonoIgual += 1;
        else contacts.telefonoDistintoDeExistente += 1;
      }
      if (births.length) {
        if (!ex.birthDate) contacts.nacimientoNuevoParaExistente += 1;
        else if (!births.includes(ex.birthDate)) {
          contacts.nacimientoDistinto += 1;
          // Huella del defecto de un día del primer import (la base quedó un día ANTES del original): se corrige con `npm run import:fix-dates`.
          const nextDay = new Date(Date.parse(`${ex.birthDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
          if (births.includes(nextDay)) contacts.nacimientoDistintoPorExactamenteUnDia += 1;
        }
      }
      if (orgId && !ex.organizationId) sugerenciaOrgParaExistentesSinOrg += 1;
      else if (orgId && ex.organizationId && orgId !== ex.organizationId) existentesConOrgDistinta += 1;
      if (mergeDecision) identityDecisionResults.push({ dni, decision: "MERGE_SAME_PERSON", outcome: "linked_to_existing", sourceRows: list.length });
      continue;
    }

    // Persona NUEVA: el nombre canónico si hay una decisión de merge; si no, el más completo entre las filas compatibles.
    const best = mergeDecision ? { first: mergeDecision.canonicalFirstName!, last: mergeDecision.canonicalLastName! } : named.reduce((a, b) => (nameOf(b).length > nameOf(a).length ? b : a), named[0]!);
    if (orgTexts.length === 0) noTextNew += 1;
    else if (orgId) resolvedNew += 1;
    else {
      unresolvedNew += 1;
      notePending(orgResult ? `resolución: ${orgResult.status}` : "sin resolución");
    }
    peopleToCreate.push({
      dni,
      first: best.first ?? "(sin nombre)",
      last: best.last ?? "(sin apellido)",
      email: emails.length === 1 ? emails[0]! : null,
      phone: phones.length === 1 ? phones[0]! : null,
      birthDate: births.length === 1 ? births[0]! : null,
      organizationKey: orgId ? canonicalOrganizationKey(ctx, orgId) : null,
      organismText: orgTexts[0]?.organismText ?? null,
      files: filesOf,
    });
    if (mergeDecision) identityDecisionResults.push({ dni, decision: "MERGE_SAME_PERSON", outcome: "person_created", sourceRows: list.length });
    if (emails.length > 1) inc("FIELD_CONFLICT_EMAIL");
    if (phones.length > 1) inc("FIELD_CONFLICT_PHONE");
    if (births.length > 1) inc("FIELD_CONFLICT_BIRTH_DATE");
  }

  // 3. actividades: operativos y jornadas
  const meetingsToCreate: NuevasPlan["meetingsToCreate"] = [];
  const meetingsReused: NuevasPlan["meetingsReused"] = [];
  const jornadaDates: Record<string, string[]> = {};
  for (const [code, sede] of Object.entries(SEDES) as Array<[Exclude<NuevaCode, "N01">, Sede]>) {
    const existingDates = ctx.meetings.filter((m) => m.key.startsWith(CAMPAIGN_PREFIX) && m.key.endsWith(`:${sede.key}`) && /^ophthalmology:\d{4}-\d{2}-\d{2}:/.test(m.key)).map((m) => m.key.split(":")[1]!);
    const dates = new Set(existingDates);
    for (const j of sede.newJornadas ?? []) {
      const key = jornadaKeyOf(j.date, sede.key);
      if (!meetingByKey.has(key)) meetingsToCreate.push({ key, name: `${sede.name} - ${j.date.split("-").reverse().join("/")}`, precision: "date_only", date: j.date, sede: sede.key });
      dates.add(j.date);
    }
    if (sede.unknownOperativo) {
      const key = unknownOperativoKeyOf(sede.key);
      if (!meetingByKey.has(key)) meetingsToCreate.push({ key, name: sede.name, precision: "unknown", date: null, sede: sede.key });
    }
    jornadaDates[code] = [...dates].sort();
  }

  // 4. participaciones (una por destino+DNI; nunca asistencia)
  const participations: PlannedNuevaParticipation[] = [];
  const seen = new Set<string>();
  const dayIssues = { conJornadaExplicita: 0, soloDiaDeSemana: 0, sinDiaValido: 0, sinDiaEnLaFila: 0, ambiguo: 0 };
  let alreadyExisting = 0;
  // Destino de CADA fila (staging/provenance): incluso las filas que no generan una participación NUEVA (porque su
  // destino ya recibió una fila anterior del mismo DNI, o la participación ya existía en la base) apuntan a la misma
  // reunión/campaña; import_rows y import_entity_links lo necesitan fila por fila, no solo agregado por DNI.
  const rowDestinations = new Map<string, PlannedNuevaParticipation["destination"] | null>();
  for (const r of rows) {
    const key = nuevaRowKey(r.file, r.sheet, r.rowNumber);
    if (!r.dni || blockedDnis.has(r.dni)) {
      rowDestinations.set(key, null);
      continue;
    }
    const sede = SEDES[r.file as Exclude<NuevaCode, "N01">];
    const dates = jornadaDates[r.file] ?? [];
    let destination: PlannedNuevaParticipation["destination"] = { type: "campaign", key: campaignKeyOf(sede.key) };
    if (dates.length > 0) {
      const explicit = parseExplicitDay(r.dayText);
      if (!r.dayText) dayIssues.sinDiaEnLaFila += 1;
      else if (!explicit) dayIssues.soloDiaDeSemana += 1; // «jueves» sin número de día: no alcanza para probar la jornada
      else {
        const match = matchJornada(r.dayText, dates);
        if (match.reason === "ok") {
          destination = { type: "meeting", key: jornadaKeyOf(match.date!, sede.key) };
          dayIssues.conJornadaExplicita += 1;
        } else if (match.reason === "ambiguous") dayIssues.ambiguo += 1;
        else dayIssues.sinDiaValido += 1;
      }
    }
    rowDestinations.set(key, destination);
    const dedupe = `${destination.type}|${destination.key}|${r.dni}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    // Sin sufijo de kind a propósito: una persona ya registrada para este destino (con cualquier kind — 'registration'
    // del histórico todavía sin reconciliar, o 'participated' si ya se reconcilió) cuenta como ya existente. Nunca se
    // crea una segunda participación para la misma persona+destino solo porque cambió la semántica del kind.
    const dbKey = `${destination.type}|${destination.key}|${r.dni}`;
    if (ctx.participations.has(dbKey)) {
      alreadyExisting += 1;
      continue;
    }
    participations.push({ destination, dni: r.dni });
  }

  // Jornadas EXISTENTES (del primer import) que reciben participaciones nuevas: se reutilizan, no se duplican.
  for (const key of new Set(participations.filter((p) => p.destination.type === "meeting" && meetingByKey.has(p.destination.key)).map((p) => p.destination.key))) {
    meetingsReused.push({ key, sede: key.split(":")[2]! });
  }

  // 5. Padrón PG (N01) vs padrón ya cargado (F07) y vs la base
  const padron = comparePadron(files.find((f) => (f.fileCode as string) === "N01") ?? null, ctx);

  // 6. informe
  const toJornada = participations.filter((p) => p.destination.type === "meeting").length;
  // Fecha usable = mismo criterio que lib/interactions/participation-sync.ts (PARTICIPATION_HAS_DATE): jornada con
  // date_only o exact_datetime y su fecha efectivamente cargada. 'unknown' (operativo sin fecha) nunca genera interacción.
  const meetingHasDate = new Map<string, boolean>();
  for (const m of meetingsToCreate) meetingHasDate.set(m.key, m.precision !== "unknown" && Boolean(m.date));
  for (const m of ctx.meetings) meetingHasDate.set(m.key, m.precision !== "unknown" && Boolean(m.date));
  const interactionsToCreate = participations.filter((p) => p.destination.type === "meeting" && meetingHasDate.get(p.destination.key)).length;
  const byDestination = participations.reduce<Record<string, number>>((acc, p) => {
    const k = `${p.destination.type}:${p.destination.key}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const perFileReport = files.map((f) => {
    const s = perFile[f.fileCode];
    return {
      codigo: f.fileCode,
      archivo: f.fileName,
      sha256: f.sha256,
      tablas: f.sheets.length,
      filas_fuente: f.sheets.reduce((n, sh) => n + sh.rows.length, 0),
      filas_de_datos: s?.filas ?? null,
      filas_validas_con_dni: s?.validas ?? null,
      filas_sin_dni: s?.sinDni ?? null,
      dni_invalidos: s?.dniInvalido ?? null,
      dni_unicos: s?.dniUnicos.size ?? null,
      filas_repetidas_mismo_dni: s?.repetidas ?? null,
      filas_con_obra_social_informada_no_se_copia: s?.obraSocial ?? null,
    };
  });
  const pending = [...orgPending.values()].sort((a, b) => b.personas.size - a.personas.size).map((e) => ({ texto: e.texto, personas: e.personas.size, archivos: [...e.archivos].sort(), contexto: "sin contexto de jurisdicción resoluble", candidato: null, decision_requerida: "aprobar alias hacia una unidad oficial o dejar sin unidad", motivo: e.motivo }));

  const report = {
    archivos: perFileReport,
    identidad: {
      filas_de_formularios: rows.length,
      filas_validas_con_dni: rows.filter((r) => r.dni).length,
      dni_unicos_en_formularios: byDni.size,
      personas_ya_existentes: existingMatched,
      personas_realmente_nuevas: peopleToCreate.length,
      identidades_bloqueadas_por_conflicto: blocked.length,
      suma_coherente: byDni.size === existingMatched + peopleToCreate.length + blocked.length,
      duplicados_dentro_del_archivo: Object.values(perFile).reduce((n, s) => n + s.repetidas, 0),
      filas_sin_dni_o_invalido: rows.filter((r) => r.dniProblem).length,
      filas_con_nacimiento_rechazado_por_implausible: rows.filter((r) => r.birthDateIssue).length,
      filas_con_nacimiento_rechazado_por_anio_ambiguo: rows.filter((r) => r.birthDateIssue === "AMBIGUOUS_BIRTH_YEAR").length,
      decisiones_humanas: ctx.identityDecisions
        ? {
            total: ctx.identityDecisions.length,
            vinculadas_a_persona_existente: identityDecisionResults.filter((r) => r.outcome === "linked_to_existing").length,
            personas_creadas_por_merge: identityDecisionResults.filter((r) => r.outcome === "person_created").length,
            sin_persona_review_later_o_keep_blocked: identityDecisionResults.filter((r) => r.outcome === "no_person_created").length,
            resultados: identityDecisionResults.map(({ dni: _dni, ...result }) => result),
          }
        : null,
    },
    cambios_sobre_personas_existentes_solo_informados_no_se_aplican: contacts,
    organizaciones: {
      nuevas_personas_con_organizacion_resuelta: resolvedNew,
      nuevas_personas_sin_texto_de_organismo: noTextNew,
      nuevas_personas_con_texto_pendiente: unresolvedNew,
      existentes_sin_organizacion_a_las_que_se_les_podria_sugerir_una: sugerenciaOrgParaExistentesSinOrg,
      existentes_con_organizacion_distinta_a_la_del_formulario_no_se_toca: existentesConOrgDistinta,
      textos_pendientes: pending,
    },
    actividades: {
      a_crear: meetingsToCreate,
      existentes_reutilizadas: [...new Map(meetingsReused.map((m) => [m.key, m])).values()].sort((a, b) => a.key.localeCompare(b.key)),
    },
    participaciones: {
      a_crear_total: participations.length,
      a_jornada: toJornada,
      a_campana_sin_jornada: participations.length - toJornada,
      ya_existentes_no_se_duplican: alreadyExisting,
      por_destino: byDestination,
      resolucion_de_dia_explicito: dayIssues,
      // Decisión de negocio EXCLUSIVA de la carga histórica inicial (migración 0028): estar incluido en estas fuentes
      // se considera participación, no una simple inscripción. Nunca aplica a actividades creadas normalmente en el CRM.
      participation_kind: "participated",
      participation_basis: "legacy_initial_import",
      posibles_asistencias: 0,
      nota_asistencia: "La marca temporal es fecha de INSCRIPCIÓN, nunca de asistencia: la interacción usa la fecha real de la jornada (o no se crea si no hay una jornada con fecha determinada).",
      interacciones_a_crear: interactionsToCreate,
      interacciones_omitidas_sin_jornada_determinada: participations.length - toJornada,
      interacciones_omitidas_jornada_sin_fecha: toJornada - interactionsToCreate,
    },
    padron_pg: padron,
    incidencias: incidents,
  };
  const planHash = sha256Hex(
    stableStringify({
      // v3: identidad organizacional estable por código oficial, sin UUID; preserva la semántica de v2.
      // Decisión de negocio de la carga histórica inicial — el estado y el basis de las
      // participaciones son parte del plan canónico (participationSemantics), no un detalle de implementación del
      // apply: dos planes con distinta semántica de participación NUNCA deben dar el mismo hash.
      version: "gabriel-nuevas-plan-v3",
      files: files.map((f) => ({ c: f.fileCode, n: f.fileName, s: f.sha256 })).sort((a, b) => a.c.localeCompare(b.c)),
      rows: rows.map((r) => ({ f: r.file, sh: r.sheet, n: r.rowNumber, dni: r.dni, p: r.dniProblem })),
      people: peopleToCreate.map((p) => ({ ...p })).sort((a, b) => a.dni.localeCompare(b.dni)),
      blocked: blocked.sort((a, b) => a.dni.localeCompare(b.dni)),
      meetings: meetingsToCreate,
      participations: [...participations].sort((a, b) => `${a.destination.key}${a.dni}`.localeCompare(`${b.destination.key}${b.dni}`)),
      participationSemantics: { kind: "participated", basis: "legacy_initial_import" },
      pendingOrg: pending.map((p) => p.texto),
      // Solo cuando hay decisiones humanas: sin ellas el payload (y el hash) queda exactamente igual que antes.
      ...(ctx.identityDecisions ? { identityDecisions: canonicalIdentityDecisions(ctx.identityDecisions) } : {}),
    })
  );
  return {
    files: files.map((f) => ({ code: f.fileCode as NuevaCode, fileName: f.fileName, sha256: f.sha256, tablas: f.sheets.length, filasFuente: f.sheets.reduce((n, sh) => n + sh.rows.length, 0) })),
    rows,
    peopleToCreate,
    blocked,
    identityDecisionResults,
    meetingsToCreate,
    meetingsReused,
    participations,
    rowDestinations,
    incidents,
    report,
    planHash,
  };
}

// ---------------------------------------------------------------- Padrón PG (PDF) vs padrón cargado

export interface PadronRow {
  dni: string;
  /** Celda del CUIL tal como sale del PDF (cortada) y primer carácter de la celda vecina, donde cae el dígito verificador. */
  cuilCell: string;
  nextCellHead: string;
  sheet: string;
  rowNumber: number;
  last: string;
  first: string;
  phone: string | null;
  email: string | null;
}

/** El PDF imprime la hoja ancha en 3 grupos de columnas; el primero (Apellido, Nombre, CUIL, teléfono, mail) es el comparable. */
export function padronRows(file: ExtractedFile): { rows: PadronRow[]; incomplete: PadronRow[]; withoutCuil: number; groupPages: number } {
  const out: PadronRow[] = [];
  const incomplete: PadronRow[] = [];
  let withoutCuil = 0;
  let groupPages = 0;
  for (const sheet of file.sheets) {
    const widths = new Map<number, number>();
    for (const r of sheet.rows) widths.set(r.cells.length, (widths.get(r.cells.length) ?? 0) + 1);
    const modal = [...widths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    if (modal < 5) continue;
    groupPages += 1;
    for (const r of sheet.rows) {
      const c = r.cells.map((x) => (typeof x === "string" ? x : x === null ? null : String(x)));
      if (c.length < 3) continue;
      if (norm(c[0]).startsWith("apellido")) continue;
      // Tres formas del CUIL en el PDF: «27-12345678-» (el dígito verificador cae en la celda vecina), 11 dígitos seguidos, o
      // 10 dígitos (INCOMPLETO: falta el dígito verificador; el DNI no se deriva de un CUIL incompleto).
      const cell = (c[2] ?? "").trim();
      const digits = cell.replace(/\D/g, "");
      const dashed = /^(\d{2})-(\d{8})(?:-\d?)?$/.exec(cell);
      const base = { cuilCell: cell, nextCellHead: (c[3] ?? "").trim().slice(0, 1), sheet: sheet.name, rowNumber: r.n, last: c[0] ?? "", first: c[1] ?? "" };
      const email = c.find((x, i) => i >= 3 && x && x.includes("@")) ?? null;
      const contact = { phone: c[3] ? c[3].replace(/^\d\s+/, "") : null, email: email ? email.toLowerCase() : null };
      if (dashed) out.push({ ...base, ...contact, dni: dashed[2]! });
      else if (digits.length === 11) out.push({ ...base, ...contact, dni: digits.slice(2, 10) });
      else if (digits.length === 10) incomplete.push({ ...base, ...contact, dni: digits.slice(2) });
      else withoutCuil += 1;
    }
  }
  return { rows: out, incomplete, withoutCuil, groupPages };
}

function comparePadron(n01: ExtractedFile | null, ctx: NuevasContext): Record<string, unknown> | null {
  if (!n01) return null;
  const pdf = padronRows(n01);
  const pdfByDni = new Map(pdf.rows.map((r) => [r.dni, r]));
  const f07Records = ctx.f07 ? parseSource(ctx.f07).records.filter((r) => r.kind === "person") : [];
  const f07 = new Map<string, (typeof f07Records)[number]>();
  for (const r of f07Records) {
    const digits = (r.person.cuilRaw ?? "").replace(/\D/g, "");
    if (digits.length === 11) f07.set(digits.slice(2, 10), r);
  }
  // Registros del padrón cargado SIN CUIL de 11 dígitos (no se les pudo derivar el DNI): el PDF podría completarlos.
  const f07Incomplete = f07Records.filter((r) => (r.person.cuilRaw ?? "").replace(/\D/g, "").length !== 11);
  const inBoth = [...pdfByDni.keys()].filter((d) => f07.has(d));
  let nameEqual = 0;
  let nameDifferent = 0;
  let phoneEqual = 0;
  let phoneDifferent = 0;
  let emailEqual = 0;
  let emailDifferent = 0;
  for (const dni of inBoth) {
    const a = pdfByDni.get(dni)!;
    const b = f07.get(dni)!.person;
    const tokA = nameTokens(`${a.last} ${a.first}`);
    const tokB = nameTokens(`${b.lastName ?? ""} ${b.firstName ?? ""}`);
    if (nameTokensCompatible(tokA, tokB)) nameEqual += 1;
    else nameDifferent += 1;
    if (a.phone && (b.phones.length > 0 || true)) {
      const ka = phoneKey(a.phone);
      const kb = b.phones.map((p) => phoneKey(p.value));
      if (ka && kb.length && kb.some((k) => k.endsWith(ka) || ka.endsWith(k) || k === ka)) phoneEqual += 1;
      else if (ka && kb.length) phoneDifferent += 1;
    }
    if (a.email) {
      const eb = b.emails.map((e) => e.value.toLowerCase());
      if (eb.some((e) => isTruncationOf(a.email, e))) emailEqual += 1;
      else if (eb.length) emailDifferent += 1;
    }
  }
  const peopleByDni = new Map(ctx.people.map((p) => [p.dni, p]));
  const pdfOnly = [...pdfByDni.keys()].filter((d) => !f07.has(d));
  // Registros con CUIL de 10 dígitos en el PDF: ¿son los mismos que el Excel cargado ya traía incompletos?
  const incompleteBothSources = pdf.incomplete.filter((row) => {
    const tok = nameTokens(`${row.last} ${row.first}`);
    return f07Incomplete.some((r) => nameTokensCompatible(tok, nameTokens(`${r.person.lastName ?? ""} ${r.person.firstName ?? ""}`)));
  }).length;
  return {
    archivo: n01.fileName,
    sha256: n01.sha256,
    paginas_con_el_grupo_de_columnas_comparable: pdf.groupPages,
    registros_del_pdf_con_cuil_legible: pdf.rows.length,
    filas_del_pdf_sin_cuil_legible_de_este_grupo: pdf.withoutCuil,
    dni_unicos_del_pdf: pdfByDni.size,
    registros_de_persona_del_padron_ya_cargado_f07: f07Records.length,
    de_ellos_con_cuil_de_11_digitos_dni_derivable: f07.size,
    de_ellos_con_cuil_incompleto_sin_dni_derivable: f07Incomplete.length,
    en_ambos: inBoth.length,
    solo_en_el_pdf: pdfOnly.length,
    registros_del_pdf_con_cuil_incompleto_10_digitos: pdf.incomplete.length,
    de_ellos_tambien_incompletos_en_el_excel_cargado: incompleteBothSources,
    solo_en_f07_no_aparecen_en_el_pdf: [...f07.keys()].filter((d) => !pdfByDni.has(d)).length,
    en_ambos_nombre_compatible: nameEqual,
    en_ambos_nombre_distinto: nameDifferent,
    en_ambos_telefono_coincide: phoneEqual,
    en_ambos_telefono_distinto: phoneDifferent,
    en_ambos_email_coincide_o_truncado: emailEqual,
    en_ambos_email_distinto: emailDifferent,
    dni_del_pdf_ya_cargados_como_personas: [...pdfByDni.keys()].filter((d) => peopleByDni.has(d)).length,
    dni_del_pdf_que_serian_personas_nuevas: pdfOnly.filter((d) => !peopleByDni.has(d)).length,
    conclusion:
      nameDifferent === 0 && pdfOnly.length === 0 && pdf.incomplete.length === incompleteBothSources
        ? "MISMO padrón: todos los registros con CUIL legible coinciden con el padrón cargado (nombre compatible) y no hay registros nuevos. El único registro con CUIL incompleto (10 dígitos) lo está IGUAL en ambas fuentes: el PDF NO lo completa. No se crean personas ni interacciones desde este archivo."
        : "El PDF trae registros que no están en el padrón cargado o difieren: ver el detalle antes de decidir.",
    diferencias_de_telefono_y_email:
      "Las diferencias de teléfono/email son en su mayoría artefactos del PDF (celdas truncadas o con el dígito pegado a la celda vecina): no se aplican cambios de contacto desde este archivo.",
  };
}

// ---------------------------------------------------------------- decisiones humanas

/** DNI de las identidades bloqueadas de ESTE lote (nuevas bases), sin ninguna decisión aplicada todavía. */
export function nuevasBlockedDnis(files: ExtractedFile[], ctx: NuevasContext): string[] {
  const { identityDecisions: _ignored, ...ctxWithoutDecisions } = ctx;
  return buildNuevasPlan(files, ctxWithoutDecisions).blocked.map((b) => b.dni).sort();
}

/**
 * Plan de las nuevas bases con las decisiones humanas ya validadas contra los DNI que ESTE lote bloquea (independiente
 * de las 12 del lote histórico). Cualquier decisión que no coincida exactamente ABORTA (parseIdentityDecisions).
 */
export function buildNuevasPlanWithDecisions(files: ExtractedFile[], ctx: NuevasContext, decisionRows?: readonly RawDecisionRow[]): { plan: NuevasPlan; decisions?: IdentityDecision[] } {
  if (!decisionRows) return { plan: buildNuevasPlan(files, ctx) };
  const decisions = parseIdentityDecisions(decisionRows, nuevasBlockedDnis(files, ctx));
  return { plan: buildNuevasPlan(files, { ...ctx, identityDecisions: decisions }), decisions };
}
