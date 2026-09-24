import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
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

  const meetings = await listMeetings(actor, filter);
  const orgTree = can(actor, "meetings.create") ? await listOrgTreeOptions(actor) : [];
  const areas = can(actor, "meetings.create") ? await listAreaOptions(actor, orgTree) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-brand-900">Reuniones</h1>
      </div>

      {can(actor, "meetings.create") ? (
        <CreateMeetingForm preselectedAssociationId={preselectedAssociationId} areas={areas} orgTree={orgTree} />
      ) : null}

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
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="py-2 pr-4 font-medium">Nombre</th>
              <th className="py-2 pr-4 font-medium">Inicio</th>
              <th className="py-2 pr-4 font-medium">Lugar</th>
              <th className="py-2 pr-4 font-medium">Organizador</th>
              <th className="py-2 pr-4 font-medium">Participantes</th>
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
                </td>
                <td className="py-2 pr-4">{formatMeetingWhen(m)}</td>
                <td className="py-2 pr-4">{m.locationName ?? "—"}</td>
                <td className="py-2 pr-4">{m.organizerName ?? "—"}</td>
                <td className="py-2 pr-4">{m.participantsCount}</td>
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
    </div>
  );
}
