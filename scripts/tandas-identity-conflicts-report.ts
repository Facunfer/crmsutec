import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sql } from "kysely";
import { closeDb, getDb } from "../lib/db/client.js";
import { comparableText, nameTokens } from "../lib/imports/gabriel/normalize.js";
import { namesCompatible, rowTokens } from "../lib/imports/tandas/plan.js";
import { parseTandaFile, TANDA_CODES, type IncomingRow } from "../lib/imports/tandas/sources.js";
import type { ExtractedFile } from "../lib/imports/gabriel/types.js";

/**
 * REPORTE PRIVADO de conflictos de identidad de las tandas 1 y 2 (contiene DNI y nombres: NO versionar ni compartir).
 * SOLO LECTURA. No modifica ni fusiona personas. Sirve para diagnosticar si existe un corrimiento entre el DNI y el nombre
 * en la fuente con la que se cargó la persona («abogados unificado.xlsx») o en el padrón nuevo.
 *
 *   npx tsx scripts/tandas-identity-conflicts-report.ts [--report-dir <carpeta privada>]
 */
const argv = process.argv.slice(2);
const dirArg = argv.indexOf("--report-dir");
const outDir = resolve(dirArg !== -1 ? argv[dirArg + 1]! : "C:/Users/usuario/Documents/sutecba-fuentes/reports/tandas-dry-run");

const key = (t: string[]) => [...t].sort().join(" ");

async function main() {
  const parsed = TANDA_CODES.filter((c) => c !== "T03").concat("T03").map((c) => parseTandaFile(JSON.parse(readFileSync(`data/tandas/extracted/${c}.json`, "utf-8")) as ExtractedFile));
  const incoming = new Map<string, IncomingRow[]>();
  for (const p of parsed) for (const r of p.rows) if (r.rowKind === "person" && r.dni && !r.problem) (incoming.get(r.dni) ?? incoming.set(r.dni, []).get(r.dni)!).push(r);
  const t04ByName = new Map<string, IncomingRow[]>();
  for (const r of parsed.find((p) => p.code === "T04")!.rows) if (r.rowKind === "person" && r.dni && !r.problem) (t04ByName.get(key(rowTokens(r))) ?? t04ByName.set(key(rowTokens(r)), []).get(key(rowTokens(r)))!).push(r);

  const db = await getDb();
  const data = await db.transaction().execute(async (trx) => {
    await sql`set transaction read only`.execute(trx);
    const people = (await sql<any>`select id, dni, first_name, last_name, cuil_cuit, organization_id, origin, created_at from people where status <> 'merged'`.execute(trx)).rows;
    const rows = (await sql<any>`select r.normalized_dni dni, f.original_name file, r.sheet, r.row_number, r.raw_data::text raw, bf.batch_id from import_rows r join import_files f on f.id = r.file_id left join import_batch_files bf on bf.file_id = f.id where r.normalized_dni is not null`.execute(trx)).rows;
    const parts = (await sql<any>`select p.dni, coalesce(mp.campaign_key, m.source_event_key) dest, mp.participation_kind kind, mp.participation_basis basis from meeting_participations mp join people p on p.id = mp.person_id left join meetings m on m.id = mp.meeting_id`.execute(trx)).rows;
    return { people, rows, parts };
  });
  const personByDni = new Map<string, any>(data.people.map((p: any) => [p.dni, p]));
  const srcByDni = new Map<string, any[]>();
  for (const r of data.rows) (srcByDni.get(r.dni) ?? srcByDni.set(r.dni, []).get(r.dni)!).push(r);
  const partsByDni = new Map<string, any[]>();
  for (const r of data.parts) (partsByDni.get(r.dni) ?? partsByDni.set(r.dni, []).get(r.dni)!).push(r);

  const conflicts: any[] = [];
  const offsetsSource: Record<string, number> = {};
  const offsetsT04: Record<string, number> = {};
  let assignedElsewhere = 0;
  let padronNameExistsInBaseUnderOtherDni = 0;
  for (const [dni, rows] of incoming) {
    const existing = personByDni.get(dni);
    if (!existing) continue;
    const ref = nameTokens(`${existing.last_name} ${existing.first_name}`);
    const bad = rows.filter((r) => rowTokens(r).length > 0 && !namesCompatible(rowTokens(r), ref));
    if (!bad.length) continue;
    const t04 = bad.find((r) => r.file === "T04") ?? bad[0]!;
    const currentSources = (srcByDni.get(dni) ?? []).map((s) => ({ archivo: s.file, hoja: s.sheet, fila: s.row_number, lote: String(s.batch_id ?? "").slice(0, 8) }));
    // ¿a qué DNI asigna el padrón el NOMBRE ACTUAL de la persona?
    const sameName = (t04ByName.get(key(ref)) ?? []).filter((r) => r.dni !== dni);
    let shift: any = null;
    if (sameName.length === 1) {
      assignedElsewhere += 1;
      const other = sameName[0]!;
      const srcRowHere = (srcByDni.get(dni) ?? []).find((s) => s.file === "abogados unificado.xlsx");
      const srcRowThere = (srcByDni.get(other.dni!) ?? []).find((s) => s.file === "abogados unificado.xlsx");
      shift = { dni_que_el_padron_asigna_al_nombre_actual: other.dni, fila_padron: other.row, fila_padron_de_este_dni: t04.row, diferencia_filas_padron: other.row - t04.row };
      offsetsT04[String(other.row - t04.row)] = (offsetsT04[String(other.row - t04.row)] ?? 0) + 1;
      if (srcRowHere && srcRowThere) {
        const d = srcRowThere.row_number - srcRowHere.row_number;
        shift.diferencia_filas_en_abogados_unificado = d;
        offsetsSource[String(d)] = (offsetsSource[String(d)] ?? 0) + 1;
      }
    }
    // ¿existe en la base una persona con el nombre del padrón bajo otro DNI?
    const padTokens = rowTokens(t04);
    const alsoInBase = data.people.filter((p: any) => p.dni !== dni && namesCompatible(padTokens, nameTokens(`${p.last_name} ${p.first_name}`)));
    if (alsoInBase.length) padronNameExistsInBaseUnderOtherDni += 1;
    const supportsCurrent = (srcByDni.get(dni) ?? []).filter((s) => ref.filter((t) => t.length > 3).some((t) => comparableText(s.raw).includes(t))).map((s) => s.file);
    const supportsPadron = [...new Set([...(srcByDni.get(dni) ?? []).filter((s) => padTokens.filter((t) => t.length > 3).some((t) => comparableText(s.raw).includes(t))).map((s) => s.file), ...rows.filter((r) => r.file !== t04.file && namesCompatible(rowTokens(r), padTokens)).map((r) => r.file)])];
    conflicts.push({
      dni,
      identidad_actual: { apellido: existing.last_name, nombre: existing.first_name, cuil: existing.cuil_cuit, creada: existing.created_at, origen: existing.origin },
      identidad_en_las_fuentes_nuevas: rows.map((r) => ({ archivo: r.file, fila: r.row, nombre: r.full ?? `${r.last ?? ""} ${r.first ?? ""}`.trim(), colegio: r.college })),
      fuentes_con_las_que_se_creo_la_persona: currentSources,
      otras_fuentes_que_respaldan_la_identidad_actual: [...new Set(supportsCurrent)],
      otras_fuentes_que_respaldan_la_identidad_del_padron: supportsPadron,
      participaciones_actividades_relacionadas: (partsByDni.get(dni) ?? []).map((p) => `${p.dest} (${p.kind}/${p.basis})`),
      corrimiento: shift,
      persona_con_nombre_del_padron_bajo_otro_dni_en_la_base: alsoInBase.length,
    });
  }
  const sortedHist = (h: Record<string, number>) => Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const summary = {
    generado: new Date().toISOString(),
    modo: "solo lectura; no se modificó ninguna persona",
    conflictos_totales: conflicts.length,
    en_padron_de_abogados: conflicts.filter((c) => c.identidad_en_las_fuentes_nuevas.some((f: any) => f.archivo === "T04")).length,
    creadas_por_abogados_unificado: conflicts.filter((c) => c.fuentes_con_las_que_se_creo_la_persona.some((f: any) => f.archivo === "abogados unificado.xlsx")).length,
    el_padron_asigna_el_nombre_actual_a_otro_dni: assignedElsewhere,
    histograma_diferencia_de_filas_en_padron: sortedHist(offsetsT04),
    histograma_diferencia_de_filas_en_abogados_unificado: sortedHist(offsetsSource),
    nombre_del_padron_existe_en_la_base_con_otro_dni: padronNameExistsInBaseUnderOtherDni,
    lectura: "Si la mayoría de los casos muestra el nombre actual en OTRO DNI del padrón y una diferencia de filas constante en abogados unificado, hay un corrimiento de columnas en esa fuente; si no hay patrón, son homónimos/errores de tipeo.",
  };
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(outDir, `PRIVADO-conflictos-identidad-${stamp}.json`), JSON.stringify({ resumen: summary, conflictos: conflicts }, null, 2), "utf-8");
  const csv = ["dni,apellido_actual,nombre_actual,archivos_de_creacion,identidad_padron,archivo_nuevo,fila_nueva,dni_que_el_padron_asigna_al_nombre_actual,dif_filas_padron,dif_filas_unificado,participaciones"].concat(
    conflicts.map((c) => [c.dni, c.identidad_actual.apellido, c.identidad_actual.nombre, [...new Set(c.fuentes_con_las_que_se_creo_la_persona.map((f: any) => f.archivo))].join(" | "), c.identidad_en_las_fuentes_nuevas[0].nombre, c.identidad_en_las_fuentes_nuevas[0].archivo, c.identidad_en_las_fuentes_nuevas[0].fila, c.corrimiento?.dni_que_el_padron_asigna_al_nombre_actual ?? "", c.corrimiento?.diferencia_filas_padron ?? "", c.corrimiento?.diferencia_filas_en_abogados_unificado ?? "", c.participaciones_actividades_relacionadas.length].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")),
  );
  writeFileSync(join(outDir, `PRIVADO-conflictos-identidad-${stamp}.csv`), "\uFEFF" + csv.join("\n"), "utf-8");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[tandas] reporte PRIVADO (con DNI y nombres): ${join(outDir, `PRIVADO-conflictos-identidad-${stamp}.json`)}`);
  await closeDb();
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
