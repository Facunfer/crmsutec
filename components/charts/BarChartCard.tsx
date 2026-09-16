"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Serie } from "@/lib/analytics/queries";

/** Wrapper delgado de Recharts (sección "Componentes reutilizados/adaptados" — Recharts se adapta, no se copia contenido). */
export function BarChartCard({
  title,
  data,
  emptyLabel = "Sin datos todavía.",
  layout = "horizontal",
  color = "#553c8a",
}: {
  title: string;
  data: Serie[];
  emptyLabel?: string;
  layout?: "horizontal" | "vertical";
  color?: string;
}) {
  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-brand-900">{title}</h3>
      {data.length === 0 ? (
        <p className="text-sm text-brand-400">{emptyLabel}</p>
      ) : (
        <div style={{ width: "100%", height: Math.max(180, layout === "vertical" ? data.length * 32 : 220) }}>
          <ResponsiveContainer>
            {layout === "vertical" ? (
              <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e1dbee" horizontal={false} />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="nombre" width={140} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="valor" fill={color} radius={[0, 4, 4, 0]} />
              </BarChart>
            ) : (
              <BarChart data={data} margin={{ left: 8, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e1dbee" vertical={false} />
                <XAxis dataKey="nombre" tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={50} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="valor" fill={color} radius={[4, 4, 0, 0]} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
