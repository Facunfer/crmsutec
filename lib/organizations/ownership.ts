import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import type { OrganizationOption } from "./queries.js";

assertServerOnly("lib/organizations/ownership.ts");

/**
 * Unidad propietaria de asociaciones, reuniones y formularios (migración 0014:
 * `owner_organization_id NOT NULL`). Solo se puede asignar una unidad activa
 * dentro del alcance del usuario: `user_accessible_organizations` (0012)
 * devuelve todas las unidades para MASTER_GLOBAL y, para el resto, las de sus
 * alcances vigentes más descendientes. La UI solo filtra lo que se ofrece; la
 * comprobación que vale es esta, del lado del servidor.
 */
export async function canActorOwnInOrganization(actorId: string, organizationId: string): Promise<boolean> {
  const db = await getDb();
  const result = await sql<{ ok: boolean }>`
    select exists (
      select 1
      from user_accessible_organizations(${actorId}::uuid) a
      join organizations o on o.id = a.organization_id
      where a.organization_id = ${organizationId}::uuid and o.active
    ) as ok
  `.execute(db);
  return result.rows[0]?.ok === true;
}

/** Unidades activas que el usuario puede elegir como propietarias, para los selectores de alta. */
export async function listOwnerOrganizationOptions(actorId: string): Promise<OrganizationOption[]> {
  const db = await getDb();
  const result = await sql<{ id: string; name: string; type_name: string }>`
    select o.id, o.name, t.name as type_name
    from user_accessible_organizations(${actorId}::uuid) a
    join organizations o on o.id = a.organization_id
    join organization_types t on t.id = o.type_id
    where o.active
    order by o.name
  `.execute(db);
  return result.rows.map((r) => ({ id: r.id, label: `${r.name} (${r.type_name})` }));
}
