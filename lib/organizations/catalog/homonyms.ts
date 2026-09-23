import { comparableText } from "../../imports/gabriel/normalize.js";
import type { CatalogOrgRow } from "./types.js";

/**
 * Familias de organizaciones HOMÓNIMAS del organigrama oficial: unidades con el mismo nombre genérico que solo se
 * distinguen por la jurisdicción (el padre) a la que pertenecen. Ejemplos reales del catálogo:
 *   «Dirección General Técnica, Administrativa y Legal» → una en Cultura, otra en Hacienda, en Seguridad, en
 *   Procuración y en ASINF;   «Unidad de Auditoría Interna X» → una por organismo (ASINF, IDECBA, AGC, PG, SGCBA).
 *
 * Es un mecanismo GENERAL derivado de la estructura oficial (no una excepción para DGTAL): todo nombre genérico que
 * comparten ≥ 2 unidades del mismo tipo con padres distintos es contextual. Sin fuzzy matching: las claves son
 * determinísticas (nombre comparable, iniciales, abreviatura «dg»).
 */

export interface FamilyMember {
  key: string;
  name: string;
  parentKey: string;
}

export interface HomonymFamily {
  /** Nombre genérico comparable (sin el sufijo de jurisdicción). */
  genericKey: string;
  tipo: string;
  members: FamilyMember[];
  /** Claves comparables con las que se nombra a la familia: nombre genérico, iniciales y variante «dg …». */
  vocabulary: Array<{ key: string; display: string; kind: "generic_name" | "acronym" | "abbreviation" }>;
}

export interface HomonymProblem {
  code: "HOMONYM_SAME_PARENT" | "HOMONYM_WITHOUT_PARENT";
  genericKey: string;
  keys: string[];
}

const STOPWORDS = new Set(["y", "e", "de", "del", "la", "las", "los", "el"]);
/** Abreviaturas de encabezado usadas en las bases («DG Técnica…»). Vocabulario controlado, no fuzzy. */
const LEADING_ABBREVIATIONS: Array<[string, string]> = [["direccion general", "dg"]];

const acronymOf = (key: string) =>
  key
    .split(" ")
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => w[0])
    .join("");

/** Nombre comparable sin el código de la jurisdicción al final («unidad de auditoria interna pg» → sin «pg»). */
export function genericNameKey(org: CatalogOrgRow, parent: CatalogOrgRow | undefined): string {
  const name = comparableText(org.nombre_oficial);
  const parentCode = comparableText(parent?.codigo_oficial ?? "");
  if (parentCode && !parent!.canonical_key.includes(":") && name.endsWith(` ${parentCode}`)) return name.slice(0, -parentCode.length - 1).trim();
  return name;
}

export function detectHomonymFamilies(orgs: readonly CatalogOrgRow[]): { families: HomonymFamily[]; problems: HomonymProblem[] } {
  const byKey = new Map(orgs.map((o) => [o.canonical_key, o]));
  const groups = new Map<string, CatalogOrgRow[]>();
  for (const org of orgs) {
    const parent = org.parent_key ? byKey.get(org.parent_key) : undefined;
    const generic = genericNameKey(org, parent);
    if (!generic) continue;
    const id = `${generic}|${org.tipo}`;
    (groups.get(id) ?? groups.set(id, []).get(id)!).push(org);
  }

  const families: HomonymFamily[] = [];
  const problems: HomonymProblem[] = [];
  for (const [id, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (members.length < 2) continue;
    const [genericKey, tipo] = id.split("|") as [string, string];
    const keys = members.map((m) => m.canonical_key).sort();
    if (members.some((m) => !m.parent_key)) {
      problems.push({ code: "HOMONYM_WITHOUT_PARENT", genericKey, keys });
      continue;
    }
    const parents = members.map((m) => m.parent_key!);
    if (new Set(parents).size !== parents.length) {
      problems.push({ code: "HOMONYM_SAME_PARENT", genericKey, keys });
      continue;
    }
    const first = members[0]!;
    const parentCode = byKey.get(first.parent_key!)?.codigo_oficial ?? "";
    const trimmedName = first.nombre_oficial.trim();
    const genericDisplay = parentCode && trimmedName.toLowerCase().endsWith(` ${parentCode.toLowerCase()}`) ? trimmedName.slice(0, -(parentCode.length + 1)).trim() : trimmedName;
    const vocabulary: HomonymFamily["vocabulary"] = [{ key: genericKey, display: genericDisplay, kind: "generic_name" }];
    const acronym = acronymOf(genericKey);
    if (acronym.length >= 3) vocabulary.push({ key: acronym, display: acronym.toUpperCase(), kind: "acronym" });
    for (const [long, short] of LEADING_ABBREVIATIONS) {
      if (genericKey.startsWith(`${long} `)) vocabulary.push({ key: `${short} ${genericKey.slice(long.length + 1)}`, display: `${short.toUpperCase()} ${genericKey.slice(long.length + 1)}`.toUpperCase(), kind: "abbreviation" });
    }
    families.push({
      genericKey,
      tipo,
      members: members.map((m) => ({ key: m.canonical_key, name: m.nombre_oficial, parentKey: m.parent_key! })).sort((a, b) => a.key.localeCompare(b.key)),
      vocabulary,
    });
  }
  return { families, problems };
}
