import { sql, type RawBuilder } from "kysely";

/**
 * Fecha SIN hora (columnas `date`) escrita desde un texto AAAA-MM-DD.
 *
 * Por qué no un `Date`: el driver `pg` serializa un `Date` en la hora LOCAL del proceso. Un `new Date("2026-03-10")`
 * (medianoche UTC) escrito desde una máquina en UTC-3 llega como «2026-03-09T21:00-03:00» y la base guarda 2026-03-09:
 * un día menos. Con el texto y `::date` el resultado no depende de la zona horaria del proceso.
 */
export function dateOnly(value: string | null | undefined): RawBuilder<Date> | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Fecha inválida: se esperaba AAAA-MM-DD.");
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  // Validación manual del calendario (día-en-mes + bisiesto): NUNCA con Date.UTC/el constructor multi-argumento de
  // Date, que reinterpreta un año de 0 a 99 como 1900+año (comportamiento heredado de JS) y rechazaría por error
  // cualquier año de 4 dígitos por debajo de 100 aunque sea una fecha de calendario perfectamente válida.
  if (m < 1 || m > 12) throw new Error("Fecha inexistente.");
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  if (d < 1 || d > daysInMonth) throw new Error("Fecha inexistente.");
  return sql<Date>`${value}::date`;
}
