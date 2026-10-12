"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { cancelAction, pauseAction, resumeAction } from "../acciones";

export function CampaignActions({ campaignId, status, canSend }: { campaignId: string; status: string; canSend: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!canSend) return null;
  const canPause = status === "sending" || status === "scheduled";
  const canResume = status === "paused";
  const canCancel = ["scheduled", "sending", "paused"].includes(status);
  if (!canPause && !canResume && !canCancel) return null;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        setAsking(false);
        setReason("");
        router.refresh();
      } else setError(r.error ?? "No se pudo completar la acción.");
    });
  }

  const btn = "rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50 disabled:opacity-50";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {canPause ? (
          <button type="button" className={btn} disabled={pending} onClick={() => run(() => pauseAction(campaignId))}>
            Pausar
          </button>
        ) : null}
        {canResume ? (
          <button type="button" className={btn} disabled={pending} onClick={() => run(() => resumeAction(campaignId))}>
            Reanudar
          </button>
        ) : null}
        {canCancel ? (
          <button type="button" className={`${btn} text-red-700`} disabled={pending} onClick={() => setAsking(true)}>
            Cancelar campaña
          </button>
        ) : null}
      </div>
      {asking ? (
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-brand-500">Motivo de la cancelación</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} className="w-80 rounded-md border border-brand-200 px-2 py-1.5" />
          </label>
          <button type="button" className={btn} disabled={pending || reason.trim().length < 3} onClick={() => run(() => cancelAction(campaignId, reason))}>
            Confirmar cancelación
          </button>
          <button type="button" className="text-brand-400 hover:underline" onClick={() => setAsking(false)}>
            volver
          </button>
        </div>
      ) : null}
      <p className="text-xs text-brand-500">Pausar detiene los envíos nuevos; lo ya reclamado termina. Cancelar no borra la historia: lo no enviado queda sin enviar.</p>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
