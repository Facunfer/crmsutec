import type { AliasEntry } from "../../imports/gabriel/organization-resolver.js";
import type { CatalogPlan } from "./plan.js";

/**
 * Contexto de resolución de organizaciones «como si» el `CatalogPlan` (organizaciones + aliases nuevos) ya
 * estuviera aplicado — puramente en memoria, SIN escribir nada. Las organizaciones nuevas todavía no tienen UUID
 * real: usan un id sintético `new:<official_code>`, visible como tal en cualquier reporte para no confundirlo con
 * un id real de la base.
 */
export interface SimulatedOrgContext {
  aliases: AliasEntry[];
  organizationParents: Map<string, string | null>;
  /** official_code → id (real si ya existía; `new:<code>` si lo crea este plan). */
  idByCode: Map<string, string>;
}

export interface ExistingOrgContext {
  aliases: ReadonlyArray<AliasEntry>;
  organizationParents: ReadonlyMap<string, string | null>;
  /** official_code → id real, de las organizaciones YA cargadas. */
  idByOfficialCode: ReadonlyMap<string, string>;
}

export const syntheticOrgId = (officialCode: string) => `new:${officialCode}`;

export function simulateCatalogOrgContext(plan: CatalogPlan, existing: ExistingOrgContext): SimulatedOrgContext {
  const idByCode = new Map(existing.idByOfficialCode);
  const organizationParents = new Map(existing.organizationParents);
  // El plan ya viene ordenado de raíz a hoja (buildCatalogPlan ordena por profundidad): el padre siempre está resuelto antes.
  for (const org of plan.organizations.toCreate) {
    const id = syntheticOrgId(org.key);
    idByCode.set(org.key, id);
    organizationParents.set(id, org.parentKey ? (idByCode.get(org.parentKey) ?? null) : null);
  }
  const aliases: AliasEntry[] = [...existing.aliases];
  for (const a of plan.aliases.toCreate) {
    const organizationId = idByCode.get(a.organizationKey);
    if (!organizationId) continue; // el plan ya garantiza que el destino existe o se crea en el mismo plan
    aliases.push({ alias: a.alias, organizationId, contextOrganizationId: a.contextKey ? (idByCode.get(a.contextKey) ?? null) : null });
  }
  return { aliases, organizationParents, idByCode };
}
