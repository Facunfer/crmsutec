"use client";

import { useState, useTransition } from "react";
import { regenerateQrSecretAction } from "../acciones";

export function RegenerateQrButton({ meetingId }: { meetingId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function regenerate() {
    if (!window.confirm("¿Regenerar el código QR? Los códigos ya impresos o compartidos dejarán de funcionar.")) return;
    startTransition(async () => {
      const result = await regenerateQrSecretAction(meetingId);
      if (result.ok) {
        setDone(true);
        setError(null);
        setTimeout(() => setDone(false), 3000);
      } else {
        setError(result.error ?? "No se pudo regenerar el código.");
      }
    });
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={regenerate}
        className="rounded-md border border-brand-200 px-3 py-1.5 text-xs text-brand-700 hover:bg-brand-50 disabled:opacity-50"
      >
        {pending ? "Regenerando..." : "Regenerar código QR"}
      </button>
      {done ? <p className="text-xs text-estado-ok">Listo, los códigos viejos ya no sirven.</p> : null}
      {error ? <p className="text-xs text-estado-riesgo">{error}</p> : null}
    </div>
  );
}
