import { sql, type Kysely, type Transaction } from "kysely";
import { loadEnv, type SutecbaEnv } from "../../db/env.js";
import { toJsonb } from "../../db/json.js";
import type { Database } from "../../db/schema.js";
import { assertDatabasePreconditions, assertRuntimeRole, ImportAbortError, type LedgerReader } from "../../imports/gabriel/preflight.js";
import type { ApprovedAliasAddition } from "./approved-additions.js";
import type { ApprovedOrgAddition } from "./approved-org-additions.js";
import { buildCatalogPlan, planCatalogFromSource, type CatalogPlan, type ExistingCatalogState } from "./plan.js";
import type { OrgCatalog } from "./types.js";

/**
 * Carga de `organizations` + `organization_aliases` desde el catálogo aprobado. Mismas garantías que el importador
 * de Gabriel: hash del plan aprobado, rol runtime (sutecba_app), identidad de la base / migraciones, actor
 * MASTER_GLOBAL activo, una sola transacción con lock (rollback total) e idempotencia por `official_code`.
 * No crea personas ni toca datos de negocio; no hay fuzzy matching.
 */

export const CATALOG_LOCK_KEY = "sutecba:org-catalog:load";

export interface CatalogApplyOptions {
  createdBy: string;
  /** Aliases aprobados por decisión humana que se suman al catálogo (los mismos que se usaron para calcular el plan_hash). */
  additions?: readonly ApprovedAliasAddition[];
  /** Altas de organización aprobadas por decisión humana (mismas que se usaron para calcular el plan_hash). */
  organizationAdditions?: readonly ApprovedOrgAddition[];
  confirmedPlanHash: string;
  env?: SutecbaEnv;
  ledger?: LedgerReader;
}

export interface CatalogApplyResult {
  outcome: "applied" | "noop_idempotent";
  planHash: string;
  runtimeRole: string;
  typesCreated: number;
  organizationsCreated: number;
  aliasesCreated: number;
  summary: Record<string, unknown>;
  plan: CatalogPlan;
}

type Db = Kysely<Database> | Transaction<Database>;

/** Solo lectura: lo que ya existe en la base, para calcular el plan contra el estado real. */
export async function loadExistingCatalogState(db: Db): Promise<ExistingCatalogState> {
  const types = await db.selectFrom("organization_types").select(["id", "key", "name", "level"]).execute();
  const orgs = await db
    .selectFrom("organizations as o")
    .innerJoin("organization_types as t", "t.id", "o.type_id")
    .leftJoin("organizations as p", "p.id", "o.parent_id")
    .select(["o.id", "o.official_code", "o.name", "o.parent_id", "p.official_code as parent_official_code", "t.key as type_key", "o.active"])
    .execute();
  // 0022 agrega context_organization_id. Un dry-run contra una base que todavía no la tiene (solo lectura) igual funciona.
  const contextColumn = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'organization_aliases' and column_name = 'context_organization_id'`.execute(db);
  const contextSupported = (contextColumn.rows[0]?.n ?? 0) > 0;
  const aliasRows = contextSupported
    ? await sql<{ alias: string; normalized_alias: string; organization_id: string; status: string; official_code: string | null; context_official_code: string | null }>`
        select a.alias, a.normalized_alias, a.organization_id, a.status, o.official_code, c.official_code as context_official_code
        from organization_aliases a
        join organizations o on o.id = a.organization_id
        left join organizations c on c.id = a.context_organization_id`.execute(db)
    : await sql<{ alias: string; normalized_alias: string; organization_id: string; status: string; official_code: string | null; context_official_code: string | null }>`
        select a.alias, a.normalized_alias, a.organization_id, a.status, o.official_code, null::text as context_official_code
        from organization_aliases a
        join organizations o on o.id = a.organization_id`.execute(db);
  const aliases = aliasRows.rows;
  return {
    types: types.map((t) => ({ id: t.id, key: t.key, name: t.name, level: t.level })),
    organizations: orgs.map((o) => ({ id: o.id, official_code: o.official_code, name: o.name, parent_id: o.parent_id, parent_official_code: o.parent_official_code, type_key: o.type_key, active: o.active })),
    aliases: aliases.map((a) => ({ alias: a.alias, normalized_alias: a.normalized_alias, organization_id: a.organization_id, official_code: a.official_code, context_official_code: a.context_official_code, status: a.status })),
    contextSupported,
  };
}

/** Plan contra la base real, en una transacción READ ONLY (nunca escribe). */
export async function dryRunAgainstDatabase(
  db: Kysely<Database>,
  catalog: OrgCatalog,
  additions: readonly ApprovedAliasAddition[] = [],
  organizationAdditions: readonly ApprovedOrgAddition[] = []
): Promise<{ plan: CatalogPlan; planHash: string }> {
  const state = await db.transaction().execute(async (trx) => {
    // Explícito (no depende del dialecto): cualquier escritura dentro de esta transacción falla.
    await sql`set transaction read only`.execute(trx);
    return loadExistingCatalogState(trx);
  });
  const { planHash } = planCatalogFromSource(catalog, additions, organizationAdditions);
  return { plan: buildCatalogPlan(catalog, state, additions, organizationAdditions), planHash };
}

async function assertCatalogActor(trx: Transaction<Database>, createdBy: string): Promise<void> {
  const actor = await trx
    .selectFrom("users")
    .innerJoin("roles", "roles.id", "users.role_id")
    .select(["users.status", "roles.key as role_key"])
    .where("users.id", "=", createdBy)
    .executeTakeFirst();
  if (!actor) throw new ImportAbortError("El usuario --created-by no existe.");
  if (actor.status !== "active") throw new ImportAbortError("El usuario --created-by no está activo.");
  if (actor.role_key !== "MASTER_GLOBAL") throw new ImportAbortError("El usuario --created-by no tiene autoridad suficiente (se requiere MASTER_GLOBAL).");
}

export async function applyCatalog(db: Kysely<Database>, catalog: OrgCatalog, options: CatalogApplyOptions): Promise<CatalogApplyResult> {
  const additions = options.additions ?? [];
  const organizationAdditions = options.organizationAdditions ?? [];
  const source = planCatalogFromSource(catalog, additions, organizationAdditions);
  if (source.planHash !== options.confirmedPlanHash) {
    throw new ImportAbortError("El hash del plan no coincide con el aprobado en el dry-run. Repetí el dry-run y confirmá el nuevo hash.");
  }
  if ((source.plan.counts.errores ?? 0) > 0) throw new ImportAbortError(`El catálogo tiene ${source.plan.counts.errores ?? 0} error(es) de estructura: no se aplica nada.`);

  const env = options.env ?? loadEnv();
  const runtime = await assertRuntimeRole(db, env);
  await assertDatabasePreconditions(db, env, { ledger: options.ledger });

  return db.transaction().execute(async (trx) => {
    const locked = await sql<{ locked: boolean }>`select pg_try_advisory_xact_lock(hashtext(${CATALOG_LOCK_KEY})) as locked`.execute(trx);
    if (!locked.rows[0]?.locked) throw new ImportAbortError("Hay otra carga del catálogo en curso (lock ocupado). No se aplica nada.");
    await assertCatalogActor(trx, options.createdBy);

    const state = await loadExistingCatalogState(trx);
    const plan = buildCatalogPlan(catalog, state, additions, organizationAdditions);
    if ((plan.counts.errores ?? 0) > 0) {
      throw new ImportAbortError(`El plan contra la base tiene ${plan.counts.errores} error(es) (${[...new Set(plan.issues.filter((i) => i.severity === "error").map((i) => i.code))].join(", ")}): no se aplica nada.`);
    }

    // 1. Tipos que faltan
    const typeIdByKey = new Map(state.types.map((t) => [t.key, t.id!]));
    for (const def of plan.types.toCreate) {
      const created = await trx.insertInto("organization_types").values({ key: def.key, name: def.name, level: def.level, active: true }).returning("id").executeTakeFirstOrThrow();
      typeIdByKey.set(def.key, created.id);
    }

    // 2. Organizaciones, de la raíz hacia abajo (el padre siempre existe antes que el hijo)
    const idByKey = new Map(state.organizations.filter((o) => o.official_code).map((o) => [o.official_code!, o.id!]));
    for (const org of plan.organizations.toCreate) {
      const parentId = org.parentKey ? idByKey.get(org.parentKey) : null;
      if (org.parentKey && !parentId) throw new ImportAbortError("Padre sin crear: se revierte todo.");
      const created = await trx
        .insertInto("organizations")
        .values({ type_id: typeIdByKey.get(org.typeKey)!, parent_id: parentId ?? null, name: org.name, official_code: org.key, active: true })
        .returning("id")
        .executeTakeFirstOrThrow();
      idByKey.set(org.key, created.id);
    }

    if (plan.aliases.toCreate.some((a) => a.contextKey) && !state.contextSupported) {
      throw new ImportAbortError("Faltan los alias contextuales en la base: aplicá la migración 0022 antes de cargar el catálogo.");
    }

    // 3. Alias aprobados: globales (una organización por texto) y contextuales (una por texto y jurisdicción)
    const approvedAt = new Date();
    for (const alias of plan.aliases.toCreate) {
      await trx
        .insertInto("organization_aliases")
        .values({
          organization_id: idByKey.get(alias.organizationKey)!,
          ...(alias.contextKey ? { context_organization_id: idByKey.get(alias.contextKey)! } : {}),
          alias: alias.alias,
          status: "approved",
          approved_by: options.createdBy,
          approved_at: approvedAt,
          created_by: options.createdBy,
        } as never)
        .execute();
    }

    const noop = plan.types.toCreate.length === 0 && plan.organizations.toCreate.length === 0 && plan.aliases.toCreate.length === 0;
    const summary: Record<string, unknown> = {
      outcome: noop ? "noop_idempotent" : "applied",
      plan_hash: source.planHash,
      catalog: { fileName: catalog.fileName, sha256: catalog.sha256, version: catalog.version },
      runtime_role: runtime.role,
      types_created: plan.types.toCreate.length,
      organizations_created: plan.organizations.toCreate.length,
      organizations_existing: plan.organizations.existing.length,
      aliases_created: plan.aliases.toCreate.length,
      aliases_contextual_created: plan.aliases.toCreate.filter((a) => a.contextKey).length,
      aliases_existing: plan.aliases.existing,
      aliases_not_loaded_by_type: plan.aliases.notLoaded,
    };

    return {
      outcome: noop ? "noop_idempotent" : "applied",
      planHash: source.planHash,
      runtimeRole: runtime.role,
      typesCreated: plan.types.toCreate.length,
      organizationsCreated: plan.organizations.toCreate.length,
      aliasesCreated: plan.aliases.toCreate.length,
      summary,
      plan,
    } satisfies CatalogApplyResult;
  });
}
