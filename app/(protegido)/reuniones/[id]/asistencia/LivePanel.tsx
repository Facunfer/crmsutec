"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import {
  correctAttendanceAction,
  listAttendanceHistoryAction,
  registerAttendanceAction,
  restoreAttendanceAction,
  revokeAttendanceAction,
  type AttendanceHistoryItem,
  type AttendanceWhenInput,
} from "../acciones";

type Person = { personId: string; firstName: string; lastName: string };

interface LivePanelData {
  meetingStatus: string;
  canManage: boolean;
  invited: number;
  confirmed: number;
  present: number;
  invitedNotArrived: number;
  pendingResponse: number;
  declined: number;
  attendanceRate: number | null;
  arrived: Array<Person & { checkedInAt: string | null; precision: "exact_datetime" | "date_only" | "unknown"; method: string; recordedAt: string }>;
  revoked: Array<Person & { revokedAt: string; reason: string }>;
  confirmedNotArrived: Person[];
  pending: Person[];
  decliners: Person[];
}

interface QuickSearchResult extends Person {
  invited: boolean;
  checkedIn: boolean;
  revoked: boolean;
}

// Cómo se registró (medio) — la identificación es un dato aparte.
const METHOD_LABEL: Record<string, string> = {
  qr: "QR",
  invitation_link: "enlace personal",
  manual: "registro manual",
  invitation_token: "enlace personal",
  dni: "QR (DNI)",
  email: "QR (email)",
  phone: "QR (teléfono)",
};
const EVENT_LABEL: Record<string, string> = { checked_in: "Asistencia registrada", revoked: "Asistencia revocada", restored: "Asistencia restaurada", corrected: "Hora corregida" };

const TZ = "America/Argentina/Buenos_Aires";
const timeFmt = new Intl.DateTimeFormat("es-AR", { timeStyle: "short", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: TZ });

/** Nunca se muestra una hora que no se conoce: solo el día si es `date_only`, «hora desconocida» si no hay dato. */
function whenLabel(iso: string | null, precision: string | null): string {
  if (!iso || precision === "unknown") return "hora desconocida";
  const d = new Date(iso);
  return precision === "date_only" ? `${dayFmt.format(d)} (solo el día)` : timeFmt.format(d);
}

type FormState =
  | { kind: "register" | "correct"; person: Person; defaultMode: AttendanceWhenInput["mode"] }
  | { kind: "revoke" | "restore"; person: Person }
  | { kind: "history"; person: Person };

function ActionForm({
  meetingId,
  meetingStatus,
  state,
  onDone,
}: {
  meetingId: string;
  meetingStatus: string;
  state: Exclude<FormState, { kind: "history" }>;
  onDone: () => void;
}) {
  const withWhen = state.kind === "register" || state.kind === "correct";
  const finished = meetingStatus === "finished";
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<AttendanceWhenInput["mode"]>(withWhen ? (state.kind === "register" && !finished ? "now" : state.defaultMode) : "now");
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const titles = {
    register: "Registrar asistencia",
    correct: "Corregir la hora de la asistencia",
    revoke: "Revocar asistencia (deja de contar; no se borra)",
    restore: "Restaurar asistencia",
  } as const;

  function submit() {
    setError(null);
    if (!reason.trim()) {
      setError("El motivo es obligatorio.");
      return;
    }
    if (withWhen && (mode === "date_only" || mode === "exact") && !day) {
      setError("Elegí el día en que ocurrió.");
      return;
    }
    startTransition(async () => {
      const when: AttendanceWhenInput = { mode, day, time };
      const person = state.person;
      const result =
        state.kind === "register"
          ? await registerAttendanceAction(meetingId, person.personId, { reason, when })
          : state.kind === "correct"
            ? await correctAttendanceAction(meetingId, person.personId, { reason, when: when as Exclude<AttendanceWhenInput, { mode: "now" }> })
            : state.kind === "revoke"
              ? await revokeAttendanceAction(meetingId, person.personId, reason)
              : await restoreAttendanceAction(meetingId, person.personId, reason);
      if (result.ok) onDone();
      else setError(result.error ?? "No se pudo completar la acción.");
    });
  }

  return (
    <div className="space-y-2 rounded-md bg-brand-50 p-3 text-sm text-brand-700">
      <p className="font-medium">
        {titles[state.kind]} — {state.person.firstName} {state.person.lastName}
      </p>
      {withWhen ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1">
            ¿Cuándo ocurrió?
            <select value={mode} onChange={(e) => setMode(e.target.value as AttendanceWhenInput["mode"])} className="rounded border border-brand-200 px-1 py-0.5">
              {state.kind === "register" && !finished ? <option value="now">Ahora</option> : null}
              <option value="exact">Día y hora</option>
              <option value="date_only">Solo el día</option>
              <option value="unknown">No se sabe</option>
            </select>
          </label>
          {mode === "date_only" || mode === "exact" ? <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="rounded border border-brand-200 px-1 py-0.5" /> : null}
          {mode === "exact" ? <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded border border-brand-200 px-1 py-0.5" /> : null}
          {finished && state.kind === "register" ? <span className="text-brand-500">La reunión ya finalizó: es una carga retroactiva y hay que indicar cuándo ocurrió.</span> : null}
        </div>
      ) : null}
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Motivo (obligatorio)"
        className="w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
      />
      {error ? <p className="text-xs text-estado-riesgo">{error}</p> : null}
      <div className="flex gap-2">
        <button type="button" disabled={pending} onClick={submit} className="rounded-md bg-brand-600 px-3 py-1 text-xs text-white hover:bg-brand-700 disabled:opacity-50">
          Confirmar
        </button>
        <button type="button" disabled={pending} onClick={onDone} className="rounded-md border border-brand-200 px-3 py-1 text-xs hover:bg-white">
          Cancelar
        </button>
      </div>
    </div>
  );
}

function History({ meetingId, person, onClose }: { meetingId: string; person: Person; onClose: () => void }) {
  const [events, setEvents] = useState<AttendanceHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    listAttendanceHistoryAction(meetingId, person.personId).then((r) => {
      if (cancelled) return;
      if (r.ok) setEvents(r.events);
      else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [meetingId, person.personId]);
  return (
    <div className="space-y-2 rounded-md bg-brand-50 p-3 text-xs text-brand-700">
      <p className="text-sm font-medium">
        Historial — {person.firstName} {person.lastName}
      </p>
      {error ? <p className="text-estado-riesgo">{error}</p> : events === null ? <p>Cargando…</p> : events.length === 0 ? <p>Sin eventos.</p> : (
        <ol className="space-y-1">
          {events.map((e, i) => (
            <li key={i}>
              <strong>{EVENT_LABEL[e.eventType] ?? e.eventType}</strong> · {dateTimeFmt.format(new Date(e.occurredAt))} · por {e.recordedBy}
              {e.method ? ` · ${METHOD_LABEL[e.method] ?? e.method}` : ""}
              {e.eventType === "checked_in" || e.eventType === "corrected" ? ` · ocurrió: ${whenLabel(e.checkedInAt, e.precision)}` : ""}
              {e.reason ? ` · motivo: ${e.reason}` : ""}
            </li>
          ))}
        </ol>
      )}
      <button type="button" onClick={onClose} className="rounded-md border border-brand-200 px-3 py-1 hover:bg-white">
        Cerrar
      </button>
    </div>
  );
}

export function LivePanel({ meetingId }: { meetingId: string }) {
  const [data, setData] = useState<LivePanelData | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<QuickSearchResult[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [tick, setTick] = useState(0);

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
  }, [meetingId, tick]);

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
  }, [search, meetingId, tick]);

  if (!data) {
    return <p className="text-sm text-brand-400">Cargando panel en vivo...</p>;
  }

  const done = () => {
    setForm(null);
    setTick((t) => t + 1);
  };
  const canManage = data.canManage;
  const person = (p: Person): Person => ({ personId: p.personId, firstName: p.firstName, lastName: p.lastName });
  const linkBtn = "text-xs text-brand-500 underline hover:text-brand-700";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-7">
        <Stat label="Invitados" value={data.invited} />
        <Stat label="Aceptaron" value={data.confirmed} />
        <Stat label="Asistieron" value={data.present} highlight hint="Asistencias vigentes (las revocadas no cuentan)." />
        <Stat label="Pendientes" value={data.pendingResponse} />
        <Stat label="Rechazaron" value={data.declined} />
        <Stat
          label="Sin asistencia registrada"
          value={data.invitedNotArrived}
          hint="Invitados vigentes que todavía no tienen check-in. La falta de check-in no es evidencia de ausencia."
        />
        <Stat
          label="Asistencia sobre invitados"
          value={data.attendanceRate === null ? "—" : `${data.attendanceRate}%`}
          hint="Invitados vigentes con asistencia registrada, sobre el total de invitados vigentes. No incluye a quienes asistieron sin invitación."
        />
      </div>

      {form ? (
        form.kind === "history" ? (
          <History meetingId={meetingId} person={form.person} onClose={() => setForm(null)} />
        ) : (
          <ActionForm meetingId={meetingId} meetingStatus={data.meetingStatus} state={form} onDone={done} />
        )
      ) : null}

      {canManage ? (
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold text-brand-900">Registrar asistencia a mano</h3>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, apellido o DNI..."
            className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm"
          />
          {results.length > 0 ? (
            <ul className="mt-2 divide-y divide-brand-50 text-sm">
              {results.map((r) => (
                <li key={r.personId} className="flex items-center justify-between py-1.5">
                  <span>
                    {r.firstName} {r.lastName}
                    {!r.invited ? <span className="ml-2 text-xs text-brand-400">(sin invitación)</span> : null}
                  </span>
                  {r.checkedIn ? (
                    <span className="text-xs text-estado-ok">ya registrada</span>
                  ) : r.revoked ? (
                    <button type="button" onClick={() => setForm({ kind: "restore", person: person(r) })} className={linkBtn}>
                      revocada: restaurar
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setForm({ kind: "register", person: person(r), defaultMode: data.meetingStatus === "finished" ? "date_only" : "now" })}
                      className="rounded-md bg-brand-600 px-2 py-1 text-xs text-white hover:bg-brand-700"
                    >
                      Registrar asistencia
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <ListCard title={`Asistieron (${data.arrived.length})`}>
          {data.arrived.map((p) => (
            <li key={p.personId} className="flex items-center justify-between py-1 text-sm">
              <span>
                {p.firstName} {p.lastName}
              </span>
              <span className="flex items-center gap-2 text-xs text-brand-400">
                {whenLabel(p.checkedInAt, p.precision)} · {METHOD_LABEL[p.method] ?? p.method}
                {canManage ? (
                  <>
                    <button type="button" onClick={() => setForm({ kind: "history", person: person(p) })} className={linkBtn}>
                      historial
                    </button>
                    {p.method === "manual" ? (
                      <button type="button" onClick={() => setForm({ kind: "correct", person: person(p), defaultMode: p.precision === "exact_datetime" ? "exact" : p.precision })} className={linkBtn}>
                        corregir hora
                      </button>
                    ) : null}
                    <button type="button" onClick={() => setForm({ kind: "revoke", person: person(p) })} className="text-xs text-brand-400 underline hover:text-estado-riesgo">
                      revocar
                    </button>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ListCard>

        <ListCard title={`Aceptaron, sin asistencia registrada (${data.confirmedNotArrived.length})`}>
          {data.confirmedNotArrived.map((p) => (
            <li key={p.personId} className="flex items-center justify-between py-1 text-sm">
              <span>
                {p.firstName} {p.lastName}
              </span>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => setForm({ kind: "register", person: person(p), defaultMode: data.meetingStatus === "finished" ? "date_only" : "now" })}
                  className={linkBtn}
                >
                  registrar asistencia
                </button>
              ) : null}
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

        {canManage ? (
          <ListCard title={`Asistencias revocadas (${data.revoked.length})`}>
            {data.revoked.map((p) => (
              <li key={p.personId} className="flex items-center justify-between py-1 text-sm">
                <span>
                  {p.firstName} {p.lastName}
                  <span className="block text-xs text-brand-400">
                    revocada el {dateTimeFmt.format(new Date(p.revokedAt))} · motivo: {p.reason}
                  </span>
                </span>
                <span className="flex gap-2">
                  <button type="button" onClick={() => setForm({ kind: "history", person: person(p) })} className={linkBtn}>
                    historial
                  </button>
                  <button type="button" onClick={() => setForm({ kind: "restore", person: person(p) })} className={linkBtn}>
                    restaurar
                  </button>
                </span>
              </li>
            ))}
          </ListCard>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value, highlight, hint }: { label: string; value: number | string; highlight?: boolean; hint?: string }) {
  return (
    <div title={hint} className={`rounded-lg p-3 text-center shadow-sm ${highlight ? "bg-brand-600 text-white" : "bg-white text-brand-900"}`}>
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
