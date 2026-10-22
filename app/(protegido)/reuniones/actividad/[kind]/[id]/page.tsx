import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { getActivityHub, type ActivityKind } from "@/lib/activities/hub";
import { STATUS_LABEL } from "@/lib/meetings/state-machine";
import { formatMeetingWhen } from "@/lib/meetings/when";
import { CopyLink } from "./CopyLink";
import { QrToggle } from "./QrToggle";

const ENROLLMENT_LABEL: Record<string, string> = {
  never: "Solo recibe respuestas (no inscribe)",
  single_meeting: "Quien responde queda inscripto en la reunión",
  campaign_all: "Quien responde queda inscripto en todas las fechas vigentes",
  campaign_selected: "Quien responde queda inscripto en las fechas que elija",
};

const FORM_STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  published: "Publicado",
  unpublished: "Despublicado",
  archived: "Archivado",
};

/**
 * Tablero de una actividad: reunión de un día o campaña con varias fechas. Reúne en un solo lugar sus fechas (cada una con su QR de asistencia y su
 * consola en vivo) y su formulario de inscripción. Todo dentro del alcance del usuario.
 */
export default async function ActividadPage({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const actor = await requirePermission("meetings.view");
  const { kind, id } = await params;
  if (kind !== "reunion" && kind !== "campana") notFound();

  const hub = await getActivityHub(actor, kind as ActivityKind, id);
  if (!hub) notFound();

  const canAccredit = can(actor, "meetings.accredit");
  const canViewForms = can(actor, "forms.view");

  return (
    <div className="space-y-6">
      <div>
        <Link href="/reuniones" className="text-xs text-brand-400 hover:underline">
          ← volver a Actividades
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-brand-900">{hub.name}</h1>
          <span className="rounded-full bg-brand-100 px-3 py-1 text-xs text-brand-700">{hub.statusLabel}</span>
        </div>
        <p className="mt-1 text-sm text-brand-500">
          {hub.kind === "campana" ? `Campaña · ${hub.dates.length} fecha${hub.dates.length === 1 ? "" : "s"}` : "Reunión de un día"}
          {hub.campaign ? (
            <>
              {" · jornada de "}
              <Link href={`/reuniones/actividad/campana/${hub.campaign.id}`} className="text-brand-700 hover:underline">
                {hub.campaign.name}
              </Link>
            </>
          ) : null}
        </p>
        {hub.description ? <p className="mt-2 max-w-2xl text-sm text-brand-700">{hub.description}</p> : null}
      </div>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-4 shadow-sm">
        <div>
          <h2 className="text-sm font-semibold text-brand-900">Asistencia</h2>
          <p className="text-xs text-brand-500">Quiénes fueron y quiénes no{hub.kind === "campana" ? ", fecha por fecha" : ""}, con el historial de cada persona.</p>
        </div>
        <Link href={`/reuniones/actividad/${kind}/${id}/asistencia`} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          Ver registro de asistencia
        </Link>
      </section>

      <section className="space-y-3 rounded-lg bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-brand-900">Formulario de inscripción</h2>
        {hub.forms.length === 0 ? (
          <p className="text-sm text-brand-500">Esta actividad no tiene un formulario asociado.</p>
        ) : (
          hub.forms.map((form) => (
            <div key={form.id} className="space-y-2 rounded-md border border-brand-100 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-brand-900">{form.name}</span>
                <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700">{FORM_STATUS_LABEL[form.status] ?? form.status}</span>
              </div>
              <p className="text-xs text-brand-500">{ENROLLMENT_LABEL[form.enrollmentMode] ?? form.enrollmentMode}</p>
              {form.status === "published" ? (
                <CopyLink path={form.publicPath} />
              ) : (
                <p className="text-xs text-brand-400">El formulario todavía no es público.</p>
              )}
              {canViewForms ? (
                <Link href={`/formularios/${form.id}`} className="inline-block text-xs text-brand-700 hover:underline">
                  Ver respuestas y configuración →
                </Link>
              ) : null}
            </div>
          ))
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-brand-900">{hub.kind === "campana" ? "Fechas y QR de asistencia" : "Fecha y QR de asistencia"}</h2>
        {hub.dates.length === 0 ? <p className="text-sm text-brand-500">Todavía no hay fechas visibles para tu usuario.</p> : null}
        <div className="grid gap-3 md:grid-cols-2">
          {hub.dates.map((date) => {
            const qrAvailable = canAccredit && date.canOperate && (date.status === "scheduled" || date.status === "in_progress");
            return (
              <article key={date.id} className="space-y-3 rounded-lg bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-brand-400">{hub.kind === "campana" ? `Fecha ${date.number}` : "Fecha"}</div>
                    <div className="text-sm font-medium text-brand-900">
                      {formatMeetingWhen({ startsAt: date.startsAt, endsAt: date.endsAt, schedulePrecision: "exact_datetime", eventDate: null }, { withEnd: true })}
                    </div>
                    {date.locationName ? <div className="text-xs text-brand-500">{date.locationName}</div> : null}
                  </div>
                  <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700">{STATUS_LABEL[date.status]}</span>
                </div>
                <div className="text-xs text-brand-500">QR {date.qrMode === "static" ? "fijo (se puede imprimir)" : "rotativo (se renueva solo)"}</div>
                <div className="flex flex-wrap items-center gap-2">
                  {canAccredit && date.canOperate ? (
                    <Link href={`/reuniones/${date.id}/asistencia`} className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
                      Consola de asistencia
                    </Link>
                  ) : null}
                  <Link href={`/reuniones/${date.id}`} className="rounded-md border border-brand-300 px-3 py-1.5 text-xs text-brand-700 hover:bg-brand-50">
                    Ver reunión
                  </Link>
                </div>
                {qrAvailable ? <QrToggle meetingId={date.id} /> : null}
                {canAccredit && date.canOperate && !qrAvailable ? (
                  <p className="text-xs text-brand-400">El QR se habilita cuando la fecha está programada o en curso.</p>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
