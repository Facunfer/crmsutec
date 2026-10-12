"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addSuppressionAction, liftSuppressionAction } from "../acciones";

interface Row {
  id: string;
  email: string;
  reason: string;
  source: string;
  createdAt: string;
  active: boolean;
  liftedAt: string | null;
  liftReason: string | null;
}

const fmt = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short", hourCycle: "h23" });

export function SuppressionManager({
  rows,
  total,
  page,
  search,
  reasonLabels,
}: {
  rows: Row[];
  total: number;
  page: number;
  search: string;
  reasonLabels: Record<string, string>;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [liftId, setLiftId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done: () => void) {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        done();
        router.refresh();
      } else setError(r.error ?? "No se pudo completar.");
    });
  }
  const input = "rounded-md border border-brand-200 px-2 py-1.5 text-sm";

  return (
    <div className="space-y-4">
      {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-brand-500">Suprimir un email manualmente</span>
          <input className={`${input} w-72`} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="persona@dominio.com" />
        </label>
        <button
          type="button"
          disabled={pending || !email.trim()}
          onClick={() => run(() => addSuppressionAction(email), () => setEmail(""))}
          className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50 disabled:opacity-50"
        >
          Suprimir
        </button>
        <form method="get" className="ml-auto flex items-end gap-2">
          <input name="q" defaultValue={search} className={`${input} w-56`} placeholder="Buscar email" />
          <button className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50">Buscar</button>
        </form>
      </div>

      <div className="overflow-x-auto rounded-lg bg-white p-4 shadow-sm">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="py-2 pr-4 font-medium">Email</th>
              <th className="py-2 pr-4 font-medium">Motivo</th>
              <th className="py-2 pr-4 font-medium">Origen</th>
              <th className="py-2 pr-4 font-medium">Fecha</th>
              <th className="py-2 pr-4 font-medium">Estado</th>
              <th className="py-2 pr-4 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-brand-50">
                <td className="py-1.5 pr-4 font-mono text-xs">{r.email}</td>
                <td className="py-1.5 pr-4">{reasonLabels[r.reason] ?? r.reason}</td>
                <td className="py-1.5 pr-4 text-xs">{r.source}</td>
                <td className="py-1.5 pr-4">{fmt.format(new Date(r.createdAt))}</td>
                <td className="py-1.5 pr-4">{r.active ? "Activa" : `Levantada${r.liftReason ? `: ${r.liftReason}` : ""}`}</td>
                <td className="py-1.5 pr-4 text-right">
                  {r.active ? (
                    liftId === r.id ? (
                      <span className="inline-flex items-center gap-2">
                        <input className={`${input} w-56`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (obligatorio)" />
                        <button
                          type="button"
                          disabled={pending || reason.trim().length < 5}
                          className="text-brand-600 hover:underline disabled:opacity-50"
                          onClick={() => run(() => liftSuppressionAction(r.id, reason), () => { setLiftId(null); setReason(""); })}
                        >
                          confirmar
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="text-brand-600 hover:underline" onClick={() => setLiftId(r.id)}>
                        levantar
                      </button>
                    )
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p className="py-4 text-sm text-brand-400">No hay supresiones.</p> : null}
      </div>

      {total > 50 ? (
        <div className="flex items-center gap-3 text-sm">
          {page > 1 ? <Link className="text-brand-600 hover:underline" href={`/mailing/supresiones?page=${page - 1}${search ? `&q=${encodeURIComponent(search)}` : ""}`}>← anterior</Link> : null}
          <span className="text-brand-400">Página {page} de {Math.ceil(total / 50)}</span>
          {page * 50 < total ? <Link className="text-brand-600 hover:underline" href={`/mailing/supresiones?page=${page + 1}${search ? `&q=${encodeURIComponent(search)}` : ""}`}>siguiente →</Link> : null}
        </div>
      ) : null}
    </div>
  );
}
