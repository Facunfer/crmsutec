import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/organizations/queries.ts");

export interface OrganizationTypeItem {
  id: string;
  key: string;
  name: string;
  level: number;
  active: boolean;
}

export async function listOrganizationTypes(): Promise<OrganizationTypeItem[]> {
  const db = await getDb();
  return db
    .selectFrom("organization_types")
    .select(["id", "key", "name", "level", "active"])
    .orderBy("level", "asc")
    .orderBy("name", "asc")
    .execute();
}

export interface OrganizationItem {
  id: string;
  name: string;
  active: boolean;
  typeId: string;
  typeName: string;
  parentId: string | null;
  parentName: string | null;
}

export async function listOrganizations(): Promise<OrganizationItem[]> {
  const db = await getDb();

  const rows = await db
    .selectFrom("organizations")
    .innerJoin("organization_types", "organization_types.id", "organizations.type_id")
    .leftJoin("organizations as parent_org", "parent_org.id", "organizations.parent_id")
    .select([
      "organizations.id",
      "organizations.name",
      "organizations.active",
      "organizations.type_id as typeId",
      "organization_types.name as typeName",
      "organizations.parent_id as parentId",
      "parent_org.name as parentName",
    ])
    .orderBy("organizations.name", "asc")
    .execute();

  return rows;
}

/** Para poblar el <select> de organismo en el alta/edición de Personas: no requiere permiso especial. */
export interface OrganizationOption {
  id: string;
  label: string;
}

export async function listActiveOrganizationOptions(): Promise<OrganizationOption[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("organizations")
    .innerJoin("organization_types", "organization_types.id", "organizations.type_id")
    .select(["organizations.id", "organizations.name", "organization_types.name as typeName"])
    .where("organizations.active", "=", true)
    .orderBy("organizations.name", "asc")
    .execute();

  return rows.map((r) => ({ id: r.id, label: `${r.name} (${r.typeName})` }));
}
