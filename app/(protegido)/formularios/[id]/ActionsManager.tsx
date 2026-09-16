"use client";

import { useState, useTransition } from "react";
import type { FormActionRow } from "@/lib/forms/queries";
import type { AssociationListItem } from "@/lib/associations/queries";
import { addAssociationActionAction, removeActionAction } from "./acciones";

export function ActionsManager({
  formId,
  actions,
  associations,
  canEdit,
}: {
  formId: string;
  actions: FormActionRow[];
  associations: AssociationListItem[];
  canEdit: boolean;
}) {
  const [selected, setSelected] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const associationName = (id?: string) => associations.find((a) => a.id === id)?.name ?? id ?? "—";

  function add() {
    if (!selected) return;
    startTransition(async () => {
      const result = await addAssociationActionAction(formId, selected);
      setError(result.ok ? null : result.error ?? "No se pudo agregar.");
      if (result.ok) setSelected("");
    });
  }

  function remove(actionId: string) {
    startTransition(async () => {
      const result = await removeActionAction(formId, actionId);
      setError(result.ok ? null : result.error ?? "No se pudo quitar.");
    });
  }

  return (
    <div className="space-y-3">
      {actions.length === 0 ? <p className="text-sm text-brand-400">Nadie se suma a ninguna asociación automáticamente todavía.</p> : null}
      {actions.map((a) => (
        <div key={a.id} className="flex items-center justify-between rounded-md border border-brand-100 p-2 text-sm">
          <span>Sumar a: {associationName(a.config.associationId)}</span>
          {canEdit ? (
            <button type="button" disabled={pending} onClick={() => remove(a.id)} className="text-xs text-estado-riesgo hover:underline disabled:opacity-50">
              quitar
            </button>
          ) : null}
        </div>
      ))}
      {error ? <p className="text-sm text-estado-riesgo">{error}</p> : null}
      {canEdit ? (
        <div className="flex items-center gap-2">
          <select value={selected} onChange={(e) => setSelected(e.target.value)} className="rounded-md border border-brand-200 px-2 py-1.5 text-sm">
            <option value="">Elegir asociación...</option>
            {associations.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button type="button" disabled={pending || !selected} onClick={add} className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50 disabled:opacity-50">
            + Agregar
          </button>
        </div>
      ) : null}
    </div>
  );
}
