"use client";

import { useState } from "react";
import { AudiencePanel } from "../AudiencePanel";

export function NewMailingForm({ tags }: { tags: Array<{ id: string; name: string }> }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<string[] | null>(null);

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    setConfirmed(null);
  }

  return (
    <div className="space-y-4">
      <fieldset className="rounded-lg bg-white p-4 text-sm shadow-sm">
        <legend className="px-1 text-xs uppercase tracking-wide text-brand-400">Etiquetas</legend>
        {tags.length === 0 ? <p className="text-brand-400">No hay etiquetas visibles para tu usuario.</p> : null}
        <div className="flex flex-wrap gap-3">
          {tags.map((t) => (
            <label key={t.id} className="flex items-center gap-1.5">
              <input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggle(t.id)} />
              {t.name}
            </label>
          ))}
        </div>
        <button
          type="button"
          disabled={selected.length === 0}
          onClick={() => setConfirmed(selected)}
          className="mt-3 rounded-md border border-brand-200 px-3 py-1.5 text-brand-700 hover:bg-brand-50 disabled:opacity-50"
        >
          Calcular audiencia
        </button>
      </fieldset>
      {confirmed ? <AudiencePanel selection={{ mode: "tag", tagIds: confirmed }} /> : null}
    </div>
  );
}
