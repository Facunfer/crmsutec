/**
 * Zona horaria de negocio única (decisión D15): Argentina no observa
 * horario de verano desde 2009, así que el offset es siempre -03:00. Un
 * `<input type="datetime-local">` manda una cadena sin zona ("2026-05-10T14:30");
 * si se le pasa tal cual a `new Date()`, JS la interpreta en la zona local
 * del proceso de Node, que en el VPS de producción no tiene por qué ser
 * Buenos Aires. Se fuerza el offset acá para que sea siempre el mismo,
 * sin importar dónde corra el servidor.
 */
const BUENOS_AIRES_OFFSET = "-03:00";

export function parseLocalDateTimeInBusinessTz(value: string): Date {
  return new Date(`${value}${BUENOS_AIRES_OFFSET}`);
}
