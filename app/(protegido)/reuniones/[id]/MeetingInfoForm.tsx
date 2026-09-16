"use client";

import { useActionState } from "react";
import { updateMeetingAction, type MeetingActionResult } from "../acciones";

const initialState: MeetingActionResult = { ok: false };

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function MeetingInfoForm({
  meetingId,
  name,
  description,
  startsAt,
  endsAt,
  locationName,
  address,
  notes,
}: {
  meetingId: string;
  name: string;
  description: string;
  startsAt: Date;
  endsAt: Date;
  locationName: string;
  address: string;
  notes: string;
}) {
  const [state, formAction, pending] = useActionState(updateMeetingAction.bind(null, meetingId), initialState);

  return (
    <form action={formAction} className="max-w-2xl space-y-3">
      <div>
        <label className="block text-xs text-brand-500">Nombre *</label>
        <input name="name" defaultValue={name} required className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-brand-500">Inicio *</label>
          <input
            name="startsAt"
            type="datetime-local"
            defaultValue={toLocalInputValue(startsAt)}
            required
            className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Fin *</label>
          <input
            name="endsAt"
            type="datetime-local"
            defaultValue={toLocalInputValue(endsAt)}
            required
            className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-brand-500">Lugar</label>
          <input name="locationName" defaultValue={locationName} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Dirección</label>
          <input name="address" defaultValue={address} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Descripción</label>
        <textarea name="description" defaultValue={description} rows={2} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Observaciones</label>
        <textarea name="notes" defaultValue={notes} rows={2} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
      </div>
      {state.error ? <p className="text-sm text-estado-riesgo">{state.error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? "Guardando..." : "Guardar"}
      </button>
    </form>
  );
}
