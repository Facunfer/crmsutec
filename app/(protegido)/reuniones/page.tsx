import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { listCampaigns } from "@/lib/campaigns/queries";
import { CAMPAIGN_TYPE_LABEL, campaignDatesLabel, campaignStatusLabel } from "@/lib/campaigns/labels";
import { listMeetings, type MeetingListFilter } from "@/lib/meetings/queries";
import { STATUS_LABEL } from "@/lib/meetings/state-machine";
import { formatMeetingWhen } from "@/lib/meetings/when";
import { listAreaOptions, listOrgTreeOptions } from "@/lib/organizations/areas";
import { CreateMeetingForm } from "./CreateMeetingForm";

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" }).format(date);
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-brand-100 text-brand-500",
  scheduled: "bg-brand-100 text-brand-700",
  in_progress: "bg-estado-alerta/10 text-estado-alerta",
  finished: "bg-estado-ok/10 text-estado-ok",
  cancelled: "bg-estado-riesgo/10 text-estado-riesgo",
  overdue_unclosed: "bg-estado-riesgo/10 text-estado-riesgo",
};

export default async function ReunionesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requirePermission("meetings.view");
  const sp = await searchParams;
  const filter: MeetingListFilter = { status: (sp.status as MeetingListFilter["status"]) || "all" };
  const preselectedAssociationId = sp.associationId || undefined;

  const tipo = sp.tipo === "campanas" || sp.tipo === "reuniones" ? sp.tipo : "todas";
  const [allMeetings, campaigns] = await Promise.all([listMeetings(actor, filter), tipo === "reuniones" ? Promise.resolve([]) : listCampaigns(actor)]);
  // Las jornadas de campaña se ven dentro de su campaña; en la tabla de reuniones se marcan para distinguirlas.
  const meetings = tipo === "campanas" ? [] : allMeetings;
  const orgTree = can(actor, "meetings.create") ? await listOrgTreeOptions(actor) : [];
  const areas = can(actor, "meetings.create") ? await listAreaOptions(actor, orgTree) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-brand-900">Actividades</h1>
      </div>

      {can(actor, "meetings.create") ? (
        <CreateMeetingForm preselectedAssociationId={preselectedAssociationId} areas={areas} orgTree={orgTree} />
      ) : null}

      <div className="flex flex-wrap gap-2 text-sm">
        {(["todas", "campanas", "reuniones"] as const).map((t) => (
          <Link
            key={t}
            href={t === "todas" ? "/reuniones" : `/reuniones?tipo=${t}`}
            className={`rounded-full px-3 py-1 ${tipo === t ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-700"}`}
          >
            {t === "todas" ? "Todas" : t === "campanas" ? "Campañas" : "Reuniones y capacitaciones"}
          </Link>
        ))}
      </div>

      {campaigns.length > 0 ? (
        <div className="overflow-x-auto rounded-lg bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-brand-900">Campañas</h2>
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
                <th className="py-2 pr-4 font-medium">Campaña</th>
                <th className="py-2 pr-4 font-medium">Tipo</th>
                <th className="py-2 pr-4 font-medium">Fechas</th>
                <th className="py-2 pr-4 font-medium">Jornadas</th>
                <th className="py-2 pr-4 font-medium" title="Personas distintas dentro de tu alcance. 0 significa sin participantes registrados, no que la campaña no haya ocurrido.">Participantes registrados</th>
                <th className="py-2 pr-4 font-medium">Inscriptas</th>
                <th className="py-2 pr-4 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b border-brand-50">
                  <td className="py-2 pr-4">
                    <Link href={`/reuniones/campanas/${c.id}`} className="text-brand-700 hover:underline">
                      {c.name}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">{CAMPAIGN_TYPE_LABEL[c.type]}</td>
                  <td className="py-2 pr-4">{campaignDatesLabel(c)}</td>
                  <td className="py-2 pr-4">{c.jornadasCount}</td>
                  <td className="py-2 pr-4">{c.participatedCount}</td>
                  <td className="py-2 pr-4">{c.registeredCount}</td>
                  <td className="py-2 pr-4">
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700">
                      {campaignStatusLabel(c)}
                      {c.jornadasCount > 0 ? ` · ${c.jornadasCount} jornada${c.jornadasCount === 1 ? "" : "s"} registrada${c.jornadasCount === 1 ? "" : "s"}` : ""}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {tipo === "campanas" ? null : (
      <>
      <div className="flex flex-wrap gap-2 text-sm">
        {(["all", "draft", "scheduled", "in_progress", "overdue_unclosed", "finished", "cancelled"] as const).map(
          (status) => (
            <Link
              key={status}
              href={status === "all" ? "/reuniones" : `/reuniones?status=${status}`}
              className={`rounded-full px-3 py-1 ${
                (filter.status ?? "all") === status ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-700"
              }`}
            >
              {status === "all" ? "Todas" : STATUS_LABEL[status]}
            </Link>
          )
        )}
      </div>

      <div className="overflow-x-auto rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold text-brand-900">Reuniones y capacitaciones</h2>
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="py-2 pr-4 font-medium">Nombre</th>
              <th className="py-2 pr-4 font-medium">Inicio</th>
              <th className="py-2 pr-4 font-medium">Lugar</th>
              <th className="py-2 pr-4 font-medium">Organizador</th>
              <th className="py-2 pr-4 font-medium" title="Incluye a quienes participaron de la campaña sin jornada determinada, cuando corresponde.">Participantes</th>
              <th className="py-2 pr-4 font-medium">Invitados</th>
              <th className="py-2 pr-4 font-medium">Confirmados</th>
              <th className="py-2 pr-4 font-medium">Estado</th>
            </tr>
          </thead>
          <tbody>
            {meetings.map((m) => (
              <tr key={m.id} className="border-b border-brand-50">
                <td className="py-2 pr-4">
                  <Link href={`/reuniones/${m.id}`} className="text-brand-700 hover:underline">
                    {m.name}
                  </Link>
                  {m.campaignId ? (
                    <Link href={`/reuniones/campanas/${m.campaignId}`} className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-500" title={m.campaignName ?? undefined}>
                      Jornada de campaña
                    </Link>
                  ) : m.meetingType === "capacitacion" ? (
                    <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-500">Capacitación</span>
                  ) : null}
                </td>
                <td className="py-2 pr-4">{formatMeetingWhen(m)}</td>
                <td className="py-2 pr-4">{m.locationName ?? "—"}</td>
                <td className="py-2 pr-4">{m.organizerName ?? "—"}</td>
                <td className="py-2 pr-4">
                  <Link
                    href={`/reuniones/${m.id}`}
                    className="hover:underline"
                    title={
                      m.campaignParticipantsCount !== null && m.campaignParticipantsCount > 0
                        ? `Incluye ${m.campaignParticipantsCount} persona(s) que participaron de la campaña sin jornada determinada (no se les adivinó el día). Ver detalle.`
                        : undefined
                    }
                  >
                    {m.participantsCount + (m.campaignParticipantsCount ?? 0)}
                  </Link>
                </td>
                <td className="py-2 pr-4">{m.invitedCount}</td>
                <td className="py-2 pr-4">{m.confirmedCount}</td>
                <td className="py-2 pr-4">
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[m.displayStatus]}`}>
                    {STATUS_LABEL[m.displayStatus]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {meetings.length === 0 ? <p className="py-4 text-sm text-brand-400">No hay reuniones para este filtro.</p> : null}
      </div>
      </>
      )}
    </div>
  );
}
