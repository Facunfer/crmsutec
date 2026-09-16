"use client";

import { useState, useTransition } from "react";
import { setAssociationActiveAction } from "../acciones";

export function StatusButton({ associationId, active }: { associationId: string; active: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await setAssociationActiveAction(associationId, !active);
            setError(result.ok ? null : result.error ?? "No se pudo actualizar.");
          })
        }
        className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50 disabled:opacity-50"
      >
        {active ? "Desactivar" : "Reactivar"}
      </button>
      {error ? <p className="mt-1 text-xs text-estado-riesgo">{error}</p> : null}
    </div>
  );
}
