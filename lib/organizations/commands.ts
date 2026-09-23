import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import type { SessionUser } from "../permissions/can.js";

assertServerOnly("lib/organizations/commands.ts");

export class OrganizationCommandError extends Error {}

export interface CreateOrganizationInput {
  name: string;
  typeId: string;
  parentId?: string | null;
}

export async function createOrganization(
  actor: SessionUser,
  input: CreateOrganizationInput
): Promise<{ id: string }> {
  assertPermission(actor, "organizations.manage");

  const name = input.name.trim();
  if (!name) {
    throw new OrganizationCommandError("El nombre es obligatorio.");
  }

  const db = await getDb();
  const type = await db
    .selectFrom("organization_types")
    .select("id")
    .where("id", "=", input.typeId)
    .executeTakeFirst();
  if (!type) {
    throw new OrganizationCommandError("El tipo de organismo no existe.");
  }

  const created = await db
    .insertInto("organizations")
    .values({ name, type_id: input.typeId, parent_id: input.parentId ?? null })
    .returning("id")
    .executeTakeFirstOrThrow();


  return { id: created.id };
}

export interface UpdateOrganizationInput {
  name?: string;
  typeId?: string;
  parentId?: string | null;
}

export async function updateOrganization(
  actor: SessionUser,
  organizationId: string,
  input: UpdateOrganizationInput
): Promise<void> {
  assertPermission(actor, "organizations.manage");

  if (input.parentId === organizationId) {
    throw new OrganizationCommandError("Un organismo no puede ser su propio padre.");
  }

  const db = await getDb();
  const existing = await db
    .selectFrom("organizations")
    .selectAll()
    .where("id", "=", organizationId)
    .executeTakeFirst();
  if (!existing) {
    throw new OrganizationCommandError("El organismo no existe.");
  }

  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.typeId !== undefined) patch.type_id = input.typeId;
  if (input.parentId !== undefined) patch.parent_id = input.parentId;

  await db.updateTable("organizations").set(patch).where("id", "=", organizationId).execute();

}

export async function setOrganizationActive(
  actor: SessionUser,
  organizationId: string,
  active: boolean
): Promise<void> {
  assertPermission(actor, "organizations.manage");

  const db = await getDb();
  await db
    .updateTable("organizations")
    .set({ active, updated_at: new Date() })
    .where("id", "=", organizationId)
    .execute();

}
