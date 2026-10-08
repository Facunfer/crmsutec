/**
 * Formato de fechas del timeline (puro, sin base): lo usan el servidor y el cliente. Nunca se muestra una hora que no se conoce.
 *
 * DETERMINISTA a propósito: `Intl.DateTimeFormat("es-AR", { timeStyle: "short" })` produce espacios Unicode distintos en Node (servidor) y en
 * el navegador (p. ej. U+202F antes de «p. m.»), lo que rompe la hidratación de React. Acá se componen las partes numéricas a mano
 * (dd/mm/aaaa y hh:mm de 24 h, en Buenos Aires), idénticas en ambos lados.
 */
export const TIMELINE_TZ = "America/Argentina/Buenos_Aires";

export type FormatPrecision = "exact_datetime" | "date_only" | null;

const PARTS = new Intl.DateTimeFormat("en-GB", { timeZone: TIMELINE_TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function partsOf(d: Date): { dd: string; mm: string; yyyy: string; hh: string; mi: string } {
  const p = Object.fromEntries(PARTS.formatToParts(d).map((x) => [x.type, x.value]));
  return { dd: p.day!, mm: p.month!, yyyy: p.year!, hh: p.hour!, mi: p.minute! };
}

export function formatTimelineDate(at: Date | string | null, precision: FormatPrecision): string {
  if (!at) return "Fecha no registrada";
  const d = typeof at === "string" ? new Date(at) : at;
  const p = partsOf(d);
  return precision === "exact_datetime" ? `${p.dd}/${p.mm}/${p.yyyy} ${p.hh}:${p.mi}` : `${p.dd}/${p.mm}/${p.yyyy}`;
}

/** Día de la actividad como contexto de un hecho sin fecha propia («actividad del 12/03/2026»). */
export function formatActivityContext(activityDate: Date | string | null, precision: FormatPrecision): string | null {
  if (!activityDate) return null;
  return `actividad del ${formatTimelineDate(activityDate, precision === "exact_datetime" ? "exact_datetime" : "date_only")}`;
}
