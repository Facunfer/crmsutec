import { METRIC_HINT, METRIC_LABEL, METRIC_ORDER, factChips, metricText, type ActivityMetrics, type FactChip, type PersonActivityFacts } from "@/lib/activities/labels";

const TONE: Record<FactChip["tone"], string> = {
  neutral: "bg-gray-100 text-gray-700",
  positive: "bg-green-100 text-green-800",
  negative: "bg-red-100 text-red-800",
  info: "bg-blue-100 text-blue-800",
};

/** Los siete conteos de una actividad. «No disponible» / «Sin información» se muestran como texto, nunca como 0. */
export function MetricsPanel({ metrics, caption }: { metrics: ActivityMetrics; caption?: string }) {
  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4 lg:grid-cols-7">
        {METRIC_ORDER.map((key) => {
          const m = metrics[key];
          return (
            <div key={key} title={METRIC_HINT[key]}>
              <dt className="text-brand-400">{METRIC_LABEL[key]}</dt>
              <dd className={m.kind === "value" ? "text-lg font-semibold text-brand-900" : "text-sm text-brand-500"}>{metricText(m)}</dd>
            </div>
          );
        })}
      </dl>
      <p className="mt-3 text-xs text-brand-400">
        {caption ??
          "Personas distintas dentro de tu alcance. Inscriptos, Participaron y Asistieron se solapan: no se suman. Participar según un registro no es asistir: la asistencia solo se registra por check-in real."}
      </p>
    </div>
  );
}

/** Hechos independientes de una persona en la actividad (nunca un único «estado efectivo»). La procedencia queda en el tooltip. */
export function FactChips({ facts, provenance }: { facts: PersonActivityFacts; provenance?: string }) {
  const chips = factChips(facts);
  if (chips.length === 0) return <span className="text-xs text-brand-400">Sin hechos registrados</span>;
  return (
    <span className="flex flex-wrap gap-1" title={provenance}>
      {chips.map((c) => (
        <span key={c.key} className={`rounded-full px-2 py-0.5 text-xs ${TONE[c.tone]}`}>
          {c.label}
        </span>
      ))}
    </span>
  );
}
