"use client";

import { useActionState } from "react";
import type { AssociationTypeItem } from "@/lib/associations/queries";
import { updateAssociationAction, type AssociationActionResult } from "../acciones";

const initialState: AssociationActionResult = { ok: false };

export function AssociationInfoForm({
  associationId,
  name,
  description,
  typeId,
  types,
}: {
  associationId: string;
  name: string;
  description: string;
  typeId: string;
  types: AssociationTypeItem[];
}) {
  const [state, formAction, pending] = useActionState(updateAssociationAction.bind(null, associationId), initialState);

  return (
    <form action={formAction} className="max-w-xl space-y-3">
      <div>
        <label className="block text-xs text-brand-500">Nombre</label>
        <input
          name="name"
          defaultValue={name}
          required
          className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Tipo</label>
        <select name="typeId" defaultValue={typeId} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm">
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Descripción</label>
        <textarea
          name="description"
          defaultValue={description}
          rows={2}
          className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
        />
      </div>
      {state.error ? <p className="text-sm text-estado-riesgo">{state.error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? "Guardando..." : "Guardar"}
      </button>
    </form>
  );
}
