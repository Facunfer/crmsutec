import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { hasGlobalScope } from "../scope/organizations.js";
import { loadOrgDisplayNames } from "./display.js";
import type { SessionUser } from "../permissions/can.js";

assertServerOnly("lib/organizations/areas.ts");

/**
 * ÁREA y REPARTICIÓN.
 *
 * Modelo (sin duplicar la estructura): `people.organization_id` apunta siempre a la unidad oficial MÁS ESPECÍFICA
 * conocida. Desde ahí se derivan:
 *   - Repartición = esa unidad (`people.organization_id`);
 *   - Área        = su ANCESTRO RAÍZ (la unidad sin padre a la que se llega recorriendo `parent_id`): el ministerio, la
 *                   Procuración, la Jefatura de Gabinete, la secretaría raíz, el ente principal o equivalente.
 * Si la unidad guardada ES la raíz (solo se conoce el Área), la repartición específica es «ninguna».
 *
 * SUTECBA es una raíz independiente que solo es propietaria de actividades: nunca es Área ni Repartición laboral.
 * La función SQL `organization_area_id(uuid)` (migración 0024) es la única definición de «Área».
 */

/** Tipo de la organización propietaria de las actividades históricas (sindicato): no se ofrece como área laboral. */
export const OWNER_TYPE_KEY = "sindicato";

export const OWNER_AS_WORK_UNIT_MESSAGE = "SUTECBA es la organización propietaria de las actividades: no puede ser el Área ni la Repartición laboral de una persona.";

export interface OrgTreeOption {
  id: string;
  name: string;
  officialCode: string | null;
  areaId: string;
  /** 0 = el Área misma. */
  depth: number;
  /** Camino desde el Área (sin incluirla): «Secretaría › Dirección General». Vacío para el Área misma. */
  path: string;
}

/**
 * Todas las unidades activas que el usuario puede usar (su alcance, con dependientes; MASTER_GLOBAL: todas), con su
 * Área y su camino. Sin SUTECBA. Un solo recorrido recursivo, ordenado por área y por camino.
 */
export async function listOrgTreeOptions(actor: Pick<SessionUser, "id" | "roleKey">): Promise<OrgTreeOption[]> {
  const db = await getDb();
  const global = hasGlobalScope(actor as SessionUser);
  const result = await sql<{ id: string; name: string; official_code: string | null; area_id: string; depth: number; path: string }>`
    with recursive tree as (
      select o.id, o.name, o.official_code, o.id as area_id, 0 as depth, ''::text as path
      from organizations o
      join organization_types t on t.id = o.type_id
      where o.parent_id is null and o.active and t.key <> ${OWNER_TYPE_KEY}
      union all
      select c.id, c.name, c.official_code, tree.area_id, tree.depth + 1,
             case when tree.depth = 0 then c.name else tree.path || ' › ' || c.name end
      from organizations c
      join tree on c.parent_id = tree.id
      where c.active and tree.depth < 32
    )
    select tree.id, tree.name, tree.official_code, tree.area_id, tree.depth, tree.path
    from tree
    ${global ? sql`` : sql`where tree.id in (select organization_id from user_accessible_organizations(${actor.id}::uuid))`}
    order by (select a.name from organizations a where a.id = tree.area_id), tree.path, tree.name
  `.execute(db);
  // Presentación: «Nombre (CÓDIGO)» solo cuando el nombre no es único. `path` termina en ese texto.
  const names = await loadOrgDisplayNames(db);
  return result.rows.map((r) => {
    const label = names.get(r.id) ?? r.name;
    const segments = r.path ? r.path.split(" › ") : [];
    if (segments.length > 0) segments[segments.length - 1] = label;
    return { id: r.id, name: label, officialCode: r.official_code, areaId: r.area_id, depth: Number(r.depth), path: segments.join(" › ") };
  });
}

export interface AreaOption {
  id: string;
  name: string;
  officialCode: string | null;
  /** ¿Puede el usuario asignar solo el Área (sin repartición específica)? Solo si el Área misma está en su alcance. */
  selectable: boolean;
}

/** Áreas con al menos una unidad usable. Un usuario con alcance solo sobre una repartición ve su Área, pero no puede elegir el Área sola. */
export async function listAreaOptions(actor: Pick<SessionUser, "id" | "roleKey">, tree?: OrgTreeOption[]): Promise<AreaOption[]> {
  const options = tree ?? (await listOrgTreeOptions(actor));
  const db = await getDb();
  const areaIds = [...new Set(options.map((o) => o.areaId))];
  if (areaIds.length === 0) return [];
  const rows = await db.selectFrom("organizations").select(["id", "name", "official_code"]).where("id", "in", areaIds).orderBy("name").execute();
  const names = await loadOrgDisplayNames(db);
  const selectable = new Set(options.filter((o) => o.depth === 0).map((o) => o.id));
  return rows.map((r) => ({ id: r.id, name: names.get(r.id) ?? r.name, officialCode: r.official_code, selectable: selectable.has(r.id) }));
}

export interface AreaAndReparticion {
  area: { id: string; name: string } | null;
  /** null cuando solo se conoce el Área. */
  reparticion: { id: string; name: string; path: string } | null;
}

/** Área y Repartición de una unidad (para mostrar). `null` = sin unidad. */
export async function describeOrganization(organizationId: string | null): Promise<AreaAndReparticion> {
  if (!organizationId) return { area: null, reparticion: null };
  const db = await getDb();
  const r = await sql<{ area_id: string | null; area_name: string | null; name: string; parent_id: string | null }>`
    select public.organization_area_id(o.id) as area_id,
           (select a.name from organizations a where a.id = public.organization_area_id(o.id)) as area_name,
           o.name, o.parent_id
    from organizations o where o.id = ${organizationId}::uuid
  `.execute(db);
  const row = r.rows[0];
  if (!row || !row.area_id) return { area: null, reparticion: null };
  const names = await loadOrgDisplayNames(db);
  return {
    area: { id: row.area_id, name: names.get(row.area_id) ?? row.area_name ?? "" },
    reparticion: row.parent_id === null ? null : { id: organizationId, name: names.get(organizationId) ?? row.name, path: "" },
  };
}

/** SUTECBA (o cualquier organización de tipo «sindicato») no puede ser el Área/Repartición laboral de una persona. */
export async function isOwnerOrganization(organizationId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .selectFrom("organizations")
    .innerJoin("organization_types", "organization_types.id", "organizations.type_id")
    .select("organization_types.key")
    .where("organizations.id", "=", organizationId)
    .executeTakeFirst();
  return row?.key === OWNER_TYPE_KEY;
}
