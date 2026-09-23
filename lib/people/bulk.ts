import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import type { SessionUser } from "../permissions/can.js";
import { orgScope } from "../scope/organizations.js";

assertServerOnly("lib/people/bulk.ts");

const MAX_BULK_IDS = 5000;

export async function bulkSetActive(actor: SessionUser, personIds: string[], active: boolean): Promise<number> {
  assertPermission(actor, "people.deactivate");

  const ids = personIds.slice(0, MAX_BULK_IDS);
  if (ids.length === 0) return 0;

  // `numUpdatedRows` no es confiable con PGlite (ver comentario en
  // lib/people/commands.ts): se cuenta con `.returning()` en su lugar.
  const db = await getDb();
  const updated = await db
    .updateTable("people")
    .set({ status: active ? "active" : "inactive", updated_by: actor.id, updated_at: new Date() })
    .where("id", "in", ids)
    // Los ids llegan del cliente: solo se actualizan las personas dentro del alcance del usuario.
    .where(orgScope(actor, "people.organization_id"))
    .returning("id")
    .execute();


  return updated.length;
}
