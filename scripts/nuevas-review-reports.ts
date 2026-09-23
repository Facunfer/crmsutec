import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import { closeDb, getDb } from "../lib/db/client.js";
import { normalizeOrgName } from "../lib/organizations/display.js";
import { buildNuevasPlan, NUEVAS_CODES, padronRows, SEDES, type NuevaRow } from "../lib/imports/gabriel/nuevas.js";
import { comparableText, cuilCheckDigit, nameTokens, nameTokensCompatible } from "../lib/imports/gabriel/normalize.js";
import { parseSource } from "../lib/imports/gabriel/sources.js";
import type { ExtractedFile } from "../lib/imports/gabriel/types.js";
import { readNuevasContext } from "./import-nuevas-dry-run.js";

/**
 * Reportes de REVISIÓN HUMANA de las nuevas bases (solo lectura; nada se aplica ni se decide solo):
 *   A. nuevas_identidades_bloqueadas.xlsx   B. nuevas_organismos_pendientes.xlsx   C. nuevas_pg_cuil_revision.xlsx
 * Contienen datos personales: SOLO quedan en el .xlsx / _spec (fuera de Git). No se imprime ninguna fila.
 *
 *   npm run gabriel:nuevas-reports -- --out "C:\Users\usuario\Documents\sutecba-fuentes\reports\nuevas-2026-09-21"
 */
const FILE_LABEL: Record<string, string> = { N01: "Padrón PG (PDF)", N02: "Oftalmo Teatro Colón", N03: "Oftalmo SS. Trabajo", N04: "Oftalmo IVC", N05: "Oftalmo Cruz Malta", N06: "Oftalmo Centro Metropolitano de Diseño", N07: "Oftalmo Canale", N08: "Oftalmo ASI" };
const DECISIONS = ["MERGE_SAME_PERSON", "KEEP_BLOCKED", "SOURCE_ERROR", "REVIEW_LATER"];
const uniq = (list: Array<string | null | undefined>) => [...new Set(list.filter((x): x is string => Boolean(x && x.trim())).map((x) => x.trim()))];
const pageOf = (r: { sheet: string }) => `pág. ${r.sheet.replace(/^p(\d+).*/, "$1")}`;

// ---------------------------------------------------------------- A. identidades bloqueadas

function proposal(rows: NuevaRow[], existing: { first: string; last: string } | null): string {
  const names = uniq(rows.map((r) => `${r.last ?? ""} ${r.first ?? ""}`));
  if (existing) names.push(`${existing.last} ${existing.first}`);
  const sets = names.map((n) => nameTokens(n));
  const sortedKey = (t: string[]) => [...t].sort().join(" ");
  const distinct = [...new Set(sets.map(sortedKey))];
  if (distinct.length === 1) return "Mismo conjunto de palabras en otro orden (apellido/nombre invertidos): probable MISMA persona. Propuesta: MERGE_SAME_PERSON (a confirmar por una persona).";
  let shared = false;
  let disjoint = true;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const common = sets[i]!.filter((t) => sets[j]!.includes(t));
      if (common.length > 0) {
        shared = true;
        disjoint = false;
      }
    }
  }
  if (shared) return "Coincidencia PARCIAL de palabras (nombre/apellido compartido, el resto difiere): puede ser una persona con nombre incompleto o dos personas. Propuesta: REVIEW_LATER hasta verificar con la persona.";
  void disjoint;
  return "Nombres COMPLETAMENTE distintos para el mismo DNI: probable error de DNI en alguna de las fuentes (o dos personas). Propuesta: KEEP_BLOCKED o SOURCE_ERROR según la fuente correcta.";
}

// ---------------------------------------------------------------- B. organismos pendientes

interface OrgRow {
  id: string;
  name: string;
  official_code: string | null;
  parent_id: string | null;
  type: string;
  area: string | null;
}
const PLACEHOLDER = new Set(["no", "0", "-", ".", "?", "s/d", "sd", "n/a", "na", "ninguno", "ninguna", "x", "xx"]);
const containsPhrase = (haystack: string, needle: string) => ` ${haystack} `.includes(` ${needle} `);

function classify(text: string, orgs: OrgRow[]): { clase: string; tipo: string; candidatos: OrgRow[]; razon: string } {
  const t = normalizeOrgName(text);
  if (!t || t.length < 2 || PLACEHOLDER.has(text.trim().toLowerCase()) || PLACEHOLDER.has(t)) {
    return { clase: "INVALID", tipo: "PLACEHOLDER", candidatos: [], razon: "Valor vacío o placeholder: no debe asignar ni crear organismo." };
  }
  if (/seguridad y justicia/.test(t)) {
    return { clase: "HISTORICAL", tipo: "DENOMINACION_HISTORICA", candidatos: orgs.filter((o) => /^(MJGC|MSEGC)$/.test(o.official_code ?? "")), razon: "Denominación histórica: hoy Justicia y Seguridad son jurisdicciones separadas; no se elige una por vos." };
  }
  const compact = t.replace(/ /g, "");
  const byCode = orgs.filter((o) => (o.official_code ?? "").toLowerCase() === compact);
  const byName = orgs.filter((o) => normalizeOrgName(o.name) === t);
  if (byCode.length + byName.length > 0) {
    const exact = [...new Map([...byCode, ...byName].map((o) => [o.id, o])).values()];
    return exact.length === 1
      ? { clase: "SAFE_CANDIDATE", tipo: byCode.length ? "CODIGO_EXACTO" : "NOMBRE_EXACTO", candidatos: exact, razon: `Coincide exactamente con una única unidad del catálogo (${byCode.length ? "código" : "nombre oficial"}). Falta tu aprobación del alias.` }
      : { clase: "AMBIGUOUS", tipo: "NOMBRE_EXACTO_VARIAS_UNIDADES", candidatos: exact, razon: "El texto coincide exactamente con más de una unidad (homónimas en distintas jurisdicciones): hace falta contexto de jurisdicción." };
  }
  const contain = orgs.filter((o) => containsPhrase(normalizeOrgName(o.name), t));
  if (contain.length === 1 && t.split(" ").length >= 2) {
    return { clase: "SAFE_CANDIDATE", tipo: "CONTENIDO_UNICO", candidatos: contain, razon: "Es la única unidad cuyo nombre oficial contiene esa frase completa. NO se aprueba sola: es una coincidencia por contenido, no una equivalencia declarada." };
  }
  if (contain.length >= 1) {
    return { clase: "AMBIGUOUS", tipo: contain.length === 1 ? "CONTENIDO_UNICO_PALABRA_SUELTA" : "CONTENIDO_MULTIPLE", candidatos: contain.slice(0, 6), razon: contain.length === 1 ? "Una sola unidad contiene la palabra, pero es un término genérico sin jurisdicción: no es inequívoco." : `${contain.length} unidades contienen el texto y no trae jurisdicción: no es inequívoco.` };
  }
  return { clase: "UNRESOLVED", tipo: "SIN_COINCIDENCIA", candidatos: [], razon: "Ninguna unidad del catálogo cargado coincide (ni por código, ni por nombre, ni por contenido). Puede ser una unidad no catalogada o un área laboral." };
}

// ---------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  const outDir = resolve(value("out") ?? "");
  if (!value("out")) throw new Error("Falta --out <carpeta>.");
  const extracted = resolve(value("extracted") ?? "data/gabriel-nuevas/extracted");
  const files: ExtractedFile[] = NUEVAS_CODES.map((c) => JSON.parse(readFileSync(join(extracted, `${c}.json`), "utf-8")) as ExtractedFile);
  const f07Path = resolve("data/gabriel/extracted/F07.json");
  const f07 = existsSync(f07Path) ? (JSON.parse(readFileSync(f07Path, "utf-8")) as ExtractedFile) : null;
  mkdirSync(join(outDir, "_spec"), { recursive: true });

  const db = await getDb();
  try {
    const ctx = await readNuevasContext(db, f07);
    const plan = buildNuevasPlan(files, ctx);
    const orgRows = (
      await sql<OrgRow>`
        select o.id, o.name, o.official_code, o.parent_id, t.key as type, (select a.official_code from organizations a where a.id = public.organization_area_id(o.id)) as area
        from organizations o join organization_types t on t.id = o.type_id order by o.official_code nulls last, o.name`.execute(db)
    ).rows;
    const existingByDni = new Map(ctx.people.map((p) => [p.dni, p]));

    // ---- A
    const idRows: Record<string, unknown>[] = [];
    const occRows: Record<string, unknown>[] = [];
    for (const b of plan.blocked) {
      const rows = plan.rows.filter((r) => r.dni === b.dni);
      const ex = existingByDni.get(b.dni) ?? null;
      const names = uniq(rows.map((r) => `${r.last ?? ""} ${r.first ?? ""}`));
      idRows.push({
        dni: b.dni,
        cuil_en_base: ex?.cuil ?? "",
        persona_ya_cargada: ex ? `SÍ: ${ex.lastName} ${ex.firstName}` : "no (sería persona nueva)",
        nombres: names,
        fuentes: uniq(rows.map((r) => `${r.file} · ${FILE_LABEL[r.file]}`)),
        ubicacion: rows.map((r) => `${r.file} ${pageOf(r)} fila ${r.rowNumber}`),
        emails: uniq(rows.map((r) => r.email)),
        telefonos: uniq(rows.map((r) => r.phone)),
        nacimientos: uniq(rows.map((r) => r.birthDate)),
        organismos: uniq(rows.map((r) => r.organismText)),
        apariciones: rows.length,
        motivo: b.reason,
        propuesta_normalizador: proposal(rows, ex ? { first: ex.firstName, last: ex.lastName } : null),
        decision: "",
        canonical_first_name: "",
        canonical_last_name: "",
        notes: "",
      });
      for (const r of rows) {
        occRows.push({ dni: b.dni, archivo: `${r.file} · ${FILE_LABEL[r.file]}`, pagina: r.sheet, fila: r.rowNumber, apellido: r.last, nombre: r.first, email: r.email, telefono: r.phone, nacimiento: r.birthDate, organismo: r.organismText, marca_temporal_inscripcion: r.timestamp, texto_de_dia: r.dayText });
      }
    }
    const specA = {
      sheets: [
        {
          name: "Identidades",
          note: "12 identidades del mismo DNI con nombres incompatibles. NO se decidió nada: completá `decision` (solo MERGE_SAME_PERSON / KEEP_BLOCKED / SOURCE_ERROR / REVIEW_LATER). MERGE_SAME_PERSON exige canonical_first_name y canonical_last_name. La «propuesta del normalizador» es solo una pista.",
          editable: ["decision", "canonical_first_name", "canonical_last_name", "notes"],
          validations: [{ key: "decision", options: DECISIONS }],
          freeze: "C3",
          columns: [
            { key: "dni", header: "DNI", width: 12 },
            { key: "cuil_en_base", header: "CUIL (si existe en la base)", width: 16 },
            { key: "persona_ya_cargada", header: "¿Persona ya cargada?", width: 28 },
            { key: "nombres", header: "Nombres encontrados", width: 34 },
            { key: "fuentes", header: "Fuentes", width: 28 },
            { key: "ubicacion", header: "Archivo / página / fila", width: 24 },
            { key: "emails", header: "Email", width: 28 },
            { key: "telefonos", header: "Teléfono", width: 18 },
            { key: "nacimientos", header: "Fecha de nacimiento", width: 14 },
            { key: "organismos", header: "Organismo (texto original)", width: 26 },
            { key: "apariciones", header: "Apariciones", width: 11 },
            { key: "motivo", header: "Motivo del conflicto", width: 30 },
            { key: "propuesta_normalizador", header: "Propuesta del normalizador (solo pista)", width: 48 },
            { key: "decision", header: "decision", width: 22 },
            { key: "canonical_first_name", header: "canonical_first_name", width: 22 },
            { key: "canonical_last_name", header: "canonical_last_name", width: 22 },
            { key: "notes", header: "notes", width: 30 },
          ],
          rows: idRows,
        },
        {
          name: "Apariciones",
          columns: ["dni", "archivo", "pagina", "fila", "apellido", "nombre", "email", "telefono", "nacimiento", "organismo", "marca_temporal_inscripcion", "texto_de_dia"].map((k) => ({ key: k, header: k, width: 20 })),
          rows: occRows,
        },
      ],
    };

    // ---- B
    const pendingPeople = plan.peopleToCreate.filter((p) => !p.organizationKey && comparableText(p.organismText));
    const groups = new Map<string, { variants: Set<string>; dnis: Set<string>; files: Set<string> }>();
    for (const p of pendingPeople) {
      const key = normalizeOrgName(p.organismText!) || p.organismText!.trim().toLowerCase();
      const g = groups.get(key) ?? { variants: new Set(), dnis: new Set(), files: new Set() };
      g.variants.add(p.organismText!.trim());
      g.dnis.add(p.dni);
      for (const f of p.files) g.files.add(f);
      groups.set(key, g);
    }
    const orgReportRows = [...groups.entries()]
      .sort((a, b) => b[1].dnis.size - a[1].dnis.size || a[0].localeCompare(b[0]))
      .map(([key, g]) => {
        const cls = classify([...g.variants][0]!, orgRows);
        const sedes = [...g.files].map((f) => `${f} · ${SEDES[f as keyof typeof SEDES]?.name ?? FILE_LABEL[f]}`);
        return {
          texto_original: [...g.variants],
          normalizado: key,
          personas: g.dnis.size,
          archivo: [...g.files].sort(),
          contexto_disponible: `Operativo: ${sedes.join("; ")}. El formulario no trae jurisdicción aparte (solo este texto).`,
          candidato_oficial: cls.candidatos.length ? cls.candidatos.map((o) => `${o.official_code ?? "(sin código)"} — ${o.name}${o.area && o.area !== o.official_code ? ` [área ${o.area}]` : ""}`) : "—",
          tipo_de_resolucion: cls.tipo,
          clasificacion: cls.clase,
          por_que: cls.razon,
          decision: "",
          codigo_elegido: "",
          notas: "",
        };
      });
    const byClass: Record<string, number> = {};
    for (const r of orgReportRows) byClass[r.clasificacion] = (byClass[r.clasificacion] ?? 0) + 1;
    const specB = {
      sheets: [
        {
          name: "Organismos pendientes",
          note: "Textos de organismo SIN resolver de las personas nuevas. Comparación SIN fuzzy contra el catálogo actual de Supabase (código exacto, nombre exacto o frase contenida). SAFE_CANDIDATE también necesita tu aprobación. No se crea ninguna organización: si hace falta una nueva, se decide aparte.",
          editable: ["decision", "codigo_elegido", "notas"],
          validations: [{ key: "decision", options: ["APPROVE_ALIAS_GLOBAL", "APPROVE_ALIAS_CONTEXTUAL", "LEAVE_UNMAPPED", "NEEDS_NEW_ORGANIZATION_DECISION", "IGNORE_INVALID"] }],
          freeze: "C3",
          columns: [
            { key: "texto_original", header: "Texto original (variantes)", width: 32 },
            { key: "normalizado", header: "Normalizado", width: 26 },
            { key: "personas", header: "Personas", width: 10 },
            { key: "archivo", header: "Archivo", width: 12 },
            { key: "contexto_disponible", header: "Contexto disponible", width: 40 },
            { key: "candidato_oficial", header: "Candidato oficial (catálogo)", width: 46 },
            { key: "tipo_de_resolucion", header: "Tipo de resolución", width: 24 },
            { key: "clasificacion", header: "Clasificación", width: 16 },
            { key: "por_que", header: "Por qué", width: 50 },
            { key: "decision", header: "decision", width: 26 },
            { key: "codigo_elegido", header: "código elegido", width: 18 },
            { key: "notas", header: "notas", width: 30 },
          ],
          rows: orgReportRows,
        },
        {
          name: "Catalogo",
          note: "Catálogo organizacional actual (Supabase): usalo para elegir el «código elegido». Solo lectura.",
          columns: [
            { key: "official_code", header: "Código", width: 16 },
            { key: "name", header: "Nombre oficial", width: 60 },
            { key: "type", header: "Tipo", width: 22 },
            { key: "area", header: "Área (código)", width: 14 },
          ],
          rows: orgRows.filter((o) => o.type !== "sindicato"),
        },
      ],
    };

    // ---- C (PG: registros con CUIL de 10 dígitos). Lo que se comprobó: el PDF NO completa el CUIL, lo trae igual de incompleto.
    const n01 = files.find((f) => (f.fileCode as string) === "N01")!;
    const pdf = padronRows(n01);
    const f07Records = f07 ? parseSource(f07).records.filter((r) => r.kind === "person") : [];
    const incompleteExcel = f07Records.filter((r) => (r.person.cuilRaw ?? "").replace(/\D/g, "").length !== 11);
    const cases: Record<string, unknown>[] = [];
    for (const row of pdf.incomplete) {
      const tok = nameTokens(`${row.last} ${row.first}`);
      const match = incompleteExcel.find((r) => nameTokensCompatible(tok, nameTokens(`${r.person.lastName ?? ""} ${r.person.firstName ?? ""}`)));
      const excelDigits = (match?.person.cuilRaw ?? "").replace(/\D/g, "");
      const pdfDigits = row.cuilCell.replace(/\D/g, "");
      const first10 = pdfDigits.slice(0, 10);
      const rebuilt = first10.length === 10 ? `${first10}${cuilCheckDigit(first10)}` : "";
      const dbPerson = ctx.people.find((p) => p.dni === row.dni);
      cases.push({
        persona_excel: match ? `${match.person.lastName ?? ""}, ${match.person.firstName ?? ""}` : "(no se pudo emparejar por nombre con un registro incompleto del Excel)",
        persona_pdf: `${row.last}, ${row.first}`,
        nombres_compatibles: match ? "SÍ (mismo conjunto de palabras)" : "NO",
        cuil_anterior_excel: excelDigits || "(vacío)",
        digitos_excel: excelDigits.length,
        cuil_del_pdf: pdfDigits,
        digitos_pdf: pdfDigits.length,
        el_pdf_completa_el_cuil: excelDigits === pdfDigits ? "NO: el PDF trae EXACTAMENTE los mismos 10 dígitos que el Excel" : "revisar: difiere del Excel",
        dni_probable_ultimos_8_digitos: row.dni,
        cuil_reconstruido_calculando_el_digito_verificador: rebuilt ? `${rebuilt} (dígito verificador CALCULADO con el algoritmo oficial; no está en ninguna fuente)` : "",
        persona_con_ese_dni_en_la_base: dbPerson ? `SÍ: ${dbPerson.lastName} ${dbPerson.firstName}` : "NO (hoy no existe; el registro quedó sin DNI en el primer import: MISSING_CANONICAL_DNI)",
        email_excel: uniq((match?.person.emails ?? []).map((e) => e.value)),
        email_pdf: row.email ?? "",
        telefono_excel: uniq((match?.person.phones ?? []).map((p) => p.value)),
        telefono_pdf: row.phone ?? "",
        organizacion_texto_excel: match?.person.organismText ?? "",
        evidencia: `Excel F07 fila ${match?.rowNumber ?? "?"}: CUIL de ${excelDigits.length} dígitos (sin dígito verificador). PDF ${pageOf(row)} fila ${row.rowNumber}: mismos ${pdfDigits.length} dígitos. Las 2 fuentes coinciden en nombre.`,
        decision: "",
        notas: "",
      });
    }
    const specC = {
      sheets: [
        {
          name: "Caso CUIL PG",
          note: "IMPORTANTE: el PDF NO completa el CUIL de este registro: trae los mismos 10 dígitos que el Excel ya importado. Se incluye una reconstrucción con el dígito verificador CALCULADO solo como ayuda. NO se actualizó a la persona ni se creó nada. Decisión: COMPLETE_CUIL_AND_CREATE_PERSON (crea la persona con DNI derivado del CUIL reconstruido), KEEP_INCOMPLETE o REVIEW_LATER.",
          editable: ["decision", "notas"],
          validations: [{ key: "decision", options: ["COMPLETE_CUIL_AND_CREATE_PERSON", "KEEP_INCOMPLETE", "REVIEW_LATER"] }],
          freeze: "A3",
          columns: Object.keys(cases[0] ?? { x: 1 }).map((k) => ({ key: k, header: k.replace(/_/g, " "), width: k === "evidencia" ? 60 : 26 })),
          rows: cases,
        },
      ],
    };

    const targets: Array<[string, unknown]> = [["nuevas_identidades_bloqueadas", specA], ["nuevas_organismos_pendientes", specB], ["nuevas_pg_cuil_revision", specC]];
    for (const [name, spec] of targets) {
      const specPath = join(outDir, "_spec", `${name}.json`);
      writeFileSync(specPath, JSON.stringify(spec), "utf-8");
      const r = spawnSync("python", [resolve("tools/review-xlsx.py"), specPath, join(outDir, `${name}.xlsx`)], { encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`No se pudo generar ${name}.xlsx: ${r.stderr.slice(0, 300)}`);
    }
    console.log(
      JSON.stringify(
        {
          carpeta: outDir,
          plan_hash_de_las_nuevas: plan.planHash,
          identidades_bloqueadas: { filas: idRows.length, apariciones: occRows.length, ya_cargadas_en_la_base: idRows.filter((r) => String(r.persona_ya_cargada).startsWith("SÍ")).length },
          organismos_pendientes: { textos_distintos: orgReportRows.length, personas: pendingPeople.length, por_clasificacion: byClass, top: orgReportRows.slice(0, 12).map((r) => ({ texto: r.normalizado, personas: r.personas, clase: r.clasificacion, tipo: r.tipo_de_resolucion })) },
          caso_cuil_pg: { filas: cases.length, nombres_compatibles: cases.map((c) => c.nombres_compatibles), digitos_excel: cases.map((c) => c.digitos_excel), digitos_pdf: cases.map((c) => c.digitos_pdf), el_pdf_completa: cases.map((c) => String(c.el_pdf_completa_el_cuil).slice(0, 2)), ya_existe_en_base: cases.map((c) => String(c.persona_con_ese_dni_en_la_base).slice(0, 2)) },
        },
        null,
        2
      )
    );
  } finally {
    await closeDb();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[nuevas-reports] error: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
    process.exitCode = 1;
  });
}
