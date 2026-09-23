import { sql } from "kysely";
import type { SessionUser } from "../permissions/can.js";
import { orgScope } from "../scope/organizations.js";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/meetings/audience.ts");

/**
 * Especificación tipada de audiencia (sección 11 del prompt): personas
 * individuales, asociaciones, organismos (que se expanden a sus
 * dependencias) — combinados con OR, como un asistente que va sumando
 * fuentes. El mismo resolvedor se usa para el conteo previo y para crear
 * las invitaciones (sección 6.2: "el número que se muestra es el que se
 * inserta").
 */
export interface MeetingAudienceSpec {
  personIds?: string[];
  associationIds?: string[];
  organizationIds?: string[];
}

export function isEmptyAudienceSpec(spec: MeetingAudienceSpec): boolean {
  return !spec.personIds?.length && !spec.associationIds?.length && !spec.organizationIds?.length;
}

/** Un organismo seleccionado incluye a todas sus dependencias (jerarquía real, no solo el nodo elegido). */
async function expandOrganizationIds(organizationIds: string[]): Promise<string[]> {
  if (organizationIds.length === 0) return [];
  const db = await getDb();
  const result = await sql<{ id: string }>`
    with recursive descendants as (
      select id from organizations where id in (${sql.join(organizationIds)})
      union all
      select o.id from organizations o
      inner join descendants d on o.parent_id = d.id
    )
    select id from descendants
  `.execute(db);
  return result.rows.map((r) => r.id);
}

/** La audiencia se arma solo con personas dentro del alcance de quien invita. */
async function resolveAudienceQuery(actor: SessionUser, spec: MeetingAudienceSpec) {
  const db = await getDb();
  const expandedOrgIds = await expandOrganizationIds(spec.organizationIds ?? []);

  let query = db
    .selectFrom("people")
    .where("people.status", "=", "active")
    .where(orgScope(actor, "people.organization_id"));

  const branches: Array<(eb: Parameters<typeof query.where>[0] extends infer _ ? any : never) => any> = [];
  if (spec.personIds && spec.personIds.length > 0) {
    const ids = spec.personIds;
    branches.push((eb: any) => eb("people.id", "in", ids));
  }
  if (expandedOrgIds.length > 0) {
    branches.push((eb: any) => eb("people.organization_id", "in", expandedOrgIds));
  }
  if (spec.associationIds && spec.associationIds.length > 0) {
    const ids = spec.associationIds;
    branches.push((eb: any) =>
      eb.exists(
        eb
          .selectFrom("people_associations")
          .select("people_associations.id")
          .whereRef("people_associations.person_id", "=", "people.id")
          .where("people_associations.association_id", "in", ids)
          .where("people_associations.status", "=", "active")
      )
    );
  }

  if (branches.length === 0) {
    // Ninguna fuente elegida: no hay audiencia. `false` explícito, no "todas".
    return query.where(sql<boolean>`false`);
  }

  query = query.where((eb) => eb.or(branches.map((b) => b(eb))));
  return query;
}

export async function countAudience(actor: SessionUser, spec: MeetingAudienceSpec): Promise<number> {
  if (isEmptyAudienceSpec(spec)) return 0;
  const query = await resolveAudienceQuery(actor, spec);
  const row = await query.select(({ fn }) => fn.count<number>("people.id").as("count")).executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function resolveAudienceIds(actor: SessionUser, spec: MeetingAudienceSpec): Promise<string[]> {
  if (isEmptyAudienceSpec(spec)) return [];
  const query = await resolveAudienceQuery(actor, spec);
  const rows = await query.select("people.id").execute();
  return rows.map((r) => r.id);
}
