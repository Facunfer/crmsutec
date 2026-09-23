"use client";

import { useActionState } from "react";
import { AreaReparticionSelect } from "@/components/organizations/AreaReparticionSelect";
import type { AreaOption, OrgTreeOption } from "@/lib/organizations/areas";
import { updateAffiliationAction, type ActionResult } from "./acciones";

const initialState: ActionResult = { ok: false };

/**
 * Afiliación organizativa del usuario (dónde PERTENECE). Es informativa: cambiarla NO cambia lo que el usuario puede
 * ver; eso se define solo en «Alcances» (user_scopes).
 */
export function AffiliationEditor({
  userId,
  areas,
  orgTree,
  currentOrganizationId,
  editable,
}: {
  userId: string;
  areas: AreaOption[];
  orgTree: OrgTreeOption[];
  currentOrganizationId: string | null;
  editable: boolean;
}) {
  const [state, action, pending] = useActionState(updateAffiliationAction.bind(null, userId), initialState);
  if (!editable) return null;
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 text-sm">
      <span className="text-xs font-medium text-brand-500">Afiliación</span>
      <AreaReparticionSelect areas={areas} tree={orgTree} initialOrganizationId={currentOrganizationId ?? ""} name="primaryOrganizationId" />
      <button type="submit" disabled={pending} className="rounded-md border border-brand-200 px-2 py-1 text-xs text-brand-700 hover:bg-brand-50 disabled:opacity-50">
        {pending ? "Guardando..." : "Guardar afiliación"}
      </button>
      <span className="text-xs text-brand-400">No cambia lo que el usuario puede ver (eso se define en Alcances).</span>
      {state.error ? <span className="text-xs text-estado-riesgo">{state.error}</span> : null}
      {state.ok ? <span className="text-xs text-estado-ok">Guardado.</span> : null}
    </form>
  );
}
