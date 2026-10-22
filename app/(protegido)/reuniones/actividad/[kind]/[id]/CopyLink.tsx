"use client";

import { useState } from "react";

/** Muestra el enlace público de un formulario con un botón para copiarlo. La URL completa se arma con el origen del navegador. */
export function CopyLink({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <code className="rounded bg-brand-50 px-2 py-1 text-xs text-brand-700">{path}</code>
      <button type="button" onClick={copy} className="rounded-md border border-brand-300 px-2 py-1 text-xs text-brand-700 hover:bg-brand-50">
        {copied ? "¡Copiado!" : "Copiar enlace"}
      </button>
    </div>
  );
}
