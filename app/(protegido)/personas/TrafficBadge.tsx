import { TRAFFIC_LABEL, type TrafficLight } from "@/lib/people/traffic";

const COLOR: Record<TrafficLight, string> = {
  green: "bg-green-100 text-green-800 ring-green-300",
  yellow: "bg-yellow-100 text-yellow-800 ring-yellow-300",
  red: "bg-red-100 text-red-800 ring-red-300",
  gray: "bg-gray-100 text-gray-600 ring-gray-300",
};

const SHORT: Record<TrafficLight, string> = { green: "Verde", yellow: "Amarillo", red: "Rojo", gray: "Gris" };

/** Semáforo de una persona (badge). El color siempre va acompañado de texto: no depende solo del color. */
export function TrafficBadge({ light }: { light: TrafficLight }) {
  return (
    <span title={TRAFFIC_LABEL[light]} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${COLOR[light]}`}>
      {SHORT[light]}
    </span>
  );
}
