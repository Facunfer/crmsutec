"use client";

import { useState, useTransition } from "react";
import { formatActivityContext, formatTimelineDate } from "@/lib/people/timeline-format";
import type { ClientTimelineEvent, ClientTimelinePage } from "@/lib/people/timeline-client";
import { loadTimelineAction } from "./timeline-actions";

type Category = "contact" | "invitation" | "registration" | "participation" | "attendance";
const CHIPS: Array<{ key: Category | null; label: string }> = [
  { key: null, label: "Todo" },
  { key: "contact", label: "Contactos" },
  { key: "invitation", label: "Invitaciones" },
  { key: "registration", label: "Inscripciones" },
  { key: "participation", label: "Actividades" },
  { key: "attendance", label: "Asistencia" },
];

function EventRow({ e }: { e: ClientTimelineEvent }) {
  const activityName = e.activity ? (e.activity.name ?? "Actividad de otra unidad") : null;
  const context = e.at === null ? formatActivityContext(e.activityDate, e.activityDate ? "date_only" : null) : null;
  return (
    <li className="border-b border-brand-50 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="w-36 shrink-0 text-xs text-brand-500">{formatTimelineDate(e.at, e.precision)}</span>
        <span className="text-sm font-medium text-brand-900">{e.title}</span>
        {e.countsAsContact ? (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800">Contacto real</span>
        ) : e.administrative ? null : (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">No cuenta como contacto</span>
        )}
        {e.administrative ? <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[11px] text-brand-700">Acto administrativo</span> : null}
      </div>
      <div className="mt-0.5 space-y-0.5 text-xs text-brand-600 sm:ml-[10.5rem]">
        {activityName ? (
          <div>
            {activityName}
            {e.activity?.type === "campaign" && e.category === "participation" ? " — jornada no determinada" : ""}
            {context ? ` (${context})` : ""}
          </div>
        ) : null}
        {e.description ? <div>{e.description}</div> : null}
        {e.origin ? <div>Canal / origen: {e.origin}</div> : null}
        {e.provenance.map((p) => (
          <div key={p} className="text-brand-400">{p}</div>
        ))}
        {e.recordedBy ? <div className="text-brand-400">Registró: {e.recordedBy}</div> : null}
        {e.details.map((d) => (
          <div key={d} className="text-brand-500">{d}</div>
        ))}
      </div>
    </li>
  );
}

/**
 * Línea de tiempo de la persona. Los hechos con fecha van ordenados (más reciente primero); los que no tienen fecha real van aparte,
 * al final, en «Eventos sin fecha registrada» (nunca se ordenan con created_at ni con la fecha de importación).
 */
export function PersonTimeline({ personId, initial }: { personId: string; initial: ClientTimelinePage }) {
  const [category, setCategory] = useState<Category | null>(null);
  const [events, setEvents] = useState(initial.events);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const counts = initial.counts;

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const apply = (next: Category | null) => {
    setCategory(next);
    setError(null);
    start(async () => {
      const page = await loadTimelineAction(personId, next, null);
      if (!page) return setError("No se pudo cargar la línea de tiempo.");
      setEvents(page.events);
      setCursor(page.nextCursor);
    });
  };
  const more = () =>
    start(async () => {
      const page = await loadTimelineAction(personId, category, cursor);
      if (!page) return setError("No se pudo cargar la línea de tiempo.");
      setEvents((prev) => [...prev, ...page.events]);
      setCursor(page.nextCursor);
    });

  const dated = events.filter((e) => e.at !== null);
  const undated = events.filter((e) => e.at === null);
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="Filtrar línea de tiempo">
        {CHIPS.map((c) => {
          const n = c.key === null ? total : counts[c.key];
          const active = category === c.key;
          return (
            <button
              key={c.label}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={pending}
              onClick={() => apply(c.key)}
              className={`rounded-full border px-3 py-1 text-xs ${active ? "border-brand-600 bg-brand-600 text-white" : "border-brand-200 text-brand-700 hover:bg-brand-50"}`}
            >
              {c.label} ({n})
            </button>
          );
        })}
      </div>
      {error ? <p className="mb-2 text-xs text-red-700">{error}</p> : null}
      {events.length === 0 ? (
        <p className="text-sm text-brand-400">No hay hechos registrados{category ? " en esta categoría" : ""}.</p>
      ) : (
        <>
          {dated.length > 0 ? <ul>{dated.map((e) => <EventRow key={e.id} e={e} />)}</ul> : null}
          {undated.length > 0 ? (
            <div className="mt-4">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-400">Eventos sin fecha registrada</h3>
              <p className="mb-1 text-xs text-brand-400">Hechos históricos cuya fecha real no existe. No se ordenan con fechas técnicas ni de importación.</p>
              <ul>{undated.map((e) => <EventRow key={e.id} e={e} />)}</ul>
            </div>
          ) : null}
        </>
      )}
      {cursor ? (
        <button type="button" disabled={pending} onClick={more} className="mt-3 rounded-md border border-brand-200 px-3 py-1.5 text-xs text-brand-700 hover:bg-brand-50">
          {pending ? "Cargando…" : "Cargar más"}
        </button>
      ) : null}
    </div>
  );
}
