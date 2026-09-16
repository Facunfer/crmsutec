"use client";

import { useActionState } from "react";
import type { OrganizationItem, OrganizationTypeItem } from "@/lib/organizations/queries";
import { createOrganizationAction, type ActionResult } from "./acciones";

const initialState: ActionResult = { ok: false };

export function CreateOrganizationForm({
  types,
  organizations,
}: {
  types: OrganizationTypeItem[];
  organizations: OrganizationItem[];
}) {
  const [state, formAction, pending] = useActionState(createOrganizationAction, initialState);

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-brand-900">Nuevo organismo</h2>
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-brand-500">Nombre</label>
          <input name="name" required className="mt-1 rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Tipo</label>
          <select name="typeId" required className="mt-1 rounded-md border border-brand-200 px-2 py-1.5 text-sm">
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-brand-500">Organismo padre (opcional)</label>
          <select name="parentId" className="mt-1 rounded-md border border-brand-200 px-2 py-1.5 text-sm">
            <option value="">— ninguno —</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {pending ? "Creando..." : "Crear"}
        </button>
      </form>
      {state.error ? <p className="mt-2 text-sm text-estado-riesgo">{state.error}</p> : null}
    </div>
  );
}
