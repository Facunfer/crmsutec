"use client";

import { useState, useTransition } from "react";
import type { AssociationListItem } from "@/lib/associations/queries";
import { setMeetingAssociationsAction } from "../acciones";

export function AssociationsPicker({
  meetingId,
  associations,
  selectedIds,
  canEdit,
}: {
  meetingId: string;
  associations: AssociationListItem[];
  selectedIds: string[];
  canEdit: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(selectedIds));
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  if (!canEdit && selected.size === 0) {
    return <p className="text-sm text-brand-400">Sin asociaciones vinculadas.</p>;
  }

  if (!canEdit) {
    return (
      <p className="text-sm text-brand-700">
        {associations.filter((a) => selected.has(a.id)).map((a) => a.name).join(", ")}
      </p>
    );
  }

  function save() {
    startTransition(async () => {
      const result = await setMeetingAssociationsAction(meetingId, [...selected]);
      setMessage(result.ok ? "Guardado." : result.error ?? "No se pudo guardar.");
    });
  }

  return (
    <div>
      <div className="flex flex-wrap gap-3 text-sm">
        {associations.map((a) => (
          <label key={a.id} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={selected.has(a.id)}
              onChange={(e) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(a.id);
                  else next.delete(a.id);
                  return next;
                });
              }}
            />
            {a.name}
          </label>
        ))}
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={save}
        className="mt-2 rounded-md border border-brand-200 px-3 py-1 text-xs text-brand-700 hover:bg-brand-50 disabled:opacity-50"
      >
        Guardar asociaciones
      </button>
      {message ? <span className="ml-2 text-xs text-brand-600">{message}</span> : null}
    </div>
  );
}
