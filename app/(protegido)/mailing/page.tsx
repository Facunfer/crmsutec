import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { CAMPAIGN_STATUS_LABEL, listCampaigns } from "@/lib/mailing/queries";
import { SesBanner } from "./SesBanner";

export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short", hourCycle: "h23" });

export default async function MailingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requirePermission("mailing.view");
  const sp = await searchParams;
  const page = Math.max(Number(sp.page) || 1, 1);
  const { rows, total } = await listCampaigns(actor, { page, pageSize: 25 });
  const canCreate = can(actor, "mailing.create");
  const totalPages = Math.max(Math.ceil(total / 25), 1);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-brand-900">Mailing</h1>
        <div className="flex flex-wrap gap-2 text-sm">
          {can(actor, "mailing.manage_senders") ? (
            <Link href="/mailing/remitentes" className="rounded-md border border-brand-200 px-3 py-1.5 text-brand-700 hover:bg-brand-50">
              Remitentes
            </Link>
          ) : null}
          {can(actor, "mailing.manage_suppressions") ? (
            <Link href="/mailing/supresiones" className="rounded-md border border-brand-200 px-3 py-1.5 text-brand-700 hover:bg-brand-50">
              Bajas y supresiones
            </Link>
          ) : null}
          {canCreate ? (
            <Link href="/mailing/nueva" className="rounded-md bg-brand-600 px-3 py-1.5 text-white hover:bg-brand-700">
              Nueva campaña
            </Link>
          ) : null}
        </div>
      </div>

      <SesBanner />

      <div className="rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-600">
        Un mailing no es un contacto real: enviar, entregar, abrir o hacer click no mueve el semáforo ni «Último contacto».
      </div>

      <div className="overflow-x-auto rounded-lg bg-white p-4 shadow-sm">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="py-2 pr-4 font-medium">Campaña</th>
              <th className="py-2 pr-4 font-medium">Remitente</th>
              <th className="py-2 pr-4 font-medium">Estado</th>
              <th className="py-2 pr-4 font-medium">Destinatarios</th>
              <th className="py-2 pr-4 font-medium">Enviados</th>
              <th className="py-2 pr-4 font-medium">Entregados</th>
              <th className="py-2 pr-4 font-medium">Rebotados</th>
              <th className="py-2 pr-4 font-medium">Fecha</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b border-brand-50">
                <td className="py-1.5 pr-4">
                  <Link href={c.status === "draft" || c.status === "ready" ? `/mailing/${c.id}/editar` : `/mailing/${c.id}`} className="text-brand-700 hover:underline">
                    {c.name}
                  </Link>
                </td>
                <td className="py-1.5 pr-4">{c.senderName ?? "—"}</td>
                <td className="py-1.5 pr-4">{CAMPAIGN_STATUS_LABEL[c.status]}</td>
                <td className="py-1.5 pr-4">{c.totalRecipients.toLocaleString("es-AR")}</td>
                <td className="py-1.5 pr-4">{c.metrics ? c.metrics.sent : "—"}</td>
                <td className="py-1.5 pr-4">{c.metrics ? c.metrics.delivered : "—"}</td>
                <td className="py-1.5 pr-4">{c.metrics ? c.metrics.bounced : "—"}</td>
                <td className="py-1.5 pr-4">{fmt.format(c.launchedAt ?? c.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p className="py-4 text-sm text-brand-400">Todavía no hay campañas.</p> : null}
      </div>

      {totalPages > 1 ? (
        <div className="flex items-center gap-3 text-sm">
          {page > 1 ? <Link className="text-brand-600 hover:underline" href={`/mailing?page=${page - 1}`}>← anterior</Link> : null}
          <span className="text-brand-400">Página {page} de {totalPages}</span>
          {page < totalPages ? <Link className="text-brand-600 hover:underline" href={`/mailing?page=${page + 1}`}>siguiente →</Link> : null}
        </div>
      ) : null}
    </div>
  );
}
