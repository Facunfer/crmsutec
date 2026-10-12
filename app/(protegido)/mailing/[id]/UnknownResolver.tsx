"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { resolveUnknownAction } from "../acciones";

/** Un envío incierto nunca se reintenta solo: un operador decide si lo da por no enviado o lo vuelve a poner en cola (puede duplicar). */
export function UnknownResolver({ campaignId, recipientId }: { campaignId: string; recipientId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: "requeue" | "mark_failed") {
    if (action === "requeue" && !window.confirm("Reencolar puede generar un envío duplicado si el proveedor recibió el mensaje original. ¿Reencolar igual?")) return;
    startTransition(async () => {
      const r = await resolveUnknownAction(campaignId, recipientId, action);
      if (r.ok) router.refresh();
      else setError(r.error ?? "No se pudo resolver.");
    });
  }

  return (
    <span className="ml-2 inline-flex gap-2">
      <button type="button" disabled={pending} onClick={() => run("mark_failed")} className="text-brand-600 hover:underline">
        marcar no enviado
      </button>
      <button type="button" disabled={pending} onClick={() => run("requeue")} className="text-brand-600 hover:underline">
        reencolar
      </button>
      {error ? <span className="text-red-700">{error}</span> : null}
    </span>
  );
}
