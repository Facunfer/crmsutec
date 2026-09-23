import Link from "next/link";
import { TRAFFIC_LABEL, type TrafficLight } from "@/lib/people/traffic";
import type { TrafficKpis } from "@/lib/people/queries";

const ORDER: TrafficLight[] = ["green", "yellow", "red", "gray"];
const TONE: Record<TrafficLight, string> = {
  green: "border-green-300 bg-green-50 text-green-900",
  yellow: "border-yellow-300 bg-yellow-50 text-yellow-900",
  red: "border-red-300 bg-red-50 text-red-900",
  gray: "border-gray-300 bg-gray-50 text-gray-700",
};

/**
 * KPIs = cantidad de PERSONAS por semáforo, sobre los filtros actuales. Cada uno es un enlace que activa ese filtro
 * (y otro clic sobre el activo lo quita). `baseQuery` son los filtros de la URL sin `traffic` ni `page`.
 */
export function TrafficKpiCards({ kpis, active, baseQuery }: { kpis: TrafficKpis; active: TrafficLight | undefined; baseQuery: string }) {
  const href = (light: TrafficLight | null) => {
    const params = new URLSearchParams(baseQuery);
    if (light) params.set("traffic", light);
    const qs = params.toString();
    return qs ? `/personas?${qs}` : "/personas";
  };
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Personas por última interacción">
      {ORDER.map((light) => {
        const isActive = active === light;
        return (
          <Link
            key={light}
            href={href(isActive ? null : light)}
            aria-pressed={isActive}
            className={`rounded-lg border px-4 py-3 shadow-sm transition ${TONE[light]} ${isActive ? "ring-2 ring-brand-600" : "hover:brightness-95"}`}
          >
            <div className="text-2xl font-semibold">{kpis[light].toLocaleString("es-AR")}</div>
            <div className="text-xs">{TRAFFIC_LABEL[light]}</div>
          </Link>
        );
      })}
    </div>
  );
}
