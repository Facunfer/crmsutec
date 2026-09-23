import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { sql } from "kysely";
import { loadOrganizationContext, runImport } from "../lib/imports/gabriel/apply.js";
import { buildPlan, type ImportPlan } from "../lib/imports/gabriel/plan.js";
import type { RawDecisionRow } from "../lib/imports/gabriel/identity-decisions.js";
import type { IdentityDecision } from "../lib/imports/gabriel/identity-decisions.js";
import { planFromSources } from "../lib/imports/gabriel/plan-hash.js";
import { assertApplyEnvironment, assertUuid, ImportAbortError, verifySourceFiles } from "../lib/imports/gabriel/preflight.js";
import { FILE_CODES, type ExtractedFile } from "../lib/imports/gabriel/types.js";

/**
 * Importación histórica de Gabriel.
 *
 *   npm run import:gabriel -- [--extracted data/gabriel/extracted] [--report-dir data/gabriel/reports] [--raw-dir <originales>]
 *       DRY-RUN (por defecto): arma el plan, calcula el plan_hash y escribe un informe SIN datos personales.
 *       No abre ninguna conexión a base de datos.
 *
 *   npm run import:gabriel -- --simulate-apply [--raw-dir <originales>]
 *       Simulación del apply SIN escribir: lee de la base, en una transacción READ ONLY, las organizaciones y los alias
 *       aprobados reales (y cuántas personas hay), arma el plan tal como lo ejecutaría el apply y resume el resultado
 *       (personas, bloqueadas, con/sin organización, reuniones, participaciones, filas omitidas, incidencias, conflictos).
 *
 *   npm run import:gabriel -- --apply --confirm-plan <PLAN_HASH> --owner-organization-id <UUID> --created-by <UUID> --raw-dir <originales> [--yes]
 *       APPLY: escribe. Antes verifica entorno, rol runtime (sutecba_app), identidad de la base, migraciones
 *       (0021 aplicada, cero pendientes), actor y unidad, SHA-256 de cada original y que el plan_hash sea el
 *       aprobado. En SUTECBA_ENV=production exige además --yes. Todo ocurre en una transacción con lock.
 *
 * Nunca se imprimen DNI, CUIL, emails, teléfonos ni nombres: solo conteos, IDs internos, códigos y hashes.
 */

function parseArgs(argv: string[]) {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  return {
    apply: argv.includes("--apply"),
    simulate: argv.includes("--simulate-apply"),
    ownerOfficialCode: value("owner-official-code"),
    yes: argv.includes("--yes"),
    extracted: resolve(value("extracted") ?? "data/gabriel/extracted"),
    reportDir: resolve(value("report-dir") ?? "data/gabriel/reports"),
    rawDir: value("raw-dir") ? resolve(value("raw-dir")!) : undefined,
    confirmPlan: value("confirm-plan"),
    ownerOrganizationId: value("owner-organization-id"),
    createdBy: value("created-by"),
    identityDecisions: value("identity-decisions"),
    identityDecisionsXlsx: value("identity-decisions-xlsx"),
  };
}

export interface LoadedDecisions {
  rows: RawDecisionRow[];
  source: { fileName: string; sha256: string };
}

/**
 * Decisiones humanas: JSON que produce tools/identity-decisions-extract.py del XLSX aprobado. Si se indica el XLSX, se
 * recalcula su SHA-256 y debe coincidir con el del extracto (que no sea otro archivo ni haya cambiado). Contiene DNI:
 * queda fuera de Git y nunca se imprime.
 */
export function loadIdentityDecisions(jsonPath: string, xlsxPath?: string): LoadedDecisions {
  if (!existsSync(jsonPath)) throw new ImportAbortError("No existe el extracto de decisiones de identidad (--identity-decisions).");
  const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as { rows?: RawDecisionRow[]; source_file?: string; source_sha256?: string };
  if (!Array.isArray(parsed.rows) || !parsed.source_file || !/^[0-9a-f]{64}$/.test(parsed.source_sha256 ?? "")) {
    throw new ImportAbortError("El extracto de decisiones no tiene rows / source_file / source_sha256: volvé a generarlo con tools/identity-decisions-extract.py.");
  }
  if (xlsxPath) {
    if (!existsSync(xlsxPath)) throw new ImportAbortError("No existe el XLSX de decisiones (--identity-decisions-xlsx).");
    const actual = createHash("sha256").update(readFileSync(xlsxPath)).digest("hex");
    if (actual !== parsed.source_sha256 || basename(xlsxPath) !== parsed.source_file) {
      throw new ImportAbortError("El XLSX de decisiones no coincide (nombre o SHA-256) con el extracto usado: se aborta.");
    }
  }
  return { rows: parsed.rows, source: { fileName: parsed.source_file, sha256: parsed.source_sha256! } };
}

export function loadExtracted(dir: string): ExtractedFile[] {
  const files: ExtractedFile[] = [];
  for (const code of FILE_CODES) {
    const path = join(dir, `${code}.json`);
    if (!existsSync(path)) throw new ImportAbortError(`Falta ${code}.json en el directorio de extractos.`);
    files.push(JSON.parse(readFileSync(path, "utf-8")) as ExtractedFile);
  }
  return files;
}

/** Quita de cualquier texto lo que parezca DNI/CUIL/teléfono/email antes de imprimirlo. */
export function redact(text: string): string {
  return text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/\d[\d .-]{5,}\d/g, "[número]");
}

/** Informe seguro: nada de DNI, CUIL, nombres, emails ni teléfonos. */
export function toSafeReport(plan: ImportPlan, planHash: string) {
  return {
    generado: new Date().toISOString(),
    modo: "dry-run (no se escribió nada)",
    plan_hash: planHash,
    archivos: plan.files,
    conteos: plan.counts,
    people_insert_reales: plan.people.toCreate.length,
    personas_a_actualizar: plan.people.toUpdate.length,
    personas_bloqueadas_por_conflicto_de_identidad: plan.people.blocked.map((b) => ({ motivo: b.reason })),
    reuniones_a_crear: plan.events.toCreate.map((e) => ({
      key: e.key,
      tipo: e.type,
      subtipo: e.subtype,
      nombre: e.name,
      precision: e.schedulePrecision,
      dia: e.eventDate,
      franja: e.startTime && e.endTime ? `${e.startTime}–${e.endTime}` : null,
      fuentes: e.sourceFiles,
    })),
    inscripciones_por_destino: Object.entries(
      plan.participations.reduce<Record<string, number>>((acc, p) => {
        const k = `${p.target.type}:${p.target.key}`;
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {})
    ).sort(([a], [b]) => a.localeCompare(b)),
    filas_de_f03_pendientes_de_clasificacion: plan.pendingClassificationRows.length,
    conflictos: plan.conflicts.map((c) => ({ campo: c.field, bloqueante: c.blocking, codigo: c.code, fuentes: c.sources, filas: c.rows })),
    filas_sin_dni: plan.rows
      .filter((r) => r.record.kind === "person" && !r.normalizedDni)
      .map((r) => ({
        archivo: r.record.fileCode,
        hoja: r.record.sheet,
        fila: r.record.rowNumber,
        codigos: r.issues.filter((i) => i.severity !== "info").map((i) => i.code),
      })),
  };
}

/** Resumen SIN datos personales de lo que haría el apply con el estado real de la base (solo lectura). */
export function expectedInserts(plan: ImportPlan, importFilesToInsert = plan.files.length) {
  const issueKeys = new Set<string>();
  for (const r of plan.rows) for (const i of r.issues) if (i.severity !== "info") issueKeys.add(`${r.record.fileCode}|${r.record.sheet}|${r.record.rowNumber}|${i.code}`);
  const personLinks = plan.rows.filter((r) => r.status === "normalized" && r.personDni).length;
  const participationLinks = plan.participations.reduce((n, p) => n + p.rows.length, 0);
  return {
    import_files: importFilesToInsert,
    import_batches: 1,
    import_batch_files: plan.files.length,
    import_rows: plan.rows.length,
    import_issues: issueKeys.size,
    people: plan.people.toCreate.length,
    meetings: plan.events.toCreate.length,
    meeting_participations: plan.participations.length,
    import_entity_links: personLinks + participationLinks,
    meeting_attendance: 0,
  };
}

/** Resultado de las decisiones humanas sin identificadores ni nombres de personas. */
export function summarizeDecisions(plan: ImportPlan, decisions: readonly IdentityDecision[], source: { fileName: string; sha256: string }) {
  const por_decision: Record<string, number> = {};
  for (const d of decisions) por_decision[d.decision] = (por_decision[d.decision] ?? 0) + 1;
  return {
    archivo: source.fileName,
    sha256_del_xlsx: source.sha256,
    decisiones: decisions.length,
    por_decision,
    personas_creadas_por_merge: plan.identityDecisionResults.filter((r) => r.outcome === "person_created").length,
    personas_que_siguen_sin_crear: plan.identityDecisionResults.filter((r) => r.outcome === "no_person_created").length,
    resultados: plan.identityDecisionResults.map((r) => ({ decision: r.decision, resultado: r.outcome, filas_fuente: r.sourceRows })),
  };
}

export function summarizeSimulation(plan: ImportPlan, planHash: string, peopleInDb: number) {
  const inc = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  const rowsByStatus: Record<string, number> = {};
  const inReviewBy: Record<string, number> = {};
  const skippedBy: Record<string, number> = {};
  const blockedDnis = new Set(plan.rows.filter((r) => r.issues.some((i) => i.code === "BLOCKED_IDENTITY_CONFLICT") && r.normalizedDni).map((r) => r.normalizedDni!));
  for (const r of plan.rows) {
    inc(rowsByStatus, r.status);
    if (r.status === "in_review") {
      const code = r.issues.find((i) => ["BLOCKED_IDENTITY_CONFLICT", "MISSING_CANONICAL_DNI", "UNRECOGNIZED_LAYOUT", "HIGH_SEVERITY_CONFLICT"].includes(i.code))?.code;
      // Las demás apariciones de un DNI bloqueado también quedan en revisión (sin incidencia propia).
      inc(inReviewBy, code ?? (r.normalizedDni && blockedDnis.has(r.normalizedDni) ? "BLOCKED_IDENTITY_CONFLICT (otras apariciones del mismo DNI)" : "OTRO"));
    }
    if (r.status === "skipped") inc(skippedBy, r.issues.find((i) => i.severity === "info")?.code ?? r.record.kind);
  }
  const f03Participations = plan.participations.filter((p) => plan.rows.some((r) => r.record.fileCode === "F03" && r.personDni === p.dni && p.rows.some((x) => x.fileCode === "F03"))).length;
  return {
    plan_hash: planHash,
    base_actual: { personas: peopleInDb },
    // Cuatro números que suman sin ambigüedad: identidades = insertables + bloqueadas.
    identidades: {
      identidades_canonicas_totales: plan.counts.identidades_canonicas_totales,
      people_insert_reales_en_este_apply: plan.people.toCreate.length,
      personas_bloqueadas_no_se_insertan: plan.people.blocked.length,
      suma_coherente: plan.counts.identidades_canonicas_totales === plan.people.toCreate.length + plan.people.blocked.length + plan.people.toUpdate.length,
      filas_sin_dni_no_son_identidades: plan.counts.filas_sin_dni,
      filas_de_las_identidades_bloqueadas: plan.counts.filas_de_identidades_bloqueadas,
      ya_existentes_en_la_base_actualizadas_o_sin_cambios: peopleInDb,
    },
    personas_con_organizacion: plan.people.toCreate.filter((p) => p.organizationId).length,
    personas_sin_organizacion_organization_id_null: plan.people.toCreate.filter((p) => !p.organizationId).length,
    de_las_sin_organizacion_sin_ningun_texto: plan.people.toCreate.filter((p) => p.organizationStatus === "none").length,
    de_las_sin_organizacion_con_texto_pendiente_o_conflicto: plan.people.toCreate.filter((p) => !p.organizationId && p.organizationStatus !== "none").length,
    organizacion_por_tipo_de_resolucion: {
      global: plan.counts.organizacion_resuelta_global,
      contexto_de_fila: plan.counts.organizacion_resuelta_por_contexto_de_fila,
      contexto_embebido: plan.counts.organizacion_resuelta_por_contexto_embebido,
      contexto_de_archivo: plan.counts.organizacion_resuelta_por_contexto_de_archivo,
      contexto_de_persona: plan.counts.organizacion_resuelta_por_contexto_de_persona,
    },
    reuniones_a_crear: plan.events.toCreate.length,
    reuniones_por_precision_de_horario: plan.counts.reuniones_por_fecha,
    participaciones_a_crear: plan.participations.length,
    participaciones_a_evento: plan.counts.inscripciones_a_evento,
    participaciones_a_campana_sin_jornada: plan.counts.inscripciones_a_campana_sin_jornada,
    asistencias_acreditadas: plan.counts.asistencias_acreditadas,
    f03: { filas: plan.pendingClassificationRows.length, reuniones_creadas: 0, participaciones_creadas: f03Participations, estado: "PENDING_CLASSIFICATION: solo aporta identidad de personas" },
    filas_fuente_total: plan.rows.length,
    filas_por_estado: rowsByStatus,
    filas_omitidas_skipped: { total: rowsByStatus.skipped ?? 0, por_motivo: skippedBy },
    filas_en_revision_no_crean_persona: { total: rowsByStatus.in_review ?? 0, por_motivo: inReviewBy },
    incidencias: plan.counts.incidencias,
    incidencias_por_codigo: plan.counts.incidencias_por_codigo,
    conflictos: { total: plan.counts.conflictos, bloqueantes: plan.counts.conflictos_bloqueantes, no_bloqueantes: plan.counts.conflictos_no_bloqueantes, por_campo: plan.counts.conflictos_por_campo },
    personas_listas_para_crear: plan.counts.personas_listas_para_crear,
    personas_con_conflictos_no_bloqueantes: plan.counts.personas_con_conflictos_no_bloqueantes,
  };
}

async function simulateApply(files: ExtractedFile[], planHash: string, reportDir: string, originalsVerified: boolean, ownerOfficialCode?: string, decisions?: { parsed: IdentityDecision[]; source: { fileName: string; sha256: string }; hashWithoutDecisions: string }) {
  const env = loadEnv();
  const db = await getDb();
  try {
    const { ctx, peopleInDb, owner } = await db.transaction().execute(async (trx) => {
      await sql`set transaction read only`.execute(trx);
      const people = await sql<{ n: number }>`select count(*)::int as n from people`.execute(trx);
      // La unidad propietaria del lote y de las reuniones: se resuelve por official_code y se verifica como lo hará el apply.
      const ownerRow = ownerOfficialCode
        ? await sql<{ id: string; official_code: string; name: string; type: string; parent_id: string | null; active: boolean; valid_to: Date | null; children: number }>`
            select o.id, o.official_code, o.name, t.key as type, o.parent_id, o.active, o.valid_to,
                   (select count(*)::int from organizations c where c.parent_id = o.id) as children
            from organizations o join organization_types t on t.id = o.type_id
            where o.official_code = ${ownerOfficialCode}`.execute(trx)
        : null;
      return { ctx: await loadOrganizationContext(trx), peopleInDb: people.rows[0]!.n, owner: ownerRow?.rows[0] ?? (ownerOfficialCode ? null : undefined) };
    });
    const plan = buildPlan(files, { ...ctx, identityDecisions: decisions?.parsed });
    const importFilesExisting = Number(
      (await sql<{ n: number }>`select count(*)::int as n from import_files where content_hash in (${sql.join(files.map((f) => f.sha256))})`.execute(db)).rows[0]!.n
    );
    const summary = {
      ...summarizeSimulation(plan, planHash, peopleInDb),
      inserts_por_tabla: expectedInserts(plan, files.length - importFilesExisting),
      ...(decisions ? { plan_hash_sin_decisiones: decisions.hashWithoutDecisions, decisiones_de_identidad: summarizeDecisions(plan, decisions.parsed, decisions.source) } : {}),
      archivos_originales: files.map((f) => ({ codigo: f.fileCode, sha256: f.sha256 })),
      ...(owner === undefined
        ? {}
        : {
            owner_organization: owner
              ? {
                  resuelta: true,
                  ownerOrganizationId: owner.id,
                  official_code: owner.official_code,
                  nombre: owner.name,
                  tipo: owner.type,
                  es_raiz_independiente: owner.parent_id === null,
                  activa_y_vigente: owner.active && (!owner.valid_to || owner.valid_to.getTime() >= Date.now()),
                  organizaciones_que_cuelgan_de_ella: owner.children,
                }
              : { resuelta: false, official_code: ownerOfficialCode },
          }),
    };
    mkdirSync(reportDir, { recursive: true });
    const target = join(reportDir, `simulate-apply-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(target, JSON.stringify({ generado: new Date().toISOString(), entorno: env.SUTECBA_ENV, modo: "simulación del apply, solo lectura (nada se escribió)", ...summary }, null, 2), "utf-8");
    console.log(JSON.stringify(summary, null, 2));
    console.log(`[import-gabriel] simulación del apply (solo lectura, entorno=${env.SUTECBA_ENV}); originales verificados: ${originalsVerified ? "sí" : "no (falta --raw-dir)"}`);
    console.log(`[import-gabriel] informe sin datos personales: ${target}`);
  } finally {
    await closeDb();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = loadExtracted(args.extracted);
  const loaded = args.identityDecisions ? loadIdentityDecisions(resolve(args.identityDecisions), args.identityDecisionsXlsx ? resolve(args.identityDecisionsXlsx) : undefined) : undefined;
  if (args.apply && loaded && !args.identityDecisionsXlsx) throw new ImportAbortError("--apply con decisiones exige también --identity-decisions-xlsx (se verifica su SHA-256).");
  const { plan, planHash, decisions: parsedDecisions } = planFromSources(files, { identityDecisionRows: loaded?.rows });
  const decisionContext = loaded && parsedDecisions ? { parsed: parsedDecisions, source: loaded.source, hashWithoutDecisions: planFromSources(files).planHash } : undefined;

  if (args.rawDir) verifySourceFiles(args.rawDir, files);

  if (args.simulate) {
    await simulateApply(files, planHash, args.reportDir, Boolean(args.rawDir), args.ownerOfficialCode, decisionContext);
    return;
  }

  if (!args.apply) {
    mkdirSync(args.reportDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(args.reportDir, `dry-run-${stamp}.json`);
    writeFileSync(target, JSON.stringify(toSafeReport(plan, planHash), null, 2), "utf-8");
    console.log(JSON.stringify(plan.counts, null, 2));
    console.log(`[import-gabriel] plan_hash: ${planHash}`);
    if (decisionContext) console.log(JSON.stringify({ plan_hash_sin_decisiones: decisionContext.hashWithoutDecisions, decisiones_de_identidad: summarizeDecisions(plan, decisionContext.parsed, decisionContext.source) }, null, 2));
    console.log(`[import-gabriel] originales verificados contra su SHA-256: ${args.rawDir ? "sí" : "no (falta --raw-dir)"}`);
    console.log(`[import-gabriel] informe sin datos personales: ${target}`);
    return;
  }

  // ---------------------------------------------------------------- APPLY
  if (!args.confirmPlan) throw new ImportAbortError("--apply requiere --confirm-plan <PLAN_HASH> (el que imprimió el dry-run).");
  if (args.confirmPlan !== planHash) throw new ImportAbortError("--confirm-plan no coincide con el plan_hash de estos archivos: no se aplica nada.");
  const ownerOrganizationId = assertUuid(args.ownerOrganizationId, "--owner-organization-id");
  const createdBy = assertUuid(args.createdBy, "--created-by");
  if (!args.rawDir) throw new ImportAbortError("--apply requiere --raw-dir con los originales para verificar sus SHA-256.");

  const env = loadEnv();
  assertApplyEnvironment({ env, yes: args.yes });
  console.log(`[import-gabriel] APPLY entorno=${env.SUTECBA_ENV} plan_hash=${planHash}`);

  // Nunca activateMigrationConnection(): el negocio escribe con SUTECBA_DATABASE_URL (rol sutecba_app).
  const db = await getDb();
  try {
    const result = await runImport(db, files, { ownerOrganizationId, createdBy, confirmedPlanHash: args.confirmPlan, identityDecisionRows: loaded?.rows, identityDecisionSource: loaded?.source });
    console.log(JSON.stringify({ resultado: result.outcome, batch_id: result.batchId, rol_de_escritura: result.runtimeRole, people_insert_reales: result.peopleCreated, resumen: result.summary }, null, 2));
    if (result.outcome === "noop_idempotent") {
      console.log("[import-gabriel] NO-OP: el plan ya estaba aplicado por completo (0 personas, 0 reuniones, 0 participaciones nuevas).");
    }
  } finally {
    await closeDb();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[import-gabriel] ${err instanceof ImportAbortError ? "ABORTADO" : "error"}: ${redact(message)}`);
    process.exitCode = 1;
  });
}
