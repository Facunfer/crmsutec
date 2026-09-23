import { sql, type Kysely, type Transaction } from "kysely";
import type { Database, ImportRowStatus } from "../../db/schema.js";
import { dateOnly } from "../../db/date-only.js";
import { validateBirthDate } from "../../people/birth-date.js";
import { loadEnv, type SutecbaEnv } from "../../db/env.js";
import { toJsonb } from "../../db/json.js";
import { comparableText, fingerprintRow } from "./normalize.js";
import { assertActorAndOwner, assertDatabasePreconditions, assertRuntimeRole, ImportAbortError, type LedgerReader } from "./preflight.js";
import type { RawDecisionRow } from "./identity-decisions.js";
import { loadOrganizationContext } from "./apply.js";
import { syncParticipationInteractions } from "../../interactions/participation-sync.js";
import { buildNuevasPlanWithDecisions, nuevaRowKey, padronRows, type NuevaCode, type NuevaRow, type NuevasContext, type NuevasPlan, type PadronRow } from "./nuevas.js";
import type { ExtractedFile } from "./types.js";

/**
 * APPLY de las nuevas bases de Gabriel (2026-09-22): lote INDEPENDIENTE del importador histórico (otro
 * `import_batches`, otro `plan_hash`, otro lock). Reutiliza staging (`import_files`/`import_batches`/`import_rows`/
 * `import_issues`/`import_entity_links`), DNI canónico, alias de organización YA cargados en la base y las mismas
 * garantías (hash aprobado, rol runtime, actor MASTER_GLOBAL, una sola transacción con lock, idempotencia).
 *
 * El catálogo organizacional (unidades y alias nuevos) debe estar YA aplicado antes de correr esto: la resolución de
 * organización se lee de la base real (igual que el importador histórico), nunca simulada. Requiere la migración
 * 0028 (participation_basis) aplicada, además de 0027 (metadatos de archivos).
 *
 * Trazabilidad (paridad con el importador histórico): CADA fila de los 8 archivos (los 7 formularios de oftalmología
 * y el Padrón PG) queda en `import_rows`, con sus incidencias reales en `import_issues` y un vínculo en
 * `import_entity_links` hacia la persona/participación que originó o con la que reconcilió — se puede abrir
 * cualquier persona o reunión de este lote y saber de qué fila de qué archivo salió. El Padrón PG (N01) nunca
 * origina personas ni participaciones en este lote (es reconciliación): sus filas quedan en staging con el vínculo a
 * la persona existente cuando reconcilian, o `in_review` cuando no. Nunca se crea `meeting_attendance` ni se copian
 * datos de obra social / prepaga / número de afiliado.
 *
 * Participaciones (migración 0028, decisión de negocio EXCLUSIVA de la carga histórica inicial): se insertan con
 * participation_kind='participated' y participation_basis='legacy_initial_import' (nunca 'registration' — estar en
 * esta fuente ya se considera participación). Al final se corre `syncParticipationInteractions`: genera una
 * interacción SOLO para las participaciones con jornada y fecha real determinada; una participación de campaña sin
 * jornada asignada queda igual como "participó" pero nunca produce una interacción con fecha inventada.
 */

export const NUEVAS_IMPORT_LOCK_KEY = "sutecba:import:gabriel-nuevas";
export const NUEVAS_SOURCE_SYSTEM = "gabriel-nuevas-2026-09-22";

type Trx = Transaction<Database> | Kysely<Database>;

export interface NuevasApplyOptions {
  ownerOrganizationId: string;
  createdBy: string;
  confirmedPlanHash: string;
  identityDecisionRows?: readonly RawDecisionRow[];
  identityDecisionSource?: { fileName: string; sha256: string };
  notes?: string;
  env?: SutecbaEnv;
  ledger?: LedgerReader;
}

export interface NuevasApplyResult {
  outcome: "applied" | "noop_idempotent";
  planHash: string;
  runtimeRole: string;
  batchId: string;
  filesInserted: number;
  rowsInserted: number;
  rowsAlreadyImported: number;
  issuesInserted: number;
  entityLinksInserted: number;
  peopleCreated: number;
  peopleLinkedToExisting: number;
  meetingsCreated: number;
  meetingsExisting: number;
  participationsCreated: number;
  participationsAlreadyExisting: number;
  interactionsCreated: number;
  summary: Record<string, unknown>;
  plan: NuevasPlan;
}

async function acquireNuevasLock(trx: Transaction<Database>): Promise<void> {
  const result = await sql<{ locked: boolean }>`select pg_try_advisory_xact_lock(hashtext(${NUEVAS_IMPORT_LOCK_KEY})) as locked`.execute(trx);
  if (!result.rows[0]?.locked) throw new ImportAbortError("Hay otra importación de las nuevas bases en curso (lock ocupado). No se aplica nada.");
}

/** Foto de la base DENTRO de la transacción de escritura (nunca simulada: el catálogo ya debe estar aplicado). */
async function readNuevasContextTrx(trx: Transaction<Database>, f07: ExtractedFile | null): Promise<NuevasContext> {
  const people = await sql<{ dni: string; first_name: string; last_name: string; email: string | null; phone: string | null; cuil_cuit: string | null; organization_id: string | null; b: string | null }>`
    select dni, first_name, last_name, email, phone, cuil_cuit, organization_id, to_char(birth_date, 'YYYY-MM-DD') as b from people where status <> 'merged'
  `.execute(trx);
  const meetings = await sql<{ k: string; p: string; d: string | null }>`
    select source_event_key as k, schedule_precision as p, to_char(event_date, 'YYYY-MM-DD') as d from meetings where source_event_key is not null
  `.execute(trx);
  const parts = await sql<{ campaign_key: string | null; key: string | null; dni: string; kind: string }>`
    select mp.campaign_key, m.source_event_key as key, p.dni, mp.participation_kind as kind
    from meeting_participations mp join people p on p.id = mp.person_id left join meetings m on m.id = mp.meeting_id
  `.execute(trx);
  const org = await loadOrganizationContext(trx);
  const codes = await trx.selectFrom("organizations").select(["id", "official_code"]).where("official_code", "is not", null).execute();
  return {
    organizationCodeById: new Map(codes.map((o) => [o.id, o.official_code!])),
    people: people.rows.map((r) => ({ dni: r.dni, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone, cuil: r.cuil_cuit, organizationId: r.organization_id, birthDate: r.b })),
    meetings: meetings.rows.map((r) => ({ key: r.k, precision: r.p, date: r.d })),
    participations: new Set(parts.rows.map((r) => (r.campaign_key ? `campaign|${r.campaign_key}|${r.dni}` : `meeting|${r.key}|${r.dni}`))),
    aliases: org.organizationAliases,
    organizationParents: org.organizationParents,
    f07,
  };
}

const meetingStatusFor = (date: string | null, today: string) => (date && date < today ? "finished" : "draft");

/** Incidencia real de staging (código libre en `import_issues.code`, sin CHECK: ver 0018_imports.sql). */
type NuevasIssue = { code: string; severity: "warning" | "error"; message: string };

function issuesForFormRow(row: NuevaRow, blockedDnis: ReadonlySet<string>, pendingOrgDnis: ReadonlySet<string>): NuevasIssue[] {
  const issues: NuevasIssue[] = [];
  if (row.dniProblem === "missing") issues.push({ code: "MISSING_CANONICAL_DNI", severity: "error", message: "Fila sin DNI reconocible." });
  if (row.dniProblem === "invalid") issues.push({ code: "INVALID_DNI_FORMAT", severity: "error", message: "El DNI de la fila no tiene 7-8 dígitos válidos." });
  if (row.dni && blockedDnis.has(row.dni)) issues.push({ code: "BLOCKED_IDENTITY_CONFLICT", severity: "error", message: "DNI bloqueado por conflicto de identidad: sin decisión humana que lo resuelva." });
  if (row.duplicateInFile) issues.push({ code: "DUPLICATE_ROW_SAME_DNI_IN_FILE", severity: "warning", message: "Otra fila de este mismo archivo ya trae el mismo DNI." });
  if (row.birthDateIssue) issues.push({ code: row.birthDateIssue, severity: "warning", message: "Fecha de nacimiento descartada por implausible: no se escribe en people.birth_date." });
  if (row.dni && pendingOrgDnis.has(row.dni) && comparableText(row.organismText)) issues.push({ code: "ORGANISM_UNMAPPED", severity: "warning", message: "Texto de organismo sin alias aprobado: persona creada sin unidad." });
  return issues;
}

function issuesForPadronRow(row: PadronRow, incomplete: boolean, personFound: boolean): NuevasIssue[] {
  const issues: NuevasIssue[] = [];
  if (incomplete) issues.push({ code: "INCOMPLETE_CUIL_NO_DNI", severity: "warning", message: "CUIL de 10 dígitos en el PDF: no se puede derivar el DNI de este registro." });
  else if (!personFound) issues.push({ code: "PADRON_PERSON_NOT_FOUND", severity: "warning", message: "DNI legible del PDF sin persona cargada para reconciliar." });
  return issues;
}

export async function runNuevasImport(db: Kysely<Database>, files: ExtractedFile[], f07: ExtractedFile | null, options: NuevasApplyOptions): Promise<NuevasApplyResult> {
  const env = options.env ?? loadEnv();
  const runtime = await assertRuntimeRole(db, env);
  await assertDatabasePreconditions(db, env, { ledger: options.ledger });

  return db.transaction().execute(async (trx) => {
    const today = new Date().toISOString().slice(0, 10);
    await acquireNuevasLock(trx);
    await assertActorAndOwner(trx, options.createdBy, options.ownerOrganizationId);

    const ctx = await readNuevasContextTrx(trx, f07);
    const { plan, decisions } = buildNuevasPlanWithDecisions(files, ctx, options.identityDecisionRows);
    if (plan.planHash !== options.confirmedPlanHash) {
      throw new ImportAbortError("El hash del plan de las nuevas bases no coincide con el aprobado en el dry-run. Repetí el dry-run y confirmá el nuevo hash.");
    }

    const blockedDnis = new Set(plan.blocked.map((b) => b.dni));
    const pendingOrgDnis = new Set(plan.peopleToCreate.filter((p) => !p.organizationKey && p.organismText && comparableText(p.organismText)).map((p) => p.dni));

    // 1. Archivos (dedup por content_hash, igual que el importador histórico: tamaño y metadata de fuente incluidos) y lote propio.
    const fileIdByCode = new Map<NuevaCode, string>();
    const shaByCode = new Map<NuevaCode, string>();
    let filesInserted = 0;
    for (const file of files) {
      shaByCode.set(file.fileCode as NuevaCode, file.sha256);
      const existingFile = await trx.selectFrom("import_files").select("id").where("content_hash", "=", file.sha256).executeTakeFirst();
      if (existingFile) fileIdByCode.set(file.fileCode as NuevaCode, existingFile.id);
      else {
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
        fileIdByCode.set(file.fileCode as NuevaCode, created.id);
        filesInserted += 1;
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
        notes: options.notes ?? "Nuevas bases de Gabriel (2026-09-22): oftalmología + Padrón PG",
        execution_mode: "apply",
        plan_hash: plan.planHash,
        source_system: NUEVAS_SOURCE_SYSTEM,
        sutecba_env: env.SUTECBA_ENV,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const [, fileId] of fileIdByCode) {
      await trx.insertInto("import_batch_files").values({ batch_id: batch.id, file_id: fileId, linked_by: options.createdBy }).onConflict((oc) => oc.doNothing()).execute();
    }

    // 2. Staging fila por fila (idempotente por file_id+sheet+row_number): los 7 formularios primero, después el Padrón PG.
    const rowIdByKey = new Map<string, string>();
    let rowsInserted = 0;
    let rowsAlreadyImported = 0;

    for (const row of plan.rows) {
      const rk = nuevaRowKey(row.file, row.sheet, row.rowNumber);
      const fileId = fileIdByCode.get(row.file)!;
      const hash = fingerprintRow(shaByCode.get(row.file)!, row.sheet, row.rowNumber, row.rawCells);
      const destination = plan.rowDestinations.get(rk) ?? null;
      const normalizedDni = row.dniProblem ? null : row.dni;
      const inserted = await trx
        .insertInto("import_rows")
        .values({
          file_id: fileId,
          sheet: row.sheet,
          row_number: row.rowNumber,
          raw_data: toJsonb(row.rawCells as never),
          normalized_data: toJsonb({
            last: row.last,
            first: row.first,
            email: row.email,
            phone: row.phone,
            birth_date: row.birthDate,
            birth_date_issue: row.birthDateIssue,
            organism_text: row.organismText,
            day_text: row.dayText,
            has_health_insurance: row.hasHealthInsurance,
            destination,
          } as never),
          row_hash: hash,
          status: "staged" satisfies ImportRowStatus,
          source_file_code: row.file,
          normalized_dni: normalizedDni,
          dni_source: normalizedDni ? "explicit" : null,
          normalized_cuil_cuit: null,
          campaign_key: destination?.type === "campaign" ? destination.key : null,
          participation_kind: normalizedDni && !blockedDnis.has(normalizedDni) ? "participated" : null,
        })
        .onConflict((oc) => oc.columns(["file_id", "sheet", "row_number"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (inserted) {
        rowIdByKey.set(rk, inserted.id);
        rowsInserted += 1;
      } else {
        const existing = await trx.selectFrom("import_rows").select("id").where("file_id", "=", fileId).where("sheet", "=", row.sheet).where("row_number", "=", row.rowNumber).executeTakeFirstOrThrow();
        rowIdByKey.set(rk, existing.id);
        rowsAlreadyImported += 1;
      }
    }

    // Padrón PG (N01): reconciliación pura, nunca crea personas ni participaciones en este lote.
    const n01 = files.find((f) => (f.fileCode as string) === "N01") ?? null;
    const padron = n01 ? padronRows(n01) : null;
    const padronFileId = n01 ? fileIdByCode.get("N01" as NuevaCode)! : null;
    const padronSha = n01 ? shaByCode.get("N01" as NuevaCode)! : null;
    const currentPeopleDnis = new Set(ctx.people.map((p) => p.dni));
    const padronRowIdByKey = new Map<string, string>();
    if (padron && padronFileId && padronSha) {
      const stagePadronRow = async (row: PadronRow, incomplete: boolean) => {
        const rk = nuevaRowKey("N01", row.sheet, row.rowNumber);
        const hash = fingerprintRow(padronSha, row.sheet, row.rowNumber, { cuilCell: row.cuilCell, nextCellHead: row.nextCellHead, last: row.last, first: row.first, phone: row.phone, email: row.email });
        const normalizedDni = incomplete ? null : row.dni;
        const inserted = await trx
          .insertInto("import_rows")
          .values({
            file_id: padronFileId,
            sheet: row.sheet,
            row_number: row.rowNumber,
            raw_data: toJsonb({ cuilCell: row.cuilCell, nextCellHead: row.nextCellHead, last: row.last, first: row.first, phone: row.phone, email: row.email } as never),
            normalized_data: toJsonb({ incomplete_cuil: incomplete, matches_existing_person: !incomplete && currentPeopleDnis.has(row.dni) } as never),
            row_hash: hash,
            status: "staged" satisfies ImportRowStatus,
            source_file_code: "N01",
            normalized_dni: normalizedDni,
            dni_source: normalizedDni ? "derived_from_cuil" : null,
            normalized_cuil_cuit: null,
            campaign_key: null,
            participation_kind: null,
          })
          .onConflict((oc) => oc.columns(["file_id", "sheet", "row_number"]).doNothing())
          .returning("id")
          .executeTakeFirst();
        if (inserted) {
          padronRowIdByKey.set(rk, inserted.id);
          rowsInserted += 1;
        } else {
          const existing = await trx.selectFrom("import_rows").select("id").where("file_id", "=", padronFileId).where("sheet", "=", row.sheet).where("row_number", "=", row.rowNumber).executeTakeFirstOrThrow();
          padronRowIdByKey.set(rk, existing.id);
          rowsAlreadyImported += 1;
        }
      };
      for (const row of padron.rows) await stagePadronRow(row, false);
      for (const row of padron.incomplete) await stagePadronRow(row, true);
    }

    // 3. Incidencias (una por fila y código, igual política de deduplicación que el histórico)
    let issuesInserted = 0;
    const allRowIds = [...rowIdByKey.values(), ...padronRowIdByKey.values()];
    const existingIssueKeys = new Set<string>();
    for (let i = 0; i < allRowIds.length; i += 500) {
      const chunk = allRowIds.slice(i, i + 500);
      const found = await trx.selectFrom("import_issues").select(["import_row_id", "code"]).where("import_row_id", "in", chunk).execute();
      for (const f of found) existingIssueKeys.add(`${f.import_row_id}|${f.code}`);
    }
    const insertIssues = async (rowId: string, issues: NuevasIssue[]) => {
      const seen = new Set<string>();
      for (const issue of issues) {
        const key = `${rowId}|${issue.code}`;
        if (existingIssueKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        await trx.insertInto("import_issues").values({ batch_id: batch.id, import_row_id: rowId, severity: issue.severity, code: issue.code, message: issue.message }).execute();
        issuesInserted += 1;
      }
    };
    for (const row of plan.rows) {
      const rowId = rowIdByKey.get(nuevaRowKey(row.file, row.sheet, row.rowNumber))!;
      await insertIssues(rowId, issuesForFormRow(row, blockedDnis, pendingOrgDnis));
    }
    if (padron) {
      for (const row of padron.rows) {
        const rowId = padronRowIdByKey.get(nuevaRowKey("N01", row.sheet, row.rowNumber))!;
        await insertIssues(rowId, issuesForPadronRow(row, false, currentPeopleDnis.has(row.dni)));
      }
      for (const row of padron.incomplete) {
        const rowId = padronRowIdByKey.get(nuevaRowKey("N01", row.sheet, row.rowNumber))!;
        await insertIssues(rowId, issuesForPadronRow(row, true, false));
      }
    }

    // 4. Personas: nuevas (con o sin merge) y vínculo por DNI a las que ya existían.
    const personIdByDni = new Map<string, string>();
    for (const p of ctx.people) {
      const row = await trx.selectFrom("people").select("id").where("dni", "=", p.dni).where("status", "!=", "merged").executeTakeFirst();
      if (row) personIdByDni.set(p.dni, row.id);
    }
    let peopleCreated = 0;
    const organizationIdByCode = new Map([...ctx.organizationCodeById!].map(([id, code]) => [code, id]));
    for (const person of plan.peopleToCreate) {
      if (person.organizationKey && !organizationIdByCode.has(person.organizationKey)) throw new ImportAbortError("Falta materializar una organización del plan.");
      if (!/^[0-9]{7,8}$/.test(person.dni)) throw new ImportAbortError("Se intentó crear una persona sin DNI canónico: se revierte todo.");
      const already = await trx.selectFrom("people").select("id").where("dni", "=", person.dni).where("status", "!=", "merged").executeTakeFirst();
      if (already) {
        personIdByDni.set(person.dni, already.id);
        continue; // idempotencia: ya se había creado en una corrida anterior
      }
      // Defensa en profundidad: un año de nacimiento implausible nunca se escribe (nuevas.ts ya lo descarta antes, pero se revalida acá).
      const birthDateOk = person.birthDate ? validateBirthDate(person.birthDate, today).ok : true;
      const created = await trx
        .insertInto("people")
        .values({
          first_name: person.first,
          last_name: person.last,
          dni: person.dni,
          dni_source: "explicit",
          email: person.email,
          phone: person.phone,
          birth_date: birthDateOk ? dateOnly(person.birthDate) : null,
          organization_id: person.organizationKey ? organizationIdByCode.get(person.organizationKey)! : null,
          origin: "import",
          created_by: options.createdBy,
          updated_by: options.createdBy,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      personIdByDni.set(person.dni, created.id);
      peopleCreated += 1;
    }
    const peopleLinkedToExisting = plan.identityDecisionResults.filter((r) => r.outcome === "linked_to_existing").length;

    // 5. Reuniones/operativos nuevos.
    const meetingIdByKey = new Map<string, string>();
    for (const m of ctx.meetings) {
      const row = await trx.selectFrom("meetings").select("id").where("source_event_key", "=", m.key).executeTakeFirst();
      if (row) meetingIdByKey.set(m.key, row.id);
    }
    let meetingsCreated = 0;
    for (const meeting of plan.meetingsToCreate) {
      const already = await trx.selectFrom("meetings").select("id").where("source_event_key", "=", meeting.key).executeTakeFirst();
      if (already) {
        meetingIdByKey.set(meeting.key, already.id);
        continue;
      }
      const created = await trx
        .insertInto("meetings")
        .values({
          name: meeting.name,
          owner_organization_id: options.ownerOrganizationId,
          meeting_type: "operativo_salud",
          origin: "import",
          source_event_key: meeting.key,
          import_batch_id: batch.id,
          schedule_precision: meeting.precision,
          event_date: meeting.precision === "date_only" ? dateOnly(meeting.date) : null,
          status: meetingStatusFor(meeting.date, today),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      meetingIdByKey.set(meeting.key, created.id);
      meetingsCreated += 1;
    }

    // 6. Participaciones: decisión de negocio de la carga histórica inicial (migración 0028) — 'participated' con
    // participation_basis='legacy_initial_import', nunca 'attended' inventado; únicas por (destino, persona, tipo).
    let participationsCreated = 0;
    let participationsExisting = 0;
    const participationIdByDest = new Map<string, string>(); // `${type}|${key}|${dni}` -> meeting_participations.id
    const originByDest = new Map<string, string>();
    for (const row of plan.rows) {
      const rk = nuevaRowKey(row.file, row.sheet, row.rowNumber);
      const destination = plan.rowDestinations.get(rk);
      if (!row.dni || row.dniProblem || blockedDnis.has(row.dni) || !destination) continue;
      const key = `${destination.type}|${destination.key}|${row.dni}`;
      if (!originByDest.has(key)) originByDest.set(key, rowIdByKey.get(rk)!);
    }
    const existingParts = await sql<{ id: string; dni: string; campaign_key: string | null; event_key: string | null }>`
      select mp.id, p.dni, mp.campaign_key, m.source_event_key as event_key
      from meeting_participations mp join people p on p.id=mp.person_id left join meetings m on m.id=mp.meeting_id
      order by case mp.participation_kind when 'participated' then 0 when 'attended' then 1 else 2 end, mp.id
    `.execute(trx);
    for (const p of existingParts.rows) {
      const key = p.campaign_key ? `campaign|${p.campaign_key}|${p.dni}` : `meeting|${p.event_key}|${p.dni}`;
      if (originByDest.has(key) && !participationIdByDest.has(key)) participationIdByDest.set(key, p.id);
    }
    participationsExisting = participationIdByDest.size;
    for (const participation of plan.participations) {
      const personId = personIdByDni.get(participation.dni);
      if (!personId) continue; // no debería pasar: toda participación planificada corresponde a un dni no bloqueado
      const meetingId = participation.destination.type === "meeting" ? (meetingIdByKey.get(participation.destination.key) ?? null) : null;
      if (participation.destination.type === "meeting" && !meetingId) continue;
      const destKey = `${participation.destination.type}|${participation.destination.key}|${participation.dni}`;
      const inserted = await trx
        .insertInto("meeting_participations")
        .values({
          meeting_id: meetingId,
          campaign_key: participation.destination.type === "campaign" ? participation.destination.key : null,
          person_id: personId,
          participation_kind: "participated",
          participation_basis: "legacy_initial_import",
          evidence: null,
          import_row_id: originByDest.get(destKey)!,
        })
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst();
      let participationId = inserted?.id;
      if (inserted) participationsCreated += 1;
      else {
        participationsExisting += 1;
        participationId = (
          await trx
            .selectFrom("meeting_participations")
            .select("id")
            .where("person_id", "=", personId)
            .where("participation_kind", "=", "participated")
            .$if(meetingId !== null, (qb) => qb.where("meeting_id", "=", meetingId!))
            .$if(meetingId === null, (qb) => qb.where("meeting_id", "is", null).where("campaign_key", "=", participation.destination.key))
            .executeTakeFirst()
        )?.id;
      }
      if (participationId) participationIdByDest.set(destKey, participationId);
    }

    // 7. Vínculos de procedencia (import_entity_links) y estado final de cada fila de staging.
    let entityLinksInserted = 0;
    const linkEntity = async (rowId: string, entityType: string, entityId: string) => {
      const res = await trx.insertInto("import_entity_links").values({ import_row_id: rowId, entity_type: entityType, entity_id: entityId, linked_by: options.createdBy }).onConflict((oc) => oc.doNothing()).returning("id").executeTakeFirst();
      if (res) entityLinksInserted += 1;
    };
    for (const row of plan.rows) {
      const rk = nuevaRowKey(row.file, row.sheet, row.rowNumber);
      const rowId = rowIdByKey.get(rk)!;
      const normalizedDni = row.dniProblem ? null : row.dni;
      const destination = plan.rowDestinations.get(rk) ?? null;
      if (normalizedDni && !blockedDnis.has(normalizedDni)) {
        const personId = personIdByDni.get(normalizedDni) ?? null;
        const meetingId = destination?.type === "meeting" ? (meetingIdByKey.get(destination.key) ?? null) : null;
        await trx.updateTable("import_rows").set({ person_id: personId, meeting_id: meetingId, status: "applied" satisfies ImportRowStatus }).where("id", "=", rowId).execute();
        if (personId) await linkEntity(rowId, "person", personId);
        if (destination) {
          const participationId = participationIdByDest.get(`${destination.type}|${destination.key}|${normalizedDni}`);
          if (participationId) await linkEntity(rowId, "meeting_participation", participationId);
        }
      } else {
        await trx.updateTable("import_rows").set({ status: "in_review" satisfies ImportRowStatus }).where("id", "=", rowId).execute();
      }
    }
    if (padron) {
      const finalizePadronRow = async (row: PadronRow, incomplete: boolean) => {
        const rowId = padronRowIdByKey.get(nuevaRowKey("N01", row.sheet, row.rowNumber))!;
        if (incomplete) {
          await trx.updateTable("import_rows").set({ status: "in_review" satisfies ImportRowStatus }).where("id", "=", rowId).execute();
          return;
        }
        const personId = personIdByDni.get(row.dni) ?? null;
        if (personId) {
          await trx.updateTable("import_rows").set({ person_id: personId, status: "applied" satisfies ImportRowStatus }).where("id", "=", rowId).execute();
          await linkEntity(rowId, "person", personId);
        } else {
          await trx.updateTable("import_rows").set({ status: "in_review" satisfies ImportRowStatus }).where("id", "=", rowId).execute();
        }
      };
      for (const row of padron.rows) await finalizePadronRow(row, false);
      for (const row of padron.incomplete) await finalizePadronRow(row, true);
    }

    // 8. Interacciones automáticas: solo participaciones 'participated' con jornada y fecha real (nunca inventada;
    // ver lib/interactions/participation-sync.ts). Una participación de campaña sin jornada determinada nunca genera una.
    const interactionSync = await syncParticipationInteractions(trx, { actorUserId: options.createdBy, participationIds: [...participationIdByDest.values()] });

    const noop = filesInserted === 0 && rowsInserted === 0 && issuesInserted === 0 && entityLinksInserted === 0 && peopleCreated === 0 && meetingsCreated === 0 && participationsCreated === 0 && interactionSync.created === 0;
    const outcome: NuevasApplyResult["outcome"] = noop ? "noop_idempotent" : "applied";
    const summary: Record<string, unknown> = {
      outcome,
      plan_hash: plan.planHash,
      runtime_role: runtime.role,
      files: files.map((f) => ({ code: f.fileCode, sha256: f.sha256, size_bytes: f.sizeBytes })),
      rows: { processed: rowIdByKey.size + padronRowIdByKey.size, inserted: rowsInserted, already_imported: rowsAlreadyImported },
      issues_inserted: issuesInserted,
      entity_links_inserted: entityLinksInserted,
      people: { created: peopleCreated, linked_to_existing_by_merge: peopleLinkedToExisting, blocked: plan.blocked.length },
      meetings: { created: meetingsCreated, existing: plan.meetingsReused.length },
      participations: { created: participationsCreated, already_existing: participationsExisting },
      attendance_created: 0,
      interactions: { created: interactionSync.created, skipped_without_date: interactionSync.skippedWithoutDate },
      ...(decisions
        ? {
            identity_decisions: {
              source_file: options.identityDecisionSource ?? null,
              total: decisions.length,
              by_decision: decisions.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.decision]: (acc[d.decision] ?? 0) + 1 }), {}),
              results: plan.identityDecisionResults.map((r) => ({ decision: r.decision, outcome: r.outcome, source_rows: r.sourceRows })),
            },
          }
        : {}),
    };
    const completedAt = new Date();
    await trx.updateTable("import_batches").set({ status: "applied", completed_at: completedAt, applied_at: completedAt, summary: toJsonb(summary as never) }).where("id", "=", batch.id).execute();

    return {
      outcome,
      planHash: plan.planHash,
      runtimeRole: runtime.role,
      batchId: batch.id,
      filesInserted,
      rowsInserted,
      rowsAlreadyImported,
      issuesInserted,
      entityLinksInserted,
      peopleCreated,
      peopleLinkedToExisting,
      meetingsCreated,
      meetingsExisting: plan.meetingsReused.length,
      participationsCreated,
      participationsAlreadyExisting: participationsExisting,
      interactionsCreated: interactionSync.created,
      summary,
      plan,
    };
  });
}

export type { Trx as NuevasTrx };
