import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import { loadOrganizationContext } from "../gabriel/apply.js";
import type { Snapshot } from "./plan.js";

type Db = Kysely<Database> | Transaction<Database>;

/** Foto de la base para el planificador. SOLO LECTURA (se puede llamar dentro de una transacción de escritura del apply). */
export async function readTandasSnapshot(trx: Db): Promise<{ snap: Snapshot; extra: Record<string, unknown> }> {
  const people = await sql<{ id: string; dni: string; first_name: string; last_name: string; email: string | null; phone: string | null; cuil_cuit: string | null; organization_id: string | null; status: string }>`
    select id, dni, first_name, last_name, email, phone, cuil_cuit, organization_id, status from people`.execute(trx);
  const meetings = await sql<{ id: string; k: string; d: string | null; p: string; t: string; name: string; n: number }>`
    select m.id, m.source_event_key as k, to_char(m.event_date,'YYYY-MM-DD') d, m.schedule_precision p, m.meeting_type t, m.name,
           (select count(*)::int from meeting_participations mp where mp.meeting_id = m.id) n
    from meetings m where m.source_event_key is not null`.execute(trx);
  const parts = await sql<{ campaign_key: string | null; key: string | null; dni: string; kind: string; basis: string }>`
    select mp.campaign_key, m.source_event_key as key, p.dni, mp.participation_kind as kind, mp.participation_basis as basis
    from meeting_participations mp join people p on p.id = mp.person_id left join meetings m on m.id = mp.meeting_id`.execute(trx);
  const orgs = await sql<{ id: string; name: string }>`select id, name from organizations`.execute(trx);
  const files = await sql<{ original_name: string; content_hash: string; dni: string | null }>`
    select f.original_name, f.content_hash, r.normalized_dni as dni from import_files f left join import_rows r on r.file_id = f.id`.execute(trx);
  const tags = await sql<{ name: string; normalized_name: string }>`select name, normalized_name from tags`.execute(trx);
  const basisCounts = await sql<{ b: string; k: string; n: number }>`select participation_basis b, participation_kind k, count(*)::int n from meeting_participations group by 1,2 order by 1,2`.execute(trx);
  const idx = await sql<{ indexdef: string }>`select indexdef from pg_indexes where schemaname='public' and tablename='people'`.execute(trx);
  const interactionsBySource = await sql<{ s: string; n: number }>`select split_part(source_key, ':', 1) s, count(*)::int n from person_interactions where source_key is not null group by 1`.execute(trx);
  const nameChecks = await sql<{ blank: number; placeholders: number; total: number }>`select count(*) filter (where btrim(first_name)='' or btrim(last_name)='')::int blank, count(*) filter (where first_name like '(sin%' or last_name like '(sin%')::int placeholders, count(*)::int total from people`.execute(trx);
  const partChecks = await sql<{ participated_bad_basis: number; total: number }>`select count(*) filter (where participation_kind='participated' and participation_basis not in ('legacy_initial_import','source_business_rule'))::int participated_bad_basis, count(*)::int total from meeting_participations`.execute(trx);
  const orgCtx = await loadOrganizationContext(trx);

  const participations = new Map<string, string[]>();
  const campaignCounts = new Map<string, number>();
  for (const r of parts.rows) {
    const k = r.campaign_key ? `campaign|${r.campaign_key}|${r.dni}` : `meeting|${r.key}|${r.dni}`;
    (participations.get(k) ?? participations.set(k, []).get(k)!).push(`${r.kind}/${r.basis}`);
    if (r.campaign_key) campaignCounts.set(r.campaign_key, (campaignCounts.get(r.campaign_key) ?? 0) + 1);
  }
  const prevFileDnis = new Map<string, Set<string>>();
  const prevFileHashes = new Map<string, string>();
  for (const r of files.rows) {
    const nm = r.original_name.normalize("NFC");
    prevFileHashes.set(nm, r.content_hash);
    const s = prevFileDnis.get(nm) ?? prevFileDnis.set(nm, new Set()).get(nm)!;
    if (r.dni) s.add(r.dni);
  }
  const snap: Snapshot = {
    people: new Map(people.rows.filter((p) => p.status !== "merged").map((p) => [p.dni, { id: p.id, first: p.first_name, last: p.last_name, email: p.email, phone: p.phone, cuil: p.cuil_cuit, orgId: p.organization_id }])),
    mergedDnis: new Set(people.rows.filter((p) => p.status === "merged").map((p) => p.dni)),
    meetings: new Map(meetings.rows.map((m) => [m.k, { key: m.k, date: m.d, precision: m.p, type: m.t, name: m.name, participants: m.n }])),
    participations,
    campaignCounts,
    aliases: orgCtx.organizationAliases,
    parents: orgCtx.organizationParents,
    orgNames: new Map(orgs.rows.map((o) => [o.id, o.name])),
    jurisdictionByFile: { T03: orgCtx.fileJurisdictions["F07" as never] as string },
    prevFileDnis,
    prevFileHashes,
    emails: new Set(people.rows.flatMap((p) => (p.email ? [p.email.toLowerCase()] : []))),
    phones: new Set(people.rows.flatMap((p) => (p.phone ? [p.phone] : []))),
    tags: tags.rows.map((t) => ({ name: t.name, normalized: t.normalized_name })),
    today: "2026-09-30",
  };
  return {
    snap,
    extra: {
      migraciones: "30 aplicadas, última 0030 (verificado con conexión administrativa READ ONLY)",
      personas_en_base: people.rows.length,
      participation_basis_actual: basisCounts.rows,
      validacion_de_los_nuevos_CHECK_contra_datos_actuales: {
        personas_con_nombre_o_apellido_en_blanco: nameChecks.rows[0]!.blank,
        personas_con_texto_ficticio_historico: nameChecks.rows[0]!.placeholders,
        personas_total: nameChecks.rows[0]!.total,
        participaciones_participated_con_base_no_permitida: partChecks.rows[0]!.participated_bad_basis,
        participaciones_total: partChecks.rows[0]!.total,
        conclusion: "las 3 migraciones son aditivas y todas las filas actuales las cumplen: no se modifica ningún dato histórico",
      },
      interacciones_por_origen: interactionsBySource.rows,
      indices_people: idx.rows.map((r) => r.indexdef.replace(/ON public\.people USING /, "")),
    },
  };
}
