"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { DuplicateCandidateRow } from "@/lib/forms/queries";
import { createNewFromCandidateAction, discardCandidateAction, linkCandidateAction } from "./acciones";

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" }).format(date);
}

export function CandidateRow({ candidate }: { candidate: DuplicateCandidateRow }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  function link() {
    startTransition(async () => {
      const result = await linkCandidateAction(candidate.id);
      if (result.ok) setResolved(true);
      else setError(result.error ?? "No se pudo vincular.");
    });
  }

  function createNew() {
    if (!window.confirm("¿Crear una persona nueva a partir de este envío?")) return;
    startTransition(async () => {
      const result = await createNewFromCandidateAction(candidate.id);
      if (result.ok) setResolved(true);
      else setError(result.error ?? "No se pudo crear.");
    });
  }

  function discard() {
    startTransition(async () => {
      const result = await discardCandidateAction(candidate.id);
      if (result.ok) setResolved(true);
      else setError(result.error ?? "No se pudo descartar.");
    });
  }

  if (resolved) return null;

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="text-brand-400">
          {candidate.formName ?? "Formulario"} · {formatDateTime(candidate.createdAt)}
        </span>
      </div>
      <p className="mb-2 text-sm">{candidate.matchReason}</p>
      {candidate.personId ? (
        <p className="mb-2 text-sm">
          Posible persona:{" "}
          <Link href={`/personas/${candidate.personId}`} className="text-brand-700 hover:underline" target="_blank">
            {candidate.personName ?? candidate.personId}
          </Link>
        </p>
      ) : null}
      {candidate.rawPayload ? (
        <details className="mb-2 text-xs text-brand-500">
          <summary className="cursor-pointer">Ver lo que envió</summary>
          <pre className="mt-1 whitespace-pre-wrap rounded bg-brand-50 p-2">{JSON.stringify(candidate.rawPayload, null, 2)}</pre>
        </details>
      ) : null}
      {error ? <p className="mb-2 text-sm text-estado-riesgo">{error}</p> : null}
      <div className="flex gap-2">
        {candidate.personId ? (
          <button type="button" disabled={pending} onClick={link} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
            Sí, es esta persona
          </button>
        ) : null}
        <button type="button" disabled={pending} onClick={createNew} className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50 disabled:opacity-50">
          Es una persona nueva
        </button>
        <button type="button" disabled={pending} onClick={discard} className="ml-auto rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-500 hover:bg-brand-50 disabled:opacity-50">
          Descartar
        </button>
      </div>
    </div>
  );
}
