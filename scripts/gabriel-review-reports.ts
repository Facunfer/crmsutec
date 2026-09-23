import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { comparableText, nameTokens } from "../lib/imports/gabriel/normalize.js";
import { buildPlan, type ImportPlan, type PlannedRow } from "../lib/imports/gabriel/plan.js";
import { FILE_CODES, type ExtractedFile, type FileCode } from "../lib/imports/gabriel/types.js";
import { aliasKey } from "../lib/organizations/catalog/plan.js";
import { isYes, type OrgCatalog } from "../lib/organizations/catalog/types.js";
import { readRealSource } from "./org-coverage-sim.js";

/**
 * Reportes de REVISIÓN HUMANA de la importación de Gabriel (nada se decide ni se escribe en ninguna base):
 *   1. gabriel_identidades_bloqueadas.xlsx   — las identidades con BLOCKED_IDENTITY_CONFLICT;
 *   2. gabriel_f03_revision.xlsx             — F03 (AGC-CAPACITACION 2026) y su solapamiento con otras capacitaciones;
 *   3. gabriel_organismos_pendientes.xlsx    — textos de organismo sin resolver / contexto insuficiente / conflicto.
 *
 *   npm run gabriel:review-reports -- [--out "C:\\Users\\usuario\\Documents\\sutecba-fuentes\\reports"]
 *
 * Los .xlsx contienen datos personales y quedan FUERA de Git. Este script solo imprime conteos y rutas.
 */

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as { $date?: string; $datetime?: string };
    return o.$datetime ?? o.$date ?? JSON.stringify(v);
  }
  return String(v).trim();
};

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j += 1) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

const nameOfRow = (r: PlannedRow) => {
  const p = r.record.person;
  return p.lastName && p.firstName ? `${p.lastName}, ${p.firstName}`.replace(/\s+/g, " ") : (p.fullName ?? "").replace(/\s+/g, " ");
};
const tokensOfRow = (r: PlannedRow) => nameTokens(r.record.person.lastName && r.record.person.firstName ? `${r.record.person.lastName} ${r.record.person.firstName}` : r.record.person.fullName);
const where = (plan: ImportPlan, r: PlannedRow) => `${plan.files.find((f) => f.fileCode === r.record.fileCode)?.fileName ?? r.record.fileCode} · hoja «${r.record.sheet}» · fila ${r.record.rowNumber}`;

// ---------------------------------------------------------------- 1. identidades bloqueadas
function blockedIdentities(plan: ImportPlan) {
  const rowOf = (ref: { fileCode: FileCode; sheet: string; rowNumber: number }) => plan.rows.find((r) => r.record.fileCode === ref.fileCode && r.record.sheet === ref.sheet && r.record.rowNumber === ref.rowNumber);
  const byDni = new Map<string, ImportPlan["conflicts"]>();
  for (const c of plan.conflicts.filter((x) => x.blocking)) {
    const dni = rowOf(c.rows[0]!)?.normalizedDni;
    if (!dni) continue;
    byDni.set(dni, [...(byDni.get(dni) ?? []), c]);
  }
  const groups: Array<Record<string, unknown>> = [];
  const detail: Array<Record<string, unknown>> = [];
  for (const [dni, conflicts] of [...byDni].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = plan.rows.filter((r) => r.normalizedDni === dni && r.record.kind === "person");
    const cuils = [...new Set(rows.map((r) => r.normalizedCuil).filter(Boolean))];
    const reasons: string[] = [];
    const proposals: string[] = [];
    for (const c of conflicts) {
      if (c.field === "name") {
        const [a, b] = c.rows.map((ref) => rowOf(ref)!);
        const ta = tokensOfRow(a!);
        const tb = tokensOfRow(b!);
        const shared = ta.filter((t) => tb.includes(t));
        const onlyA = ta.filter((t) => !tb.includes(t));
        const onlyB = tb.filter((t) => !ta.includes(t));
        reasons.push(
          `BLOCKED_IDENTITY_CONFLICT en «nombre»: «${nameOfRow(a!)}» (${where(plan, a!)}) y «${nameOfRow(b!)}» (${where(plan, b!)}) no son compatibles: ` +
            `palabras en común [${shared.join(", ") || "ninguna"}]; solo en la primera [${onlyA.join(", ")}]; solo en la segunda [${onlyB.join(", ")}]. ` +
            `El normalizador solo unifica nombres cuando las palabras de uno están todas en el otro.`
        );
        const typo = onlyA.flatMap((x) => onlyB.filter((y) => x.length >= 4 && y.length >= 4 && levenshtein(x, y) <= 2).map((y) => `«${x}» ≈ «${y}»`));
        if (shared.length === 0) proposals.push("Sin palabras en común: parecen personas distintas con un mismo DNI (posible DNI mal cargado en una fuente).");
        else if (typo.length > 0) proposals.push(`Comparten ${shared.length} palabra(s) y difieren por pocas letras (${typo.join("; ")}): posible error de tipeo, pero NO se unifica sola.`);
        else proposals.push(`Comparten ${shared.length} palabra(s) pero cada nombre trae palabras propias (variante de nombre/apellido distinta): requiere criterio humano.`);
      } else if (c.field === "cuil_cuit") {
        const uniq = [...new Set(rows.map((r) => r.normalizedCuil).filter(Boolean))];
        reasons.push(`BLOCKED_IDENTITY_CONFLICT en «CUIL/CUIT»: hay ${uniq.length} CUIL/CUIT válidos distintos (${uniq.join(", ")}) para el mismo DNI.`);
        proposals.push("Dos CUIL válidos para un mismo DNI: no se elige ninguno; verificar cuál corresponde.");
      } else reasons.push(`BLOCKED_IDENTITY_CONFLICT en «${c.field}».`);
    }
    groups.push({
      dni,
      cuil: cuils.join(" / "),
      nombres: [...new Set(rows.map(nameOfRow))],
      fuentes: [...new Set(rows.map((r) => plan.files.find((f) => f.fileCode === r.record.fileCode)?.fileName))],
      hojas: [...new Set(rows.map((r) => `${r.record.fileCode}: ${r.record.sheet}`))],
      filas: rows.map((r) => `${r.record.fileCode} fila ${r.record.rowNumber}`),
      emails: [...new Set(rows.flatMap((r) => r.record.person.emails.map((e) => e.value)))],
      telefonos: [...new Set(rows.flatMap((r) => r.record.person.phones.map((p) => p.value)))],
      reparticiones: [...new Set(rows.map((r) => r.record.person.organismText).filter(Boolean))],
      nacimiento: [...new Set(rows.map((r) => r.record.person.birthDate).filter(Boolean))],
      apariciones: rows.length,
      motivo: reasons,
      propuesta: [...proposals, "Propuesta del normalizador: NO crear la persona y conservar las filas en staging hasta tu decisión."],
      decision: "",
      canonical_first_name: "",
      canonical_last_name: "",
      notes: "",
    });
    for (const r of rows) {
      detail.push({
        dni,
        cuil: r.normalizedCuil ?? "",
        apellido: r.record.person.lastName ?? "",
        nombre: r.record.person.firstName ?? "",
        nombre_completo_sin_separar: r.record.person.fullName ?? "",
        archivo: plan.files.find((f) => f.fileCode === r.record.fileCode)?.fileName,
        codigo: r.record.fileCode,
        hoja: r.record.sheet,
        fila: r.record.rowNumber,
        email: r.record.person.emails.map((e) => e.value).join(", "),
        telefono: r.record.person.phones.map((p) => p.value).join(", "),
        reparticion: r.record.person.organismText ?? "",
        nacimiento: r.record.person.birthDate ?? "",
        dni_proviene_de: r.dniSource ?? "",
      });
    }
  }
  return { groups, detail };
}

// ---------------------------------------------------------------- 2. F03
function f03Report(plan: ImportPlan) {
  const f03 = plan.rows.filter((r) => r.record.fileCode === "F03" && r.record.kind === "person");
  const headerRow = plan.rows.find((r) => r.record.fileCode === "F03" && r.record.kind === "residual" && /marca temporal/i.test(cellText(r.record.rawData.c0)));
  const idx = (needle: RegExp) => Object.entries(headerRow?.record.rawData ?? {}).find(([, v]) => needle.test(cellText(v)))?.[0];
  const cTs = idx(/marca temporal/i) ?? "c0";
  const cIngreso = idx(/fecha de ingreso/i) ?? "c3";
  const cRep = idx(/reparticion/i) ?? "c5";
  const cArea = idx(/area/i) ?? "c6";
  const dniSet = (code: FileCode) => new Set(plan.rows.filter((r) => r.record.fileCode === code && r.record.kind === "person" && r.normalizedDni).map((r) => r.normalizedDni!));
  const sets = { F01: dniSet("F01"), F02: dniSet("F02"), F04: dniSet("F04"), F05: dniSet("F05") };
  const rows = f03.map((r) => {
    const dni = r.normalizedDni ?? "";
    return {
      dni_canonico: dni,
      dni_procedencia: r.dniSource ?? "",
      nombre: r.record.person.fullName ?? nameOfRow(r),
      cuil: r.record.person.cuilRaw ?? "",
      reparticion: cellText(r.record.rawData[cRep]),
      area: cellText(r.record.rawData[cArea]),
      fecha_ingreso: cellText(r.record.rawData[cIngreso]),
      marca_temporal: cellText(r.record.rawData[cTs]),
      archivo: plan.files.find((f) => f.fileCode === "F03")?.fileName,
      hoja: r.record.sheet,
      fila: r.record.rowNumber,
      tambien_en_F04: dni && sets.F04.has(dni) ? "SÍ" : "no",
      tambien_en_F05: dni && sets.F05.has(dni) ? "SÍ" : "no",
      tambien_en_F01_RCP: dni && sets.F01.has(dni) ? "SÍ" : "no",
      tambien_en_F02_RCP: dni && sets.F02.has(dni) ? "SÍ" : "no",
    };
  });
  const dnis = f03.map((r) => r.normalizedDni).filter((d): d is string => Boolean(d));
  const uniq = [...new Set(dnis)];
  const count = (pred: (d: string) => boolean) => uniq.filter(pred).length;
  const in4 = (d: string) => sets.F04.has(d);
  const in5 = (d: string) => sets.F05.has(d);
  const summary = {
    filas_f03: f03.length,
    personas_distintas_con_dni: uniq.length,
    filas_sin_dni_canonico: f03.length - dnis.length,
    tambien_en_F04: count(in4),
    tambien_en_F05: count(in5),
    en_ambas_F04_y_F05: count((d) => in4(d) && in5(d)),
    solo_F04: count((d) => in4(d) && !in5(d)),
    solo_F05: count((d) => in5(d) && !in4(d)),
    en_ninguna_de_F04_ni_F05: count((d) => !in4(d) && !in5(d)),
    tambien_en_F01_RCP: count((d) => sets.F01.has(d)),
    tambien_en_F02_RCP: count((d) => sets.F02.has(d)),
    en_ninguna_capacitacion_recuperada: count((d) => !in4(d) && !in5(d) && !sets.F01.has(d) && !sets.F02.has(d)),
  };
  const tsRange = (code: FileCode) => {
    const values = plan.rows.filter((r) => r.record.fileCode === code && r.record.kind === "person").map((r) => cellText(r.record.rawData.c0)).filter((t) => /\d{4}|\d{1,2}\/\d{1,2}/.test(t)).sort();
    return values.length ? `${values[0]} … ${values.at(-1)}` : "sin marca temporal";
  };
  const repDist = (code: FileCode, col: string) => {
    const m = new Map<string, number>();
    for (const r of plan.rows.filter((x) => x.record.fileCode === code && x.record.kind === "person")) {
      const k = comparableText(cellText(r.record.rawData[col])) || "(vacío)";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} (${n})`).join("; ");
  };
  return { rows, summary, timestamps: { F03: tsRange("F03"), F04: tsRange("F04") }, repDist: { F03: repDist("F03", cRep), F04: repDist("F04", "c6"), F05: repDist("F05", "c6") } };
}

// ---------------------------------------------------------------- 3. organismos pendientes
const INVESTIGATION: Record<string, { clase: "SAFE_CANDIDATE" | "AMBIGUOUS" | "HISTORICAL" | "INVALID" | "UNRESOLVED"; candidato: string; razon: string }> = {
  "sastreria cultura": { clase: "AMBIGUOUS", candidato: "MCGC (Ministerio de Cultura) o EATC (Ente Autárquico Teatro Colón)", razon: "«Sastrería» es un taller/área laboral, no una unidad catalogada; «Cultura» sola apunta al ministerio, pero un taller de sastrería puede ser del Teatro Colón, que en el catálogo es un ente autárquico con raíz propia. El catálogo lo deja en REVISAR." },
  dgadb: { clase: "UNRESOLVED", candidato: "—", razon: "Sigla sin correspondencia: ninguna de las 146 unidades cargadas tiene ese código ni esas iniciales. Probablemente pertenece a una rama del organigrama todavía no catalogada." },
  dgpdynd: { clase: "UNRESOLVED", candidato: "—", razon: "Sigla sin correspondencia en el catálogo cargado (ningún código ni iniciales coinciden). Aparece en filas de la hoja «Educación»; esa jurisdicción no está desarrollada en el catálogo V1." },
  inversiones: { clase: "AMBIGUOUS", candidato: "SSIN (Subsecretaría de Inversiones)", razon: "Es la única unidad cargada que contiene la palabra, pero «inversiones» es un sustantivo genérico (el propio catálogo dice que el texto aislado es genérico) y no trae jurisdicción. No es inequívoco." },
  tecba: { clase: "AMBIGUOUS", candidato: "ASINF (Agencia de Sistemas de Información)", razon: "Decisiones_V2: TecBA es una iniciativa/marca integrada por más de un organismo; no equivale automáticamente a ASINF ni existe como código oficial." },
  alumbrado: { clase: "UNRESOLVED", candidato: "—", razon: "Ninguna unidad cargada contiene «alumbrado»; es una función/área que no está catalogada." },
  apra: { clase: "UNRESOLVED", candidato: "—", razon: "Sigla sin correspondencia: ningún código ni iniciales de las 146 unidades coinciden." },
  bienes: { clase: "UNRESOLVED", candidato: "—", razon: "Ninguna unidad cargada contiene «bienes»; es genérico (área o función), sin jurisdicción." },
  dai: { clase: "AMBIGUOUS", candidato: "DGAI (Dirección General Administración de Infracciones)", razon: "Solo coincide por similitud de iniciales (el catálogo lo marca «sugerencia por similitud textual»); la sigla puede referirse a otras unidades no catalogadas. No es inequívoco." },
  dginfra: { clase: "AMBIGUOUS", candidato: "DGIASINF (DG Infraestructura, ASINF) o MMIGC (Ministerio de Movilidad e Infraestructura)", razon: "Catálogo: código abreviado ambiguo, existen varias Direcciones Generales de Infraestructura. En el catálogo cargado hay más de una unidad con «infraestructura» y el texto no trae jurisdicción." },
  dgovp: { clase: "UNRESOLVED", candidato: "—", razon: "Sigla sin correspondencia en el catálogo cargado." },
  "efectos escenicos": { clase: "UNRESOLVED", candidato: "—", razon: "Área artística/técnica que no figura como unidad catalogada (del Teatro Colón solo están «Orquestas y Coro» y «Escenotécnica»). No se infiere el organismo desde el nombre del área." },
  "liquidacion haberes": { clase: "UNRESOLVED", candidato: "—", razon: "Función/área laboral, no una unidad catalogada; varias jurisdicciones tienen liquidación de haberes. Las áreas laborales nunca son contexto." },
  luminotecnia: { clase: "UNRESOLVED", candidato: "—", razon: "Área técnica no catalogada; mismo caso que «efectos escénicos»." },
  "ministerio de espacio publico": { clase: "SAFE_CANDIDATE", candidato: "MEPHUGC (Ministerio de Espacio Público e Higiene Urbana)", razon: "Es la única unidad del catálogo cuyo nombre oficial comienza exactamente con «Ministerio de Espacio Público» (el texto omite «e Higiene Urbana»); no compite con otra. Podría ser un nombre abreviado o anterior del mismo ministerio: NO se aprueba sola, requiere tu confirmación." },
  ordenamiento: { clase: "AMBIGUOUS", candidato: "SECOU (Secretaría Ordenamiento Urbano) o SSGOU (Subsecretaría de Gestión del Ordenamiento Urbano)", razon: "Dos unidades cargadas contienen «ordenamiento» y el texto no trae jurisdicción ni nivel." },
  pymes: { clase: "UNRESOLVED", candidato: "—", razon: "Ninguna unidad cargada contiene «pymes»; es un área/programa sin catalogar." },
  seguridad: { clase: "AMBIGUOUS", candidato: "MSEGC (Ministerio de Seguridad), DGSEI (DG Seguridad Informática) o DGHYSA (DG Higiene y Seguridad Alimentaria)", razon: "Varias unidades cargadas contienen «seguridad»; además existe la denominación histórica «Seguridad y Justicia» (hoy jurisdicciones separadas). Sin contexto no es inequívoco." },
  "sindicatura general de la ciudad": { clase: "SAFE_CANDIDATE", candidato: "SGCBA (Sindicatura General de la Ciudad de Buenos Aires)", razon: "Es la única sindicatura del catálogo y el texto es su nombre oficial sin «de Buenos Aires»; ya están cargados como alias seguros «Sindicatura» y el nombre completo hacia SGCBA. NO se aprueba sola, requiere tu confirmación." },
  "min seguridad y justicia": { clase: "HISTORICAL", candidato: "—", razon: "(Fuera de tu lista.) Denominación histórica: hoy Justicia y Seguridad son jurisdicciones separadas (Decisiones_V2 → REVISAR)." },
  "0": { clase: "INVALID", candidato: "—", razon: "(Fuera de tu lista.) Valor vacío/placeholder: no debe crear ni asignar organismo." },
};

async function pendingOrganisms(files: ExtractedFile[], catalog: OrgCatalog) {
  const source = await readRealSource();
  const after = buildPlan(files, { organizationAliases: source.aliases, organizationParents: source.parents, fileJurisdictions: source.fileJurisdictions });
  const code = (id: string) => source.idToCode?.get(id) ?? id;
  const catalogByKey = new Map<string, { tipo: string; candidato: string; motivo: string }>();
  for (const r of catalog.sheets.Alias_Reparticion) {
    if (isYes(r.AUTO_MAP)) continue;
    catalogByKey.set(aliasKey(r.reparticion_original), { tipo: r.match_type ?? "REVISAR", candidato: r.canonical_key ? `${r.canonical_key}${r.nombre_oficial ? ` — ${r.nombre_oficial}` : ""}` : "", motivo: r.fundamento ?? "" });
  }
  for (const p of catalog.sheets.Pendientes) {
    const k = aliasKey(p.reparticion_original);
    const cur = catalogByKey.get(k);
    catalogByKey.set(k, { tipo: p.tipo_match ?? cur?.tipo ?? "REVISAR", candidato: p.candidato_codigo ? `${p.candidato_codigo}${p.candidato_nombre ? ` — ${p.candidato_nombre}` : ""}` : cur?.candidato ?? "", motivo: p.motivo ?? cur?.motivo ?? "" });
  }
  const contribs = new Map<string, PlannedRow[]>();
  for (const r of after.rows) if (r.personDni && r.record.kind === "person") (contribs.get(r.personDni) ?? contribs.set(r.personDni, []).get(r.personDni)!).push(r);

  const PENDING = new Set(["unmapped", "ambiguous", "context_missing", "context_conflict", "conflict"]);
  const TYPE_LABEL: Record<string, string> = { unmapped: "SIN_ALIAS", ambiguous: "ALIAS_AMBIGUO", context_missing: "CONTEXTO_INSUFICIENTE", context_conflict: "CONFLICTO_DE_CONTEXTO", conflict: "CONFLICTO_DE_ORGANISMO" };
  interface Group { texts: Set<string>; keys: string[]; personas: number; tipo: string; files: Map<string, number>; resolvedCtx: Set<string>; otherTexts: Set<string> }
  const groups = new Map<string, Group>();
  let pendingPeople = 0;
  for (const person of after.people.toCreate) {
    if (person.organizationId || !PENDING.has(person.organizationStatus)) continue;
    pendingPeople += 1;
    const rows = (contribs.get(person.dni) ?? []).filter((r) => comparableText(r.record.person.organismText));
    const keys = [...new Set(rows.map((r) => comparableText(r.record.person.organismText)))].sort();
    if (keys.length === 0) continue;
    const gk = `${person.organizationStatus}|${keys.join(" | ")}`;
    const g = groups.get(gk) ?? { texts: new Set<string>(), keys, personas: 0, tipo: TYPE_LABEL[person.organizationStatus]!, files: new Map<string, number>(), resolvedCtx: new Set<string>(), otherTexts: new Set<string>() };
    g.personas += 1;
    for (const r of rows) {
      g.texts.add(r.record.person.organismText!.trim());
      const f = `${r.record.fileCode} · ${r.record.sheet}`;
      g.files.set(f, (g.files.get(f) ?? 0) + 1);
      if (r.organization) g.resolvedCtx.add(`${code(r.organization.organizationId)} (${r.organization.kind})`);
    }
    for (const r of contribs.get(person.dni) ?? []) if (r.record.person.organismText && !keys.includes(comparableText(r.record.person.organismText))) g.otherTexts.add(r.record.person.organismText.trim());
    groups.set(gk, g);
  }
  const rows = [...groups.values()]
    .sort((a, b) => b.personas - a.personas || a.keys.join().localeCompare(b.keys.join()))
    .map((g) => {
      const single = g.keys.length === 1 ? catalogByKey.get(g.keys[0]!) : undefined;
      const isPlaceholder = single?.tipo === "INVALIDO";
      const invest = g.keys.length === 1 ? INVESTIGATION[g.keys[0]!] : undefined;
      return {
        texto_original: [...g.texts].join("  ‖  "),
        texto_normalizado: g.keys.join(" | "),
        personas_afectadas: g.personas,
        tipo_de_problema: isPlaceholder ? "PLACEHOLDER_INVALIDO" : g.tipo,
        organismo_candidato: g.keys.length === 1 ? single?.candidato ?? "" : [...g.resolvedCtx].join("; "),
        estado_en_catalogo: single ? `${single.tipo}${single.motivo ? ` — ${single.motivo}` : ""}` : g.keys.length === 1 ? "sin entrada" : "textos de distintas fuentes que resuelven a unidades distintas / no resueltas",
        contexto_disponible: [...(g.resolvedCtx.size ? [`unidades ya resueltas: ${[...g.resolvedCtx].join("; ")}`] : []), ...(g.otherTexts.size ? [`otros textos de las mismas personas: ${[...g.otherTexts].slice(0, 4).join(" / ")}`] : [])].join("\n") || "sin contexto adicional",
        archivo: [...g.files].map(([f, n]) => `${f}: ${n}`).join("\n"),
        clasificacion_investigada: invest?.clase ?? "",
        decision: "",
        organization_id_o_codigo_elegido: "",
        notas: "",
      };
    });
  // Investigación de los textos pedidos (sin fuzzy): clase, candidato y razón, con la evidencia real de las bases.
  const byKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!r.texto_normalizado.includes(" | ")) byKey.set(r.texto_normalizado, r);
  const requested = ["sastreria -cultura", "dgadb", "Dgpdynd", "inversiones", "TECBA", "alumbrado", "apra", "bienes", "dai", "dginfra", "dgovp", "efectos escenicos", "liquidacion haberes", "luminotecnia", "Ministerio de Espacio Publico", "ordenamiento", "pymes", "Seguridad", "Sindicatura General de la Ciudad", "Min. seguridad y Justicia", "0"];
  const investigation = requested.map((t) => {
    const k = comparableText(t);
    const inv = INVESTIGATION[k];
    const g = byKey.get(k);
    return {
      texto: t,
      en_tu_lista: ["Min. seguridad y Justicia", "0"].includes(t) ? "no (agregado)" : "sí",
      clasificacion: inv?.clase ?? "UNRESOLVED",
      candidato_del_catalogo_cargado: inv?.candidato ?? "—",
      por_que: inv?.razon ?? "",
      personas: g?.personas_afectadas ?? 0,
      donde_aparece: g?.archivo ?? "",
      estado_en_catalogo_v2: g?.estado_en_catalogo ?? "",
      decision: "",
      notas: "",
    };
  });
  return { rows, investigation, pendingPeople, total: after.people.toCreate.length, withoutText: after.people.toCreate.filter((p) => p.organizationStatus === "none").length };
}

// ---------------------------------------------------------------- salida
function writeWorkbook(outDir: string, name: string, spec: unknown) {
  const specDir = join(outDir, "_spec");
  mkdirSync(specDir, { recursive: true });
  const specPath = join(specDir, `${name}.json`);
  writeFileSync(specPath, JSON.stringify(spec), "utf-8");
  const target = join(outDir, `${name}.xlsx`);
  const r = spawnSync("python", [resolve("tools/review-xlsx.py"), specPath, target], { encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  if (r.status !== 0) throw new Error(`review-xlsx.py falló: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return target;
}

async function main() {
  const outDir = resolve(arg("out", "C:\\Users\\usuario\\Documents\\sutecba-fuentes\\reports"));
  mkdirSync(outDir, { recursive: true });
  const files = FILE_CODES.map((c) => JSON.parse(readFileSync(join(resolve("data/gabriel/extracted"), `${c}.json`), "utf-8")) as ExtractedFile);
  const catalog = JSON.parse(readFileSync(resolve("data/org-catalog/catalog.json"), "utf-8")) as OrgCatalog;
  const plan = buildPlan(files);

  // 1
  const blocked = blockedIdentities(plan);
  const DECISIONS = ["MERGE_SAME_PERSON", "KEEP_BLOCKED", "SOURCE_ERROR", "REVIEW_LATER"];
  const w1 = writeWorkbook(outDir, "gabriel_identidades_bloqueadas", {
    sheets: [
      {
        name: "Identidades",
        note: "Una fila por DNI con BLOCKED_IDENTITY_CONFLICT. NO se tomó ninguna decisión: completá `decision` (lista), y si corresponde `canonical_first_name`/`canonical_last_name`/`notes`. Archivo con datos personales: fuera de Git.",
        editable: ["decision", "canonical_first_name", "canonical_last_name", "notes"],
        validations: [{ key: "decision", options: DECISIONS }],
        freeze: "C3",
        columns: [
          { key: "dni", header: "DNI", width: 12 }, { key: "cuil", header: "CUIL/CUIT", width: 16 }, { key: "nombres", header: "Nombres / apellidos encontrados", width: 38 },
          { key: "fuentes", header: "Fuente / archivo", width: 32 }, { key: "hojas", header: "Hoja", width: 22 }, { key: "filas", header: "Fila", width: 14 },
          { key: "emails", header: "Email", width: 28 }, { key: "telefonos", header: "Teléfono", width: 18 }, { key: "reparticiones", header: "Repartición", width: 26 }, { key: "nacimiento", header: "Fecha de nacimiento", width: 14 },
          { key: "apariciones", header: "Apariciones", width: 11 }, { key: "motivo", header: "Motivo exacto (BLOCKED_IDENTITY_CONFLICT)", width: 70 }, { key: "propuesta", header: "Propuesta del normalizador (no es una decisión)", width: 55 },
          { key: "decision", header: "decision", width: 20 }, { key: "canonical_first_name", header: "canonical_first_name", width: 20 }, { key: "canonical_last_name", header: "canonical_last_name", width: 20 }, { key: "notes", header: "notes", width: 30 },
        ],
        rows: blocked.groups,
      },
      {
        name: "Apariciones",
        columns: ["dni", "cuil", "apellido", "nombre", "nombre_completo_sin_separar", "archivo", "codigo", "hoja", "fila", "email", "telefono", "reparticion", "nacimiento", "dni_proviene_de"].map((k) => ({ key: k, header: k, width: k === "archivo" ? 34 : 18 })),
        rows: blocked.detail,
      },
    ],
  });

  // 2
  const f03 = f03Report(plan);
  const w2 = writeWorkbook(outDir, "gabriel_f03_revision", {
    sheets: [
      {
        name: "F03_30_filas",
        note: "Evidencia para que identifiques el curso de F03 (AGC-CAPACITACION 2026). El solapamiento de personas NO prueba que F03 sea F04 o F05: es solo un dato más. No se creó ninguna reunión ni participación.",
        columns: [
          { key: "dni_canonico", header: "DNI canónico", width: 13 }, { key: "dni_procedencia", header: "Procedencia del DNI", width: 16 }, { key: "nombre", header: "Nombre", width: 30 }, { key: "cuil", header: "CUIL", width: 16 },
          { key: "reparticion", header: "Repartición", width: 26 }, { key: "area", header: "Área", width: 26 }, { key: "fecha_ingreso", header: "Fecha de ingreso", width: 14 }, { key: "marca_temporal", header: "Marca temporal del formulario", width: 22 },
          { key: "archivo", header: "Archivo", width: 34 }, { key: "hoja", header: "Hoja", width: 8 }, { key: "fila", header: "Fila", width: 7 },
          { key: "tambien_en_F04", header: "También en F04 (Primeros Auxilios Psicológicos)", width: 20 }, { key: "tambien_en_F05", header: "También en F05 (Inteligencia Emocional)", width: 20 },
          { key: "tambien_en_F01_RCP", header: "También en F01 (RCP)", width: 14 }, { key: "tambien_en_F02_RCP", header: "También en F02 (RCP 52010)", width: 14 },
        ],
        rows: f03.rows,
      },
      {
        name: "Resumen_solapamientos",
        columns: [{ key: "concepto", header: "Concepto", width: 58 }, { key: "valor", header: "Valor", width: 60 }],
        rows: [
          ...Object.entries(f03.summary).map(([concepto, valor]) => ({ concepto, valor })),
          { concepto: "—", valor: "Solo evidencia: no se concluye qué curso es F03." },
          { concepto: "Marcas temporales F03", valor: f03.timestamps.F03 },
          { concepto: "Marcas temporales F04", valor: f03.timestamps.F04 },
          { concepto: "Repartición más frecuente F03", valor: f03.repDist.F03 },
          { concepto: "Repartición más frecuente F04", valor: f03.repDist.F04 },
          { concepto: "Repartición más frecuente F05", valor: f03.repDist.F05 },
        ],
      },
    ],
  });

  // 3
  const pending = await pendingOrganisms(files, catalog);
  const w3 = writeWorkbook(outDir, "gabriel_organismos_pendientes", {
    sheets: [
      {
        name: "Pendientes_agrupados",
        note: `Solo personas con texto de organismo NO resuelto, contexto insuficiente o conflicto (excluye a las ${pending.withoutText} sin ningún texto de organismo, que se importan con organization_id = NULL). Textos iguales agrupados; orden por impacto. Nada se resolvió automáticamente.`,
        editable: ["decision", "organization_id_o_codigo_elegido", "notas"],
        validations: [{ key: "decision", options: ["APROBAR_ALIAS_GLOBAL", "APROBAR_ALIAS_CONTEXTUAL", "ASIGNAR_UNIDAD_A_ESTAS_PERSONAS", "MANTENER_SIN_ORGANIZACION", "DESCARTAR_TEXTO"] }],
        freeze: "C3",
        columns: [
          { key: "texto_original", header: "Texto original", width: 36 }, { key: "texto_normalizado", header: "Texto normalizado", width: 30 }, { key: "personas_afectadas", header: "Personas afectadas", width: 11 },
          { key: "tipo_de_problema", header: "Tipo de problema", width: 22 }, { key: "organismo_candidato", header: "Organismo candidato (catálogo)", width: 36 }, { key: "estado_en_catalogo", header: "Estado en el catálogo V2", width: 40 },
          { key: "contexto_disponible", header: "Contexto disponible", width: 40 }, { key: "archivo", header: "Archivo · hoja: filas", width: 28 }, { key: "clasificacion_investigada", header: "Clasificación (ver hoja Investigación)", width: 18 },
          { key: "decision", header: "decisión humana", width: 26 }, { key: "organization_id_o_codigo_elegido", header: "organization_id / código elegido", width: 26 }, { key: "notas", header: "notas", width: 30 },
        ],
        rows: pending.rows,
      },
      {
        name: "Investigación",
        note: "Equivalencias buscadas SIN fuzzy contra las 146 unidades ya cargadas. SAFE_CANDIDATE = una única unidad oficial es candidata inequívoca (igual necesita tu confirmación). Nada se aprobó por similitud textual.",
        editable: ["decision", "notas"],
        columns: [
          { key: "texto", header: "Texto", width: 28 }, { key: "en_tu_lista", header: "En tu lista", width: 10 }, { key: "clasificacion", header: "Clasificación", width: 16 }, { key: "candidato_del_catalogo_cargado", header: "Candidato (catálogo cargado)", width: 38 },
          { key: "por_que", header: "Por qué", width: 70 }, { key: "personas", header: "Personas", width: 9 }, { key: "donde_aparece", header: "Dónde aparece", width: 26 }, { key: "estado_en_catalogo_v2", header: "Estado en catálogo V2", width: 36 },
          { key: "decision", header: "decisión humana", width: 20 }, { key: "notas", header: "notas", width: 26 },
        ],
        rows: pending.investigation,
      },
    ],
  });

  const investCount: Record<string, number> = {};
  for (const r of pending.investigation.filter((x) => x.en_tu_lista === "sí")) investCount[r.clasificacion] = (investCount[r.clasificacion] ?? 0) + 1;
  console.log(JSON.stringify({
    identidades_bloqueadas: { dni: blocked.groups.length, apariciones: blocked.detail.length, archivo: w1 },
    f03: { ...f03.summary, archivo: w2 },
    organismos_pendientes: { personas_pendientes: pending.pendingPeople, sin_texto_excluidas: pending.withoutText, grupos: pending.rows.length, archivo: w3 },
    investigacion_de_los_19: investCount,
  }, null, 2));
}

main().catch((e) => {
  console.error(String((e as Error).message ?? e).replace(/\d{6,}/g, "[n]"));
  process.exitCode = 1;
});
