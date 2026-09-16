"use client";

import { useActionState } from "react";
import type { OrganizationItem, OrganizationTypeItem } from "@/lib/organizations/queries";
import { toggleOrganizationActiveAction, updateOrganizationAction, type ActionResult } from "./acciones";

const initialState: ActionResult = { ok: false };

export function OrganizationRow({
  organization,
  types,
  organizations,
}: {
  organization: OrganizationItem;
  types: OrganizationTypeItem[];
  organizations: OrganizationItem[];
}) {
  const [updateState, updateAction, updatePending] = useActionState(
    updateOrganizationAction.bind(null, organization.id),
    initialState
  );
  const [toggleState, toggleAction, togglePending] = useActionState(
    toggleOrganizationActiveAction.bind(null, organization.id, !organization.active),
    initialState
  );

  return (
    <tr className="border-b border-brand-50 align-top">
      <td className="py-2 pr-4">
        <form action={updateAction} className="flex flex-wrap items-center gap-2">
          <input
            name="name"
            defaultValue={organization.name}
            disabled={updatePending}
            className="w-40 rounded-md border border-brand-200 px-2 py-1 text-xs"
          />
          <select
            name="typeId"
            defaultValue={organization.typeId}
            disabled={updatePending}
            className="rounded-md border border-brand-200 px-2 py-1 text-xs"
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            name="parentId"
            defaultValue={organization.parentId ?? ""}
            disabled={updatePending}
            className="rounded-md border border-brand-200 px-2 py-1 text-xs"
          >
            <option value="">— ninguno —</option>
            {organizations
              .filter((o) => o.id !== organization.id)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </select>
          <button type="submit" disabled={updatePending} className="text-xs text-brand-600 hover:underline">
            guardar
          </button>
        </form>
        {updateState.error ? <p className="mt-1 text-xs text-estado-riesgo">{updateState.error}</p> : null}
      </td>
      <td className="py-2 pr-4">
        <span
          className={
            organization.active
              ? "rounded-full bg-estado-ok/10 px-2 py-0.5 text-xs text-estado-ok"
              : "rounded-full bg-brand-100 px-2 py-0.5 text-xs text-brand-400"
          }
        >
          {organization.active ? "Activo" : "Inactivo"}
        </span>
      </td>
      <td className="py-2 pr-4">
        <form action={toggleAction}>
          <button type="submit" disabled={togglePending} className="text-xs text-brand-600 hover:underline">
            {organization.active ? "Desactivar" : "Reactivar"}
          </button>
        </form>
        {toggleState.error ? <p className="mt-1 text-xs text-estado-riesgo">{toggleState.error}</p> : null}
      </td>
    </tr>
  );
}
