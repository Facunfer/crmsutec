import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { writeAuditLog } from "../audit/log.js";
import type { SessionUser } from "../permissions/can.js";

assertServerOnly("lib/associations/commands.ts");

export class AssociationCommandError extends Error {}

export interface CreateAssociationInput {
  name: string;
  description?: string;
  typeId: string;
}

export async function createAssociation(
  actor: SessionUser,
  input: CreateAssociationInput
): Promise<{ id: string }> {
  assertPermission(actor, "associations.create");

  const name = input.name.trim();
  if (!name) throw new AssociationCommandError("El nombre es obligatorio.");

  const db = await getDb();
  const type = await db
    .selectFrom("association_types")
    .select("id")
    .where("id", "=", input.typeId)
    .executeTakeFirst();
  if (!type) throw new AssociationCommandError("El tipo de asociación no existe.");

  const created = await db
    .insertInto("associations")
    .values({
      name,
      description: input.description?.trim() || null,
      type_id: input.typeId,
      created_by: actor.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await writeAuditLog({
    actorUserId: actor.id,
    action: "ASSOCIATION_CREATED",
    entityType: "association",
    entityId: created.id,
    after: { name, type_id: input.typeId },
  });

  return { id: created.id };
}

export interface UpdateAssociationInput {
  name?: string;
  description?: string;
  typeId?: string;
}

export async function updateAssociation(
  actor: SessionUser,
  associationId: string,
  input: UpdateAssociationInput
): Promise<void> {
  assertPermission(actor, "associations.edit");

  const db = await getDb();
  const existing = await db
    .selectFrom("associations")
    .selectAll()
    .where("id", "=", associationId)
    .executeTakeFirst();
  if (!existing) throw new AssociationCommandError("La asociación no existe.");

  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description.trim() || null;
  if (input.typeId !== undefined) patch.type_id = input.typeId;

  await db.updateTable("associations").set(patch).where("id", "=", associationId).execute();

  await writeAuditLog({
    actorUserId: actor.id,
    action: "ASSOCIATION_UPDATED",
    entityType: "association",
    entityId: associationId,
    before: { name: existing.name, description: existing.description, type_id: existing.type_id },
    after: { name: input.name ?? null, description: input.description ?? null, type_id: input.typeId ?? null },
  });
}

export async function setAssociationActive(
  actor: SessionUser,
  associationId: string,
  active: boolean
): Promise<void> {
  assertPermission(actor, "associations.deactivate");

  const db = await getDb();
  await db
    .updateTable("associations")
    .set({ status: active ? "active" : "inactive", updated_at: new Date() })
    .where("id", "=", associationId)
    .execute();

  await writeAuditLog({
    actorUserId: actor.id,
    action: "ASSOCIATION_UPDATED",
    entityType: "association",
    entityId: associationId,
    after: { status: active ? "active" : "inactive" },
  });
}
