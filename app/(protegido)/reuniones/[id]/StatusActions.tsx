"use client";

import { useState, useTransition } from "react";
import type { MeetingStatus } from "@/lib/meetings/state-machine";
import { changeMeetingStatusAction } from "../acciones";

const TRANSITION_LABEL: Record<MeetingStatus, string> = {
  draft: "Volver a borrador",
  scheduled: "Programar",
  in_progress: "Iniciar reunión",
  finished: "Finalizar",
  cancelled: "Cancelar",
  overdue_unclosed: "Marcar vencida",
};

export function StatusActions({ meetingId, availableTransitions }: { meetingId: string; availableTransitions: MeetingStatus[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (availableTransitions.length === 0) return null;

  function go(target: MeetingStatus) {
    if (target === "cancelled" && !window.confirm("¿Cancelar esta reunión? No se puede deshacer.")) return;
    startTransition(async () => {
      const result = await changeMeetingStatusAction(meetingId, target);
      setError(result.ok ? null : result.error ?? "No se pudo cambiar el estado.");
    });
  }

  return (
    <div className="flex items-center gap-2">
      {availableTransitions.map((target) => (
        <button
          key={target}
          type="button"
          disabled={pending}
          onClick={() => go(target)}
          className={
            target === "cancelled"
              ? "rounded-md border border-estado-riesgo px-3 py-1.5 text-sm text-estado-riesgo hover:bg-estado-riesgo/10 disabled:opacity-50"
              : "rounded-md bg-brand-600 px-3 py-1.5 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
          }
        >
          {TRANSITION_LABEL[target]}
        </button>
      ))}
      {error ? <p className="text-xs text-estado-riesgo">{error}</p> : null}
    </div>
  );
}
