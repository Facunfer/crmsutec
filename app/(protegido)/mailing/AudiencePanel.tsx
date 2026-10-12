"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { AudienceStats } from "@/lib/mailing/audience";
import { createCampaignAction, previewAudienceAction, type MailingSelection } from "./acciones";

const nf = new Intl.NumberFormat("es-AR");

/**
 * Paso 1 del mailing: muestra qué pasaría con la selección (seleccionadas, con/sin email, inválidos, duplicados, suprimidos,
 * destinatarios finales) y, al confirmar, CONGELA la audiencia en una campaña en borrador. La selección se resuelve en el servidor.
 */
export function AudiencePanel({
  selection,
  defaultName = "",
  onClose,
}: {
  selection: MailingSelection;
  defaultName?: string;
  onClose?: () => void;
}) {
  const router = useRouter();
  const [stats, setStats] = useState<AudienceStats | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(defaultName);
  const [loading, startPreview] = useTransition();
  const [creating, startCreate] = useTransition();

  const key = JSON.stringify(selection);
  useEffect(() => {
    setStats(null);
    setError(null);
    startPreview(async () => {
      const r = await previewAudienceAction(selection);
      if (r.ok && r.stats) {
        setStats(r.stats);
        setCost(r.estimatedCostUsd ?? null);
      } else setError(r.error ?? "No se pudo calcular la audiencia.");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function create() {
    setError(null);
    startCreate(async () => {
      const r = await createCampaignAction(selection, name);
      if (r.ok && r.id) router.push(`/mailing/${r.id}/editar`);
      else setError(r.error ?? "No se pudo crear la campaña.");
    });
  }

  const rows: Array<[string, number | undefined, string?]> = stats
    ? [
        ["Personas seleccionadas", stats.selected],
        ["Con email", stats.withEmail],
        ["Sin email", stats.withoutEmail],
        ["Emails inválidos", stats.invalid],
        ["Duplicados (email compartido)", stats.duplicates],
        ["Suprimidos (bajas, rebotes, quejas)", stats.suppressed],
        ["Destinatarios finales", stats.finalRecipients, "font-semibold text-brand-900"],
      ]
    : [];

  return (
    <div className="space-y-3 rounded-lg border border-brand-200 bg-white p-4 text-sm">
      <div className="flex items-start justify-between gap-4">
        <h2 className="font-semibold text-brand-900">Audiencia del mailing</h2>
        {onClose ? (
          <button type="button" onClick={onClose} className="text-brand-400 hover:underline">
            cerrar
          </button>
        ) : null}
      </div>

      {loading && !stats ? <p className="text-brand-500">Calculando audiencia…</p> : null}
      {stats ? (
        <table className="w-full max-w-md text-left">
          <tbody>
            {rows.map(([label, value, cls]) => (
              <tr key={label} className="border-b border-brand-50">
                <td className="py-1 pr-4 text-brand-600">{label}</td>
                <td className={`py-1 text-right ${cls ?? ""}`}>{nf.format(value ?? 0)}</td>
              </tr>
            ))}
            {stats.inactiveExcluded > 0 ? (
              <tr>
                <td className="py-1 pr-4 text-brand-400">Personas inactivas excluidas</td>
                <td className="py-1 text-right text-brand-400">{nf.format(stats.inactiveExcluded)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}
      {stats && cost !== null ? <p className="text-xs text-brand-500">Costo aproximado de SES: USD {cost.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</p> : null}
      <p className="text-xs text-brand-500">
        La audiencia se congela al crear la campaña: si después cambian los filtros, las etiquetas o los emails, esta campaña no se modifica. Un mailing no es
        contacto real.
      </p>

      {error ? <p className="text-red-700">{error}</p> : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-brand-500">Nombre de la campaña</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={160}
            className="w-72 rounded-md border border-brand-200 px-2 py-1.5"
            placeholder="Ej.: Capacitación octubre"
          />
        </label>
        <button
          type="button"
          onClick={create}
          disabled={creating || !stats || stats.finalRecipients + stats.suppressed + stats.invalid === 0 || name.trim() === ""}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {creating ? "Creando…" : "Congelar audiencia y continuar"}
        </button>
      </div>
    </div>
  );
}
