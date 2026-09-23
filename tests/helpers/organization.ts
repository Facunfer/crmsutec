import { getDb } from "../../lib/db/client.js";

/**
 * Unidad organizativa mínima para tests que crean asociaciones, reuniones o
 * formularios (owner_organization_id es NOT NULL desde la migración 0014).
 * Requiere que el seed ya haya cargado organization_types.
 */
export async function createTestOrganization(name = "Unidad de prueba"): Promise<string> {
  const db = await getDb();
  const type = await db
    .selectFrom("organization_types")
    .select("id")
    .where("key", "=", "reparticion")
    .executeTakeFirstOrThrow();
  const org = await db
    .insertInto("organizations")
    .values({ name, type_id: type.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  return org.id;
}
