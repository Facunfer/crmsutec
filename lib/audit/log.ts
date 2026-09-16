import { getDb } from "../db/client.js";
import { toJsonb } from "../db/json.js";
import type { Json } from "../db/schema.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/audit/log.ts");

export interface AuditEntry {
  actorUserId?: string | null;
  actorType?: "user" | "public" | "system";
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Json | null;
  after?: Json | null;
  metadata?: Json | null;
}

/**
 * Única ruta de escritura de auditoría (sección 15.1). audit_logs además es
 * append-only por trigger de base (ver db/migrations/0007), así que ni esta
 * función ni nadie más puede corregir un registro ya escrito.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  const db = await getDb();
  await db
    .insertInto("audit_logs")
    .values({
      actor_user_id: entry.actorUserId ?? null,
      actor_type: entry.actorType ?? "user",
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      before: toJsonb(entry.before ?? null),
      after: toJsonb(entry.after ?? null),
      metadata: toJsonb(entry.metadata ?? null),
    })
    .execute();
}
