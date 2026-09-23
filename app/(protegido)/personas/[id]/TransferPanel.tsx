"use client";

import { useActionState } from "react";
import type { OrganizationOption } from "@/lib/organizations/queries";
import {
  assignInitialOrganizationAction,
  transferPersonAction,
  type TransferActionResult,
} from "../acciones";

const initialState: TransferActionResult = { ok: false };

export function TransferPanel({
  personId,
  currentOrganizationId,
  destinations,
}: {
  personId: string;
  currentOrganizationId: string | null;
  destinations: OrganizationOption[];
}) {
  const [state, formAction, pending] = useActionState(
    (currentOrganizationId ? transferPersonAction : assignInitialOrganizationAction).bind(null, personId),
    initialState
  );
  const options = destinations.filter((o) => o.id !== currentOrganizationId);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div>
        <label className="block text-xs text-brand-500">
          {currentOrganizationId ? "Trasladar a" : "Asignar unidad"}
        </label>
        <select name="organizationId" required className="mt-1 rounded-md border border-brand-200 px-2 py-1.5 text-sm">
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {currentOrganizationId ? (
        <div>
          <label className="block text-xs text-brand-500">Motivo (obligatorio)</label>
          <input name="reason" required className="mt-1 w-64 rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {currentOrganizationId ? "Trasladar" : "Asignar"}
      </button>
      {state.error ? <p className="w-full text-sm text-estado-riesgo">{state.error}</p> : null}
      {state.ok ? <p className="w-full text-sm text-estado-ok">Listo.</p> : null}
    </form>
  );
}
