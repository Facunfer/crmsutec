import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { can, type SessionUser } from "../permissions/can.js";
import { orgScope } from "../scope/organizations.js";
import type { InteractionStatus } from "../db/schema.js";

assertServerOnly("lib/interactions/queries.ts");

/**
 * Interacciones (migración 0017). El acceso se determina por
 * `owner_organization_id` de LA INTERACCIÓN — la unidad que la registró — y NO
 * por la unidad actual de la persona ni por poder ver a la persona. Ejemplo: la
 * persona estaba en A, A registra una interacción y después se la traslada a B:
 * B ve a la persona pero NO esa interacción histórica; A, en cambio, sigue viendo
 * la suya.
 *
 * Requieren `interactions.view` (con su módulo `interacciones`), vía `can()`.
 * Todavía no hay UI: son las consultas listas para cuando exista.
 */

export interface InteractionItem {
  id: string;
  ownerOrganizationId: string;
  occurredAt: Date;
  subject: string;
  description: string | null;
  status: InteractionStatus;
  outcome: string | null;
  nextFollowUpAt: Date | null;
}

const COLUMNS_PERSON = [
  "person_interactions.id",
  "person_interactions.owner_organization_id",
  "person_interactions.occurred_at",
  "person_interactions.subject",
  "person_interactions.description",
  "person_interactions.status",
  "person_interactions.outcome",
  "person_interactions.next_follow_up_at",
] as const;

const COLUMNS_ASSOCIATION = [
  "association_interactions.id",
  "association_interactions.owner_organization_id",
  "association_interactions.occurred_at",
  "association_interactions.subject",
  "association_interactions.description",
  "association_interactions.status",
  "association_interactions.outcome",
  "association_interactions.next_follow_up_at",
] as const;

interface Row {
  id: string;
  owner_organization_id: string;
  occurred_at: Date;
  subject: string;
  description: string | null;
  status: InteractionStatus;
  outcome: string | null;
  next_follow_up_at: Date | null;
}

function toItem(r: Row): InteractionItem {
  return {
    id: r.id,
    ownerOrganizationId: r.owner_organization_id,
    occurredAt: r.occurred_at,
    subject: r.subject,
    description: r.description,
    status: r.status,
    outcome: r.outcome,
    nextFollowUpAt: r.next_follow_up_at,
  };
}

export async function listPersonInteractions(actor: SessionUser, personId: string): Promise<InteractionItem[]> {
  if (!can(actor, "interactions.view")) return [];

  const db = await getDb();
  const rows = await db
    .selectFrom("person_interactions")
    .select([...COLUMNS_PERSON])
    .where("person_interactions.person_id", "=", personId)
    .where(orgScope(actor, "person_interactions.owner_organization_id"))
    .orderBy("person_interactions.occurred_at", "desc")
    .execute();

  return rows.map(toItem);
}

export async function listAssociationInteractions(actor: SessionUser, associationId: string): Promise<InteractionItem[]> {
  if (!can(actor, "interactions.view")) return [];

  const db = await getDb();
  const rows = await db
    .selectFrom("association_interactions")
    .select([...COLUMNS_ASSOCIATION])
    .where("association_interactions.association_id", "=", associationId)
    .where(orgScope(actor, "association_interactions.owner_organization_id"))
    .orderBy("association_interactions.occurred_at", "desc")
    .execute();

  return rows.map(toItem);
}

/** null si no existe O está fuera del alcance (una interacción ajena no se distingue de una inexistente). */
export async function getPersonInteractionById(actor: SessionUser, id: string): Promise<InteractionItem | null> {
  if (!can(actor, "interactions.view")) return null;

  const db = await getDb();
  const row = await db
    .selectFrom("person_interactions")
    .select([...COLUMNS_PERSON])
    .where("person_interactions.id", "=", id)
    .where(orgScope(actor, "person_interactions.owner_organization_id"))
    .executeTakeFirst();

  return row ? toItem(row) : null;
}
