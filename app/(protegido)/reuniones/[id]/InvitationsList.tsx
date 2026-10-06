"use client";

import { useState, useTransition } from "react";
import type { InvitationRow } from "@/lib/meetings/invitations";
import {
  INVITATION_CHANNEL_LABEL,
  INVITATION_RESPONSE_LABEL,
  RESPONSE_CHANNEL_LABEL,
  STAFF_RESPONSE_CHANNELS,
  type InvitationResponse,
} from "@/lib/activities/labels";
import { recordInvitationResponseAction, withdrawInvitationAction } from "./acciones";

const TZ = "America/Argentina/Buenos_Aires";
const dayFmt = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: TZ });

function channelLabel(c: string | null, table: Record<string, string>): string {
  return c ? (table[c] ?? c) : "";
}

/** Fecha de la respuesta: solo el día si solo se conoce el día; «fecha no registrada» si se desconoce (nunca una fecha inventada). */
function respondedLabel(inv: InvitationRow): string {
  if (inv.responseStatus === "pending") return "";
  if (!inv.respondedAt) return "fecha no registrada";
  return (inv.respondedAtPrecision === "date_only" ? dayFmt : dateTimeFmt).format(inv.respondedAt);
}

function RecordResponseForm({ meetingId, invitation, onDone }: { meetingId: string; invitation: InvitationRow; onDone: () => void }) {
  const [response, setResponse] = useState<"confirmed" | "declined">(invitation.responseStatus === "declined" ? "declined" : "confirmed");
  const [channel, setChannel] = useState<string>("whatsapp");
  const [dateMode, setDateMode] = useState<"unknown" | "date_only" | "exact">("unknown");
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    if (dateMode !== "unknown" && !day) {
      setError("Elegí el día de la respuesta o marcá «No se sabe cuándo respondió».");
      return;
    }
    startTransition(async () => {
      const result = await recordInvitationResponseAction(meetingId, invitation.id, { response, channel, dateMode, day, time });
      if (result.ok) onDone();
      else setError(result.error ?? "No se pudo registrar la respuesta.");
    });
  }

  return (
    <div className="mt-2 space-y-2 rounded-md bg-brand-50 p-3 text-xs text-brand-700">
      <p>
        Registrás una respuesta que la persona te dio por otro medio. Queda guardado que la cargaste vos y por qué canal llegó.
        {" "}No se envía ningún mensaje.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1">
          Respuesta
          <select value={response} onChange={(e) => setResponse(e.target.value as "confirmed" | "declined")} className="rounded border border-brand-200 px-1 py-0.5">
            <option value="confirmed">Aceptó</option>
            <option value="declined">Rechazó</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          Llegó por
          <select value={channel} onChange={(e) => setChannel(e.target.value)} className="rounded border border-brand-200 px-1 py-0.5">
            {STAFF_RESPONSE_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {INVITATION_CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          ¿Cuándo respondió?
          <select value={dateMode} onChange={(e) => setDateMode(e.target.value as "unknown" | "date_only" | "exact")} className="rounded border border-brand-200 px-1 py-0.5">
            <option value="unknown">No se sabe</option>
            <option value="date_only">Solo el día</option>
            <option value="exact">Día y hora</option>
          </select>
        </label>
        {dateMode !== "unknown" ? <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="rounded border border-brand-200 px-1 py-0.5" /> : null}
        {dateMode === "exact" ? <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded border border-brand-200 px-1 py-0.5" /> : null}
      </div>
      {error ? <p className="text-estado-riesgo">{error}</p> : null}
      <div className="flex gap-2">
        <button type="button" disabled={pending} onClick={submit} className="rounded-md bg-brand-600 px-3 py-1 text-white hover:bg-brand-700 disabled:opacity-50">
          Guardar respuesta
        </button>
        <button type="button" disabled={pending} onClick={onDone} className="rounded-md border border-brand-200 px-3 py-1 hover:bg-white">
          Cancelar
        </button>
      </div>
    </div>
  );
}

export function InvitationsList({
  meetingId,
  invitations,
  canManage,
}: {
  meetingId: string;
  invitations: InvitationRow[];
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);

  const active = invitations.filter((i) => !i.withdrawn);

  function withdraw(invitationId: string) {
    startTransition(async () => {
      const result = await withdrawInvitationAction(meetingId, invitationId);
      setError(result.ok ? null : result.error ?? "No se pudo quitar.");
    });
  }

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold text-brand-900">Invitados ({active.length})</h2>
      <p className="mb-3 text-xs text-brand-400">
        El canal de invitación es un registro: indica por dónde se invitó, no que el CRM haya enviado algo. Respuesta y asistencia son cosas distintas: aceptar no implica asistir.
      </p>
      {error ? <p className="mb-2 text-sm text-estado-riesgo">{error}</p> : null}
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-brand-100 text-xs uppercase text-brand-400">
            <th className="py-1.5 pr-4">Persona</th>
            <th className="py-1.5 pr-4">Invitación</th>
            <th className="py-1.5 pr-4">Respuesta</th>
            <th className="py-1.5 pr-4">Asistencia comprobada</th>
            {canManage ? <th className="py-1.5 pr-4"></th> : null}
          </tr>
        </thead>
        <tbody>
          {active.map((inv) => {
            const responded = inv.responseStatus !== "pending";
            const invitedTitle = [
              inv.invitedByName ? `Invitó: ${inv.invitedByName}` : null,
              inv.invitationChannel ? `Canal registrado: ${channelLabel(inv.invitationChannel, INVITATION_CHANNEL_LABEL)} (el CRM no envió el mensaje)` : "Canal no registrado",
            ]
              .filter(Boolean)
              .join(" · ");
            const respondedTitle = responded
              ? [
                  inv.respondedByPerson ? "Respondió la propia persona por su enlace" : inv.responseRecordedByName ? `Registrada por ${inv.responseRecordedByName}` : "Registrada por un operador",
                  inv.responseRecordedAt ? `Guardada el ${dateTimeFmt.format(inv.responseRecordedAt)}` : null,
                  inv.respondedAt && inv.respondedAtPrecision === "date_only" ? "Se conoce solo el día de la respuesta" : null,
                  !inv.respondedAt ? "No se conoce cuándo respondió" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : undefined;
            return (
              <tr key={inv.id} className="border-b border-brand-50 align-top">
                <td className="py-1.5 pr-4">
                  {inv.firstName} {inv.lastName}
                </td>
                <td className="py-1.5 pr-4" title={invitedTitle}>
                  {dayFmt.format(inv.invitedAt)}
                  {inv.invitationChannel ? <span className="block text-xs text-brand-400">{channelLabel(inv.invitationChannel, INVITATION_CHANNEL_LABEL)}</span> : null}
                </td>
                <td className="py-1.5 pr-4" title={respondedTitle}>
                  {INVITATION_RESPONSE_LABEL[inv.responseStatus as InvitationResponse] ?? inv.responseStatus}
                  {responded ? (
                    <span className="block text-xs text-brand-400">
                      {respondedLabel(inv)} · {channelLabel(inv.responseChannel, RESPONSE_CHANNEL_LABEL)}
                      {!inv.respondedByPerson ? " · cargada por operador" : ""}
                    </span>
                  ) : null}
                </td>
                <td className="py-1.5 pr-4">{inv.attended ? "Asistió" : "Sin asistencia registrada"}</td>
                {canManage ? (
                  <td className="py-1.5 pr-4">
                    <div className="flex gap-3">
                      <button type="button" disabled={pending} onClick={() => setRecordingId(recordingId === inv.id ? null : inv.id)} className="text-xs text-brand-600 hover:underline disabled:opacity-50">
                        {responded ? "corregir respuesta" : "registrar respuesta"}
                      </button>
                      <button type="button" disabled={pending} onClick={() => withdraw(inv.id)} className="text-xs text-brand-500 hover:underline disabled:opacity-50">
                        quitar
                      </button>
                    </div>
                    {recordingId === inv.id ? <RecordResponseForm meetingId={meetingId} invitation={inv} onDone={() => setRecordingId(null)} /> : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {active.length === 0 ? <p className="py-2 text-sm text-brand-400">Todavía no hay invitados.</p> : null}
    </section>
  );
}
