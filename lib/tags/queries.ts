import { sql, type RawBuilder } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { can, type SessionUser } from "../permissions/can.js";
import { canAccessPerson, orgScope } from "../scope/organizations.js";

assertServerOnly("lib/tags/queries.ts");

/**
 * Visibilidad de etiquetas (migración 0016), aplicada del lado del servidor en
 * TODA superficie: listados, filtros de personas, exports y estadísticas.
 *
 *  - Necesita `tags.view`.
 *  - Etiqueta global (`owner_organization_id IS NULL`): visible según permisos.
 *  - Etiqueta local: solo dentro del alcance de su unidad.
 *  - Etiqueta sensible: además exige `people.view_sensitive` (una etiqueta
 *    puede revelar afiliación u opinión política; dato sensible, Ley 25.326).
 *  - Etiquetas inactivas no se ofrecen.
 *
 * `alias` es siempre un literal del código (nunca texto del usuario).
 */
export function tagVisibility(actor: SessionUser, alias = "t"): RawBuilder<boolean> {
  if (!can(actor, "tags.view")) return sql<boolean>`false`;

  const inScope = orgScope(actor, `${alias}.owner_organization_id`, { includeNull: true });
  const sensitiveOk = can(actor, "people.view_sensitive")
    ? sql<boolean>`true`
    : sql<boolean>`${sql.ref(`${alias}.is_sensitive`)} = false`;

  return sql<boolean>`(${inScope} and ${sensitiveOk} and ${sql.ref(`${alias}.active`)} = true)`;
}

/**
 * Condición para filtrar `people` por etiquetas: la persona tiene alguna de las
 * etiquetas indicadas, contando SOLO las que el usuario puede ver. Un id de una
 * etiqueta no visible simplemente no matchea (no revela que existe).
 */
export function visibleTagIdsCondition(actor: SessionUser, tagIds: string[]): RawBuilder<boolean> {
  return sql<boolean>`exists (
    select 1
    from person_tags pt
    join tags t on t.id = pt.tag_id
    where pt.person_id = people.id
      and pt.removed_at is null
      and t.id in (${sql.join(tagIds.map((id) => sql`${id}::uuid`))})
      and ${tagVisibility(actor)}
  )`;
}

export interface TagItem {
  id: string;
  name: string;
  category: string | null;
  isControlled: boolean;
  isSensitive: boolean;
  ownerOrganizationId: string | null;
}

/** Etiquetas que el usuario puede ver (catálogo). */
export async function listVisibleTags(actor: SessionUser): Promise<TagItem[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("tags as t")
    .select(["t.id", "t.name", "t.category", "t.is_controlled", "t.is_sensitive", "t.owner_organization_id"])
    .where(tagVisibility(actor))
    .orderBy("t.name", "asc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    isControlled: r.is_controlled,
    isSensitive: r.is_sensitive,
    ownerOrganizationId: r.owner_organization_id,
  }));
}

/** Etiquetas vigentes de una persona, solo si la persona está en el alcance y solo las visibles para el usuario. */
export async function listPersonTags(actor: SessionUser, personId: string): Promise<TagItem[]> {
  if (!(await canAccessPerson(actor, personId))) return [];

  const db = await getDb();
  const rows = await db
    .selectFrom("person_tags as pt")
    .innerJoin("tags as t", "t.id", "pt.tag_id")
    .select(["t.id", "t.name", "t.category", "t.is_controlled", "t.is_sensitive", "t.owner_organization_id"])
    .where("pt.person_id", "=", personId)
    .where("pt.removed_at", "is", null)
    .where(tagVisibility(actor))
    .orderBy("t.name", "asc")
    .execute();

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    isControlled: r.is_controlled,
    isSensitive: r.is_sensitive,
    ownerOrganizationId: r.owner_organization_id,
  }));
}

/**
 * Nombres de las etiquetas vigentes y VISIBLES para el usuario de un conjunto de personas (los ids de una página ya
 * acotada por alcance). Una sola consulta; devuelve un mapa personId → nombres ordenados.
 */
export async function listTagNamesForPeople(actor: SessionUser, personIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (personIds.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .selectFrom("person_tags as pt")
    .innerJoin("tags as t", "t.id", "pt.tag_id")
    .select(["pt.person_id as person_id", "t.name as name"])
    .where("pt.person_id", "in", personIds)
    .where("pt.removed_at", "is", null)
    .where(tagVisibility(actor))
    .orderBy("t.name", "asc")
    .execute();
  for (const r of rows) (out.get(r.person_id) ?? out.set(r.person_id, []).get(r.person_id)!).push(r.name);
  return out;
}

/** Estadística: personas (dentro del alcance) por etiqueta visible. */
export async function countPeopleByVisibleTag(actor: SessionUser): Promise<Array<{ tagId: string; name: string; count: number }>> {
  const db = await getDb();
  const rows = await db
    .selectFrom("person_tags as pt")
    .innerJoin("tags as t", "t.id", "pt.tag_id")
    .innerJoin("people", "people.id", "pt.person_id")
    .select(["t.id as tag_id", "t.name", ({ fn }) => fn.count<number>("pt.id").as("count")])
    .where("pt.removed_at", "is", null)
    .where(tagVisibility(actor))
    .where(orgScope(actor, "people.organization_id"))
    .groupBy(["t.id", "t.name"])
    .orderBy("t.name", "asc")
    .execute();

  return rows.map((r) => ({ tagId: r.tag_id, name: r.name, count: Number(r.count) }));
}
