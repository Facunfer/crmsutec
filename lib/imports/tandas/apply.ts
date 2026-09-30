import { sql, type Kysely, type Transaction } from "kysely";
import { toJsonb } from "../../db/json.js";
import type { Database } from "../../db/schema.js";
import { validateBirthDate } from "../../people/birth-date.js";
import { dateOnly } from "../../db/date-only.js";
import { fingerprintRow } from "../gabriel/normalize.js";
import { ImportAbortError, assertActorAndOwner, assertDatabasePreconditions, assertRuntimeRole, type LedgerReader } from "../gabriel/preflight.js";
import type { ExtractedFile } from "../gabriel/types.js";
import { loadEnv, type SutecbaEnv } from "../../db/env.js";
import { buildTandasPlan } from "./plan.js";
import { readTandasSnapshot } from "./snapshot.js";
import { parseTandaFile, sourceDef, type ParsedFile } from "./sources.js";

/**
 * APPLY de las tandas 1 y 2. Solo corre con el hash del plan aprobado en el dry-run y en un entorno permitido.
 *
 * Diseño (volumen ≈ 180.000 filas):
 *  - FASES, cada una en su propia transacción y TODAS idempotentes: un fallo deja una fase completa o sin efecto, y
 *    reintentar el mismo comando CONTINÚA (recuperación hacia adelante) sin duplicar nada. No hay borrados: no se promete
 *    un rollback destructivo que pueda llevarse datos ajenos.
 *  - El lote (`import_batches`) queda 'processing' hasta que la conciliación final coincide con el plan; recién ahí 'applied'.
 *  - El hash del plan es sobre el ESTADO DESEADO derivado de las fuentes: es el mismo antes y después de un apply parcial.
 *  - Nada genera person_interactions, asistencia ni check-in. Las participaciones nuevas son `participated` +
 *    `source_business_rule` (migración 0031) y las inscripciones (52016) `registration` estándar.
 *  - Personas existentes: solo se completa la organización cuando estaba vacía y la resolución fue inequívoca.
 */

export const TANDAS_SOURCE_SYSTEM = "tandas-1-2-2026-09";
const LOCK_KEY = "sutecba:import:tandas";
const CHUNK = 1000;
export const REQUIRED_MIGRATIONS = ["0031_participation_basis_source_business_rule.sql", "0032_people_unsplit_full_name.sql", "0033_person_observations.sql"];

type Db = Kysely<Database>;
type Trx = Transaction<Database>;

export interface TandasApplyOptions {
  ownerOrganizationId: string;
  createdBy: string;
  confirmedPlanHash: string;
  /** Solo en la primera corrida: cantidades de la base vistas en el dry-run (detecta cambios del destino). */
  expectPeople?: number;
  expectParticipations?: number;
  notes?: string;
  env?: SutecbaEnv;
  ledger?: LedgerReader;
  /** Solo tests: aborta tras una fase para probar la recuperación. */
  failAfterPhase?: string;
}

export interface TandasApplyResult {
  outcome: "applied" | "noop_idempotent";
  batchId: string;
  planHash: string;
  summary: Record<string, unknown>;
}

const chunks = <T,>(list: T[], size = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

const abort = (m: string): never => {
  throw new ImportAbortError(m);
};

const evidenceFor = (fileName: string, code: string, sheet: string, row: number, kind: "listado" | "formulario", vaccines: string[]) =>
  `Regla de negocio: ${kind === "listado" ? "el listado de cursada realizada" : "la respuesta del formulario"} acredita participación efectiva (no es asistencia ni check-in). ` +
  `Fuente ${code} «${fileName}», hoja «${sheet}», fila ${row}.${vaccines.length ? ` Vacunas: ${[...vaccines].sort().join(", ")}.` : ""}`;

export async function runTandasImport(db: Db, files: ExtractedFile[], options: TandasApplyOptions): Promise<TandasApplyResult> {
  const env = options.env ?? loadEnv();
  const runtime = await assertRuntimeRole(db, env);
  await assertDatabasePreconditions(db, env, { ledger: options.ledger });
  const parsed: ParsedFile[] = files.map((f) => parseTandaFile(f));
  const fileByCode = new Map<string, ExtractedFile>(files.map((f) => [f.fileCode as string, f]));
  const today = new Date().toISOString().slice(0, 10);
  const stop = (phase: string) => {
    if (options.failAfterPhase === phase) throw new ImportAbortError(`Falla simulada tras la fase ${phase}`);
  };

  // ------------------------------------------------ fase 0: verificación, plan y lote
  const phase0 = await db.transaction().execute(async (trx) => {
    await lock(trx);
    await assertActorAndOwner(trx, options.createdBy, options.ownerOrganizationId);
    const migrations = await sql<{ n: number }>`select count(*)::int n from information_schema.tables where table_schema='public' and table_name='person_observations'`.execute(trx);
    if (!migrations.rows[0]?.n) abort(`Faltan migraciones: ${REQUIRED_MIGRATIONS.join(", ")}.`);
    const { snap } = await readTandasSnapshot(trx);
    const plan = buildTandasPlan(parsed, snap);
    if (plan.planHash !== options.confirmedPlanHash) abort("El hash del plan no coincide con el aprobado en el dry-run. Repetí el dry-run y confirmá el nuevo hash.");

    const open = await trx.selectFrom("import_batches").select(["id", "plan_hash", "status"]).where("source_system", "=", TANDAS_SOURCE_SYSTEM).where("status", "in", ["processing", "applied"]).orderBy("created_at", "desc").execute();
    const applied = open.find((b) => b.status === "applied" && b.plan_hash === plan.planHash);
    const processing = open.find((b) => b.status === "processing");
    if (processing && processing.plan_hash !== plan.planHash) abort("Hay un lote de las tandas en curso con otro plan: revisalo antes de continuar.");
    let batchId = processing?.id ?? applied?.id;
    const firstRun = !batchId;
    if (firstRun) {
      if (options.expectPeople !== undefined && snap.people.size + snap.mergedDnis.size !== options.expectPeople) abort("La cantidad de personas del destino cambió desde el dry-run: no se aplica nada.");
      if (options.expectParticipations !== undefined && [...snap.participations.values()].reduce((n, k) => n + k.length, 0) !== options.expectParticipations) abort("La cantidad de participaciones del destino cambió desde el dry-run: no se aplica nada.");
      const batch = await trx
        .insertInto("import_batches")
        .values({
          owner_organization_id: options.ownerOrganizationId, responsible_user_id: options.createdBy, created_by: options.createdBy, status: "processing", started_at: new Date(),
          notes: options.notes ?? "Tandas 1 y 2 (2026-09): 22 fuentes", execution_mode: "apply", plan_hash: plan.planHash, source_system: TANDAS_SOURCE_SYSTEM, sutecba_env: env.SUTECBA_ENV,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      batchId = batch.id;
    }
    const fileIds = new Map<string, string>();
    for (const f of files) {
      const found = await trx.selectFrom("import_files").select("id").where("content_hash", "=", f.sha256).executeTakeFirst();
      const id =
        found?.id ??
        (
          await trx
            .insertInto("import_files")
            .values({ original_name: f.fileName, content_hash: f.sha256, external_reference: f.fileCode, created_by: options.createdBy, size_bytes: f.sizeBytes, source_metadata: toJsonb({ file_code: f.fileCode, sheets: f.sheets.map((s) => s.name) } as never) })
            .returning("id")
            .executeTakeFirstOrThrow()
        ).id;
      fileIds.set(f.fileCode, id);
      await trx.insertInto("import_batch_files").values({ batch_id: batchId!, file_id: id, linked_by: options.createdBy }).onConflict((oc) => oc.doNothing()).execute();
    }
    return { batchId: batchId!, fileIds, planHash: plan.planHash, alreadyApplied: Boolean(applied) && !processing, firstRun };
  });
  stop("0");
  const { batchId, fileIds } = phase0;

  const counters = { rowsInserted: 0, peopleCreated: 0, meetingsCreated: 0, participationsCreated: 0, observationsCreated: 0, tagsAssigned: 0, orgCompleted: 0, linksInserted: 0, issuesInserted: 0 };

  // El plan se recalcula en cada fase (lee la base actual): así cada fase ve lo que las anteriores ya dejaron.
  const planIn = async (trx: Trx) => {
    const { snap } = await readTandasSnapshot(trx);
    const plan = buildTandasPlan(parsed, snap);
    if (plan.planHash !== options.confirmedPlanHash) abort("El plan cambió durante la importación (hash distinto): se detiene sin continuar.");
    return { plan, snap };
  };

  // ------------------------------------------------ fase 1: staging de filas (trazabilidad)
  const planA = await db.transaction().execute(async (trx) => (await planIn(trx)).plan);
  const rowIdByKey = new Map<string, string>();
  for (const pf of parsed) {
    const ef = fileByCode.get(pf.code)!;
    const fileId = fileIds.get(pf.code)!;
    const cellsByRow = new Map(ef.sheets.flatMap((s) => s.rows.map((r) => [`${s.name}|${r.n}`, r.cells] as const)));
    const outcomes = planA.rowOutcomes.filter((o) => o.file === pf.code);
    for (const part of chunks(outcomes)) {
      await db.transaction().execute(async (trx) => {
        await lock(trx);
        const inserted = await trx
          .insertInto("import_rows")
          .values(
            part.map((o) => ({
              file_id: fileId, sheet: o.sheet, row_number: o.row,
              raw_data: toJsonb((cellsByRow.get(`${o.sheet}|${o.row}`) ?? []) as never),
              normalized_data: toJsonb({ blocked_reason: o.blockedReason } as never),
              row_hash: fingerprintRow(ef.sha256, o.sheet, o.row, cellsByRow.get(`${o.sheet}|${o.row}`) ?? []),
              status: "staged" as const, source_file_code: o.file,
              normalized_dni: o.dni, dni_source: o.dni ? (o.dniSource as "explicit" | "derived_from_cuil") : null, normalized_cuil_cuit: o.dni ? o.cuil : null,
            }))
          )
          .onConflict((oc) => oc.columns(["file_id", "sheet", "row_number"]).doNothing())
          .returning("id")
          .execute();
        counters.rowsInserted += inserted.length;
      });
    }
    const ids = await db.selectFrom("import_rows").select(["id", "sheet", "row_number"]).where("file_id", "=", fileId).execute();
    for (const r of ids) rowIdByKey.set(`${pf.code}|${r.sheet}|${r.row_number}`, r.id);
  }
  stop("1");

  // ------------------------------------------------ fase 2: personas nuevas
  for (const part of chunks(planA.newPersonSpecs)) {
    await db.transaction().execute(async (trx) => {
      await lock(trx);
      const present = new Set((await trx.selectFrom("people").select("dni").where("dni", "in", part.map((p) => p.dni)).where("status", "!=", "merged").execute()).map((r) => r.dni));
      const todo = part.filter((p) => !present.has(p.dni));
      if (!todo.length) return;
      const rows = todo.map((p) => {
        if (!/^[0-9]{7,8}$/.test(p.dni)) abort("Se intentó crear una persona sin DNI canónico: se revierte la fase.");
        const birthOk = p.birthDate ? validateBirthDate(p.birthDate, today).ok : true;
        return {
          first_name: p.first, last_name: p.last, name_split_status: p.unsplit ? ("unsplit" as const) : ("split" as const), full_name_original: p.unsplit ? p.fullOriginal : null,
          dni: p.dni, dni_source: p.cuil ? p.dniSource : ("explicit" as const), cuil_cuit: p.cuil, email: p.email, phone: p.phone,
          birth_date: birthOk ? dateOnly(p.birthDate) : null, organization_id: p.orgId, origin: "import" as const, created_by: options.createdBy, updated_by: options.createdBy,
        };
      });
      await trx.insertInto("people").values(rows).execute();
      counters.peopleCreated += rows.length;
    });
  }
  stop("2");

  // mapa DNI → persona (todas las procesables)
  const personIdByDni = new Map<string, string>();
  const processable = [...planA.byDni.values()].filter((a) => !a.block).map((a) => a.dni);
  for (const part of chunks(processable, 5000)) {
    const found = await db.selectFrom("people").select(["id", "dni"]).where("dni", "in", part).where("status", "!=", "merged").execute();
    for (const r of found) personIdByDni.set(r.dni, r.id);
  }
  for (const dni of processable) if (!personIdByDni.has(dni)) abort("Una persona procesable no existe tras la fase de altas: se detiene.");

  // ------------------------------------------------ fase 3: reuniones y participaciones
  const meetingIdByKey = new Map<string, string>();
  await db.transaction().execute(async (trx) => {
    await lock(trx);
    for (const a of planA.activities.filter((x) => x.target === "meeting")) {
      const found = await trx.selectFrom("meetings").select("id").where("source_event_key", "=", a.key).executeTakeFirst();
      if (found) {
        meetingIdByKey.set(a.key, found.id);
        continue;
      }
      const dated = a.precision !== "unknown" && a.date;
      const created = await trx
        .insertInto("meetings")
        .values({
          name: a.name, owner_organization_id: options.ownerOrganizationId, meeting_type: "capacitacion", origin: "import", source_event_key: a.key, import_batch_id: batchId,
          schedule_precision: a.precision as "exact_datetime" | "date_only" | "unknown",
          event_date: a.precision === "date_only" ? dateOnly(a.date) : null,
          starts_at: a.precision === "exact_datetime" ? sql<Date>`(${a.date}::date + ${a.start}::time) at time zone 'America/Argentina/Buenos_Aires'` : null,
          ends_at: a.precision === "exact_datetime" ? sql<Date>`(${a.date}::date + ${a.end}::time) at time zone 'America/Argentina/Buenos_Aires'` : null,
          status: dated && a.date! < today ? "finished" : "draft",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      meetingIdByKey.set(a.key, created.id);
      counters.meetingsCreated += 1;
    }
  });
  for (const m of await db.selectFrom("meetings").select(["id", "source_event_key"]).where("source_event_key", "is not", null).execute()) meetingIdByKey.set(m.source_event_key!, m.id);
  stop("3a");

  const newFacts = planA.facts.filter((f) => !f.existing);
  for (const part of chunks(newFacts)) {
    await db.transaction().execute(async (trx) => {
      await lock(trx);
      const values = part.map((f) => {
        const [type, key] = [f.dest.slice(0, f.dest.indexOf("|")), f.dest.slice(f.dest.indexOf("|") + 1)];
        const origin = f.originRow!;
        const pf = parsed.find((p) => p.code === origin.file)!;
        const byRule = f.semantics === "participation_by_rule";
        const meetingId = type === "meeting" ? meetingIdByKey.get(key) : null;
        if (type === "meeting" && !meetingId) abort(`Falta la reunión ${key}`);
        return {
          meeting_id: meetingId ?? null, campaign_key: type === "campaign" ? key : null, person_id: personIdByDni.get(f.dni)!,
          participation_kind: byRule ? ("participated" as const) : ("registration" as const),
          participation_basis: byRule ? ("source_business_rule" as const) : ("standard" as const),
          evidence: byRule ? evidenceFor(pf.fileName, origin.file, origin.sheet, origin.row, sourceDef(origin.file).layout === "listado" ? "listado" : "formulario", [...f.vaccines]) : `Inscripción según el listado ${pf.fileName} (${origin.file}), fila ${origin.row}: no acredita participación ni asistencia.`,
          import_row_id: rowIdByKey.get(`${origin.file}|${origin.sheet}|${origin.row}`) ?? null,
        };
      });
      const inserted = await trx.insertInto("meeting_participations").values(values).onConflict((oc) => oc.doNothing()).returning("id").execute();
      counters.participationsCreated += inserted.length;
    });
  }
  stop("3");

  // ------------------------------------------------ fase 4: etiqueta «abogado» y observaciones
  const tagId = await db.transaction().execute(async (trx) => {
    await lock(trx);
    if (!planA.tagDnis.length) return null;
    const found = await trx.selectFrom("tags").select("id").where("normalized_name", "=", "abogado").where("owner_organization_id", "is", null).executeTakeFirst();
    if (found) return found.id;
    return (await trx.insertInto("tags").values({ name: "abogado", normalized_name: "abogado", category: "clasificacion", is_controlled: true, created_by: options.createdBy } as never).returning("id").executeTakeFirstOrThrow()).id;
  });
  if (tagId) {
    for (const part of chunks(planA.tagDnis)) {
      await db.transaction().execute(async (trx) => {
        await lock(trx);
        const ids = part.map((d) => personIdByDni.get(d)!);
        const has = new Set((await trx.selectFrom("person_tags").select("person_id").where("tag_id", "=", tagId).where("removed_at", "is", null).where("person_id", "in", ids).execute()).map((r) => r.person_id));
        const todo = ids.filter((id) => !has.has(id));
        if (!todo.length) return;
        await trx.insertInto("person_tags").values(todo.map((id) => ({ person_id: id, tag_id: tagId, assigned_by: options.createdBy }))).execute();
        counters.tagsAssigned += todo.length;
      });
    }
  }
  for (const part of chunks(planA.observationSpecs)) {
    await db.transaction().execute(async (trx) => {
      await lock(trx);
      const inserted = await trx
        .insertInto("person_observations")
        .values(part.map((o) => ({ person_id: personIdByDni.get(o.dni)!, category: o.category, value: o.value, source_kind: "import" as const, import_row_id: rowIdByKey.get(o.rowKey)!, created_by: options.createdBy })))
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .execute();
      counters.observationsCreated += inserted.length;
    });
  }
  stop("4");

  // ------------------------------------------------ fase 5: organización faltante de personas existentes
  await db.transaction().execute(async (trx) => {
    await lock(trx);
    const { plan } = await planIn(trx);
    for (const o of plan.orgToComplete) {
      const res = await trx
        .updateTable("people")
        .set({ organization_id: o.orgId, updated_by: options.createdBy, updated_at: new Date(), version: sql<number>`version + 1` })
        .where("dni", "=", o.dni)
        .where("status", "!=", "merged")
        .where("organization_id", "is", null)
        .returning("id")
        .executeTakeFirst();
      if (res) counters.orgCompleted += 1;
    }
  });
  stop("5");

  // ------------------------------------------------ fase 6: vínculos de procedencia e incidencias
  const finalPlan = await db.transaction().execute(async (trx) => (await planIn(trx)).plan);
  const partIdByPersonDest = new Map<string, string>();
  const factByRow = new Map<string, { dest: string; dni: string; existingDests: string[]; kind: "participated" | "registration" }>();
  for (const f of finalPlan.facts) for (const rk of f.rowKeys) factByRow.set(rk, { dest: f.dest, dni: f.dni, existingDests: f.existingDests, kind: f.semantics === "participation_by_rule" ? "participated" : "registration" });
  for (const part of chunks(processable, 3000)) {
    const found = await sql<{ id: string; dni: string; dest: string }>`
      select mp.id, p.dni, case when mp.campaign_key is not null then 'campaign|' || mp.campaign_key else 'meeting|' || m.source_event_key end as dest
      from meeting_participations mp join people p on p.id = mp.person_id left join meetings m on m.id = mp.meeting_id
      where p.dni = any(${part}) and p.status <> 'merged' order by case mp.participation_kind when 'participated' then 0 when 'attended' then 1 else 2 end, mp.id`.execute(db);
    for (const r of found.rows) if (!partIdByPersonDest.has(`${r.dni}|${r.dest}`)) partIdByPersonDest.set(`${r.dni}|${r.dest}`, r.id);
  }
  const outcomes = finalPlan.rowOutcomes;
  for (const part of chunks(outcomes)) {
    await db.transaction().execute(async (trx) => {
      await lock(trx);
      const links: Array<{ import_row_id: string; entity_type: string; entity_id: string; linked_by: string }> = [];
      const issues: Array<{ batch_id: string; import_row_id: string; severity: "warning" | "error"; code: string; message: string }> = [];
      const updates: Array<{ id: string; person: string | null; status: string; campaign: string | null; meeting: string | null; kind: string | null }> = [];
      for (const o of part) {
        const rowId = rowIdByKey.get(o.key)!;
        if (!o.dni || o.blockedReason) {
          updates.push({ id: rowId, person: null, status: "in_review", campaign: null, meeting: null, kind: null });
          issues.push({ batch_id: batchId, import_row_id: rowId, severity: "error", code: o.blockedReason ?? "MISSING_IDENTIFIER", message: blockedMessage(o.blockedReason) });
          continue;
        }
        const personId = personIdByDni.get(o.dni)!;
        links.push({ import_row_id: rowId, entity_type: "person", entity_id: personId, linked_by: options.createdBy });
        const fact = factByRow.get(o.key);
        let campaign: string | null = null;
        let meeting: string | null = null;
        if (fact) {
          const candidates = [fact.dest, ...fact.existingDests];
          const found = candidates.find((d) => partIdByPersonDest.has(`${o.dni}|${d}`));
          if (found) {
            links.push({ import_row_id: rowId, entity_type: "meeting_participation", entity_id: partIdByPersonDest.get(`${o.dni}|${found}`)!, linked_by: options.createdBy });
            if (found.startsWith("campaign|")) campaign = found.slice(9);
            else meeting = meetingIdByKey.get(found.slice(8)) ?? null;
          }
        }
        updates.push({ id: rowId, person: personId, status: "applied", campaign, meeting, kind: fact?.kind ?? null });
      }
      // Una sola sentencia por bloque (un UPDATE por fila sería ~180.000 viajes de red contra Supabase).
      if (updates.length) {
        await sql`
          update import_rows r set person_id = v.person_id, status = v.status, campaign_key = v.campaign, meeting_id = v.meeting, participation_kind = v.kind
          from (select unnest(${updates.map((u) => u.id)}::uuid[]) as id, unnest(${updates.map((u) => u.person)}::uuid[]) as person_id, unnest(${updates.map((u) => u.status)}::text[]) as status,
                       unnest(${updates.map((u) => u.campaign)}::text[]) as campaign, unnest(${updates.map((u) => u.meeting)}::uuid[]) as meeting, unnest(${updates.map((u) => u.kind)}::text[]) as kind) v
          where r.id = v.id`.execute(trx);
      }
      if (links.length) {
        const ins = await trx.insertInto("import_entity_links").values(links).onConflict((oc) => oc.doNothing()).returning("id").execute();
        counters.linksInserted += ins.length;
      }
      if (issues.length) {
        const have = new Set((await trx.selectFrom("import_issues").select(["import_row_id", "code"]).where("import_row_id", "in", issues.map((i) => i.import_row_id)).execute()).map((r) => `${r.import_row_id}|${r.code}`));
        const todo = issues.filter((i) => !have.has(`${i.import_row_id}|${i.code}`));
        if (todo.length) {
          await trx.insertInto("import_issues").values(todo).execute();
          counters.issuesInserted += todo.length;
        }
      }
    });
  }
  stop("6");

  // ------------------------------------------------ fase 7: conciliación final y cierre del lote
  return db.transaction().execute(async (trx) => {
    await lock(trx);
    const { plan, snap } = await planIn(trx);
    const pending = plan.facts.filter((f) => !f.existing).length + plan.newPeople.length + plan.orgToComplete.length;
    if (pending !== 0) abort(`Conciliación: quedan ${pending} elementos del plan sin aplicar. El lote sigue en 'processing'; reintentá el mismo comando.`);
    const interactions = await sql<{ n: number }>`select count(*)::int n from person_interactions where source_key like 'meeting_participation:%' and created_at >= (select started_at from import_batches where id = ${batchId}::uuid)`.execute(trx);
    const noop = Object.values(counters).every((n) => n === 0);
    const summary: Record<string, unknown> = {
      outcome: noop ? "noop_idempotent" : "applied",
      plan_hash: plan.planHash,
      runtime_role: runtime.role,
      files: files.map((f) => ({ code: f.fileCode, sha256: f.sha256 })),
      created_this_run: counters,
      final_state: { people_total: snap.people.size, participations_pending: 0, interactions_created_after_batch_start: interactions.rows[0]!.n },
      interactions_created_by_import: 0,
      attendance_created: 0,
      blocked_rows: plan.blocked.length,
    };
    const now = new Date();
    await trx.updateTable("import_batches").set({ status: "applied", completed_at: now, applied_at: now, summary: toJsonb(summary as never) }).where("id", "=", batchId).execute();
    return { outcome: summary.outcome as TandasApplyResult["outcome"], batchId, planHash: plan.planHash, summary };
  });
}

async function lock(trx: Trx): Promise<void> {
  const r = await sql<{ locked: boolean }>`select pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) as locked`.execute(trx);
  if (!r.rows[0]?.locked) abort("Hay otra importación de las tandas en curso (lock ocupado). No se aplica nada.");
}

function blockedMessage(reason: string | null): string {
  switch (reason) {
    case "DOC_TYPE_NOT_DNI": return "Tipo documental (LE/LC/CI) no soportado en esta carga: no se convierte en DNI por inferencia.";
    case "NAME_CONFLICT_WITH_EXISTING_PERSON": return "El nombre de la fuente contradice a la persona ya cargada con ese DNI: pendiente de revisión específica.";
    case "NAME_CONFLICT_BETWEEN_ROWS": return "Otra fila de esta carga trae otro nombre para el mismo DNI: pendiente de revisión.";
    case "DNI_CUIL_CONFLICT": return "El CUIL contradice al de la persona o a otra fila con el mismo DNI.";
    case "MATCHES_MERGED_PERSON": return "El DNI corresponde a una persona fusionada.";
    case "INVALID_CUIL": return "CUIL inválido (largo o dígito verificador) y sin DNI explícito.";
    case "INVALID_DNI": return "DNI con formato inválido.";
    case "PRECISION_LOSS": return "Valor numérico con pérdida de precisión: no se interpreta.";
    default: return "Fila sin identificador utilizable.";
  }
}
