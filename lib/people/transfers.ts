import { sql } from "kysely";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { can, isMasterGlobal, type SessionUser } from "../permissions/can.js";
import { canAccessPerson, isUuid, orgScope } from "../scope/organizations.js";
import { isOwnerOrganization, OWNER_AS_WORK_UNIT_MESSAGE } from "../organizations/areas.js";
import { PersonCommandError } from "./commands.js";

assertServerOnly("lib/people/transfers.ts");

/** Las funciones SQL de 0015 violan sus reglas con RAISE EXCEPTION (P0001): se muestran como error de negocio. */
async function withDbRuleErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: string }).code === "P0001" && err instanceof Error) {
      throw new PersonCommandError(err.message, "VALIDATION");
    }
    throw err;
  }
}

/**
 * Traslada a una persona de su repartición actual a otra (`transfer_person`,
 * migración 0015). Semántica: la repartición destino pasa a ver la ficha; la de
 * origen deja de verla y conserva solo la constancia (ver `listTransferReceipts`);
 * las interacciones ya registradas conservan su unidad propietaria original, así
 * que la unidad nueva NO las ve. El destino puede ser cualquier unidad activa.
 *
 * Además de las validaciones de la base (permiso, alcance sobre el origen,
 * motivo obligatorio), acá se exige `people.transfer` con su módulo y que la
 * persona esté dentro del alcance del actor: fuera de él, "no existe".
 */
export async function transferPerson(
  actor: SessionUser,
  personId: string,
  toOrganizationId: string,
  reason: string
): Promise<void> {
  assertPermission(actor, "people.transfer");

  if (!isUuid(toOrganizationId) || !(await canAccessPerson(actor, personId))) {
    throw new PersonCommandError("La persona no existe.");
  }
  if (await isOwnerOrganization(toOrganizationId)) throw new PersonCommandError(OWNER_AS_WORK_UNIT_MESSAGE, "VALIDATION");

  const db = await getDb();
  await withDbRuleErrors(async () => {
    await sql`
      select * from transfer_person(${personId}::uuid, ${toOrganizationId}::uuid, ${reason}, ${actor.id}::uuid)
    `.execute(db);
  });

}

/**
 * Asigna la repartición inicial a una persona pendiente de clasificar
 * (`assign_initial_organization`). Una persona sin unidad solo es visible para
 * MASTER_GLOBAL hasta que se la clasifica, así que esta operación es exclusiva
 * suya: un usuario con alcance limitado no ve a esas personas (y no puede
 * "reclamar" una por UUID). El permiso `people.assign_organization` tampoco se
 * le da a ADMIN (ver lib/permissions/catalog.ts).
 */
export async function assignInitialOrganization(
  actor: SessionUser,
  personId: string,
  organizationId: string
): Promise<void> {
  assertPermission(actor, "people.assign_organization");
  if (!isMasterGlobal(actor)) throw new PersonCommandError("La persona no existe.");

  if (!isUuid(personId) || !isUuid(organizationId)) {
    throw new PersonCommandError("La persona no existe.");
  }
  if (await isOwnerOrganization(organizationId)) throw new PersonCommandError(OWNER_AS_WORK_UNIT_MESSAGE, "VALIDATION");

  const db = await getDb();
  await withDbRuleErrors(async () => {
    await sql`
      select * from assign_initial_organization(${personId}::uuid, ${organizationId}::uuid, ${actor.id}::uuid)
    `.execute(db);
  });

}

export interface TransferReceipt {
  transferId: string;
  transferredAt: Date;
  personName: string;
  /** Solo si la persona sigue siendo visible para el usuario (si no, no hay ficha a la que enlazar). */
  personId: string | null;
  fromOrganizationName: string | null;
  toOrganizationName: string;
  reason: string;
  direction: "salida" | "entrada";
}

/**
 * Constancia de traslados: para la unidad de origen, "salió a tal repartición";
 * para la de destino, "llegó desde tal repartición". Muestra nombre de la
 * persona, fecha y las dos unidades — NUNCA la ficha (DNI, contacto, etc.). El
 * enlace a la ficha solo aparece si la persona sigue dentro del alcance.
 */
export async function listTransferReceipts(actor: SessionUser): Promise<TransferReceipt[]> {
  if (!can(actor, "people.view")) return [];

  const db = await getDb();
  const rows = await db
    .selectFrom("person_organization_transfers as t")
    .innerJoin("people as p", "p.id", "t.person_id")
    .leftJoin("organizations as fo", "fo.id", "t.from_organization_id")
    .innerJoin("organizations as to_o", "to_o.id", "t.to_organization_id")
    .select([
      "t.id",
      "t.transferred_at",
      "t.reason",
      "p.id as person_id",
      "p.first_name",
      "p.last_name",
      "fo.name as from_name",
      "to_o.name as to_name",
      orgScope(actor, "t.from_organization_id").as("from_in_scope"),
      orgScope(actor, "p.organization_id").as("person_visible"),
    ])
    .where((eb) =>
      eb.or([orgScope(actor, "t.from_organization_id"), orgScope(actor, "t.to_organization_id")])
    )
    .orderBy("t.transferred_at", "desc")
    .execute();

  return rows.map((r) => ({
    transferId: r.id,
    transferredAt: r.transferred_at,
    personName: `${r.first_name} ${r.last_name}`,
    personId: r.person_visible ? r.person_id : null,
    fromOrganizationName: r.from_name,
    toOrganizationName: r.to_name,
    // El motivo es de la unidad que trasladó; la unidad que recibe no lo ve.
    reason: r.from_in_scope ? r.reason : "",
    direction: r.from_in_scope ? "salida" : "entrada",
  }));
}
