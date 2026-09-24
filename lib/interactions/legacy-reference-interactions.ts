import { sql, type Kysely, type Transaction } from "kysely";
import { assertServerOnly } from "../server-only.js";
import type { Database } from "../db/schema.js";
import { trafficLightOf, type TrafficLight } from "../people/traffic.js";
import { validInteraction, interactionDay, interactionAgeDays } from "../people/traffic-sql.js";
import { assertMasterActor } from "../imports/gabriel/preflight.js";
import { BA_TIMEZONE } from "./participation-sync.js";

assertServerOnly("lib/interactions/legacy-reference-interactions.ts");

type Db = Kysely<Database> | Transaction<Database>;

/**
 * Reconciliación de INTERACCIONES faltantes de la carga histórica inicial (decisión de negocio SUTECBA 2026-09-23,
 * segunda etapa de legacy-reconciliation.ts / migración 0028): una participación 'participated' con
 * participation_basis='legacy_initial_import' que hoy NO generó interacción por falta de fecha real (campaña sin
 * `meeting_id`, o reunión con `schedule_precision='unknown'`) recibe igual una interacción, usando la fecha real si
 * existe o, si no, la fecha TÉCNICA de referencia 2026-01-01 (migración 0029, `date_basis='legacy_reference'`).
 *
 * Alcance EXCLUSIVO: participation_kind='participated' AND participation_basis='legacy_initial_import', verificado
 * por PROCEDENCIA real (import_row_id → import_rows → import_files → import_batch_files → import_batches aplicado),
 * nunca por un WHERE genérico — así nunca alcanza a una reunión futura creada normalmente en el CRM (que usa
 * participation_basis='standard' y nunca tiene esta cadena de procedencia hacia un batch histórico). Cubre los DOS
 * lotes históricos ya integrados (cualquier import_batches con status='applied', sin fijar un source_system): el
 * primero (gabriel-historical, vía legacy-reconciliation.ts) y el segundo (vía lib/imports/gabriel/nuevas.ts), que ya
 * escriben participation_basis='legacy_initial_import' directamente.
 *
 * NUNCA se inventa una jornada: una participación de campaña sigue sin `meeting_id`; la interacción sintética se
 * vincula a la persona y a la campaña (vía `source_key`), no a una reunión concreta.
 *
 * ¿Por qué no se busca automáticamente una fecha real en `import_rows.raw_data`? Se probó (dry-run de solo lectura
 * contra producción, 2026-09-24) un chequeo genérico por patrón de fecha en `raw_data` antes de aceptar el fallback
 * referencial. Resultado: `raw_data` se guarda como array posicional sin nombres de columna (`{"0":.., "1":..}` /
 * `{"c0":.., "c1":..}` según el origen) — un patrón de fecha aparece en casi TODAS las filas (nacimiento, timestamp
 * del formulario, etc.), sin relación con si hay o no una fecha real de la ACTIVIDAD sin usar. Habría marcado ~95%
 * de las candidatas reales como "ambiguas" sin motivo. La determinación autoritativa de "hay o no fecha real" ya la
 * hizo el importador (lib/imports/gabriel/sources.ts), con parsers específicos por formato de columna — es la razón
 * por la que estas filas llegaron sin `event_date`/`schedule_precision` real. Un regex genérico no puede mejorar esa
 * determinación, solo agregar ruido. Por eso NO se reintenta acá.
 */

export const LEGACY_REFERENCE_DATE = "2026-01-01";
/** Instante = 2026-01-01 00:00 Buenos Aires, resuelto correctamente en zona horaria (nunca una hora real). */
const LEGACY_REFERENCE_OCCURRED_AT = sql`('2026-01-01'::date::timestamp at time zone ${sql.lit(BA_TIMEZONE)})`;
// Regex idéntica a campaignKeyOfMeeting (lib/meetings/participants.ts): única fuente de la relación campaña↔reunión.
const CAMPAIGN_KEY_REGEX = "^ophthalmology:(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|sin-fecha):(.+)$";

interface CandidateRow {
  participation_id: string;
  meeting_id: string | null;
  campaign_key: string | null;
  person_id: string;
  person_organization_id: string | null;
  import_row_id: string | null;
  has_provenance: boolean;
  batch_source_system: string | null;
  meeting_name: string | null;
  meeting_type: string | null;
  meeting_owner_org: string | null;
  meeting_organizer: string | null;
  meeting_created_by: string | null;
  schedule_precision: "exact_datetime" | "date_only" | "unknown" | null;
  rep_meeting_id: string | null;
  rep_name: string | null;
  rep_type: string | null;
  rep_owner_org: string | null;
  rep_organizer: string | null;
  rep_created_by: string | null;
  already_has_interaction: boolean;
}

/**
 * Candidatas: 'participated'+'legacy_initial_import' sin interacción, sin fecha real usable HOY (ni por jornada
 * concreta ni por día conocido), con procedencia verificada (`has_provenance`). Las filas SIN procedencia verificable
 * (import_row_id nulo, o su import_row no traza a un batch aplicado) se traen igual, marcadas `has_provenance=false`
 * — quedan como caso AMBIGUO en el reporte, nunca se procesan.
 *
 * IMPORTANTE (hallazgo 2026-09-24, dry-run real contra producción): en producción hay DOS `import_batches` de
 * `gabriel-historical` con `status='applied' AND execution_mode='apply'` (una re-aplicación quedó registrada además
 * de la original), y los mismos `import_files` están vinculados a ambas vía `import_batch_files`. Un `JOIN` directo
 * contra esa cadena duplica cada candidata del primer lote (1712 en vez de 856 — exactamente ×2, confirmado). Por
 * eso la procedencia se resuelve con subconsultas escalares (`EXISTS` + un `source_system` representativo con
 * `LIMIT 1`), que dan como máximo UNA fila por candidata sin importar a cuántos batches aplicados esté vinculado el
 * mismo archivo. El resultado (1120 participaciones efectivas, 110 con interacción) es idéntico al conteo crudo sin
 * ningún join — ver `previewLegacyReferenceCandidates`/el script de preview, que lo verifica.
 */
async function findCandidates(db: Db): Promise<CandidateRow[]> {
  const result = await sql<CandidateRow>`
    with candidates as (
      select mp.id as participation_id, mp.meeting_id, mp.campaign_key, mp.person_id, mp.import_row_id,
             p.organization_id as person_organization_id,
             m.name as meeting_name, m.meeting_type as meeting_type, m.owner_organization_id as meeting_owner_org,
             m.organizer_user_id as meeting_organizer, m.created_by as meeting_created_by, m.schedule_precision
      from meeting_participations mp
      join people p on p.id = mp.person_id
      left join meetings m on m.id = mp.meeting_id
      where mp.participation_kind = 'participated' and mp.participation_basis = 'legacy_initial_import'
        and not (
          (m.schedule_precision = 'exact_datetime' and m.starts_at is not null)
          or (m.schedule_precision = 'date_only' and m.event_date is not null)
        )
        and not exists (
          select 1 from person_interactions pi where pi.source_key = 'meeting_participation:' || mp.id
        )
    ),
    -- Subconsultas escalares a propósito (no un JOIN): un import_row puede trazar a MÁS de un import_batches
    -- aplicado (ver nota arriba) y un JOIN normal multiplicaría la candidata una vez por cada batch encontrado.
    provenance as (
      select c.participation_id,
        exists (
          select 1
          from import_rows ir
          join import_files fi on fi.id = ir.file_id
          join import_batch_files ibf on ibf.file_id = fi.id
          join import_batches ib on ib.id = ibf.batch_id and ib.status = 'applied' and ib.execution_mode = 'apply'
          where ir.id = c.import_row_id
        ) as has_provenance,
        (
          select ib.source_system
          from import_rows ir
          join import_files fi on fi.id = ir.file_id
          join import_batch_files ibf on ibf.file_id = fi.id
          join import_batches ib on ib.id = ibf.batch_id and ib.status = 'applied' and ib.execution_mode = 'apply'
          where ir.id = c.import_row_id
          order by ib.created_at asc
          limit 1
        ) as batch_source_system
      from candidates c
    ),
    representative as (
      select c.participation_id,
        (select m2.id from meetings m2
         where c.meeting_id is null and c.campaign_key is not null
           and 'ophthalmology:' || (regexp_match(m2.source_event_key, ${CAMPAIGN_KEY_REGEX}))[1] = c.campaign_key
         order by m2.starts_at asc nulls last, m2.event_date asc nulls last, m2.id asc
         limit 1) as rep_meeting_id
      from candidates c
    )
    select
      c.participation_id, c.meeting_id, c.campaign_key, c.person_id, c.person_organization_id, c.import_row_id,
      coalesce(pv.has_provenance, false) as has_provenance, pv.batch_source_system,
      c.meeting_name, c.meeting_type, c.meeting_owner_org, c.meeting_organizer, c.meeting_created_by, c.schedule_precision,
      r.rep_meeting_id, rm.name as rep_name, rm.meeting_type as rep_type, rm.owner_organization_id as rep_owner_org,
      rm.organizer_user_id as rep_organizer, rm.created_by as rep_created_by,
      false as already_has_interaction
    from candidates c
    left join provenance pv on pv.participation_id = c.participation_id
    left join representative r on r.participation_id = c.participation_id
    left join meetings rm on rm.id = r.rep_meeting_id
  `.execute(db);
  return result.rows;
}

function subjectFor(row: CandidateRow): string | null {
  const type = row.meeting_id ? row.meeting_type : row.rep_type;
  const name = row.meeting_id ? row.meeting_name : row.rep_name;
  if (!name) return null; // Campaña sin ninguna reunión representativa: caso ambiguo, no se genera subject.
  const suffix = row.meeting_id ? "" : " — jornada no determinada";
  const label =
    type === "capacitacion" ? "Participó en capacitación: " : type === "operativo_salud" ? "Participó en operativo de salud: " : type === "jornada" ? "Participó en jornada: " : "Participó en: ";
  return `${label}${name}${suffix}`;
}

function ownerOrgFor(row: CandidateRow): string | null {
  return row.person_organization_id ?? (row.meeting_id ? row.meeting_owner_org : row.rep_owner_org);
}

export interface LegacyReferencePlanRow {
  participationId: string;
  personId: string;
  kind: "meeting_unknown_precision" | "campaign_without_meeting";
  hasProvenance: boolean;
  batchSourceSystem: string | null;
  canBuildSubject: boolean;
}

export interface LegacyReferencePlan {
  uniquePeople: number;
  totalCandidates: number;
  withMeetingUnknownPrecision: number;
  campaignWithoutMeeting: number;
  provenanceVerified: number;
  ambiguousNoProvenance: number;
  ambiguousNoRepresentativeMeeting: number;
  readyToCreate: number;
  activitiesAffected: number;
  campaignsAffected: number;
  trafficBefore: Record<TrafficLight, number>;
  trafficAfter: Record<TrafficLight, number>;
  peopleWithRealLastInteraction: number;
  peopleWithOnlyReferentialLastInteraction: number;
  rows: LegacyReferencePlanRow[];
}

async function trafficBucketsWithBasis(
  db: Db,
  personIds: readonly string[],
  extra: readonly { person_id: string }[]
): Promise<{ buckets: Record<TrafficLight, number>; realCount: number; referentialOnlyCount: number }> {
  const buckets: Record<TrafficLight, number> = { green: 0, yellow: 0, red: 0, gray: 0 };
  if (personIds.length === 0) return { buckets, realCount: 0, referentialOnlyCount: 0 };
  const extraIds = JSON.stringify(extra.map((r) => r.person_id));
  const rows = await sql<{ days: number | null; basis: "actual" | "legacy_reference" | null }>`
    with extra as (select value::uuid as person_id from jsonb_array_elements_text(${extraIds}::jsonb) as value)
    select
      ${interactionAgeDays(sql`last.d`)} as days,
      last.basis
    from people p
    left join lateral (
      select d, basis from (
        select ${interactionDay(sql`pi.occurred_at`)} d, pi.date_basis as basis
        from person_interactions pi where pi.person_id = p.id and ${validInteraction()}
        union all
        select ${LEGACY_REFERENCE_OCCURRED_AT}::date d, 'legacy_reference'::text as basis
        from extra e where e.person_id = p.id
      ) dates
      order by d desc limit 1
    ) last on true
    where p.id = any(${personIds}::uuid[])
  `.execute(db);
  let realCount = 0;
  let referentialOnlyCount = 0;
  for (const row of rows.rows) {
    buckets[trafficLightOf(row.days === null ? null : Number(row.days))] += 1;
    if (row.basis === "actual") realCount += 1;
    else if (row.basis === "legacy_reference") referentialOnlyCount += 1;
  }
  return { buckets, realCount, referentialOnlyCount };
}

/** TODAS las personas con alguna participación histórica ('participated'+'legacy_initial_import'), resuelta o no —
 * universo correcto para el semáforo antes/después y el split real/referencial (a diferencia de `findCandidates`,
 * que solo trae las TODAVÍA sin interacción). */
async function findAllHistoricalPeople(db: Db): Promise<string[]> {
  const result = await sql<{ person_id: string }>`
    select distinct person_id from meeting_participations
    where participation_kind = 'participated' and participation_basis = 'legacy_initial_import'
  `.execute(db);
  return result.rows.map((r) => r.person_id);
}

export interface CandidateSummary {
  uniquePeople: number;
  totalCandidates: number;
  withMeetingUnknownPrecision: number;
  campaignWithoutMeeting: number;
  provenanceVerified: number;
  ambiguousNoProvenance: number;
  ambiguousNoRepresentativeMeeting: number;
  readyToCreate: number;
  activitiesAffected: number;
  campaignsAffected: number;
  affectedPeopleIds: string[];
  rows: LegacyReferencePlanRow[];
}

/**
 * Resumen de candidatas SIN depender de `date_basis` (columna nueva, migración 0029): solo usa columnas que ya
 * existen hoy en producción (`meeting_participations`, `meetings`, `import_*`, y `person_interactions.source_key`,
 * que ya existe desde 0024). Por eso `previewLegacyReferenceCandidates` (más abajo) puede correr como dry-run REAL
 * contra producción hoy mismo, aunque 0029/0030 todavía no estén aplicadas ahí.
 */
function summarizeCandidates(candidates: CandidateRow[]): CandidateSummary {
  const planRows: LegacyReferencePlanRow[] = candidates.map((c) => ({
    participationId: c.participation_id,
    personId: c.person_id,
    kind: c.meeting_id ? "meeting_unknown_precision" : "campaign_without_meeting",
    hasProvenance: c.has_provenance,
    batchSourceSystem: c.batch_source_system,
    canBuildSubject: subjectFor(c) !== null,
  }));

  const withMeetingUnknownPrecision = candidates.filter((c) => c.meeting_id !== null).length;
  const campaignWithoutMeeting = candidates.filter((c) => c.meeting_id === null).length;
  const provenanceVerified = candidates.filter((c) => c.has_provenance).length;
  const ambiguousNoProvenance = candidates.filter((c) => !c.has_provenance).length;
  const ambiguousNoRepresentativeMeeting = candidates.filter((c) => c.has_provenance && subjectFor(c) === null).length;
  // Listo para crear: procedencia verificada y subject construible.
  const readyRows = candidates.filter((c) => c.has_provenance && subjectFor(c) !== null);

  const activitiesAffected = new Set(readyRows.filter((c) => c.meeting_id).map((c) => c.meeting_id)).size;
  const campaignsAffected = new Set(readyRows.filter((c) => !c.meeting_id).map((c) => c.campaign_key)).size;
  const uniquePeople = new Set(candidates.map((c) => c.person_id));
  const affectedPeople = new Set(readyRows.map((c) => c.person_id));

  return {
    uniquePeople: uniquePeople.size,
    totalCandidates: candidates.length,
    withMeetingUnknownPrecision,
    campaignWithoutMeeting,
    provenanceVerified,
    ambiguousNoProvenance,
    ambiguousNoRepresentativeMeeting,
    readyToCreate: readyRows.length,
    activitiesAffected,
    campaignsAffected,
    affectedPeopleIds: [...affectedPeople],
    rows: planRows,
  };
}

/**
 * Vista previa de solo lectura, compatible con el esquema de HOY en producción (sin 0029/0030). Sirve para el
 * dry-run real pedido antes de aplicar ninguna migración: mismos conteos de candidatas/procedencia/ambiguos que
 * `planLegacyReferenceInteractions`, sin el semáforo antes/después (que sí depende de `date_basis`).
 */
export async function previewLegacyReferenceCandidates(db: Db): Promise<CandidateSummary> {
  const candidates = await findCandidates(db);
  return summarizeCandidates(candidates);
}

export interface TrafficProjection {
  before: Record<TrafficLight, number>;
  after: Record<TrafficLight, number>;
}

/**
 * Semáforo antes/después, compatible con el esquema de HOY (sin `date_basis`): "antes" es el estado real actual de
 * TODA la población histórica; "después" simula agregar la interacción referencial (2026-01-01) a las personas
 * afectadas por esta corrida — mismo patrón que `trafficBuckets` en legacy-reconciliation.ts (ninguno de los dos
 * necesita `date_basis` para simular, porque la simulación es un UNION ALL en JS/SQL, no una columna real todavía).
 */
export async function previewTrafficProjection(db: Db, affectedPeopleIds: readonly string[]): Promise<TrafficProjection> {
  const allHistoricalPeople = await findAllHistoricalPeople(db);
  const buckets = async (extra: readonly string[]): Promise<Record<TrafficLight, number>> => {
    const out: Record<TrafficLight, number> = { green: 0, yellow: 0, red: 0, gray: 0 };
    if (allHistoricalPeople.length === 0) return out;
    const extraJson = JSON.stringify(extra.map((person_id) => ({ person_id, occurred_at: LEGACY_REFERENCE_DATE })));
    const rows = await sql<{ days: number | null }>`
      with extra as (select * from jsonb_to_recordset(${extraJson}::jsonb) as x(person_id uuid, occurred_at date))
      select ${interactionAgeDays(sql`last.d`)} as days from people p
      left join lateral (
        select max(d) d from (
          select ${interactionDay(sql`pi.occurred_at`)} d from person_interactions pi where pi.person_id = p.id and ${validInteraction()}
          union all
          select e.occurred_at d from extra e where e.person_id = p.id
        ) dates
      ) last on true
      where p.id = any(${allHistoricalPeople}::uuid[])
    `.execute(db);
    for (const row of rows.rows) out[trafficLightOf(row.days === null ? null : Number(row.days))] += 1;
    return out;
  };
  return { before: await buckets([]), after: await buckets(affectedPeopleIds) };
}

export async function planLegacyReferenceInteractions(db: Db): Promise<LegacyReferencePlan> {
  const candidates = await findCandidates(db);
  const summary = summarizeCandidates(candidates);

  // Semáforo y split real/referencial: sobre TODA la población histórica (ya resuelta o no), no solo las candidatas
  // pendientes de esta corrida — así "antes" refleja el estado real actual (incluye corridas previas ya aplicadas).
  const allHistoricalPeople = await findAllHistoricalPeople(db);
  const before = await trafficBucketsWithBasis(db, allHistoricalPeople, []);
  const after = await trafficBucketsWithBasis(
    db,
    allHistoricalPeople,
    summary.affectedPeopleIds.map((person_id) => ({ person_id }))
  );

  return {
    uniquePeople: summary.uniquePeople,
    totalCandidates: summary.totalCandidates,
    withMeetingUnknownPrecision: summary.withMeetingUnknownPrecision,
    campaignWithoutMeeting: summary.campaignWithoutMeeting,
    provenanceVerified: summary.provenanceVerified,
    ambiguousNoProvenance: summary.ambiguousNoProvenance,
    ambiguousNoRepresentativeMeeting: summary.ambiguousNoRepresentativeMeeting,
    readyToCreate: summary.readyToCreate,
    activitiesAffected: summary.activitiesAffected,
    campaignsAffected: summary.campaignsAffected,
    trafficBefore: before.buckets,
    trafficAfter: after.buckets,
    peopleWithRealLastInteraction: after.realCount,
    peopleWithOnlyReferentialLastInteraction: after.referentialOnlyCount,
    rows: summary.rows,
  };
}

export interface LegacyReferenceApplyResult extends LegacyReferencePlan {
  interactionsCreated: number;
}

export interface LegacyReferenceApplyOptions {
  actorUserId: string;
}

/**
 * Aplica: para cada candidata "lista" (procedencia verificada, subject construible, sin patrón de fecha sin revisar),
 * inserta UNA interacción con date_basis='legacy_reference'. Idempotente (`source_key` UNIQUE, ON CONFLICT DO
 * NOTHING). Transaccional, con advisory lock (mismo patrón que legacy-reconciliation.ts) y `assertMasterActor`.
 */
export async function applyLegacyReferenceInteractions(db: Kysely<Database>, options: LegacyReferenceApplyOptions): Promise<LegacyReferenceApplyResult> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext('sutecba:maintenance:legacy-reference-interactions'))`.execute(trx);
    await assertMasterActor(trx, options.actorUserId);

    const typeRow = await sql<{ id: string }>`select id from interaction_types where key = 'participation'`.execute(trx);
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error("Falta el tipo de interacción «participation» (migración 0024).");

    const candidates = await findCandidates(trx);
    const ready = candidates.filter((c) => c.has_provenance && subjectFor(c) !== null);

    let created = 0;
    for (const row of ready) {
      const ownerOrg = ownerOrgFor(row);
      const createdBy = row.meeting_id
        ? (row.meeting_organizer ?? row.meeting_created_by ?? options.actorUserId)
        : (row.rep_organizer ?? row.rep_created_by ?? options.actorUserId);
      const subject = subjectFor(row);
      if (!ownerOrg || !subject) continue; // defensivo: ya filtrado arriba, nunca debería pasar.

      // Kysely's onConflict() infiere el índice por columnas exactas; el UNIQUE real es PARCIAL (WHERE source_key IS
      // NOT NULL, migración 0024), así que el arbiter debe declarar el mismo predicado — igual que
      // participation-sync.ts, se usa SQL crudo con el WHERE explícito en el ON CONFLICT.
      const insertedRows = await sql<{ id: string }>`
        insert into person_interactions
          (person_id, owner_organization_id, occurred_at, occurred_precision, date_basis, interaction_type_id, subject, status, meeting_id, created_by, source_key)
        values (${row.person_id}::uuid, ${ownerOrg}::uuid, ${LEGACY_REFERENCE_OCCURRED_AT}, 'date_only', 'legacy_reference', ${typeId}::uuid, ${subject}, 'completed', ${row.meeting_id}::uuid, ${createdBy}::uuid, ${`meeting_participation:${row.participation_id}`})
        on conflict (source_key) where source_key is not null do nothing
        returning id
      `.execute(trx);
      if (insertedRows.rows.length > 0) created += 1;
    }

    const after = await planLegacyReferenceInteractions(trx);
    return { ...after, interactionsCreated: created };
  });
}
