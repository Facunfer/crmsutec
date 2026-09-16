"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { setAttendanceManuallyAction } from "../acciones";

interface LivePanelData {
  invited: number;
  confirmed: number;
  present: number;
  absentSoFar: number;
  pendingResponse: number;
  declined: number;
  attendanceRate: number | null;
  arrived: Array<{ personId: string; firstName: string; lastName: string; checkedInAt: string; method: string }>;
  confirmedNotArrived: Array<{ personId: string; firstName: string; lastName: string }>;
  pending: Array<{ personId: string; firstName: string; lastName: string }>;
  decliners: Array<{ personId: string; firstName: string; lastName: string }>;
}

interface QuickSearchResult {
  personId: string;
  firstName: string;
  lastName: string;
  invited: boolean;
  checkedIn: boolean;
}

const METHOD_LABEL: Record<string, string> = {
  invitation_token: "enlace personal",
  dni: "DNI",
  email: "email",
  phone: "teléfono",
  manual: "manual",
};

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("es-AR", { timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(iso));
}

export function LivePanel({ meetingId }: { meetingId: string }) {
  const [data, setData] = useState<LivePanelData | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<QuickSearchResult[]>([]);
  const [pending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchLive() {
      try {
        const res = await fetch(`/api/reuniones/${meetingId}/live`, { cache: "no-store" });
        if (!res.ok) return;
        const json: LivePanelData = await res.json();
        if (!cancelled) setData(json);
      } catch {
        // se reintenta solo, no hace falta mostrar error acá
      }
    }
    fetchLive();
    const interval = setInterval(fetchLive, 4_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [meetingId]);

  useEffect(() => {
    if (search.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/reuniones/${meetingId}/live?q=${encodeURIComponent(search)}`, { cache: "no-store" });
        if (!res.ok) return;
        const json: { results: QuickSearchResult[] } = await res.json();
        if (!cancelled) setResults(json.results);
      } catch {
        // silencioso
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [search, meetingId]);

  function markAttendance(personId: string, status: "attended" | "absent", suggestedReason: string) {
    const reason = window.prompt(
      status === "attended" ? "Motivo de la acreditación manual (obligatorio):" : "Motivo de la corrección a ausente (obligatorio):",
      suggestedReason
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setActionError("El motivo es obligatorio.");
      return;
    }
    startTransition(async () => {
      const result = await setAttendanceManuallyAction(meetingId, personId, status, reason);
      setActionError(result.ok ? null : result.error ?? "No se pudo registrar.");
    });
  }

  if (!data) {
    return <p className="text-sm text-brand-400">Cargando panel en vivo...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        <Stat label="Invitados" value={data.invited} />
        <Stat label="Confirmaron" value={data.confirmed} />
        <Stat label="Presentes" value={data.present} highlight />
        <Stat label="Pendientes" value={data.pendingResponse} />
        <Stat label="Rechazaron" value={data.declined} />
        <Stat label="% asistencia" value={data.attendanceRate === null ? "—" : `${data.attendanceRate}%`} />
      </div>

      <div className="rounded-lg bg-white p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-brand-900">Acreditar a mano</h3>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre, apellido o DNI..."
          className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm"
        />
        {actionError ? <p className="mt-1 text-xs text-estado-riesgo">{actionError}</p> : null}
        {results.length > 0 ? (
          <ul className="mt-2 divide-y divide-brand-50 text-sm">
            {results.map((r) => (
              <li key={r.personId} className="flex items-center justify-between py-1.5">
                <span>
                  {r.firstName} {r.lastName}
                  {!r.invited ? <span className="ml-2 text-xs text-brand-400">(no invitado)</span> : null}
                </span>
                {r.checkedIn ? (
                  <span className="text-xs text-estado-ok">ya presente</span>
                ) : (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => markAttendance(r.personId, "attended", "Acreditación manual en mesa")}
                    className="rounded-md bg-brand-600 px-2 py-1 text-xs text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    Marcar presente
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ListCard title={`Llegaron (${data.arrived.length})`}>
          {data.arrived.map((p) => (
            <li key={p.personId} className="flex items-center justify-between py-1 text-sm">
              <span>
                {p.firstName} {p.lastName}
              </span>
              <span className="flex items-center gap-2 text-xs text-brand-400">
                {formatTime(p.checkedInAt)} · {METHOD_LABEL[p.method] ?? p.method}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => markAttendance(p.personId, "absent", "Corrección manual: no estuvo presente")}
                  className="text-brand-400 underline hover:text-estado-riesgo disabled:opacity-50"
                >
                  corregir
                </button>
              </span>
            </li>
          ))}
        </ListCard>

        <ListCard title={`Confirmaron, no llegaron (${data.confirmedNotArrived.length})`}>
          {data.confirmedNotArrived.map((p) => (
            <li key={p.personId} className="flex items-center justify-between py-1 text-sm">
              <span>
                {p.firstName} {p.lastName}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => markAttendance(p.personId, "attended", "Acreditación manual en mesa")}
                className="text-xs text-brand-500 underline hover:text-brand-700 disabled:opacity-50"
              >
                marcar presente
              </button>
            </li>
          ))}
        </ListCard>

        <ListCard title={`Pendientes de responder (${data.pending.length})`}>
          {data.pending.map((p) => (
            <li key={p.personId} className="py-1 text-sm">
              {p.firstName} {p.lastName}
            </li>
          ))}
        </ListCard>

        <ListCard title={`Rechazaron (${data.decliners.length})`}>
          {data.decliners.map((p) => (
            <li key={p.personId} className="py-1 text-sm">
              {p.firstName} {p.lastName}
            </li>
          ))}
        </ListCard>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-3 text-center shadow-sm ${highlight ? "bg-brand-600 text-white" : "bg-white text-brand-900"}`}>
      <p className="text-xl font-semibold">{value}</p>
      <p className={`text-xs ${highlight ? "text-brand-100" : "text-brand-400"}`}>{label}</p>
    </div>
  );
}

function ListCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <h3 className="mb-2 text-sm font-semibold text-brand-900">{title}</h3>
      <ul className="max-h-64 divide-y divide-brand-50 overflow-y-auto">{children}</ul>
    </div>
  );
}
