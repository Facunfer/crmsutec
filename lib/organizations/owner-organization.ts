import { sql, type Kysely, type Transaction } from "kysely";
import { loadEnv, type SutecbaEnv } from "../db/env.js";
import { toJsonb } from "../db/json.js";
import type { Database } from "../db/schema.js";
import { assertDatabasePreconditions, assertMasterActor, assertRuntimeRole, ImportAbortError, type LedgerReader } from "../imports/gabriel/preflight.js";

/**
 * Organización RAÍZ del propio sindicato: dueña de las reuniones, capacitaciones, operativos e importaciones.
 *
 * NO forma parte del árbol GCBA: el árbol GCBA representa la repartición laboral de las personas; SUTECBA representa
 * a quien organiza/es propietario de las actividades. Por eso no tiene padre y no cuelga ninguna repartición de ella.
 */
export const OWNER_ORGANIZATION = {
  officialCode: "SUTECBA",
  name: "Sindicato Único de Trabajadores del Estado de la Ciudad de Buenos Aires",
  type: { key: "sindicato", name: "Sindicato", level: 0 },
} as const;

export const OWNER_LOCK_KEY = "sutecba:owner-organization:create";

type Db = Kysely<Database> | Transaction<Database>;

export interface OwnerOrganizationState {
  typeId: string | null;
  organization: { id: string; name: string; parent_id: string | null; active: boolean; type_key: string } | null;
  /** Otra organización con el mismo nombre y sin official_code (posible duplicado). */
  nameCollision: boolean;
  childrenOfOwner: number;
}

export async function readOwnerOrganizationState(db: Db): Promise<OwnerOrganizationState> {
  const type = await db.selectFrom("organization_types").select("id").where("key", "=", OWNER_ORGANIZATION.type.key).executeTakeFirst();
  const org = await db
    .selectFrom("organizations as o")
    .innerJoin("organization_types as t", "t.id", "o.type_id")
    .select(["o.id", "o.name", "o.parent_id", "o.active", "t.key as type_key"])
    .where("o.official_code", "=", OWNER_ORGANIZATION.officialCode)
    .executeTakeFirst();
  const collision = await db.selectFrom("organizations").select("id").where("name", "=", OWNER_ORGANIZATION.name).where("official_code", "is", null).executeTakeFirst();
  const children = org ? Number((await db.selectFrom("organizations").select((eb) => eb.fn.countAll().as("n")).where("parent_id", "=", org.id).executeTakeFirstOrThrow()).n) : 0;
  return { typeId: type?.id ?? null, organization: org ?? null, nameCollision: Boolean(collision), childrenOfOwner: children };
}

export interface OwnerOrganizationPlan {
  createType: boolean;
  createOrganization: boolean;
  problems: string[];
}

export function planOwnerOrganization(state: OwnerOrganizationState): OwnerOrganizationPlan {
  const problems: string[] = [];
  if (state.nameCollision) problems.push("Existe otra organización sin official_code con el mismo nombre: podría ser un duplicado.");
  const org = state.organization;
  if (org) {
    if (org.name !== OWNER_ORGANIZATION.name) problems.push("SUTECBA ya existe con otro nombre: no se modifica.");
    if (org.parent_id !== null) problems.push("SUTECBA ya existe pero NO es una raíz (tiene padre): no se modifica.");
    if (org.type_key !== OWNER_ORGANIZATION.type.key) problems.push("SUTECBA ya existe con otro tipo: no se modifica.");
    if (!org.active) problems.push("SUTECBA ya existe pero está inactiva: no se modifica.");
    if (state.childrenOfOwner > 0) problems.push("Hay organizaciones colgando de SUTECBA: el árbol GCBA no puede depender de ella.");
  }
  return { createType: state.typeId === null, createOrganization: org === null, problems };
}

export interface OwnerApplyOptions {
  createdBy: string;
  env?: SutecbaEnv;
  ledger?: LedgerReader;
}

export interface OwnerApplyResult {
  outcome: "created" | "noop_idempotent";
  organizationId: string;
  typeCreated: boolean;
  runtimeRole: string;
}

export async function ensureOwnerOrganization(db: Kysely<Database>, options: OwnerApplyOptions): Promise<OwnerApplyResult> {
  const env = options.env ?? loadEnv();
  const runtime = await assertRuntimeRole(db, env);
  await assertDatabasePreconditions(db, env, { ledger: options.ledger });

  return db.transaction().execute(async (trx) => {
    const locked = await sql<{ locked: boolean }>`select pg_try_advisory_xact_lock(hashtext(${OWNER_LOCK_KEY})) as locked`.execute(trx);
    if (!locked.rows[0]?.locked) throw new ImportAbortError("Hay otra creación de la organización propietaria en curso. No se aplica nada.");
    await assertMasterActor(trx, options.createdBy);

    const state = await readOwnerOrganizationState(trx);
    const plan = planOwnerOrganization(state);
    if (plan.problems.length > 0) throw new ImportAbortError(plan.problems.join(" "));

    let typeId = state.typeId;
    if (plan.createType) {
      typeId = (await trx.insertInto("organization_types").values({ key: OWNER_ORGANIZATION.type.key, name: OWNER_ORGANIZATION.type.name, level: OWNER_ORGANIZATION.type.level, active: true }).returning("id").executeTakeFirstOrThrow()).id;
    }
    let organizationId = state.organization?.id ?? "";
    if (plan.createOrganization) {
      organizationId = (
        await trx
          .insertInto("organizations")
          .values({ type_id: typeId!, parent_id: null, name: OWNER_ORGANIZATION.name, official_code: OWNER_ORGANIZATION.officialCode, active: true })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    }
    const outcome = plan.createOrganization || plan.createType ? ("created" as const) : ("noop_idempotent" as const);
    return { outcome, organizationId, typeCreated: plan.createType, runtimeRole: runtime.role };
  });
}
