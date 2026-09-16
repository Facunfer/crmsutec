import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { writeAuditLog } from "../audit/log.js";
import type { SessionUser } from "../permissions/can.js";

assertServerOnly("lib/associations/members.ts");

export class AssociationMemberError extends Error {}

/** Alta individual, idempotente: si ya es miembro activo, no hace nada (sección 6.2 del prompt). */
export async function addMember(
  actor: SessionUser,
  associationId: string,
  personId: string,
  role?: string
): Promise<void> {
  assertPermission(actor, "associations.manage_members");

  const db = await getDb();
  const existing = await db
    .selectFrom("people_associations")
    .select("id")
    .where("association_id", "=", associationId)
    .where("person_id", "=", personId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (existing) return;

  await db
    .insertInto("people_associations")
    .values({ association_id: associationId, person_id: personId, role: role || null, added_by: actor.id })
    .execute();

  await writeAuditLog({
    actorUserId: actor.id,
    action: "ASSOCIATION_MEMBER_ADDED",
    entityType: "association",
    entityId: associationId,
    metadata: { person_id: personId },
  });
}

export async function removeMember(actor: SessionUser, membershipId: string): Promise<void> {
  assertPermission(actor, "associations.manage_members");

  const db = await getDb();
  const membership = await db
    .selectFrom("people_associations")
    .selectAll()
    .where("id", "=", membershipId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!membership) return;

  await db
    .updateTable("people_associations")
    .set({ status: "inactive", removed_at: new Date(), removed_by: actor.id })
    .where("id", "=", membershipId)
    .execute();

  await writeAuditLog({
    actorUserId: actor.id,
    action: "ASSOCIATION_MEMBER_REMOVED",
    entityType: "association",
    entityId: membership.association_id,
    metadata: { person_id: membership.person_id },
  });
}

/**
 * Alta masiva desde una selección o un filtro de Personas (sección 10 del
 * prompt): una sola consulta `INSERT ... SELECT ... WHERE NOT EXISTS`, sin
 * traer las filas a Node para después insertarlas de a una (lección de la
 * sección 6.2).
 */
export async function bulkAddMembers(
  actor: SessionUser,
  associationId: string,
  personIds: string[]
): Promise<number> {
  assertPermission(actor, "associations.manage_members");

  if (personIds.length === 0) return 0;
  const ids = personIds.slice(0, 5000);

  const db = await getDb();
  const result = await sql<{ person_id: string }>`
    insert into people_associations (person_id, association_id, added_by)
    select p.id, ${associationId}, ${actor.id}
    from people p
    where p.id in (${sql.join(ids)})
      and p.status = 'active'
      and not exists (
        select 1 from people_associations pa
        where pa.person_id = p.id
          and pa.association_id = ${associationId}
          and pa.status = 'active'
      )
    returning person_id
  `.execute(db);

  const insertedCount = result.rows.length;

  await writeAuditLog({
    actorUserId: actor.id,
    action: "ASSOCIATION_MEMBER_ADDED",
    entityType: "association",
    entityId: associationId,
    metadata: { bulk: true, requested: ids.length, inserted: insertedCount },
  });

  return insertedCount;
}

export async function addManager(
  actor: SessionUser,
  associationId: string,
  input: { userId?: string; personId?: string }
): Promise<void> {
  assertPermission(actor, "associations.manage_members");

  if (!input.userId && !input.personId) {
    throw new AssociationMemberError("Elegí un usuario o una persona como responsable.");
  }

  const db = await getDb();
  await db
    .insertInto("association_managers")
    .values({ association_id: associationId, user_id: input.userId ?? null, person_id: input.personId ?? null })
    .execute();

  await writeAuditLog({
    actorUserId: actor.id,
    action: "ASSOCIATION_UPDATED",
    entityType: "association",
    entityId: associationId,
    metadata: { manager_added: input },
  });
}

export async function removeManager(actor: SessionUser, managerId: string): Promise<void> {
  assertPermission(actor, "associations.manage_members");

  const db = await getDb();
  const manager = await db
    .selectFrom("association_managers")
    .selectAll()
    .where("id", "=", managerId)
    .executeTakeFirst();
  if (!manager) return;

  await db.deleteFrom("association_managers").where("id", "=", managerId).execute();

  await writeAuditLog({
    actorUserId: actor.id,
    action: "ASSOCIATION_UPDATED",
    entityType: "association",
    entityId: manager.association_id,
    metadata: { manager_removed: managerId },
  });
}
