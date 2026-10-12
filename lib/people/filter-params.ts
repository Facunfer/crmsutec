import type { PeopleFilterSpec } from "./queries.js";
import { isTrafficLight } from "./traffic.js";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lector de parámetros (URL o formulario): primer valor y todos los valores de una clave. */
export interface ParamReader {
  get(key: string): string | undefined;
  getAll(key: string): string[];
}

export function paramReaderFromSearchParams(sp: URLSearchParams): ParamReader {
  return { get: (k) => sp.get(k) ?? undefined, getAll: (k) => sp.getAll(k) };
}

/** `searchParams` de una página de Next: un valor repetido llega como arreglo. */
export function paramReaderFromRecord(sp: Record<string, string | string[] | undefined>): ParamReader {
  const all = (k: string): string[] => {
    const v = sp[k];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  };
  return { get: (k) => all(k)[0], getAll: all };
}

/**
 * ÚNICO parser de los filtros de /personas (página, KPIs, exportación CSV y selección total hacia Mailing): así la grilla, el
 * export y la audiencia ven exactamente el mismo universo. Todo se valida; nada se interpola como texto en SQL.
 * `visibleTagIds`: si se informa, las etiquetas pedidas se acotan a las visibles para el usuario (una no visible no filtra).
 */
export function parsePeopleFilter(p: ParamReader, options: { visibleTagIds?: ReadonlySet<string> } = {}): PeopleFilterSpec {
  const tagIds = [...new Set(p.getAll("tag").filter((t) => UUID.test(t)))].filter((t) => !options.visibleTagIds || options.visibleTagIds.has(t));
  const traffic = p.get("traffic");
  const lastFrom = p.get("lastFrom");
  const lastTo = p.get("lastTo");
  const email = p.get("email");
  const phone = p.get("phone");
  return {
    tagIds: tagIds.length > 0 ? tagIds : undefined,
    tagMatch: tagIds.length > 1 && p.get("tagMatch") === "all" ? "all" : undefined,
    search: p.get("q") || undefined,
    areaId: p.get("area") || undefined,
    reparticionId: p.get("rep") || undefined,
    trafficLight: traffic && isTrafficLight(traffic) ? (traffic as PeopleFilterSpec["trafficLight"]) : undefined,
    lastInteractionFrom: lastFrom && ISO_DAY.test(lastFrom) ? lastFrom : undefined,
    lastInteractionTo: lastTo && ISO_DAY.test(lastTo) ? lastTo : undefined,
    status: (["active", "inactive", "merged", "all"] as const).find((s) => s === p.get("status")) ?? "active",
    ageMin: p.get("ageMin") ? Number(p.get("ageMin")) : undefined,
    ageMax: p.get("ageMax") ? Number(p.get("ageMax")) : undefined,
    hasEmail: email === "with" ? true : email === "without" ? false : undefined,
    hasPhone: phone === "with" ? true : phone === "without" ? false : undefined,
  };
}

/** Inversa para armar la query string (KPIs, paginación, exportación): sin semáforo, orden ni página. */
export function peopleFilterToParams(filter: PeopleFilterSpec): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.search) params.set("q", filter.search);
  for (const t of filter.tagIds ?? []) params.append("tag", t);
  if (filter.tagMatch === "all") params.set("tagMatch", "all");
  if (filter.areaId) params.set("area", filter.areaId);
  if (filter.reparticionId) params.set("rep", filter.reparticionId);
  if (filter.lastInteractionFrom) params.set("lastFrom", filter.lastInteractionFrom);
  if (filter.lastInteractionTo) params.set("lastTo", filter.lastInteractionTo);
  if (filter.status) params.set("status", filter.status);
  if (filter.ageMin !== undefined) params.set("ageMin", String(filter.ageMin));
  if (filter.ageMax !== undefined) params.set("ageMax", String(filter.ageMax));
  if (filter.hasEmail === true) params.set("email", "with");
  if (filter.hasEmail === false) params.set("email", "without");
  if (filter.hasPhone === true) params.set("phone", "with");
  if (filter.hasPhone === false) params.set("phone", "without");
  return params;
}
