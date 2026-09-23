import { sql, type Kysely, type Transaction } from "kysely";
import { assertServerOnly } from "../server-only.js";
import type { Database } from "../db/schema.js";
import { trafficLightOf, type TrafficLight } from "../people/traffic.js";
import { syncParticipationInteractions, PARTICIPATION_OCCURRED_AT } from "./participation-sync.js";
import { validInteraction, interactionDay, interactionAgeDays } from "../people/traffic-sql.js";
import { assertMasterActor } from "../imports/gabriel/preflight.js";

assertServerOnly("lib/interactions/legacy-reconciliation.ts");

type Db = Kysely<Database> | Transaction<Database>;

/**
 * Reconciliación de las participaciones de la CARGA HISTÓRICA INICIAL: decisión de negocio EXCLUSIVA de esas fuentes
 * (ver migración 0028 y lib/interactions/participation-sync.ts) — "estar incluido en la actividad = participó", NO
 * una regla general del CRM. Para cada participación 'registration' que pertenece al lote indicado (identificada por
 * procedencia real: import_batches → import_batch_files → import_files → import_rows → import_entity_links, NUNCA
 * por un WHERE status='registration' ciego), agrega una fila NUEVA participation_kind='participated' con
 * participation_basis='legacy_initial_import' — la fila 'registration' original queda intacta como evidencia de
 * fuente (raw_data, import_rows, import_entity_links no se tocan). Sin jornada probada, la persona figura igual como
 * "Participó" pero SIN fecha ni interacción (nunca se inventa una jornada ni una fecha).
 */

export const DEFAULT_LEGACY_SOURCE_SYSTEM = "gabriel-historical";

export interface LegacyReconciliationOptions {
  sourceSystem?: string;
  actorUserId: string;
}

interface LegacyRow {
  occurred_at: Date | string | null;
  participation_id: string;
  meeting_id: string | null;
  campaign_key: string | null;
  person_id: string;
  import_row_id: string | null;
  schedule_precision: "exact_datetime" | "date_only" | "unknown" | null;
  has_date: boolean;
  occurred_date: string | null; // YYYY-MM-DD (fecha BA) cuando has_date; null si no
  owner_organization_id: string | null;
  organizer_user_id: string | null;
  meeting_created_by: string | null;
  person_organization_id: string | null;
  already_reconciled: boolean; // ya existe una fila 'participated' para este (destino, persona)
  reconciled_participation_id: string | null;
}

/** Filas 'registration' de UN lote de importación (por procedencia real, nunca por status a ciegas), con lo necesario para reconciliar. */
async function findLegacyRows(db: Db, sourceSystem: string): Promise<LegacyRow[]> {
  if (sourceSystem !== DEFAULT_LEGACY_SOURCE_SYSTEM) throw new Error("Solo se reconcilia la carga histórica inicial gabriel-historical");
  const result = await sql<LegacyRow>`
    with legacy as (
      select distinct mp.id as participation_id, mp.meeting_id, mp.campaign_key, mp.person_id, mp.import_row_id
      from import_batches ib
      join import_batch_files ibf on ibf.batch_id = ib.id
      join import_files fi on fi.id = ibf.file_id
      join import_rows ir on ir.file_id = fi.id
      join import_entity_links iel on iel.import_row_id = ir.id and iel.entity_type = 'meeting_participation'
      join meeting_participations mp on mp.id = iel.entity_id
      where ib.source_system = ${sourceSystem} and ib.status = 'applied' and ib.execution_mode = 'apply'
        and mp.participation_kind = 'registration'
    ),
    existing as (
      select meeting_id, campaign_key, person_id, id from meeting_participations
      where participation_kind = 'participated' and participation_basis = 'legacy_initial_import'
    )
    select
      l.participation_id, l.meeting_id, l.campaign_key, l.person_id, l.import_row_id,
      m.schedule_precision,
      ${PARTICIPATION_OCCURRED_AT} as occurred_at,
      coalesce(
        (m.schedule_precision = 'exact_datetime' and m.starts_at is not null)
        or (m.schedule_precision = 'date_only' and m.event_date is not null),
        false
      ) as has_date,
      case
        when m.schedule_precision = 'exact_datetime' and m.starts_at is not null
          then to_char(m.starts_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD')
        when m.schedule_precision = 'date_only' and m.event_date is not null
          then to_char(m.event_date, 'YYYY-MM-DD')
        else null
      end as occurred_date,
      m.owner_organization_id, m.organizer_user_id, m.created_by as meeting_created_by,
      p.organization_id as person_organization_id,
      (e.id is not null) as already_reconciled,
      e.id as reconciled_participation_id
    from legacy l
    join people p on p.id = l.person_id
    left join meetings m on m.id = l.meeting_id
    left join existing e
      on e.person_id = l.person_id
      and ((l.meeting_id is not null and e.meeting_id = l.meeting_id) or (l.meeting_id is null and e.campaign_key = l.campaign_key))
  `.execute(db);
  return result.rows;
}

export interface LegacyReconciliationPlan {
  sourceSystem: string;
  totalLegacyParticipations: number;
  uniquePeople: number;
  activitiesAffected: number;
  withMeeting: number;
  withoutMeeting: number;
  withUsableDate: number;
  withoutUsableDate: number;
  alreadyReconciled: number;
  pendingReconciliation: number;
  interactionsToCreate: number;
  interactionsAlreadyExist: number;
  trafficBefore: Record<TrafficLight, number>;
  trafficAfter: Record<TrafficLight, number>;
}

async function trafficBuckets(db: Db, personIds: readonly string[], extraDates: readonly { person_id: string; occurred_at: string }[]): Promise<Record<TrafficLight, number>> {
  const buckets: Record<TrafficLight, number> = { green: 0, yellow: 0, red: 0, gray: 0 };
  if (personIds.length === 0) return buckets;
  const extras = JSON.stringify(extraDates.map((r) => ({ ...r, status: "completed" })));
  const current = await sql<{ days: number | null }>`
    with extra as (select * from jsonb_to_recordset(${extras}::jsonb) as x(person_id uuid, occurred_at timestamptz, status text))
    select ${interactionAgeDays(sql`last.d`)} as days from people p
    left join lateral (
      select max(d) d from (
        select ${interactionDay(sql`pi.occurred_at`)} d from person_interactions pi where pi.person_id=p.id and ${validInteraction()}
        union all
        select ${interactionDay(sql`e.occurred_at`)} d from extra e where e.person_id=p.id and ${validInteraction("e")}
      ) dates
    ) last on true where p.id = any(${personIds}::uuid[])
  `.execute(db);
  for (const row of current.rows) {
    buckets[trafficLightOf(row.days === null ? null : Number(row.days))] += 1;
  }
  return buckets;
}

export async function planLegacyReconciliation(db: Db, options: { sourceSystem?: string }): Promise<LegacyReconciliationPlan> {
  const sourceSystem = options.sourceSystem ?? DEFAULT_LEGACY_SOURCE_SYSTEM;
  const rows = await findLegacyRows(db, sourceSystem);

  const uniquePeople = new Set(rows.map((r) => r.person_id));
  const activities = new Set(rows.map((r) => r.meeting_id ?? `campaign:${r.campaign_key}`));
  const withMeeting = rows.filter((r) => r.meeting_id !== null);
  const withoutMeeting = rows.filter((r) => r.meeting_id === null);
  const withUsableDate = rows.filter((r) => r.has_date);
  const withoutUsableDate = rows.filter((r) => r.meeting_id !== null && !r.has_date);
  const pending = rows.filter((r) => !r.already_reconciled);
  const already = rows.filter((r) => r.already_reconciled);

  // Interacciones ya existentes (de un apply anterior parcial): buscamos por source_key de la fila 'participated' ya creada.
  const alreadyIds = already.map((r) => r.reconciled_participation_id!).filter(Boolean);
  let interactionsAlreadyExist = 0;
  const existingSources = new Set<string>();
  if (alreadyIds.length > 0) {
    const found = await sql<{ source_key: string }>`
      select source_key from person_interactions where source_key = any(${alreadyIds.map((id) => `meeting_participation:${id}`)}::text[])
    `.execute(db);
    for (const r of found.rows) existingSources.add(r.source_key);
    interactionsAlreadyExist = existingSources.size;
  }

  const createsInteraction = (r: LegacyRow) => r.has_date && !existingSources.has(`meeting_participation:${r.reconciled_participation_id}`);
  const interactionsToCreate = rows.filter(createsInteraction).length;

  // Semáforo antes/después: "después" simula la reconciliación COMPLETA (pendientes + ya reconciliadas) aplicada.
  const extraDates: { person_id: string; occurred_at: string }[] = [];
  for (const r of rows) {
    if (!createsInteraction(r) || !r.occurred_at) continue;
    const instant = new Date(r.occurred_at).toISOString();
    extraDates.push({ person_id: r.person_id, occurred_at: instant });
  }
  const peopleIds = [...uniquePeople];
  const trafficBefore = await trafficBuckets(db, peopleIds, []);
  const trafficAfter = await trafficBuckets(db, peopleIds, extraDates);

  return {
    sourceSystem,
    totalLegacyParticipations: rows.length,
    uniquePeople: uniquePeople.size,
    activitiesAffected: activities.size,
    withMeeting: withMeeting.length,
    withoutMeeting: withoutMeeting.length,
    withUsableDate: withUsableDate.length,
    withoutUsableDate: withoutUsableDate.length,
    alreadyReconciled: already.length,
    pendingReconciliation: pending.length,
    interactionsToCreate,
    interactionsAlreadyExist,
    trafficBefore,
    trafficAfter,
  };
}

export interface LegacyReconciliationApplyResult extends LegacyReconciliationPlan {
  participationsCreated: number;
  interactionsCreated: number;
}

export async function applyLegacyReconciliation(db: Kysely<Database>, options: LegacyReconciliationOptions): Promise<LegacyReconciliationApplyResult> {
  const sourceSystem = options.sourceSystem ?? DEFAULT_LEGACY_SOURCE_SYSTEM;

  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext('sutecba:maintenance:legacy-reconcile-participations:' || ${sourceSystem}))`.execute(trx);
    await assertMasterActor(trx, options.actorUserId);

    const before = await planLegacyReconciliation(trx, { sourceSystem });
    const rows = await findLegacyRows(trx, sourceSystem);
    const pending = rows.filter((r) => !r.already_reconciled);

    let participationsCreated = 0;
    for (const r of pending) {
      const inserted = await trx
        .insertInto("meeting_participations")
        .values({
          meeting_id: r.meeting_id,
          campaign_key: r.campaign_key,
          person_id: r.person_id,
          participation_kind: "participated",
          participation_basis: "legacy_initial_import",
          evidence: null,
          import_row_id: r.import_row_id,
        })
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst();
      if (inserted) participationsCreated += 1;
    }

    const reconciled = await findLegacyRows(trx, sourceSystem);
    const sync = await syncParticipationInteractions(trx, { actorUserId: options.actorUserId, participationIds: reconciled.flatMap((r) => r.reconciled_participation_id ? [r.reconciled_participation_id] : []) });

    const after = await planLegacyReconciliation(trx, { sourceSystem });
    return { ...after, participationsCreated, interactionsCreated: sync.created };
  });
}
