/**
 * Semáforo de personas: se calcula SIEMPRE desde la última interacción real (nunca se guarda un color).
 *
 *   verde    0–30 días desde la última interacción
 *   amarillo 31–60 días
 *   rojo     más de 60 días
 *   gris     nunca hubo interacción
 *
 * Los días se cuentan en días calendario de Buenos Aires (una interacción `date_only` solo conoce el día).
 * Es un módulo puro (sin base): lo usan la consulta, la UI y los tests, con los mismos umbrales.
 */
export const TRAFFIC_GREEN_MAX_DAYS = 30;
export const TRAFFIC_YELLOW_MAX_DAYS = 60;

export type TrafficLight = "green" | "yellow" | "red" | "gray";

export const TRAFFIC_LIGHTS: readonly TrafficLight[] = ["green", "yellow", "red", "gray"];

export function isTrafficLight(value: unknown): value is TrafficLight {
  return typeof value === "string" && (TRAFFIC_LIGHTS as readonly string[]).includes(value);
}

/** `null` = nunca hubo interacción. */
export function trafficLightOf(daysSinceLastInteraction: number | null): TrafficLight {
  if (daysSinceLastInteraction === null) return "gray";
  if (daysSinceLastInteraction <= TRAFFIC_GREEN_MAX_DAYS) return "green";
  if (daysSinceLastInteraction <= TRAFFIC_YELLOW_MAX_DAYS) return "yellow";
  return "red";
}

export const TRAFFIC_LABEL: Record<TrafficLight, string> = {
  green: "Últimos 30 días",
  yellow: "Entre 31 y 60 días",
  red: "Más de 60 días",
  gray: "Nunca interactuamos",
};
