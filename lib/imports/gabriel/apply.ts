import { sql, type Kysely, type Transaction } from "kysely";
import { loadEnv, type SutecbaEnv } from "../../db/env.js";
import type { Database, ImportRowStatus } from "../../db/schema.js";
import { toJsonb } from "../../db/json.js";
import { FILE_JURISDICTION_KEYS } from "./file-context.js";
import { fingerprintRow } from "./normalize.js";
import { buildPlan, type ExistingPerson, type ImportPlan, type PlannedRow } from "./plan.js";
import type { AliasEntry } from "./organization-resolver.js";
import type { RawDecisionRow } from "./identity-decisions.js";
import { dateOnly } from "../../db/date-only.js";
import { validateBirthDate } from "../../people/birth-date.js";
import { syncParticipationInteractions } from "../../interactions/participation-sync.js";
import { planFromSources } from "./plan-hash.js";
import {
  acquireImportLock,
  assertActorAndOwner,
  assertDatabasePreconditions,
  assertRuntimeRole,
  ImportAbortError,
  SOURCE_SYSTEM,
  type LedgerReader,
} from "./preflight.js";
import type { ExtractedFile, FileCode, PlannedEvent } from "./types.js";

/**
 * Aplicación del plan de importación sobre la base (apply real). El CLI la bloquea sin --apply y, además,
 * exige el hash del plan aprobado; en production, --yes y el rol runtime `sutecba_app`.
 *
 * Todo ocurre en UNA transacción (rollback completo ante cualquier falla), con un lock transaccional que
 * impide dos applies simultáneos, y es idempotente:
 *  - archivos: por SHA-256 (una sola fila por contenido);
 *  - filas: única por (archivo, hoja, número de fila); reimportar no duplica ni pisa;
 *  - personas: una por DNI (activa/no fusionada); a las existentes solo se les completan campos vacíos
 *    con valores inequívocos y NUNCA se transfieren de unidad;
 *  - reuniones: por `source_event_key`;
 *  - participaciones: únicas por (reunión|campaña, persona, tipo); las demás filas fuente se vinculan.
 * Las personas nacen SIN unidad organizativa salvo correspondencia inequívoca con `organizations`
 * (nunca se crean organismos desde texto libre). Ninguna fila se convierte en asistencia.
 */

export interface ApplyOptions {
  /** Unidad propietaria de las reuniones importadas y del lote. Debe existir. */
  ownerOrganizationId: string;
  /** Usuario que ejecuta la importación (queda en import_files / import_batches). */
  createdBy: string;
  /** Hash del plan aprobado en el dry-run. Si no coincide con el de estos archivos, se aborta. */
  confirmedPlanHash: string;
  notes?: string;
  /** Decisiones humanas crudas (extracto del XLSX aprobado). Forman parte del plan y de su hash: sin ellas el hash es otro. */
  identityDecisionRows?: readonly RawDecisionRow[];
  /** Procedencia de las decisiones (solo se registra en el resumen y la auditoría; no cambia el plan). */
  identityDecisionSource?: { fileName: string; sha256: string };
  /** Solo tests: entorno y lector del ledger de migraciones. Por defecto, el real. */
  env?: SutecbaEnv;
  ledger?: LedgerReader;
}

export interface ApplyResult {
  /** 'noop_idempotent': el plan ya estaba aplicado por completo; no se creó nada nuevo. */
  outcome: "applied" | "noop_idempotent";
  planHash: string;
  runtimeRole: string;
  batchId: string;
  files: number;
  rowsInserted: number;
  rowsAlreadyImported: number;
  rowsChangedSinceLastImport: number;
  issuesInserted: number;
  peopleCreated: number;
  peopleFilled: number;
  meetingsCreated: number;
  meetingsExisting: number;
  participationsCreated: number;
  participationsAlreadyExisting: number;
  summary: Record<string, unknown>;
  plan: ImportPlan;
}

type Trx = Transaction<Database> | Kysely<Database>;

const BA_OFFSET = "-03:00";

function toTimestamp(date: string, time: string): Date {
  return new Date(`${date}T${time}:00${BA_OFFSET}`);
}

function meetingStatusFor(event: PlannedEvent, today: string): "finished" | "draft" {
  // Un evento histórico con día conocido y pasado figura como finalizado; sin fecha, queda como borrador.
  return event.eventDate && event.eventDate < today ? "finished" : "draft";
}

async function loadExistingPeople(db: Trx, dnis: string[]): Promise<Map<string, ExistingPerson & { id: string }>> {
  const map = new Map<string, ExistingPerson & { id: string }>();
  for (let i = 0; i < dnis.length; i += 500) {
    const chunk = dnis.slice(i, i + 500);
    if (chunk.length === 0) continue;
    const rows = await db
      .selectFrom("people")
      .select(["id", "dni", "first_name", "last_name", "email", "phone", "cuil_cuit"])
      .where("dni", "in", chunk)
      .where("status", "!=", "merged")
      .execute();
    for (const r of rows) {
      map.set(r.dni!, { id: r.id, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone, cuilCuit: r.cuil_cuit });
    }
  }
  return map;
}

export async function runImport(db: Kysely<Database>, files: ExtractedFile[], options: ApplyOptions): Promise<ApplyResult> {
  // -1. El plan que se va a aplicar es EXACTAMENTE el aprobado (mismos archivos, mismas reglas).
  const source = planFromSources(files, { identityDecisionRows: options.identityDecisionRows });
  if (source.planHash !== options.confirmedPlanHash) {
    throw new ImportAbortError("El hash del plan no coincide con el aprobado en el dry-run. Repetí el dry-run y confirmá el nuevo hash.");
  }

  // 0. Entorno, rol runtime, identidad de la base, migraciones y 0021 (antes de abrir la transacción de escritura).
  const env = options.env ?? loadEnv();
  const runtime = await assertRuntimeRole(db, env);
  await assertDatabasePreconditions(db, env, { ledger: options.ledger });

  return db.transaction().execute(async (trx) => {
    const today = new Date().toISOString().slice(0, 10);

    // Un solo apply a la vez; actor y unidad se validan dentro de la misma transacción que escribe.
    await acquireImportLock(trx);
    await assertActorAndOwner(trx, options.createdBy, options.ownerOrganizationId);

    // 1. Plan contra el estado real de la base (así lo ya importado se detecta como existente).
    const organizationContext = await loadOrganizationContext(trx);
    const firstPass = buildPlan(files, { identityDecisions: source.decisions });
    const candidateDnis = [...new Set(firstPass.rows.map((r) => r.normalizedDni).filter((d): d is string => Boolean(d)))];
    const existingPeople = await loadExistingPeople(trx, candidateDnis);
    const eventKeys = firstPass.events.toCreate.map((e) => e.key);
    const existingMeetingRows = eventKeys.length
      ? await trx.selectFrom("meetings").select(["id", "source_event_key"]).where("source_event_key", "in", eventKeys).execute()
      : [];
    const meetingIdByKey = new Map(existingMeetingRows.map((m) => [m.source_event_key!, m.id]));
    const plan = buildPlan(files, { identityDecisions: source.decisions, existingPeople, existingEventKeys: new Set(meetingIdByKey.keys()), ...organizationContext });

    // 2. Archivos y lote
    const fileIdByCode = new Map<FileCode, string>();
    for (const file of files) {
      const existing = await trx.selectFrom("import_files").select("id").where("content_hash", "=", file.sha256).executeTakeFirst();
      if (existing) {
        fileIdByCode.set(file.fileCode, existing.id);
      } else {
        const created = await trx
          .insertInto("import_files")
          .values({
            original_name: file.fileName,
            content_hash: file.sha256,
            external_reference: file.fileCode,
            created_by: options.createdBy,
            size_bytes: file.sizeBytes,
            source_metadata: toJsonb({ file_code: file.fileCode, tables: file.sheets.length } as never),
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        fileIdByCode.set(file.fileCode, created.id);
      }
    }

    const batch = await trx
      .insertInto("import_batches")
      .values({
        owner_organization_id: options.ownerOrganizationId,
        responsible_user_id: options.createdBy,
        created_by: options.createdBy,
        status: "processing",
        started_at: new Date(),
        notes: options.notes ?? "Importación histórica (fuentes de Gabriel)",
        execution_mode: "apply",
        plan_hash: source.planHash,
        source_system: SOURCE_SYSTEM,
        sutecba_env: env.SUTECBA_ENV,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const fileId of fileIdByCode.values()) {
      await trx.insertInto("import_batch_files").values({ batch_id: batch.id, file_id: fileId, linked_by: options.createdBy }).onConflict((oc) => oc.doNothing()).execute();
    }

    // 3. Filas de staging (idempotentes por archivo/hoja/fila)
    const sha256ByCode = new Map(files.map((f) => [f.fileCode, f.sha256]));
    const rowIdByKey = new Map<string, string>();
    let rowsInserted = 0;
    let rowsAlreadyImported = 0;
    let rowsChanged = 0;
    const rowKey = (code: FileCode, sheet: string, n: number) => `${code}|${sheet}|${n}`;

    for (const row of plan.rows) {
      const rec = row.record;
      const fileId = fileIdByCode.get(rec.fileCode)!;
      const hash = fingerprintRow(sha256ByCode.get(rec.fileCode)!, rec.sheet, rec.rowNumber, rec.rawData);
      const initialStatus: ImportRowStatus = "staged";
      const inserted = await trx
        .insertInto("import_rows")
        .values({
          file_id: fileId,
          sheet: rec.sheet,
          row_number: rec.rowNumber,
          raw_data: toJsonb(rec.rawData as never),
          normalized_data: toJsonb({ layout: rec.layout, kind: rec.kind, ...(row.identityDecision ? { identity_decision: row.identityDecision } : {}), ...(row.organization ? { organization: { id: row.organization.organizationId, resolution: row.organization.kind, context_id: row.organization.contextOrganizationId } } : {}) } as never),
          row_hash: hash,
          status: initialStatus,
          source_file_code: rec.fileCode,
          normalized_dni: row.normalizedDni,
          dni_source: row.dniSource,
          normalized_cuil_cuit: row.normalizedCuil,
          campaign_key: rec.target.type === "campaign" ? rec.target.key : null,
          participation_kind: rec.participationKind,
        })
        .onConflict((oc) => oc.columns(["file_id", "sheet", "row_number"]).doNothing())
        .returning("id")
        .executeTakeFirst();

      if (inserted) {
        rowIdByKey.set(rowKey(rec.fileCode, rec.sheet, rec.rowNumber), inserted.id);
        rowsInserted += 1;
      } else {
        const existing = await trx
          .selectFrom("import_rows")
          .select(["id", "row_hash"])
          .where("file_id", "=", fileId)
          .where("sheet", "=", rec.sheet)
          .where("row_number", "=", rec.rowNumber)
          .executeTakeFirstOrThrow();
        rowIdByKey.set(rowKey(rec.fileCode, rec.sheet, rec.rowNumber), existing.id);
        rowsAlreadyImported += 1;
        if (existing.row_hash !== hash) rowsChanged += 1;
      }
    }

    // 4. Incidencias (una por fila y código)
    let issuesInserted = 0;
    const rowIds = [...rowIdByKey.values()];
    const existingIssueKeys = new Set<string>();
    for (let i = 0; i < rowIds.length; i += 500) {
      const chunk = rowIds.slice(i, i + 500);
      const found = await trx.selectFrom("import_issues").select(["import_row_id", "code"]).where("import_row_id", "in", chunk).execute();
      for (const f of found) existingIssueKeys.add(`${f.import_row_id}|${f.code}`);
    }
    for (const row of plan.rows) {
      const rowId = rowIdByKey.get(rowKey(row.record.fileCode, row.record.sheet, row.record.rowNumber))!;
      const seen = new Set<string>();
      for (const issue of row.issues) {
        if (issue.severity === "info") continue;
        const key = `${rowId}|${issue.code}`;
        if (existingIssueKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        await trx
          .insertInto("import_issues")
          .values({ batch_id: batch.id, import_row_id: rowId, severity: issue.severity === "error" ? "error" : "warning", code: issue.code, message: issue.message })
          .execute();
        issuesInserted += 1;
      }
    }

    // 5. Personas: crear las nuevas (una por DNI) y completar vacíos en las existentes
    const personIdByDni = new Map<string, string>();
    for (const [dni, p] of existingPeople) personIdByDni.set(dni, p.id);
    let peopleCreated = 0;
    let peopleWithRejectedBirthDate = 0;
    for (const person of plan.people.toCreate) {
      // Defensa en profundidad: sin DNI canónico (7 u 8 dígitos) no se crea ninguna persona, pase lo que pase con el plan.
      if (!/^[0-9]{7,8}$/.test(person.dni)) throw new ImportAbortError("Se intentó crear una persona sin DNI canónico: se revierte todo.");
      // Defensa en profundidad: un año de nacimiento implausible (p. ej. "0064" por un artefacto de la fuente) nunca
      // se escribe en birth_date, aunque como fecha de calendario sea válida (dateOnly la acepta; validateBirthDate no).
      const birthDateOk = person.birthDate ? validateBirthDate(person.birthDate).ok : true;
      if (!birthDateOk) peopleWithRejectedBirthDate += 1;
      const created = await trx
        .insertInto("people")
        .values({
          first_name: person.firstName,
          last_name: person.lastName,
          dni: person.dni,
          dni_source: person.dniSource,
          cuil_cuit: person.cuilCuit,
          email: person.email,
          phone: person.phone,
          birth_date: birthDateOk ? dateOnly(person.birthDate) : null,
          origin: "import",
          // Solo con correspondencia inequívoca; si no, NULL (pendiente de clasificación).
          organization_id: person.organizationId,
          created_by: options.createdBy,
          updated_by: options.createdBy,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      personIdByDni.set(person.dni, created.id);
      peopleCreated += 1;
    }

    let peopleFilled = 0;
    for (const update of plan.people.toUpdate) {
      const id = personIdByDni.get(update.dni)!;
      // Solo valores inequívocos calculados por el plan; el WHERE ... IS NULL garantiza que nunca se pise un dato del CRM.
      let touched = false;
      if (update.values.email) touched = Boolean(await trx.updateTable("people").set({ email: update.values.email }).where("id", "=", id).where("email", "is", null).returning("id").executeTakeFirst()) || touched;
      if (update.values.phone) touched = Boolean(await trx.updateTable("people").set({ phone: update.values.phone }).where("id", "=", id).where("phone", "is", null).returning("id").executeTakeFirst()) || touched;
      if (update.values.cuil_cuit) touched = Boolean(await trx.updateTable("people").set({ cuil_cuit: update.values.cuil_cuit }).where("id", "=", id).where("cuil_cuit", "is", null).returning("id").executeTakeFirst()) || touched;
      if (touched) peopleFilled += 1;
    }

    // 6. Reuniones/eventos históricos
    let meetingsCreated = 0;
    for (const event of plan.events.toCreate) {
      const known = event.schedulePrecision === "exact_datetime" && event.eventDate && event.startTime && event.endTime;
      const created = await trx
        .insertInto("meetings")
        .values({
          name: event.name,
          description: event.description,
          owner_organization_id: options.ownerOrganizationId,
          meeting_type: event.type,
          meeting_subtype: event.subtype,
          origin: "import",
          source_event_key: event.key,
          import_batch_id: batch.id,
          schedule_precision: event.schedulePrecision,
          event_date: event.schedulePrecision === "exact_datetime" ? null : dateOnly(event.eventDate),
          starts_at: known ? toTimestamp(event.eventDate!, event.startTime!) : null,
          ends_at: known ? toTimestamp(event.eventDate!, event.endTime!) : null,
          source_time_note: event.sourceTimeNote,
          status: meetingStatusFor(event, today),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      meetingIdByKey.set(event.key, created.id);
      meetingsCreated += 1;
    }

    // 7. Participaciones (sin asistencia inferida) y vínculos fila → entidad
    let participationsCreated = 0;
    let participationsExisting = 0;
    const participationIds: string[] = [];
    for (const participation of plan.participations) {
      const personId = personIdByDni.get(participation.dni);
      if (!personId) continue;
      const originRef = participation.rows[0]!;
      const originRowId = rowIdByKey.get(rowKey(originRef.fileCode, originRef.sheet, originRef.rowNumber));
      const meetingId = participation.target.type === "event" ? meetingIdByKey.get(participation.target.key) ?? null : null;
      if (participation.target.type === "event" && !meetingId) continue;

      const inserted = await trx
        .insertInto("meeting_participations")
        .values({
          meeting_id: meetingId,
          campaign_key: participation.target.type === "campaign" ? participation.target.key : null,
          person_id: personId,
          participation_kind: participation.kind,
          evidence: null,
          import_row_id: originRowId ?? null,
        })
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst();
      if (inserted) participationsCreated += 1;
      else participationsExisting += 1;

      const participationId =
        inserted?.id ??
        (
          await trx
            .selectFrom("meeting_participations")
            .select("id")
            .where("person_id", "=", personId)
            .where("participation_kind", "=", participation.kind)
            .$if(meetingId !== null, (qb) => qb.where("meeting_id", "=", meetingId!))
            .$if(meetingId === null, (qb) => qb.where("meeting_id", "is", null).where("campaign_key", "=", (participation.target as { key: string }).key))
            .executeTakeFirst()
        )?.id;
      if (participationId) {
        participationIds.push(participationId);
        for (const r of participation.rows) {
          const id = rowIdByKey.get(rowKey(r.fileCode, r.sheet, r.rowNumber));
          if (!id) continue;
          await trx
            .insertInto("import_entity_links")
            .values({ import_row_id: id, entity_type: "meeting_participation", entity_id: participationId, linked_by: options.createdBy })
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
      }
    }

    // 8. Vínculos de las filas con persona/reunión y estado final
    const setRow = async (row: PlannedRow, patch: { person_id?: string | null; meeting_id?: string | null; status: ImportRowStatus }) => {
      const id = rowIdByKey.get(rowKey(row.record.fileCode, row.record.sheet, row.record.rowNumber))!;
      await trx.updateTable("import_rows").set(patch).where("id", "=", id).where("status", "in", ["staged", "normalized", "in_review", "skipped"]).execute();
    };
    for (const row of plan.rows) {
      const rec = row.record;
      const meetingId = rec.target.type === "event" ? meetingIdByKey.get(rec.target.key) ?? null : null;
      if (row.status === "normalized" && row.personDni) {
        const personId = personIdByDni.get(row.personDni) ?? null;
        await setRow(row, { person_id: personId, meeting_id: meetingId, status: "applied" });
        if (personId) {
          await trx
            .insertInto("import_entity_links")
            .values({ import_row_id: rowIdByKey.get(rowKey(rec.fileCode, rec.sheet, rec.rowNumber))!, entity_type: "person", entity_id: personId, linked_by: options.createdBy })
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
      } else if (row.status === "in_review") {
        await setRow(row, { meeting_id: meetingId, status: "in_review" });
      } else if (rec.kind === "residual" && meetingId) {
        // Filas de la agenda (F08): quedan vinculadas a su jornada.
        await setRow(row, { meeting_id: meetingId, status: "applied" });
      } else {
        await setRow(row, { status: "skipped" });
      }
    }

    // 8b. Interacciones automáticas: solo por participaciones CONFIRMADAS con fecha (una inscripción no genera ninguna).
    const interactionSync = await syncParticipationInteractions(trx, { actorUserId: options.createdBy, participationIds });

    // 9. Cierre del lote: estado final, auditoría y resumen (solo conteos y códigos, sin datos personales)
    const rowsInReview = plan.rows.filter((r) => r.status === "in_review").length;
    const noop =
      rowsInserted === 0 && issuesInserted === 0 && peopleCreated === 0 && peopleFilled === 0 && meetingsCreated === 0 && participationsCreated === 0 && interactionSync.created === 0;
    const outcome: ApplyResult["outcome"] = noop ? "noop_idempotent" : "applied";
    const summary: Record<string, unknown> = {
      outcome,
      plan_hash: source.planHash,
      runtime_role: runtime.role,
      files: files.map((f) => ({ code: f.fileCode, sha256: f.sha256 })),
      rows: { processed: plan.rows.length, inserted: rowsInserted, already_imported: rowsAlreadyImported, changed_since_last_import: rowsChanged, in_review: rowsInReview },
      issues_inserted: issuesInserted,
      people: {
        created: peopleCreated,
        filled: peopleFilled,
        blocked_identity: plan.people.blocked.length,
        with_non_blocking_conflicts: plan.people.toCreate.filter((p) => p.hasNonBlockingConflicts).length,
        without_organization: plan.people.toCreate.filter((p) => !p.organizationId).length,
        with_rejected_birth_date: peopleWithRejectedBirthDate,
      },
      meetings: { created: meetingsCreated, existing: plan.events.existing.length },
      participations: { created: participationsCreated, already_existing: participationsExisting },
      attendance_created: 0,
      interactions: { created: interactionSync.created, skipped_without_date: interactionSync.skippedWithoutDate },
      ...(source.decisions
        ? {
            identity_decisions: {
              source_file: options.identityDecisionSource ?? null,
              total: source.decisions.length,
              by_decision: source.decisions.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.decision]: (acc[d.decision] ?? 0) + 1 }), {}),
              // Sin DNI ni nombres: solo la clave interna de la persona.
              results: plan.identityDecisionResults.map((r) => ({ decision: r.decision, outcome: r.outcome, source_rows: r.sourceRows })),
            },
          }
        : {}),
    };
    const completedAt = new Date();
    await trx
      .updateTable("import_batches")
      .set({ status: "applied", completed_at: completedAt, applied_at: completedAt, summary: toJsonb(summary as never) })
      .where("id", "=", batch.id)
      .execute();

    return {
      outcome,
      planHash: source.planHash,
      runtimeRole: runtime.role,
      batchId: batch.id,
      files: files.length,
      rowsInserted,
      rowsAlreadyImported,
      rowsChangedSinceLastImport: rowsChanged,
      issuesInserted,
      peopleCreated,
      peopleFilled,
      meetingsCreated,
      meetingsExisting: plan.events.existing.length,
      participationsCreated,
      participationsAlreadyExisting: participationsExisting,
      summary,
      plan,
    };
  });
}

/**
 * Lo que necesita la resolución de organización: alias aprobados (globales y contextuales) que apuntan a unidades
 * activas y vigentes, la jerarquía de las unidades activas y las jurisdicciones de los archivos de una sola jurisdicción.
 */
export async function loadOrganizationContext(db: Trx): Promise<{ organizationAliases: AliasEntry[]; organizationParents: Map<string, string | null>; fileJurisdictions: Partial<Record<FileCode, string>> }> {
  const orgs = await db.selectFrom("organizations").select(["id", "parent_id", "official_code", "valid_to"]).where("active", "=", true).execute();
  const now = Date.now();
  const live = orgs.filter((o) => !o.valid_to || o.valid_to.getTime() >= now);
  const liveIds = new Set(live.map((o) => o.id));
  // context_organization_id existe desde 0022; antes, todos los alias son globales.
  const hasContext = ((await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'organization_aliases' and column_name = 'context_organization_id'`.execute(db)).rows[0]?.n ?? 0) > 0;
  const aliasRows = hasContext
    ? (await sql<{ alias: string; organization_id: string; context_organization_id: string | null }>`select alias, organization_id, context_organization_id from organization_aliases where status = 'approved'`.execute(db)).rows
    : (await sql<{ alias: string; organization_id: string; context_organization_id: string | null }>`select alias, organization_id, null::uuid as context_organization_id from organization_aliases where status = 'approved'`.execute(db)).rows;
  const idByCode = new Map(live.filter((o) => o.official_code).map((o) => [o.official_code!, o.id]));
  const fileJurisdictions: Partial<Record<FileCode, string>> = {};
  for (const [file, code] of Object.entries(FILE_JURISDICTION_KEYS)) {
    const id = idByCode.get(code as string);
    if (id) fileJurisdictions[file as FileCode] = id;
  }
  return {
    organizationAliases: aliasRows
      .filter((r) => liveIds.has(r.organization_id) && (!r.context_organization_id || liveIds.has(r.context_organization_id)))
      .map((r) => ({ alias: r.alias, organizationId: r.organization_id, contextOrganizationId: r.context_organization_id })),
    organizationParents: new Map(live.map((o) => [o.id, o.parent_id && liveIds.has(o.parent_id) ? o.parent_id : null])),
    fileJurisdictions,
  };
}
