import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import {
  CAMPAIGN_STATUS_LABEL,
  RECIPIENT_STATUSES,
  RECIPIENT_STATUS_LABEL,
  getCampaignDetail,
  listRecipients,
  type RecipientStatus,
} from "@/lib/mailing/queries";
import { SesBanner } from "../SesBanner";
import { CampaignActions } from "./CampaignActions";
import { UnknownResolver } from "./UnknownResolver";

export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("es-AR");
const fmt = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short", hourCycle: "h23" });
const when = (d: Date | null) => (d ? fmt.format(d) : "—");

export default async function CampanaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requirePermission("mailing.view");
  const { id } = await params;
  const sp = await searchParams;
  const detail = await getCampaignDetail(actor, id);
  if (!detail) notFound();
  const c = detail.campaign;
  const status = RECIPIENT_STATUSES.includes(sp.status as RecipientStatus) ? (sp.status as RecipientStatus) : undefined;
  const page = Math.max(Number(sp.page) || 1, 1);
  const canMetrics = can(actor, "mailing.view_metrics");
  const list = canMetrics ? await listRecipients(actor, id, { status, search: sp.q, page, pageSize: 50 }) : null;
  const k = detail.counts;
  const canSend = can(actor, "mailing.send");
  const total = Math.max(c.totalRecipients, 1);
  const done = k.sentTotal + k.failed + k.suppressed + k.invalid;
  const progress = Math.min(100, Math.round((k.sentTotal / total) * 100));

  const cards: Array<[string, number]> = [
    ["Seleccionadas", c.totalSelected],
    ["Destinatarios", c.totalRecipients],
    ["Pendientes", k.pending],
    ["En cola", k.queued + k.sending],
    ["Enviados", k.sentTotal],
    ["Entregados", k.delivered],
    ["Abiertos", k.opened],
    ["Clicks", k.clicked],
    ["Rebotados", k.bounced],
    ["Quejas", k.complained],
    ["Bajas", k.unsubscribed],
    ["Suprimidos", k.suppressed],
    ["Fallidos", k.failed],
    ["Envío incierto", k.send_unknown],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-brand-900">{c.name}</h1>
          <p className="text-sm text-brand-600">
            {CAMPAIGN_STATUS_LABEL[c.status]} · {detail.sender ? `${detail.sender.fromName} <${detail.sender.fromEmail}>` : "sin remitente"} · asunto: {c.subject || "—"}
          </p>
        </div>
        <Link href="/mailing" className="text-sm text-brand-600 hover:underline">
          ← volver a Mailing
        </Link>
      </div>

      <SesBanner />

      {c.cancelReason ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{c.status === "cancelled" ? "Motivo de cancelación" : "Aviso"}: {c.cancelReason}</p> : null}

      <CampaignActions campaignId={c.id} status={c.status} canSend={canSend} />

      {detail.metricsVisible && k.send_unknown > 0 ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Hay {nf.format(k.send_unknown)} envío(s) con resultado incierto: no se reintentan solos. <strong>Reencolar puede generar un envío duplicado si el
          proveedor recibió el mensaje original.</strong> Verificá en Amazon SES antes de elegir «reencolar»; «marcar no enviado» lo da por no enviado.
        </p>
      ) : null}

      {detail.metricsVisible ? (
        <>
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between text-sm text-brand-700">
              <span>Progreso: {nf.format(k.sentTotal)} de {nf.format(c.totalRecipients)} enviados ({progress}%)</span>
              <span className="text-xs text-brand-400">procesados {nf.format(done)}</span>
            </div>
            <div className="h-2 w-full rounded bg-brand-100">
              <div className="h-2 rounded bg-brand-600" style={{ width: `${progress}%` }} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {cards.map(([label, value]) => (
              <div key={label} className="rounded-lg bg-white p-3 shadow-sm">
                <div className="text-xs text-brand-400">{label}</div>
                <div className="text-lg font-semibold text-brand-900">{nf.format(value)}</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-brand-500">No tenés permiso para ver las métricas de esta campaña.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-white p-4 text-sm shadow-sm">
          <h2 className="mb-2 font-semibold text-brand-900">Operación</h2>
          <ul className="space-y-1 text-brand-700">
            <li>
              Worker: {detail.worker.active ? "activo" : "no activo"}
              {detail.worker.lastSeenAt ? ` · última actividad ${when(new Date(detail.worker.lastSeenAt))}` : " · sin latidos"}
            </li>
            <li>
              Cuota de hoy: {nf.format(detail.quota.reserved)} de {nf.format(detail.quota.limit)} usados · quedan {nf.format(detail.quota.remaining)}
            </li>
            <li>Costo aproximado de SES: USD {detail.estimatedCostUsd.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</li>
            <li>Lanzada: {when(c.launchedAt)} · iniciada: {when(c.startedAt)} · finalizada: {when(c.finishedAt)}</li>
            {detail.configIssues.length > 0 ? <li className="text-amber-800">Configuración: {detail.configIssues.map((i) => i.key).join(", ")}</li> : null}
          </ul>
        </div>
        <div className="rounded-lg bg-white p-4 text-sm shadow-sm">
          <h2 className="mb-2 font-semibold text-brand-900">Lotes diarios</h2>
          {detail.batches.length === 0 ? <p className="text-brand-400">Todavía no se lanzó.</p> : null}
          <ul className="space-y-1 text-brand-700">
            {detail.batches.map((b) => (
              <li key={b.sequence}>
                Día {b.sequence}: {b.scheduledDate} · {b.status} · {nf.format(b.sentCount)}/{nf.format(b.recipientCount)}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {list ? (
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <h2 className="mr-2 font-semibold text-brand-900">Destinatarios ({nf.format(list.total)})</h2>
            <Link href={`/mailing/${id}`} className={`rounded px-2 py-0.5 ${!status ? "bg-brand-600 text-white" : "text-brand-600 hover:underline"}`}>
              todos
            </Link>
            {RECIPIENT_STATUSES.map((s) => (
              <Link key={s} href={`/mailing/${id}?status=${s}`} className={`rounded px-2 py-0.5 ${status === s ? "bg-brand-600 text-white" : "text-brand-600 hover:underline"}`}>
                {RECIPIENT_STATUS_LABEL[s]}
              </Link>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
                  <th className="py-2 pr-4 font-medium">Email</th>
                  <th className="py-2 pr-4 font-medium">Persona</th>
                  <th className="py-2 pr-4 font-medium">Estado</th>
                  <th className="py-2 pr-4 font-medium">Enviado</th>
                  <th className="py-2 pr-4 font-medium">Entregado</th>
                  <th className="py-2 pr-4 font-medium">Abierto</th>
                  <th className="py-2 pr-4 font-medium">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => (
                  <tr key={r.id} className="border-b border-brand-50">
                    <td className="py-1.5 pr-4 font-mono text-xs">{r.email}</td>
                    <td className="py-1.5 pr-4">
                      {r.personId ? (
                        <Link href={`/personas/${r.personId}`} className="text-brand-700 hover:underline">
                          {r.personName}
                        </Link>
                      ) : (
                        "—"
                      )}
                      {r.personCount > 1 ? <span className="ml-1 text-xs text-brand-400">(+{r.personCount - 1})</span> : null}
                    </td>
                    <td className="py-1.5 pr-4">{RECIPIENT_STATUS_LABEL[r.status]}</td>
                    <td className="py-1.5 pr-4">{when(r.sentAt)}</td>
                    <td className="py-1.5 pr-4">{when(r.deliveredAt)}</td>
                    <td className="py-1.5 pr-4">{when(r.openedAt)}</td>
                    <td className="py-1.5 pr-4 text-xs text-brand-500">
                      {r.lastError ?? r.statusDetail ?? ""}
                      {r.status === "send_unknown" && canSend ? <UnknownResolver campaignId={id} recipientId={r.id} /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.total > 50 ? (
            <div className="mt-3 flex items-center gap-3 text-sm">
              {page > 1 ? <Link className="text-brand-600 hover:underline" href={`/mailing/${id}?${status ? `status=${status}&` : ""}page=${page - 1}`}>← anterior</Link> : null}
              <span className="text-brand-400">Página {page} de {Math.ceil(list.total / 50)}</span>
              {page * 50 < list.total ? <Link className="text-brand-600 hover:underline" href={`/mailing/${id}?${status ? `status=${status}&` : ""}page=${page + 1}`}>siguiente →</Link> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
