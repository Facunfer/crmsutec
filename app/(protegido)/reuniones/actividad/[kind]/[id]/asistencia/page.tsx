import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { ATTENDANCE_CELL_LABEL, getAttendanceReport, type AttendanceCell } from "@/lib/activities/attendance-report";
import type { ActivityKind } from "@/lib/activities/hub";

const PAGE_SIZE = 50;

const CELL_STYLE: Record<AttendanceCell, string> = {
  attended: "bg-estado-ok/10 text-estado-ok",
  absent: "bg-estado-riesgo/10 text-estado-riesgo",
  walk_in: "bg-estado-alerta/10 text-estado-alerta",
  none: "text-brand-300",
};

const FILTERS = [
  { value: "all", label: "Todas" },
  { value: "attended", label: "Asistieron" },
  { value: "absent", label: "Ausentes" },
  { value: "walk_in", label: "Sin inscripción" },
] as const;

function formatDay(date: Date | null): string {
  if (!date) return "Sin fecha";
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" }).format(date);
}

/**
 * Registro de asistencia de una actividad: quiénes fueron y quiénes no, por fecha y por persona. Esperados = inscriptos vigentes; asistieron =
 * asistencia vigente (QR, enlace o carga manual); ausentes = esperados que no asistieron. Todo dentro del alcance del usuario.
 */
export default async function AsistenciaActividadPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string; id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requirePermission("meetings.view");
  const { kind, id } = await params;
  const sp = await searchParams;
  if (kind !== "reunion" && kind !== "campana") notFound();

  const filter = FILTERS.some((f) => f.value === sp.filter) ? (sp.filter as "all" | "attended" | "absent" | "walk_in") : "all";
  const page = Math.max(1, Number(sp.page) || 1);
  const search = sp.q?.trim() || undefined;
  const report = await getAttendanceReport(actor, kind as ActivityKind, id, { page, pageSize: PAGE_SIZE, search, filter });
  if (!report) notFound();

  const base = `/reuniones/actividad/${kind}/${id}`;
  const pages = Math.max(1, Math.ceil(report.totalRows / PAGE_SIZE));
  const link = (patch: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    const merged = { q: search, filter: filter === "all" ? undefined : filter, page: undefined as string | undefined, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) qs.set(k, v);
    const s = qs.toString();
    return s ? `${base}/asistencia?${s}` : `${base}/asistencia`;
  };
  const isCampaign = report.kind === "campana";
  const t = report.totals;
  const single = report.dates[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href={base} className="text-xs text-brand-400 hover:underline">
            ← volver a la actividad
          </Link>
          <h1 className="text-xl font-semibold text-brand-900">Asistencia · {report.name}</h1>
          <p className="mt-1 max-w-2xl text-xs text-brand-500">
            Esperados = personas inscriptas. Asistieron = quienes escanearon el QR, usaron su enlace o fueron cargadas a mano. Ausentes = esperados que no asistieron.
          </p>
        </div>
        {can(actor, "meetings.edit") ? (
          <a href={`/api/reuniones/actividad/${kind}/${id}/asistencia`} className="rounded-md border border-brand-300 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50">
            Exportar a CSV
          </a>
        ) : null}
      </div>

      {t.unlinkedResponses > 0 ? (
        <p className="rounded-md bg-estado-alerta/10 px-3 py-2 text-sm text-estado-alerta">
          {t.unlinkedResponses} respuesta{t.unlinkedResponses === 1 ? "" : "s"} del formulario no se pudo vincular a una persona, así que no inscribió a nadie. Un operador las puede revisar en Formularios.
        </p>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {isCampaign ? (
          <>
            <Stat label="Personas esperadas" value={t.expectedPeople} hint="Inscriptas en al menos una fecha" />
            <Stat label="Asistieron a alguna" value={t.expectedAttendedAny} hint="De las esperadas" tone="ok" />
            <Stat label="No asistieron a ninguna" value={t.expectedNeverAttended} hint="De las esperadas" tone="risk" />
            <Stat label="Asistieron a todas" value={t.attendedAllDates} hint={`Las ${report.dates.length} fechas`} />
            <Stat label="Sin inscripción" value={t.walkInPeople} hint="Asistieron sin estar inscriptas" tone="warn" />
          </>
        ) : (
          <>
            <Stat label="Esperados" value={single?.expected ?? 0} hint="Inscriptos" />
            <Stat label="Asistieron" value={(single?.expected ?? 0) - (single?.absent ?? 0)} hint="De los esperados" tone="ok" />
            <Stat label="Ausentes" value={single?.absent ?? 0} hint="Esperados que no asistieron" tone="risk" />
            <Stat label="Sin inscripción" value={single?.walkIns ?? 0} hint="Asistieron sin estar inscriptos" tone="warn" />
            <Stat label="% de asistencia" value={single?.attendanceRate === null || single?.attendanceRate === undefined ? "—" : `${single.attendanceRate}%`} hint="Asistieron / esperados" />
          </>
        )}
      </section>

      {isCampaign ? (
        <section className="overflow-x-auto rounded-lg bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-brand-900">Por fecha</h2>
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
                <th className="py-2 pr-4 font-medium">Fecha</th>
                <th className="py-2 pr-4 font-medium">Cuándo</th>
                <th className="py-2 pr-4 font-medium">Esperados</th>
                <th className="py-2 pr-4 font-medium">Asistieron</th>
                <th className="py-2 pr-4 font-medium">Ausentes</th>
                <th className="py-2 pr-4 font-medium">Sin inscripción</th>
                <th className="py-2 pr-4 font-medium">%</th>
              </tr>
            </thead>
            <tbody>
              {report.dates.map((d) => (
                <tr key={d.meetingId} className="border-b border-brand-50">
                  <td className="py-2 pr-4">
                    <Link href={`/reuniones/${d.meetingId}`} className="text-brand-700 hover:underline">
                      Fecha {d.number}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">{formatDay(d.startsAt)}</td>
                  <td className="py-2 pr-4">{d.expected}</td>
                  <td className="py-2 pr-4">{d.expected - d.absent}</td>
                  <td className="py-2 pr-4">{d.absent}</td>
                  <td className="py-2 pr-4">{d.walkIns}</td>
                  <td className="py-2 pr-4">{d.attendanceRate === null ? "—" : `${d.attendanceRate}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="space-y-3 rounded-lg bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2 text-sm">
            {FILTERS.map((f) => (
              <Link key={f.value} href={link({ filter: f.value === "all" ? undefined : f.value, page: undefined })} className={`rounded-full px-3 py-1 ${filter === f.value ? "bg-brand-600 text-white" : "bg-brand-50 text-brand-700"}`}>
                {f.label}
              </Link>
            ))}
          </div>
          <form action={`${base}/asistencia`} className="flex gap-2 text-sm">
            {filter !== "all" ? <input type="hidden" name="filter" value={filter} /> : null}
            <input name="q" defaultValue={search ?? ""} placeholder="Buscar por nombre o DNI" className="rounded-md border border-brand-200 px-2 py-1.5" />
            <button type="submit" className="rounded-md border border-brand-300 px-3 py-1.5 text-brand-700 hover:bg-brand-50">
              Buscar
            </button>
          </form>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
                <th className="py-2 pr-4 font-medium">Persona</th>
                <th className="py-2 pr-4 font-medium">DNI</th>
                <th className="py-2 pr-4 font-medium">Unidad</th>
                {report.dates.map((d) => (
                  <th key={d.meetingId} className="py-2 pr-4 font-medium">
                    {isCampaign ? `Fecha ${d.number}` : "Asistencia"}
                  </th>
                ))}
                {isCampaign ? <th className="py-2 pr-4 font-medium">Asistió a</th> : null}
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 ? (
                <tr>
                  <td colSpan={report.dates.length + 4} className="py-6 text-center text-sm text-brand-400">
                    No hay personas para mostrar con este filtro.
                  </td>
                </tr>
              ) : (
                report.rows.map((r) => (
                  <tr key={r.personId} className="border-b border-brand-50">
                    <td className="py-2 pr-4">
                      <Link href={`${base}/asistencia/${r.personId}`} className="text-brand-700 hover:underline" title="Ver el historial de esta persona en la actividad">
                        {r.lastName}, {r.firstName}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-brand-500">{r.dni ?? "—"}</td>
                    <td className="py-2 pr-4 text-brand-500">{r.organizationName ?? "—"}</td>
                    {report.dates.map((d) => {
                      const cell = r.cells[d.meetingId] ?? "none";
                      return (
                        <td key={d.meetingId} className="py-2 pr-4">
                          <span className={`rounded-full px-2 py-0.5 text-xs ${CELL_STYLE[cell]}`}>{ATTENDANCE_CELL_LABEL[cell]}</span>
                        </td>
                      );
                    })}
                    {isCampaign ? <td className="py-2 pr-4 text-brand-700">{r.attendedCount} de {report.dates.length}</td> : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between text-xs text-brand-500">
          <span>
            {report.totalRows} persona{report.totalRows === 1 ? "" : "s"} · página {report.page} de {pages}
          </span>
          <div className="flex gap-3">
            {report.page > 1 ? (
              <Link href={link({ page: String(report.page - 1) })} className="text-brand-700 hover:underline">
                ← Anterior
              </Link>
            ) : null}
            {report.page < pages ? (
              <Link href={link({ page: String(report.page + 1) })} className="text-brand-700 hover:underline">
                Siguiente →
              </Link>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: number | string; hint: string; tone?: "ok" | "risk" | "warn" }) {
  const color = tone === "ok" ? "text-estado-ok" : tone === "risk" ? "text-estado-riesgo" : tone === "warn" ? "text-estado-alerta" : "text-brand-900";
  return (
    <div className="rounded-lg bg-white p-3 shadow-sm">
      <div className="text-xs text-brand-500">{label}</div>
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-brand-400">{hint}</div>
    </div>
  );
}
