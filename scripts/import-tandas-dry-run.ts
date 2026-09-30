import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sql } from "kysely";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { readTandasSnapshot } from "../lib/imports/tandas/snapshot.js";
import type { ExtractedFile } from "../lib/imports/gabriel/types.js";
import { buildTandasPlan } from "../lib/imports/tandas/plan.js";
import { parseTandaFile, SOURCES, sourceDef, TANDA_CODES, type ParsedFile } from "../lib/imports/tandas/sources.js";

/**
 * DRY-RUN de las tandas 1 y 2 (22 fuentes, T01..T22). SOLO LECTURA: la base se lee en transacciones READ ONLY; no escribe
 * nada. No imprime DNI, nombres, emails ni teléfonos: solo cantidades, textos de organismo y hashes.
 *
 *   npx tsx scripts/import-tandas-dry-run.ts [--extracted data/tandas/extracted] [--report-dir <carpeta privada>]
 */

const argv = process.argv.slice(2);
const value = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};

async function readSnapshot(db: Awaited<ReturnType<typeof getDb>>) {
  return db.transaction().execute(async (trx) => {
    await sql`set transaction read only`.execute(trx);
    return readTandasSnapshot(trx);
  });
}

async function main() {
  const env = loadEnv();
  const dir = resolve(value("extracted") ?? "data/tandas/extracted");
  const files: ExtractedFile[] = TANDA_CODES.map((c) => {
    const p = join(dir, `${c}.json`);
    if (!existsSync(p)) throw new Error(`Falta ${c}.json (correr tools/tandas-extract.py)`);
    return JSON.parse(readFileSync(p, "utf-8")) as ExtractedFile;
  });
  const parsed: ParsedFile[] = files.map((f) => parseTandaFile(f));
  const db = await getDb();
  try {
    const { snap, extra } = await readSnapshot(db);
    const plan = buildTandasPlan(parsed, snap);
    const byCode = Object.fromEntries(parsed.map((p) => [p.code, p]));

    // ---- copias físicas
    const cellsOf = (c: string) => JSON.stringify(files.find((f) => f.fileCode === c)!.sheets.map((s) => s.rows.map((r) => r.cells)));
    const copies = SOURCES.filter((s) => s.copyOf).map((s) => ({
      copia: s.code,
      de: s.copyOf,
      mismo_sha256: byCode[s.code]!.sha256 === byCode[s.copyOf!]!.sha256,
      mismo_contenido_celda_a_celda: createHash("sha256").update(cellsOf(s.code)).digest("hex") === createHash("sha256").update(cellsOf(s.copyOf!)).digest("hex"),
      efecto: "una sola actividad y un solo hecho por persona; ambas procedencias se conservan",
    }));

    // ---- fuentes ya cargadas (hash y contenido)
    const sha = new Map(parsed.map((p) => [p.sha256, p.code]));
    const previously = [...snap.prevFileHashes.entries()].map(([name, hash]) => ({ archivo_previo: name, coincide_hash_con: sha.get(hash) ?? null }));

    // ---- oftalmología: comparación contra lo ya cargado
    const dnisOfFile = (code: string) => new Set(byCode[code]!.rows.filter((r) => r.rowKind === "person" && r.dni).map((r) => r.dni!));
    const oftalmo = SOURCES.filter((s) => s.jornadaSede).map((s) => {
      const mine = dnisOfFile(s.code);
      const sede = s.jornadaSede!;
      const jornadas = [...snap.meetings.values()].filter((m) => new RegExp(`^ophthalmology:(\\d{4}-\\d{2}-\\d{2}|sin-fecha):${sede}$`).test(m.key)).map((m) => ({ clave: m.key, fecha: m.date, participantes_actuales: m.participants }));
      const prev = (s.previouslyLoadedAs ?? []).map((name) => {
        const p = snap.prevFileDnis.get(name.normalize("NFC"));
        if (!p) return { archivo_previo: name, cargado: false };
        const both = [...mine].filter((d) => p.has(d)).length;
        return { archivo_previo: name, cargado: true, sha256_previo_igual: snap.prevFileHashes.get(name.normalize("NFC")) === byCode[s.code]!.sha256, dni_previos: p.size, dni_en_esta_fuente: mine.size, en_ambos: both, solo_en_esta_fuente: mine.size - both, solo_en_carga_previa: p.size - both };
      });
      const facts = plan.facts.filter((f) => f.files.has(s.code));
      const alreadyInCampaign = facts.filter((f) => f.existing).length;
      return {
        fuente: s.code,
        archivo: byCode[s.code]!.fileName,
        campaign_key: s.activity!.key,
        campana_existente_en_base: (snap.campaignCounts.get(s.activity!.key) ?? 0) > 0,
        participaciones_de_campana_actuales: snap.campaignCounts.get(s.activity!.key) ?? 0,
        comparacion_con_cargas_previas: prev,
        jornadas_existentes_de_la_sede: jornadas,
        dias_informados_por_la_fuente: plan.dayStats[s.code] ?? {},
        hechos_en_esta_fuente: facts.length,
        hechos_ya_existentes: alreadyInCampaign,
        hechos_faltantes_a_crear: facts.length - alreadyInCampaign,
        actividad_nueva_necesaria: (snap.campaignCounts.get(s.activity!.key) ?? 0) > 0 ? "ninguna (se reutiliza la campaña y sus jornadas)" : "campaña lógica nueva: solo la clave campaign_key (no hay tabla de campañas); se crea con la primera participación",
      };
    });
    // infraestructura escolar vs campaña 'educacion' (solo informativo)
    const educacion = new Set<string>();
    for (const k of snap.participations.keys()) if (k.startsWith("campaign|ophthalmology:educacion|")) educacion.add(k.split("|")[2]!);
    const infra = dnisOfFile("T08");

    // ---- AGC: delta real
    const agcFacts = plan.facts.filter((f) => f.files.has("T18"));
    const agc = {
      participaciones_actuales_de_la_actividad: snap.meetings.get("training:primeros-auxilios-psicologicos-agc")?.participants ?? null,
      dni_validos_en_listado: dnisOfFile("T18").size,
      ya_existentes: agcFacts.filter((f) => f.existing).length,
      delta_nuevas: agcFacts.filter((f) => !f.existing).length,
      actividad_existente_fecha: snap.meetings.get("training:primeros-auxilios-psicologicos-agc")?.precision ?? null,
    };

    // ---- padrón de abogados
    const t04 = byCode.T04!;
    const persons04 = t04.rows.filter((r) => r.rowKind === "person");
    const valid04 = persons04.filter((r) => r.dni && !r.problem);
    const docTypes: Record<string, number> = {};
    for (const r of persons04) docTypes[r.docType ?? "(sin tipo)"] = (docTypes[r.docType ?? "(sin tipo)"] ?? 0) + 1;
    const invalidBy: Record<string, number> = {};
    for (const r of persons04.filter((x) => x.problem)) invalidBy[`${r.problem}${r.docType && r.problem === "DOC_TYPE_NOT_DNI" ? `:${r.docType}` : ""}`] = (invalidBy[`${r.problem}${r.docType && r.problem === "DOC_TYPE_NOT_DNI" ? `:${r.docType}` : ""}`] ?? 0) + 1;
    const byDni04 = new Map<string, typeof valid04>();
    for (const r of valid04) (byDni04.get(r.dni!) ?? byDni04.set(r.dni!, []).get(r.dni!)!).push(r);
    let dupDni = 0, dupRows = 0, collegeConflicts = 0, emptyCollege = 0;
    for (const rows of byDni04.values()) {
      if (rows.length > 1) { dupDni += 1; dupRows += rows.length - 1; }
      const colleges = new Set(rows.map((r) => r.college).filter(Boolean));
      if (colleges.size > 1) collegeConflicts += 1;
    }
    for (const r of valid04) if (!r.college) emptyCollege += 1;
    const blocked04 = new Set(plan.blocked.filter((b) => b.file === "T04").map((b) => b.row));
    const validUnique = [...byDni04.keys()];
    const notDniButMatching = persons04.filter((r) => r.problem === "DOC_TYPE_NOT_DNI" && r.dni === null).length; // (el DNI queda sin resolver en estas filas)
    void notDniButMatching;
    // LE/LC/CI cuyo número coincidiría con una persona existente: riesgo de falso match si se los tratara como DNI
    const leLcMatches = persons04.filter((r) => r.problem === "DOC_TYPE_NOT_DNI").length;
    const abogados = {
      filas_fisicas_hoja_principal: t04.sheets.find((s) => s.name === t04.headerSheet)!.physicalRows,
      hojas: t04.sheets,
      fila_encabezado: t04.headerRow,
      filas_vacias: t04.rows.filter((r) => r.rowKind === "blank" && r.sheet === t04.headerSheet).length,
      filas_con_contenido: persons04.length,
      tipos_de_documento: docTypes,
      dni_validos_filas: valid04.length,
      filas_invalidas_o_no_dni: persons04.length - valid04.length,
      invalidas_por_motivo: invalidBy,
      dni_unicos_validos: validUnique.length,
      duplicados_internos_por_dni: { dni_repetidos: dupDni, filas_sobrantes: dupRows },
      colegios_vacios_en_filas_validas: emptyCollege,
      dni_con_colegios_contradictorios: collegeConflicts,
      dni_bloqueados_por_conflicto: plan.blockCounts,
      filas_bloqueadas_en_T04: blocked04.size,
      matches_con_personas_existentes: validUnique.filter((d) => snap.people.has(d) && !plan.byDni.get(d)?.block).length,
      altas_nuevas: validUnique.filter((d) => !snap.people.has(d) && !snap.mergedDnis.has(d) && !plan.byDni.get(d)?.block).length,
      filas_con_documento_LE_LC_CI_no_procesadas: leLcMatches,
      etiqueta_abogado_existente_o_equivalente: snap.tags.filter((t) => /abogad/.test(t.normalized)).map((t) => t.name),
      colegios_distintos: new Set(valid04.map((r) => r.college).filter(Boolean)).size,
    };

    // ---- conciliación exacta del padrón de abogados
    const cat = { matches_procesables: 0, altas_procesables: 0, bloqueados_nombre_contra_persona_existente: 0, bloqueados_nombre_entre_filas_de_distintas_fuentes: 0, bloqueados_cuil_contradictorio: 0, coincide_con_persona_fusionada: 0 };
    const t04Processable: string[] = [];
    for (const d of validUnique) {
      const agg = plan.byDni.get(d)!;
      if (agg.block === "NAME_CONFLICT_WITH_EXISTING_PERSON") cat.bloqueados_nombre_contra_persona_existente += 1;
      else if (agg.block === "NAME_CONFLICT_BETWEEN_ROWS") cat.bloqueados_nombre_entre_filas_de_distintas_fuentes += 1;
      else if (agg.block === "DNI_CUIL_CONFLICT") cat.bloqueados_cuil_contradictorio += 1;
      else if (agg.block === "MATCHES_MERGED_PERSON") cat.coincide_con_persona_fusionada += 1;
      else if (snap.people.has(d)) { cat.matches_procesables += 1; t04Processable.push(d); }
      else { cat.altas_procesables += 1; t04Processable.push(d); }
    }
    const catSum = Object.values(cat).reduce((a, b) => a + b, 0);
    const contentRows = persons04.length;
    const leLcCi: Record<string, number> = {};
    for (const r of persons04) if (r.problem === "DOC_TYPE_NOT_DNI") leLcCi[r.docType ?? "?"] = (leLcCi[r.docType ?? "?"] ?? 0) + 1;
    const leLcCiTotal = Object.values(leLcCi).reduce((a, b) => a + b, 0);
    const invalidLength = persons04.filter((r) => r.problem === "INVALID_DNI").length;
    const conciliacionAbogados = {
      filas_fisicas_hoja_principal: abogados.filas_fisicas_hoja_principal,
      "(-) encabezado": 1,
      "(-) filas vacías": abogados.filas_vacias,
      "(=) filas con contenido": contentRows,
      cierre_filas: {
        "DNI/DU con 7-8 dígitos (procesables como identidad)": valid04.length,
        "tipo documental no soportado (LE/LC/CI) — BLOQUEADAS": leLcCiTotal,
        "DNI/DU con largo inválido": invalidLength,
        suma: valid04.length + leLcCiTotal + invalidLength,
        cierra: valid04.length + leLcCiTotal + invalidLength === contentRows,
      },
      dni_validos_unicos: validUnique.length,
      duplicados_internos_descartados: valid04.length - validUnique.length,
      cierre_dni_unicos: { ...cat, suma: catSum, cierra: catSum === validUnique.length },
      explicacion_de_la_diferencia_anterior: `175.366 − (684 + 174.478) = ${validUnique.length - 684 - 174478}: son los DNI válidos que NO se procesan por conflicto de identidad (${cat.bloqueados_nombre_contra_persona_existente} contra la persona ya cargada, ${cat.bloqueados_nombre_entre_filas_de_distintas_fuentes} contra otra fuente de esta corrida, ${cat.bloqueados_cuil_contradictorio} por CUIL, ${cat.coincide_con_persona_fusionada} fusionadas). Ninguno se pierde ni se cuenta dos veces.`,
      tipo_documental_no_soportado_para_esta_carga: { ...leLcCi, total: leLcCiTotal, estado: "BLOQUEADAS (no se convierten en DNI por inferencia)" },
      a_etiquetar_abogado: t04Processable.length,
      observaciones_colegio_votacion_a_crear: t04Processable.filter((d) => byDni04.get(d)![0]!.college).length,
      observaciones_sobre_personas_existentes: t04Processable.filter((d) => snap.people.has(d)).length,
    };
    if (!conciliacionAbogados.cierre_filas.cierra || !conciliacionAbogados.cierre_dni_unicos.cierra) throw new Error("La conciliación del padrón de abogados NO cierra: el dry-run se descarta.");

    // ---- Padrón PG (T03)
    const t03 = byCode.T03!;
    const rows03 = t03.rows.filter((r) => r.rowKind === "person");
    const dnis03 = new Set(rows03.filter((r) => r.dni).map((r) => r.dni!));
    const padronPg = {
      hash_igual_a_archivo_ya_cargado: [...snap.prevFileHashes.entries()].filter(([, h]) => h === t03.sha256).map(([n]) => n),
      filas_utiles: rows03.length,
      filas_sin_dni_resoluble: rows03.filter((r) => !r.dni).length,
      sin_dni_por_motivo: rows03.filter((r) => !r.dni).reduce<Record<string, number>>((c, r) => ((c[r.problem ?? "?"] = (c[r.problem ?? "?"] ?? 0) + 1), c), {}),
      dni_unicos: dnis03.size,
      ya_existen_como_persona: [...dnis03].filter((d) => snap.people.has(d)).length,
      no_existen: [...dnis03].filter((d) => !snap.people.has(d) && !snap.mergedDnis.has(d)).length,
      genera_actividad_participacion_o_interaccion: false,
    };

    // ---- vacunas (atributos del hecho, no hechos aparte)
    const vaccineFacts = plan.facts.filter((f) => f.dest === "campaign|vaccination:2026");
    const vaccineCounts: Record<string, number> = {};
    for (const f of vaccineFacts) for (const v of f.vaccines) vaccineCounts[v] = (vaccineCounts[v] ?? 0) + 1;
    const vacunacion = {
      personas_en_la_campana: vaccineFacts.length,
      personas_en_ambas_fuentes: vaccineFacts.filter((f) => f.files.has("T01") && f.files.has("T15")).length,
      personas_con_mas_de_una_vacuna: vaccineFacts.filter((f) => f.vaccines.size > 1).length,
      personas_sin_vacuna_identificada: vaccineFacts.filter((f) => f.vaccines.size === 0).length,
      aplicaciones_por_vacuna_registradas_como_atributo: vaccineCounts,
      celdas_de_vacuna_con_valor_inesperado_ignoradas: byCode.T15!.rows.reduce((n, r) => n + r.vaccineAnomalies, 0),
      participaciones_logicas_por_persona: "1 (las vacunas son atributos del hecho; no se generan participaciones por vacuna)",
    };

    // ---- escrituras previstas (si se aprobara)
    const newMeetings = plan.activities.filter((a) => a.target === "meeting" && !a.existsInDb);
    const newFiles = parsed.filter((p) => ![...snap.prevFileHashes.values()].includes(p.sha256));
    const escrituras = {
      import_files_nuevos: newFiles.length,
      import_files_reutilizados_por_hash: parsed.length - newFiles.length,
      import_rows_a_registrar_filas_utiles: parsed.reduce((n, p) => n + p.rows.filter((r) => r.rowKind === "person").length, 0),
      personas_a_crear: plan.newPeople.length,
      personas_con_organizacion_a_completar: plan.orgToComplete.length,
      reuniones_a_crear: newMeetings.map((m) => ({ clave: m.key, nombre: m.name, precision: m.precision, fecha: m.date, horario: m.start ? `${m.start}-${m.end}` : null })),
      campanas_nuevas_claves_campaign_key: plan.activities.filter((a) => a.target === "campaign" && !a.existsInDb).map((a) => a.key),
      participaciones_nuevas: plan.totals.participaciones_nuevas,
      inscripciones_nuevas: plan.totals.inscripciones_nuevas,
      interacciones_nuevas_en_este_lote: 0,
      etiqueta_abogado: { etiqueta_a_crear: snap.tags.some((t) => /abogad/.test(t.normalized)) ? false : true, personas_a_etiquetar: conciliacionAbogados.a_etiquetar_abogado },
      person_observations_colegio_votacion: conciliacionAbogados.observaciones_colegio_votacion_a_crear,
      personas_con_nombre_sin_separar_a_crear: plan.persons.altas_con_nombre_sin_separar,
      tocado_de_personas_existentes: "solo organización faltante (si se resuelve inequívoca) y la etiqueta/observación de abogados; ningún otro campo",
    };

    // ---- totales globales
    const usefulRows = parsed.reduce((n, p) => n + p.rows.filter((r) => r.rowKind === "person").length, 0);
    const out = {
      generado: new Date().toISOString(),
      modo: "dry-run (solo lectura; no se escribió nada)",
      entorno: env.SUTECBA_ENV,
      base: extra,
      plan_hash: plan.planHash,
      fuentes_ya_cargadas_por_hash: previously.filter((p) => p.coincide_hash_con),
      copias_fisicas: copies,
      por_archivo: plan.perFile,
      hechos_por_fuente: plan.factReport,
      interacciones_por_fuente: plan.interactions,
      oftalmologia: oftalmo,
      infraestructura_escolar_vs_campana_educacion: { dni_infraestructura: infra.size, tambien_en_campana_educacion: [...infra].filter((d) => educacion.has(d)).length },
      agc,
      padron_pg: padronPg,
      padron_abogados: abogados,
      conciliacion_padron_abogados: conciliacionAbogados,
      vacunacion,
      escrituras_previstas: escrituras,
      actividades: plan.activities,
      organizaciones: { ...plan.org, textos_sin_resolver: Object.fromEntries(Object.entries(plan.orgUnresolvedTexts).map(([k, v]) => [k, Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, 12)])), conflictos_ejemplos: plan.orgConflictExamples },
      totales_globales: {
        filas_fuente_utiles: usefulRows,
        filas_bloqueadas_o_invalidas: plan.blocked.length,
        bloqueos_por_conflicto_de_identidad_dni: plan.blockCounts,
        personas: plan.persons,
        ...plan.totals,
      },
    };
    const dirOut = resolve(value("report-dir") ?? "C:/Users/usuario/Documents/sutecba-fuentes/reports/tandas-dry-run");
    mkdirSync(dirOut, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(dirOut, `dry-run-tandas-${stamp}.json`), JSON.stringify(out, null, 2), "utf-8");
    writeFileSync(join(dirOut, `filas-bloqueadas-${stamp}.csv`), ["archivo,fila,motivo", ...plan.blocked.map((b) => `${b.file},${b.row},${b.reason}`)].join("\n"), "utf-8");
    console.log(JSON.stringify(out, null, 2));
    console.log(`[tandas] informe sin datos personales: ${join(dirOut, `dry-run-tandas-${stamp}.json`)}`);
  } finally {
    await closeDb();
  }
}

main().catch((err: unknown) => {
  console.error(`[tandas] error: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
  process.exitCode = 1;
});
void sourceDef;
