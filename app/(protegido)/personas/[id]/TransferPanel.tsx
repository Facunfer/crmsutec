"use client";

import { useActionState } from "react";
import type { AreaOption, OrgTreeOption } from "@/lib/organizations/areas";
import { AreaReparticionSelect } from "@/components/organizations/AreaReparticionSelect";
import {
  assignInitialOrganizationAction,
  transferPersonAction,
  type TransferActionResult,
} from "../acciones";

const initialState: TransferActionResult = { ok: false };

export function TransferPanel({
  personId,
  currentOrganizationId,
  areas,
  orgTree,
}: {
  personId: string;
  currentOrganizationId: string | null;
  /** Ya acotadas al alcance del actor (mismas que arma la ficha para PersonForm): el servidor vuelve a validar el
   * destino igual (lib/people/transfers.ts + transfer_person en la base, migración 0030). */
  areas: AreaOption[];
  orgTree: OrgTreeOption[];
}) {
  const [state, formAction, pending] = useActionState(
    (currentOrganizationId ? transferPersonAction : assignInitialOrganizationAction).bind(null, personId),
    initialState
  );

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <AreaReparticionSelect
        areas={areas}
        tree={orgTree.filter((o) => o.id !== currentOrganizationId)}
        areaLabel={currentOrganizationId ? "Trasladar a Área" : "Área"}
        reparticionLabel="Repartición"
        required
      />
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
