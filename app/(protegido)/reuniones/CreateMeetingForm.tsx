"use client";

import { useActionState } from "react";
import type { OrganizationOption } from "@/lib/organizations/queries";
import { createMeetingAction, type MeetingActionResult } from "./acciones";

const initialState: MeetingActionResult = { ok: false };

export function CreateMeetingForm({
  preselectedAssociationId,
  organizations,
}: {
  preselectedAssociationId?: string;
  organizations: OrganizationOption[];
}) {
  const [state, formAction, pending] = useActionState(createMeetingAction, initialState);

  return (
    <form action={formAction} className="max-w-2xl space-y-3 rounded-lg bg-white p-4 shadow-sm">
      {preselectedAssociationId ? <input type="hidden" name="associationId" value={preselectedAssociationId} /> : null}
      <div>
        <label className="block text-xs text-brand-500">Nombre *</label>
        <input name="name" required className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Unidad organizativa *</label>
        <select name="ownerOrganizationId" required className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm">
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-brand-500">Inicio *</label>
          <input name="startsAt" type="datetime-local" required className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Fin *</label>
          <input name="endsAt" type="datetime-local" required className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-brand-500">Lugar</label>
          <input name="locationName" className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Dirección</label>
          <input name="address" className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Descripción</label>
        <textarea name="description" rows={2} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Observaciones</label>
        <textarea name="notes" rows={2} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
      </div>
      {state.error ? <p className="text-sm text-estado-riesgo">{state.error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? "Creando..." : "Crear reunión (borrador)"}
      </button>
    </form>
  );
}
