import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/audit/queries.ts");

export interface AuditLogRow {
  id: string;
  actorUserId: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: Date;
}

export async function listRecentAuditForEntity(
  entityType: string,
  entityId: string,
  limit = 10
): Promise<AuditLogRow[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("audit_logs")
    .select(["id", "actor_user_id", "actor_type", "action", "entity_type", "entity_id", "created_at"])
    .where("entity_type", "=", entityType)
    .where("entity_id", "=", entityId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();

  return rows.map((r) => ({
    id: r.id,
    actorUserId: r.actor_user_id,
    actorType: r.actor_type,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    createdAt: r.created_at,
  }));
}
