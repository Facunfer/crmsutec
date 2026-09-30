import { createHash } from "node:crypto";
import { comparableText, nameTokens, nameTokensCompatible } from "../gabriel/normalize.js";
import { matchJornada } from "../gabriel/nuevas.js";
import { OrganizationResolver, type AliasEntry, type OrgResolution } from "../gabriel/organization-resolver.js";
import type { FileCode } from "../gabriel/types.js";
import { SOURCES, sourceDef, type IncomingRow, type ParsedFile } from "./sources.js";

/**
 * Planificador (dry-run) de las tandas 1 y 2. PURO: recibe los archivos ya parseados y una foto de SOLO LECTURA de la base
 * y devuelve qué haría. No escribe nada. El informe no contiene DNI, nombres, emails ni teléfonos.
 *
 * Tres niveles: SOURCE RECORD (fila del Excel) → EVIDENCIA/PROCEDENCIA (archivo+hoja+fila) → HECHO (persona × actividad).
 * Idempotencia por HECHO: la clave lógica es «<destino>|<DNI>»; varias filas/archivos que acreditan el mismo hecho suman
 * evidencias, nunca participaciones.
 */

export interface SnapshotPerson {
  id: string;
  first: string;
  last: string;
  email: string | null;
  phone: string | null;
  cuil: string | null;
  orgId: string | null;
}
export interface SnapshotMeeting {
  key: string;
  date: string | null;
  precision: string;
  type: string;
  name: string;
  participants: number;
}
export interface Snapshot {
  people: Map<string, SnapshotPerson>;
  mergedDnis: Set<string>;
  meetings: Map<string, SnapshotMeeting>;
  /** «campaign|<key>|<dni>» / «meeting|<key>|<dni>» → participation_kind[] existentes. */
  participations: Map<string, string[]>;
  campaignCounts: Map<string, number>;
  aliases: ReadonlyArray<AliasEntry>;
  parents: ReadonlyMap<string, string | null>;
  orgNames: ReadonlyMap<string, string>;
  jurisdictionByFile: Readonly<Record<string, string>>;
  /** original_name del archivo ya cargado → DNI normalizados de sus filas. */
  prevFileDnis: Map<string, Set<string>>;
  prevFileHashes: Map<string, string>;
  emails: Set<string>;
  phones: Set<string>;
  tags: Array<{ name: string; normalized: string }>;
  today: string;
}

type Counter = Record<string, number>;
const bump = (c: Counter, k: string, n = 1) => {
  c[k] = (c[k] ?? 0) + n;
};

export interface BlockedRow {
  file: string;
  row: number;
  reason: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Como nameTokensCompatible, pero una inicial suelta («E» por «EDUARDO») no cuenta como palabra distinta. */
export function namesCompatible(a: string[], b: string[]): boolean {
  const full = (t: string[]) => t.filter((x) => x.length > 1);
  const fa = full(a);
  const fb = full(b);
  if (!nameTokensCompatible(fa, fb)) return false;
  const initialsOk = (from: string[], to: string[]) => from.filter((x) => x.length === 1).every((i) => to.some((t) => t.startsWith(i)));
  return initialsOk(a, b) && initialsOk(b, a);
}

export function rowTokens(r: IncomingRow): string[] {
  return r.last || r.first ? nameTokens(`${r.last ?? ""} ${r.first ?? ""}`) : nameTokens(r.full);
}

interface PersonAgg {
  dni: string;
  rows: IncomingRow[];
  files: Set<string>;
  cuils: Set<string>;
  block: string | null;
}

export interface FactAgg {
  dest: string; // «campaign|<key>» | «meeting|<key>»
  dni: string;
  semantics: "participation_by_rule" | "registration_only";
  files: Set<string>;
  rows: number;
  /** Filas fuente que respaldan el hecho (procedencia): «archivo|hoja|fila». */
  rowKeys: string[];
  /** Fila que se guarda como `import_row_id` de la participación. */
  originRow: { file: string; sheet: string; row: number } | null;
  /** Destinos (`campaign|…` / `meeting|…`) donde el hecho ya existe en la base. */
  existingDests: string[];
  vaccines: Set<string>;
  existing: boolean;
  existingKinds: string[];
  /** Existe como participación de campaña y la fuente trae día de jornada (refinamiento no aplicado). */
  refinableToJornada?: string;
}

export function buildTandasPlan(parsed: ParsedFile[], snap: Snapshot) {
  const resolver = new OrganizationResolver({ aliases: snap.aliases, parentOf: snap.parents, fileJurisdictions: snap.jurisdictionByFile as Partial<Record<FileCode, string>> });
  const blocked: BlockedRow[] = [];
  const perFile: Record<string, any> = {};
  const byDni = new Map<string, PersonAgg>();

  // ------------------------------------------------------------ 1. filas → personas agregadas
  for (const pf of parsed) {
    const def = sourceDef(pf.code);
    const st: Record<string, any> = {
      archivo: pf.fileName, sha256: pf.sha256, hojas: pf.sheets, filas_fisicas: pf.sheets.reduce((n, s) => n + s.physicalRows, 0),
      fila_encabezado: pf.headerRow, hoja_principal: pf.headerSheet,
      filas_utiles: 0, filas_vacias: 0, filas_residuales_o_cabecera: 0, filas_invalidas: 0, invalidas_por_motivo: {} as Counter,
      dni_unicos: 0, duplicados_internos_por_dni: 0,
    };
    const seen = new Set<string>();
    for (const r of pf.rows) {
      if (r.rowKind === "blank") st.filas_vacias += 1;
      else if (r.rowKind !== "person") st.filas_residuales_o_cabecera += 1;
      else {
        st.filas_utiles += 1;
        if (r.problem || !r.dni) {
          st.filas_invalidas += 1;
          bump(st.invalidas_por_motivo, r.problem ?? "MISSING_IDENTIFIER");
          blocked.push({ file: pf.code, row: r.row, reason: r.problem ?? "MISSING_IDENTIFIER" });
          continue;
        }
        if (seen.has(r.dni)) st.duplicados_internos_por_dni += 1;
        seen.add(r.dni);
        const agg = byDni.get(r.dni) ?? byDni.set(r.dni, { dni: r.dni, rows: [], files: new Set(), cuils: new Set(), block: null }).get(r.dni)!;
        agg.rows.push(r);
        agg.files.add(pf.code);
        if (r.cuil) agg.cuils.add(r.cuil);
      }
    }
    st.dni_unicos = seen.size;
    perFile[pf.code] = st;
    void def;
  }

  // ------------------------------------------------------------ 2. bloqueos de identidad por DNI
  const blockCounts: Counter = {};
  for (const agg of byDni.values()) {
    const existing = snap.people.get(agg.dni);
    if (!existing && snap.mergedDnis.has(agg.dni)) agg.block = "MATCHES_MERGED_PERSON";
    else if (agg.cuils.size > 1 || (existing?.cuil && [...agg.cuils].some((c) => c !== existing.cuil))) agg.block = "DNI_CUIL_CONFLICT";
    else {
      const named = agg.rows.map(rowTokens).filter((t) => t.length > 0);
      const ref = existing ? nameTokens(`${existing.last} ${existing.first}`) : null;
      if (ref && named.some((t) => !namesCompatible(t, ref))) agg.block = "NAME_CONFLICT_WITH_EXISTING_PERSON";
      else if (!ref && named.some((t, i) => named.slice(i + 1).some((u) => !namesCompatible(t, u)))) agg.block = "NAME_CONFLICT_BETWEEN_ROWS";
    }
    if (agg.block) {
      bump(blockCounts, agg.block);
      for (const r of agg.rows) {
        blocked.push({ file: r.file, row: r.row, reason: agg.block });
        bump(perFile[r.file].invalidas_por_motivo, `BLOCKED:${agg.block}`);
      }
    }
  }
  for (const [code, st] of Object.entries(perFile)) {
    st.filas_bloqueadas_o_invalidas_total = Object.entries(st.invalidas_por_motivo as Counter).reduce((n, [k, v]) => n + v, 0);
    void code;
  }

  // ------------------------------------------------------------ 3. personas: match / alta / organización
  const persons = { total_unicas_validas: 0, matches: 0, altas: 0, bloqueadas: 0, altas_con_nombre_sin_separar: 0, altas_sin_nombre: 0, altas_con_email_ya_usado: 0, altas_con_telefono_ya_usado: 0 };
  const org = { a_completar: 0, sin_cambio_ya_coincide: 0, refinable_no_aplicado: 0, conflictos: 0, sin_texto: 0, sin_resolver_persona_nueva: 0, sin_resolver_persona_existente_sin_org: 0 };
  const orgUnresolvedTexts: Record<string, Counter> = {};
  const orgConflictExamples: Array<{ existente: string; fuente: string; archivos: string[] }> = [];
  const orgToComplete: Array<{ dni: string; orgId: string }> = [];
  const newPeople: string[] = [];
  const matchedDnis: string[] = [];
  const perFilePeople: Record<string, { matches: Set<string>; altas: Set<string>; bloqueadas: Set<string> }> = {};
  const fp = (c: string) => (perFilePeople[c] ??= { matches: new Set(), altas: new Set(), bloqueadas: new Set() });

  const orgOfPerson = (agg: PersonAgg): { status: "none" | "resolved" | "unresolved" | "multiple"; orgId?: string; kinds?: OrgResolution["status"][]; texts: Array<{ file: string; text: string; status: string }> } => {
    const resolved = new Set<string>();
    const texts: Array<{ file: string; text: string; status: string }> = [];
    let any = false;
    for (const r of agg.rows) {
      for (const t of r.orgTexts) {
        any = true;
        const res = resolver.resolveDirect(t, r.file as FileCode);
        if (res.status === "resolved") resolved.add(res.organizationId);
        else texts.push({ file: r.file, text: t, status: res.status });
        if (res.status === "resolved") break;
      }
    }
    if (!any) return { status: "none", texts };
    if (resolved.size > 1) return { status: "multiple", texts };
    if (resolved.size === 1) return { status: "resolved", orgId: [...resolved][0], texts };
    return { status: "unresolved", texts };
  };

  for (const agg of byDni.values()) {
    if (agg.block) {
      persons.bloqueadas += 1;
      for (const f of agg.files) fp(f).bloqueadas.add(agg.dni);
      continue;
    }
    persons.total_unicas_validas += 1;
    const existing = snap.people.get(agg.dni);
    const o = orgOfPerson(agg);
    if (existing) {
      persons.matches += 1;
      matchedDnis.push(agg.dni);
      for (const f of agg.files) fp(f).matches.add(agg.dni);
      if (o.status === "none") org.sin_texto += 1;
      else if (o.status === "resolved") {
        if (!existing.orgId) {
          org.a_completar += 1;
          orgToComplete.push({ dni: agg.dni, orgId: o.orgId! });
        } else if (existing.orgId === o.orgId || resolver.isWithin(existing.orgId, o.orgId!)) org.sin_cambio_ya_coincide += 1;
        else if (resolver.isWithin(o.orgId!, existing.orgId)) org.refinable_no_aplicado += 1;
        else {
          org.conflictos += 1;
          if (orgConflictExamples.length < 25) orgConflictExamples.push({ existente: snap.orgNames.get(existing.orgId) ?? "?", fuente: snap.orgNames.get(o.orgId!) ?? "?", archivos: [...agg.files] });
        }
      } else if (!existing.orgId) {
        org.sin_resolver_persona_existente_sin_org += 1;
        for (const t of o.texts) bump((orgUnresolvedTexts[`${t.file}:${t.status}`] ??= {}), comparableText(t.text));
      }
    } else {
      persons.altas += 1;
      newPeople.push(agg.dni);
      for (const f of agg.files) fp(f).altas.add(agg.dni);
      const both = agg.rows.find((r) => r.last && r.first);
      if (!both) {
        if (agg.rows.some((r) => r.full)) persons.altas_con_nombre_sin_separar += 1;
        else if (!agg.rows.some((r) => r.last || r.first)) persons.altas_sin_nombre += 1;
      }
      if (agg.rows.some((r) => r.email && snap.emails.has(r.email))) persons.altas_con_email_ya_usado += 1;
      if (agg.rows.some((r) => r.phone && snap.phones.has(r.phone))) persons.altas_con_telefono_ya_usado += 1;
      if (o.status === "unresolved" || o.status === "multiple") {
        org.sin_resolver_persona_nueva += 1;
        for (const t of o.texts) bump((orgUnresolvedTexts[`${t.file}:${t.status}`] ??= {}), comparableText(t.text));
      }
    }
  }
  for (const [code, sets] of Object.entries(perFilePeople)) {
    perFile[code].personas = { matches: sets.matches.size, altas: sets.altas.size, bloqueadas: sets.bloqueadas.size };
  }

  // ------------------------------------------------------------ 4. hechos (persona × actividad)
  const facts = new Map<string, FactAgg>();
  const jornadaDates = (sede: string) =>
    [...snap.meetings.values()].flatMap((m) => {
      const x = new RegExp(`^ophthalmology:(\\d{4}-\\d{2}-\\d{2}):${sede}$`).exec(m.key);
      return x ? [x[1]!] : [];
    }).sort();
  const existingKinds = (dest: string, dni: string) => snap.participations.get(`${dest}|${dni}`) ?? [];
  const dayStats: Record<string, Counter> = {};

  for (const pf of parsed) {
    const def = sourceDef(pf.code);
    if (!def.activity || def.semantics === "none") continue;
    const dates = def.jornadaSede ? jornadaDates(def.jornadaSede) : [];
    const ds = (dayStats[pf.code] ??= {});
    for (const r of pf.rows) {
      if (r.rowKind !== "person" || !r.dni) continue;
      const agg = byDni.get(r.dni)!;
      if (agg.block) continue;
      let dest = `${def.activity.target}|${def.activity.key}`;
      let jornadaHit: string | null = null;
      if (def.jornadaSede && dates.length && r.dayText) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(r.dayText)) {
          if (dates.includes(r.dayText)) jornadaHit = r.dayText;
          else bump(ds, "dia_iso_sin_jornada_existente");
        } else {
          const m = matchJornada(r.dayText, dates);
          if (m.reason === "ok") jornadaHit = m.date;
          else bump(ds, `dia_${m.reason}`);
        }
      } else if (def.jornadaSede && r.dayText) bump(ds, "dia_sin_jornadas_existentes_en_la_sede");
      if (jornadaHit) {
        dest = `meeting|ophthalmology:${jornadaHit}:${def.jornadaSede}`;
        bump(ds, "filas_con_jornada_probada");
      }
      const logicalKey = def.jornadaSede ? `sede:${def.jornadaSede}|${r.dni}` : `${dest}|${r.dni}`;
      let f = facts.get(logicalKey);
      if (!f) {
        f = { dest, dni: r.dni, semantics: def.semantics as FactAgg["semantics"], files: new Set(), rows: 0, rowKeys: [], originRow: null, existingDests: [], vaccines: new Set(), existing: false, existingKinds: [] };
        facts.set(logicalKey, f);
      } else if (jornadaHit && f.dest.startsWith("campaign|")) f.dest = dest;
      f.files.add(pf.code);
      f.rows += 1;
      f.rowKeys.push(`${r.file}|${r.sheet}|${r.row}`);
      if (!f.originRow) f.originRow = { file: r.file, sheet: r.sheet, row: r.row };
      for (const v of r.vaccines) f.vaccines.add(v);
      if (def.semantics === "participation_by_rule") f.semantics = "participation_by_rule";
    }
  }
  // existencia (cualquier kind) contra la base; para oftalmología, cualquier nivel de la misma sede cuenta como el mismo hecho
  const sedeDests = (sede: string) => [`campaign|ophthalmology:${sede}`, ...[...snap.meetings.keys()].filter((k) => new RegExp(`^ophthalmology:(\\d{4}-\\d{2}-\\d{2}|sin-fecha):${sede}$`).test(k)).map((k) => `meeting|${k}`)];
  for (const [key, f] of facts) {
    const sede = key.startsWith("sede:") ? key.slice(5).split("|")[0]! : null;
    const dests = sede ? sedeDests(sede) : [f.dest];
    const kinds = dests.flatMap((d) => existingKinds(d, f.dni));
    f.existingDests = dests.filter((d) => existingKinds(d, f.dni).length > 0);
    f.existing = kinds.length > 0;
    f.existingKinds = kinds;
  }

  // ------------------------------------------------------------ 5. resumen de hechos por fuente + interacciones
  const factReport: Record<string, any> = {};
  const interactions: Record<string, any> = {};
  const activitiesNew = new Map<string, { target: string; key: string; name: string; type: string; precision: string; date: string | null; start: string | null; end: string | null; sources: string[]; existsInDb: boolean }>();
  for (const pf of parsed) {
    const def = sourceDef(pf.code);
    if (!def.activity || def.semantics === "none") continue;
    const a = def.activity;
    const dbKey = a.target === "meeting" ? a.key : null;
    const existsMeeting = dbKey ? snap.meetings.has(dbKey) : false;
    const campaignExists = a.target === "campaign" ? (snap.campaignCounts.get(a.key) ?? 0) > 0 : false;
    const list = activitiesNew.get(`${a.target}|${a.key}`);
    const date = pf.listadoDate?.date ?? null;
    if (list) list.sources.push(pf.code);
    else
      activitiesNew.set(`${a.target}|${a.key}`, {
        target: a.target, key: a.key, name: a.name, type: a.type,
        precision: date ? (pf.listadoDate?.start ? "exact_datetime" : "date_only") : "unknown", date,
        start: pf.listadoDate?.start ?? null, end: pf.listadoDate?.end ?? null, sources: [pf.code], existsInDb: existsMeeting || campaignExists,
      });
  }
  for (const pf of parsed) {
    const def = sourceDef(pf.code);
    if (!def.activity || def.semantics === "none") continue;
    const mine = [...facts.entries()].filter(([, f]) => f.files.has(pf.code));
    const r: Counter = { hechos_unicos_en_esta_fuente: mine.length, ya_existentes: 0, nuevos: 0, filas_fuente_que_los_respaldan: 0, compartidos_con_otras_fuentes_de_esta_corrida: 0 };
    const ix: Counter = {};
    for (const [, f] of mine) {
      r.filas_fuente_que_los_respaldan! += 0;
      if (f.existing) r.ya_existentes! += 1;
      else r.nuevos! += 1;
      if (f.files.size > 1) r.compartidos_con_otras_fuentes_de_esta_corrida! += 1;
      if (!f.existing) {
        const act = activitiesNew.get(`${def.activity.target}|${def.activity.key}`)!;
        const destMeeting = f.dest.startsWith("meeting|") ? snap.meetings.get(f.dest.slice(8)) ?? null : null;
        const hasRealDate = f.semantics === "participation_by_rule" && (destMeeting ? destMeeting.precision !== "unknown" && !!destMeeting.date : act.target === "meeting" && !!act.date && !act.existsInDb);
        if (f.semantics === "registration_only") bump(ix, "sin_interaccion:inscripcion_no_es_participacion");
        else if (f.dest.startsWith("campaign|")) bump(ix, "sin_interaccion:campana_sin_jornada_determinada");
        else if (hasRealDate) bump(ix, "sin_interaccion:decision_de_negocio_participacion_con_fecha_real_no_es_contacto");
        else bump(ix, "sin_interaccion:actividad_sin_fecha_determinada");
      }
    }
    r.filas_fuente_que_los_respaldan = pf.rows.filter((x) => x.rowKind === "person" && x.dni && !byDni.get(x.dni)?.block).length;
    factReport[pf.code] = { ...r, semantica: def.semantics, actividad: def.activity.name, destino: `${def.activity.target}:${def.activity.key}`, jornadas: dayStats[pf.code] ?? {} };
    interactions[pf.code] = ix;
  }

  const factList = [...facts.values()];
  const newFacts = factList.filter((f) => !f.existing);
  const totals = {
    hechos_logicos: factList.length,
    hechos_ya_existentes: factList.length - newFacts.length,
    participaciones_nuevas: newFacts.filter((f) => f.semantics === "participation_by_rule").length,
    inscripciones_nuevas: newFacts.filter((f) => f.semantics === "registration_only").length,
    hechos_respaldados_por_mas_de_una_fuente: factList.filter((f) => f.files.size > 1).length,
    participaciones_nuevas_por_destino: newFacts.reduce<Counter>((c, f) => (bump(c, f.dest), c), {}),
  };

  // ------------------------------------------------------------ 7. especificaciones para el apply (sin efectos)
  const orgByDni = new Map<string, string>();
  for (const agg of byDni.values()) {
    if (agg.block) continue;
    const o = orgOfPerson(agg);
    if (o.status === "resolved") orgByDni.set(agg.dni, o.orgId!);
  }
  const newPersonSpecs = newPeople.map((dni) => {
    const agg = byDni.get(dni)!;
    const both = agg.rows.find((r) => r.last && r.first);
    const fullOnly = agg.rows.find((r) => r.full);
    const cuilRow = agg.rows.find((r) => r.cuil);
    const derived = agg.rows.some((r) => r.dniSource === "derived_from_cuil") && !agg.rows.some((r) => r.dniSource === "explicit");
    return {
      dni,
      unsplit: !both,
      first: both ? both.first! : "",
      last: both ? both.last! : (fullOnly?.full ?? agg.rows.find((r) => r.last)?.last ?? ""),
      fullOriginal: both ? null : (fullOnly?.full ?? agg.rows.find((r) => r.last)?.last ?? null),
      email: agg.rows.find((r) => r.email)?.email ?? null,
      phone: agg.rows.find((r) => r.phone)?.phone ?? null,
      birthDate: agg.rows.find((r) => r.birthDate)?.birthDate ?? null,
      cuil: cuilRow?.cuil ?? null,
      dniSource: (derived && cuilRow ? "derived_from_cuil" : "explicit") as "explicit" | "derived_from_cuil",
      orgId: orgByDni.get(dni) ?? null,
    };
  });
  const observationSpecs: Array<{ dni: string; category: string; value: string; rowKey: string }> = [];
  const tagSet = new Set<string>();
  for (const agg of byDni.values()) {
    if (agg.block) continue;
    for (const r of agg.rows.filter((x) => x.file === "T04")) {
      tagSet.add(agg.dni);
      if (r.college) observationSpecs.push({ dni: agg.dni, category: "colegio_votacion", value: r.college, rowKey: `${r.file}|${r.sheet}|${r.row}` });
    }
  }
  const blockedByRow = new Map(blocked.map((b) => [`${b.file}|${b.row}`, b.reason]));
  const rowOutcomes: Array<{ key: string; file: string; sheet: string; row: number; dni: string | null; blockedReason: string | null; cuil: string | null; dniSource: string | null }> = [];
  for (const pf of parsed) {
    for (const r of pf.rows) {
      if (r.rowKind !== "person") continue;
      rowOutcomes.push({ key: `${r.file}|${r.sheet}|${r.row}`, file: r.file, sheet: r.sheet, row: r.row, dni: r.problem ? null : r.dni, blockedReason: r.problem ?? blockedByRow.get(`${r.file}|${r.row}`) ?? null, cuil: r.cuil, dniSource: r.dniSource });
    }
  }

  // ------------------------------------------------------------ 8. plan hash: ESTADO DESEADO derivado de las fuentes
  // (no depende de cuánto de esto ya se aplicó): un reintento tras una falla parcial produce el MISMO hash.
  const canonical = JSON.stringify({
    v: "tandas-plan-v2",
    processable: [...byDni.values()].filter((a) => !a.block).map((a) => a.dni).sort(),
    facts: factList.map((f) => `${f.dest}|${f.dni}|${f.semantics}|${[...f.vaccines].sort().join("+")}`).sort(),
    org: [...orgByDni].map(([d, o]) => `${d}|${o}`).sort(),
    obs: observationSpecs.map((o) => `${o.dni}|${o.category}|${o.value}`).sort(),
    tags: [...tagSet].sort(),
    blocked: blocked.map((b) => `${b.file}|${b.row}|${b.reason}`).sort(),
  });
  const planHash = sha(canonical);

  return {
    newPersonSpecs, observationSpecs, tagDnis: [...tagSet], rowOutcomes,
    perFile, persons, org, orgUnresolvedTexts, orgConflictExamples, orgToComplete, newPeople, matchedDnis, blocked, blockCounts,
    facts: factList, factReport, interactions, activities: [...activitiesNew.values()], totals, planHash, byDni, dayStats,
  };
}

export { SOURCES };
