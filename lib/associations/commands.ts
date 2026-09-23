import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import type { SessionUser } from "../permissions/can.js";
import { canActorOwnInOrganization } from "../organizations/ownership.js";
import { canAccessAssociation } from "../scope/organizations.js";

assertServerOnly("lib/associations/commands.ts");

export class AssociationCommandError extends Error {}

export interface CreateAssociationInput {
  name: string;
  description?: string;
  typeId: string;
  ownerOrganizationId: string;
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

  if (!(await canActorOwnInOrganization(actor.id, input.ownerOrganizationId))) {
    throw new AssociationCommandError("La unidad organizativa no existe, está inactiva o está fuera de tu alcance.");
  }

  const created = await db
    .insertInto("associations")
    .values({
      owner_organization_id: input.ownerOrganizationId,
      name,
      description: input.description?.trim() || null,
      type_id: input.typeId,
      created_by: actor.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();


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

  if (!(await canAccessAssociation(actor, associationId))) {
    throw new AssociationCommandError("La asociación no existe.");
  }

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

}

export async function setAssociationActive(
  actor: SessionUser,
  associationId: string,
  active: boolean
): Promise<void> {
  assertPermission(actor, "associations.deactivate");

  if (!(await canAccessAssociation(actor, associationId))) {
    throw new AssociationCommandError("La asociación no existe.");
  }

  const db = await getDb();
  await db
    .updateTable("associations")
    .set({ status: active ? "active" : "inactive", updated_at: new Date() })
    .where("id", "=", associationId)
    .execute();

}
