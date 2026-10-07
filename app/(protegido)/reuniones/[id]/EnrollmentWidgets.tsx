"use client";

import { useEffect, useState, useTransition } from "react";
import type { EnrollmentSearchResult, AcceptedEnrollmentCounts } from "@/lib/meetings/registrations";
import { INVITATION_CHANNELS, INVITATION_CHANNEL_LABEL, RESPONSE_CHANNEL_LABEL } from "@/lib/activities/labels";
import {
  correctEnrollmentAction,
  enrollAcceptedAction,
  enrollPersonAction,
  listEnrollmentHistoryAction,
  previewEnrollAcceptedAction,
  restoreEnrollmentAction,
  searchPeopleForEnrollmentAction,
  voidEnrollmentAction,
  type EnrollmentHistoryItem,
} from "./acciones";

type WhenMode = "now" | "date_only" | "exact" | "unknown";
const TZ = "America/Argentina/Buenos_Aires";
const dayFmt = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: TZ });
const EVENT_LABEL: Record<string, string> = { registered: "Inscripción registrada", voided: "Inscripción anulada", restored: "Inscripción restaurada", corrected: "Inscripción corregida" };

/** Nunca se muestra una fecha que no se conoce. */
function registeredLabel(iso: string | null, precision: string | null): string {
  if (!iso) return "Fecha de inscripción no registrada";
  return precision === "date_only" ? `${dayFmt.format(new Date(iso))} (solo el día)` : dateTimeFmt.format(new Date(iso));
}

function WhenFields({ finished, allowNow, mode, setMode, day, setDay, time, setTime }: {
  finished: boolean; allowNow: boolean; mode: WhenMode; setMode: (m: WhenMode) => void; day: string; setDay: (v: string) => void; time: string; setTime: (v: string) => void;
}) {
  return (
    <>
      <label className="flex items-center gap-1">
        ¿Cuándo se inscribió?
        <select value={mode} onChange={(e) => setMode(e.target.value as WhenMode)} className="rounded border border-brand-200 px-1 py-0.5">
          {allowNow && !finished ? <option value="now">Ahora</option> : null}
          <option value="exact">Día y hora</option>
          <option value="date_only">Solo el día</option>
          <option value="unknown">No se sabe</option>
        </select>
      </label>
      {mode === "date_only" || mode === "exact" ? <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="rounded border border-brand-200 px-1 py-0.5" /> : null}
      {mode === "exact" ? <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded border border-brand-200 px-1 py-0.5" /> : null}
    </>
  );
}

function ChannelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-1">
      Llegó por
      <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded border border-brand-200 px-1 py-0.5">
        {INVITATION_CHANNELS.map((c) => (
          <option key={c} value={c}>
            {INVITATION_CHANNEL_LABEL[c]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Registrar inscripción manual + «Inscribir aceptados». La inscripción NO crea invitación, participación, asistencia ni interacción. */
export function EnrollmentSection({ meetingId, meetingStatus, hasInvitations }: { meetingId: string; meetingStatus: string; hasInvitations: boolean }) {
  const finished = meetingStatus === "finished";
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<EnrollmentSearchResult[]>([]);
  const [chosen, setChosen] = useState<EnrollmentSearchResult | null>(null);
  const [channel, setChannel] = useState<string>("whatsapp");
  const [mode, setMode] = useState<WhenMode>(finished ? "date_only" : "now");
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<AcceptedEnrollmentCounts | null>(null);
  const [result, setResult] = useState<AcceptedEnrollmentCounts | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (search.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timeout = setTimeout(async () => {
      const r = await searchPeopleForEnrollmentAction(meetingId, search);
      if (!cancelled) setResults(r.results);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [search, meetingId]);

  if (meetingStatus === "cancelled") return null;

  function submit() {
    if (!chosen) return;
    setMessage(null);
    if ((mode === "date_only" || mode === "exact") && !day) {
      setMessage({ ok: false, text: "Elegí el día de la inscripción o marcá «No se sabe»." });
      return;
    }
    startTransition(async () => {
      const r = await enrollPersonAction(meetingId, chosen.personId, { channel, when: { mode, day, time }, reason });
      if (r.ok) {
        setMessage({ ok: true, text: r.changed ? "Inscripción registrada." : "Ya figuraba inscripta: no se hizo ningún cambio." });
        setChosen(null);
        setSearch("");
        setReason("");
      } else setMessage({ ok: false, text: r.error ?? "No se pudo registrar." });
    });
  }

  function loadPreview() {
    setMessage(null);
    setResult(null);
    startTransition(async () => {
      const r = await previewEnrollAcceptedAction(meetingId);
      if (r.ok) setPreview(r.counts);
      else setMessage({ ok: false, text: r.error });
    });
  }

  function confirmAccepted() {
    startTransition(async () => {
      const r = await enrollAcceptedAction(meetingId);
      if (r.ok) {
        setResult(r.counts);
        setPreview(null);
      } else setMessage({ ok: false, text: r.error });
    });
  }

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold text-brand-900">Inscripciones</h2>
      <p className="mb-3 text-xs text-brand-400">
        Inscribir a alguien no es invitarlo, ni que haya participado, ni que haya asistido: son hechos distintos. No hace falta invitación previa.
        {finished ? " La actividad ya finalizó: es una carga retroactiva (hay que indicar cuándo se inscribió y el motivo)." : ""}
      </p>

      <input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setChosen(null);
        }}
        placeholder="Buscar por nombre, apellido o DNI para inscribir…"
        className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm"
      />
      {results.length > 0 && !chosen ? (
        <ul className="mt-2 divide-y divide-brand-50 text-sm">
          {results.map((r) => (
            <li key={r.personId} className="flex items-center justify-between py-1.5">
              <span>
                {r.firstName} {r.lastName}
                {r.invited ? <span className="ml-2 text-xs text-brand-400">(invitado)</span> : null}
                {r.registeredAtCampaignLevel ? <span className="ml-2 text-xs text-brand-400">(ya figura inscripta a nivel campaña, sin jornada determinada)</span> : null}
              </span>
              {r.registered ? (
                <span className="text-xs text-estado-ok">ya inscripta</span>
              ) : r.voided ? (
                <span className="text-xs text-brand-500">inscripción anulada: restaurala desde la lista de personas</span>
              ) : (
                <button type="button" onClick={() => setChosen(r)} className="rounded-md bg-brand-600 px-2 py-1 text-xs text-white hover:bg-brand-700">
                  Inscribir
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {chosen ? (
        <div className="mt-3 space-y-2 rounded-md bg-brand-50 p-3 text-xs text-brand-700">
          <p className="text-sm font-medium">
            Registrar inscripción — {chosen.firstName} {chosen.lastName}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <ChannelSelect value={channel} onChange={setChannel} />
            <WhenFields finished={finished} allowNow mode={mode} setMode={setMode} day={day} setDay={setDay} time={time} setTime={setTime} />
          </div>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={finished ? "Motivo (obligatorio en una carga retroactiva)" : "Observación (opcional)"}
            className="w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
          <p className="text-brand-400">Registrar el canal solo deja constancia de por dónde llegó la solicitud: el CRM no envía ningún mensaje.</p>
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={submit} className="rounded-md bg-brand-600 px-3 py-1 text-white hover:bg-brand-700 disabled:opacity-50">
              Confirmar inscripción
            </button>
            <button type="button" disabled={pending} onClick={() => setChosen(null)} className="rounded-md border border-brand-200 px-3 py-1 hover:bg-white">
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      {hasInvitations && !finished ? (
        <div className="mt-4 border-t border-brand-50 pt-3 text-sm">
          <p className="mb-2 text-xs text-brand-400">
            «Inscribir aceptados» inscribe, por única vez y a pedido, a quienes aceptaron la invitación. Aceptar no inscribe solo.
          </p>
          {!preview && !result ? (
            <button type="button" disabled={pending} onClick={loadPreview} className="rounded-md border border-brand-200 px-3 py-1.5 text-xs text-brand-700 hover:bg-brand-50 disabled:opacity-50">
              Inscribir aceptados… (ver vista previa)
            </button>
          ) : null}
          {preview ? (
            <div className="space-y-2 rounded-md bg-brand-50 p-3 text-xs text-brand-700">
              <p className="font-medium">Vista previa (todavía no se creó nada)</p>
              <ul className="list-disc pl-5">
                <li>Aceptaron (dentro de tu alcance): {preview.eligible}</li>
                <li>Ya inscriptos: {preview.alreadyRegistered}</li>
                <li>Con inscripción anulada (no se restauran solos): {preview.voided}</li>
                <li>Se van a inscribir: {preview.created}</li>
                <li>Aceptaron pero están fuera de tu alcance: {preview.outOfScope}</li>
              </ul>
              <div className="flex gap-2">
                <button type="button" disabled={pending || preview.created === 0} onClick={confirmAccepted} className="rounded-md bg-brand-600 px-3 py-1 text-white hover:bg-brand-700 disabled:opacity-50">
                  Confirmar e inscribir a {preview.created}
                </button>
                <button type="button" disabled={pending} onClick={() => setPreview(null)} className="rounded-md border border-brand-200 px-3 py-1 hover:bg-white">
                  Cancelar
                </button>
              </div>
            </div>
          ) : null}
          {result ? (
            <p className="rounded-md bg-estado-ok/10 p-3 text-xs text-estado-ok">
              Listo: {result.created} inscripción(es) creada(s); {result.alreadyRegistered} ya estaban inscriptas; {result.voided} anuladas sin tocar; {result.outOfScope} fuera de tu alcance.
            </p>
          ) : null}
        </div>
      ) : null}

      {message ? <p className={`mt-2 text-xs ${message.ok ? "text-estado-ok" : "text-estado-riesgo"}`}>{message.text}</p> : null}
    </section>
  );
}

export interface RegistrationClientInfo {
  participationId: string;
  active: boolean;
  operative: boolean;
  fromAcceptance: boolean;
  originChannel: string | null;
  registeredAt: string | null;
  registeredAtPrecision: "exact_datetime" | "date_only" | null;
  voidedAt: string | null;
  voidReason: string | null;
  recordedByName: string | null;
}

/** Acciones sobre la inscripción de una persona: anular, restaurar, corregir (solo operativas) e historial. Solo con permiso. */
export function EnrollmentRowActions({ meetingId, registration }: { meetingId: string; registration: RegistrationClientInfo }) {
  const [form, setForm] = useState<"void" | "restore" | "correct" | "history" | null>(null);
  const [reason, setReason] = useState("");
  const [channel, setChannel] = useState<string>(registration.originChannel ?? "whatsapp");
  const [mode, setMode] = useState<WhenMode>(registration.registeredAtPrecision === "exact_datetime" ? "exact" : registration.registeredAtPrecision === "date_only" ? "date_only" : "unknown");
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<EnrollmentHistoryItem[] | null>(null);
  const [pending, startTransition] = useTransition();
  const linkBtn = "text-xs text-brand-500 underline hover:text-brand-700";

  useEffect(() => {
    if (form !== "history") return;
    let cancelled = false;
    setEvents(null);
    listEnrollmentHistoryAction(registration.participationId).then((r) => {
      if (cancelled) return;
      if (r.ok) setEvents(r.events);
      else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [form, registration.participationId]);

  function close() {
    setForm(null);
    setReason("");
    setError(null);
  }

  function submit() {
    setError(null);
    if (!reason.trim()) {
      setError("El motivo es obligatorio.");
      return;
    }
    if (form === "correct" && (mode === "date_only" || mode === "exact") && !day) {
      setError("Elegí el día o marcá «No se sabe».");
      return;
    }
    startTransition(async () => {
      const r =
        form === "void"
          ? await voidEnrollmentAction(meetingId, registration.participationId, reason)
          : form === "restore"
            ? await restoreEnrollmentAction(meetingId, registration.participationId, reason)
            : await correctEnrollmentAction(meetingId, registration.participationId, {
                reason,
                when: { mode: mode === "now" ? "unknown" : mode, day, time } as never,
                channel: registration.fromAcceptance ? undefined : channel,
              });
      if (r.ok) close();
      else setError(r.error ?? "No se pudo completar la acción.");
    });
  }

  return (
    <div className="mt-1 space-y-1">
      <div className="flex flex-wrap gap-3">
        {registration.active ? (
          <button type="button" onClick={() => setForm("void")} className={linkBtn}>
            anular inscripción
          </button>
        ) : (
          <button type="button" onClick={() => setForm("restore")} className={linkBtn}>
            restaurar inscripción
          </button>
        )}
        {registration.active && registration.operative ? (
          <button type="button" onClick={() => setForm("correct")} className={linkBtn}>
            corregir fecha/canal
          </button>
        ) : null}
        {registration.operative ? (
          <button type="button" onClick={() => setForm("history")} className={linkBtn}>
            historial
          </button>
        ) : null}
      </div>
      {!registration.active ? (
        <p className="text-xs text-brand-400">
          Inscripción anulada{registration.voidedAt ? ` el ${dateTimeFmt.format(new Date(registration.voidedAt))}` : ""}
          {registration.voidReason ? ` · motivo: ${registration.voidReason}` : ""}
        </p>
      ) : (
        <p className="text-xs text-brand-400">
          {registration.operative
            ? `${registration.fromAcceptance ? "Desde la aceptación de la invitación" : `Canal: ${registration.originChannel ? (RESPONSE_CHANNEL_LABEL[registration.originChannel as keyof typeof RESPONSE_CHANNEL_LABEL] ?? registration.originChannel) : "—"}`}${registration.recordedByName ? ` · cargada por ${registration.recordedByName}` : ""} · `
            : "Inscripción según listado importado · "}
          {registeredLabel(registration.registeredAt, registration.registeredAtPrecision)}
        </p>
      )}
      {form && form !== "history" ? (
        <div className="space-y-2 rounded-md bg-brand-50 p-3 text-xs text-brand-700">
          <p className="font-medium">{form === "void" ? "Anular inscripción (la fila no se borra; no afecta participación ni asistencia)" : form === "restore" ? "Restaurar inscripción" : "Corregir fecha y canal de la inscripción"}</p>
          {form === "correct" ? (
            <div className="flex flex-wrap items-center gap-3">
              {registration.fromAcceptance ? null : <ChannelSelect value={channel} onChange={setChannel} />}
              <WhenFields finished allowNow={false} mode={mode} setMode={setMode} day={day} setDay={setDay} time={time} setTime={setTime} />
            </div>
          ) : null}
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (obligatorio)" className="w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
          {error ? <p className="text-estado-riesgo">{error}</p> : null}
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={submit} className="rounded-md bg-brand-600 px-3 py-1 text-white hover:bg-brand-700 disabled:opacity-50">
              Confirmar
            </button>
            <button type="button" disabled={pending} onClick={close} className="rounded-md border border-brand-200 px-3 py-1 hover:bg-white">
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
      {form === "history" ? (
        <div className="space-y-1 rounded-md bg-brand-50 p-3 text-xs text-brand-700">
          {error ? <p className="text-estado-riesgo">{error}</p> : events === null ? <p>Cargando…</p> : events.length === 0 ? <p>Sin eventos.</p> : (
            <ol className="space-y-1">
              {events.map((e, i) => (
                <li key={i}>
                  <strong>{EVENT_LABEL[e.eventType] ?? e.eventType}</strong> · {dateTimeFmt.format(new Date(e.occurredAt))} · por {e.recordedBy}
                  {e.eventType === "registered" ? (e.fromAcceptance ? " · desde la aceptación de la invitación" : e.originChannel ? ` · canal: ${INVITATION_CHANNEL_LABEL[e.originChannel as keyof typeof INVITATION_CHANNEL_LABEL] ?? e.originChannel}` : "") : ""}
                  {e.eventType === "registered" || e.eventType === "corrected" ? ` · ${registeredLabel(e.registeredAt, e.precision)}` : ""}
                  {e.reason ? ` · motivo: ${e.reason}` : ""}
                </li>
              ))}
            </ol>
          )}
          <button type="button" onClick={close} className="rounded-md border border-brand-200 px-3 py-1 hover:bg-white">
            Cerrar
          </button>
        </div>
      ) : null}
    </div>
  );
}
