"use client";

import { useState, useTransition } from "react";
import type { FormStatus } from "@/lib/db/schema";
import { changeFormStatusAction, publishFormAction } from "./acciones";

export function PublishControls({ formId, status, hasPublishedVersion }: { formId: string; status: FormStatus; hasPublishedVersion: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function publish() {
    const confirmMessage = hasPublishedVersion
      ? "¿Publicar una nueva versión? Los cambios hechos a los campos desde la última publicación quedarán visibles para el público."
      : "¿Publicar este formulario? Va a quedar disponible en su URL pública.";
    if (!window.confirm(confirmMessage)) return;
    startTransition(async () => {
      const result = await publishFormAction(formId);
      if (result.ok) {
        setMessage(`Publicado (v${result.version}).`);
        setError(null);
      } else {
        setError(result.error ?? "No se pudo publicar.");
      }
    });
  }

  function changeStatus(target: "unpublished" | "published" | "archived") {
    if (target === "archived" && !window.confirm("¿Archivar este formulario? No se va a poder editar ni publicar de nuevo.")) return;
    startTransition(async () => {
      const result = await changeFormStatusAction(formId, target);
      setError(result.ok ? null : result.error ?? "No se pudo cambiar el estado.");
      setMessage(null);
    });
  }

  return (
    <div className="flex items-center gap-2">
      {status !== "archived" ? (
        <button type="button" disabled={pending} onClick={publish} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {status === "draft" ? "Publicar" : "Publicar cambios"}
        </button>
      ) : null}
      {status === "published" ? (
        <button type="button" disabled={pending} onClick={() => changeStatus("unpublished")} className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50 disabled:opacity-50">
          Despublicar
        </button>
      ) : null}
      {status === "unpublished" && hasPublishedVersion ? (
        <button type="button" disabled={pending} onClick={() => changeStatus("published")} className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50 disabled:opacity-50">
          Volver a publicar
        </button>
      ) : null}
      {status !== "archived" ? (
        <button type="button" disabled={pending} onClick={() => changeStatus("archived")} className="rounded-md border border-estado-riesgo px-3 py-1.5 text-sm text-estado-riesgo hover:bg-estado-riesgo/10 disabled:opacity-50">
          Archivar
        </button>
      ) : null}
      {message ? <span className="text-xs text-estado-ok">{message}</span> : null}
      {error ? <span className="text-xs text-estado-riesgo">{error}</span> : null}
    </div>
  );
}
