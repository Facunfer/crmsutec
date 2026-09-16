import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/forms/matching.ts");

export interface NormalizedIdentity {
  dni?: string | null;
  email?: string | null;
  phone?: string | null;
}

export type MatchOutcome =
  | { kind: "none" }
  | { kind: "single"; personId: string; matchedBy: string[] }
  | { kind: "multiple"; personIds: string[]; matchedBy: Record<string, string[]> };

/**
 * Identificación de una persona a partir de un envío de formulario (sección
 * de Formularios): se prueban los campos configurados en
 * `identification_policy.matchFields`, en orden, contra `people` (nunca
 * personas `merged`). Si distintos campos apuntan a distintas personas, es
 * una ambigüedad real y se deja para revisión manual — nunca se elige una al
 * azar ni se fusiona sola.
 */
export async function matchPerson(matchFields: Array<"dni" | "email" | "phone">, identity: NormalizedIdentity): Promise<MatchOutcome> {
  const db = await getDb();
  const matchedBy = new Map<string, string[]>();

  for (const field of matchFields) {
    const value = identity[field];
    if (!value) continue;

    const rows =
      field === "email"
        ? await db.selectFrom("people").select("id").where(({ fn }) => fn("lower", ["email"]), "=", value).where("status", "!=", "merged").execute()
        : await db.selectFrom("people").select("id").where(field, "=", value).where("status", "!=", "merged").execute();

    for (const row of rows) {
      const list = matchedBy.get(row.id) ?? [];
      list.push(field);
      matchedBy.set(row.id, list);
    }
  }

  const personIds = [...matchedBy.keys()];
  if (personIds.length === 0) return { kind: "none" };
  if (personIds.length === 1) return { kind: "single", personId: personIds[0]!, matchedBy: matchedBy.get(personIds[0]!)! };
  return { kind: "multiple", personIds, matchedBy: Object.fromEntries(matchedBy) };
}
