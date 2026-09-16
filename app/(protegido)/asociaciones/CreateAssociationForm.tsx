"use client";

import { useActionState } from "react";
import type { AssociationTypeItem } from "@/lib/associations/queries";
import { createAssociationAction, type AssociationActionResult } from "./acciones";

const initialState: AssociationActionResult = { ok: false };

export function CreateAssociationForm({ types }: { types: AssociationTypeItem[] }) {
  const [state, formAction, pending] = useActionState(createAssociationAction, initialState);

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-brand-900">Nueva asociación</h2>
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-brand-500">Nombre</label>
          <input name="name" required className="mt-1 w-56 rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
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
          <label className="block text-xs text-brand-500">Descripción (opcional)</label>
          <input name="description" className="mt-1 w-64 rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
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
