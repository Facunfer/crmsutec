import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { getAssociationsAnalytics, getFormsAnalytics, getMeetingsAnalytics, getPeopleAnalytics } from "@/lib/analytics/queries";
import { StatTile } from "@/components/charts/StatTile";
import { BarChartCard } from "@/components/charts/BarChartCard";
import { LineChartCard } from "@/components/charts/LineChartCard";

export default async function VisualizacionPage() {
  await requirePermission("visualization.view");

  const [people, associations, meetings, forms] = await Promise.all([
    getPeopleAnalytics(),
    getAssociationsAnalytics(),
    getMeetingsAnalytics(),
    getFormsAnalytics(),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-brand-900">Visualización</h1>
        <p className="text-sm text-brand-500">Todo se calcula al momento a partir de los datos actuales — nada acá queda guardado aparte.</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-400">Personas</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Total" value={people.total} highlight />
          <StatTile label="Activas" value={people.active} />
          <StatTile label="Inactivas" value={people.inactive} />
          <StatTile label="Sin organismo" value={people.missingOrganization} />
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <LineChartCard title="Altas por mes (últimos 12 meses)" data={people.monthlySignups} />
          <BarChartCard title="Por organismo (top 10)" data={people.byOrganization} layout="vertical" />
          <BarChartCard title="Por origen" data={people.byOrigin} />
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-semibold text-brand-900">Completitud de datos (personas activas)</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-brand-500">Sin DNI</dt>
                <dd className="font-medium">{people.missingDni}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-brand-500">Sin email</dt>
                <dd className="font-medium">{people.missingEmail}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-brand-500">Sin teléfono</dt>
                <dd className="font-medium">{people.missingPhone}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-brand-500">Sin organismo</dt>
                <dd className="font-medium">{people.missingOrganization}</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-400">Asociaciones</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Total" value={associations.total} highlight />
          <StatTile label="Activas" value={associations.active} />
          <StatTile label="Inactivas" value={associations.inactive} />
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <BarChartCard title="Por tipo" data={associations.byType} />
          <BarChartCard title="Top 10 por cantidad de miembros" data={associations.topByMembers} layout="vertical" />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-400">Reuniones</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Total" value={meetings.total} highlight />
          <StatTile label="Invitaciones vigentes" value={meetings.invited} />
          <StatTile label="Confirmaron" value={meetings.confirmed} />
          <StatTile label="% asistencia" value={meetings.attendanceRate === null ? "—" : `${meetings.attendanceRate}%`} />
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <LineChartCard title="Reuniones por mes (últimos 12 meses)" data={meetings.monthly} />
          <BarChartCard title="Por estado" data={meetings.byStatus} />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-400">Formularios</h2>
          {forms.pendingDuplicates > 0 ? (
            <Link href="/formularios/revision" className="text-xs text-brand-600 hover:underline">
              {forms.pendingDuplicates} pendiente(s) de revisión →
            </Link>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Formularios" value={forms.totalForms} highlight />
          <StatTile label="Publicados" value={forms.publishedForms} />
          <StatTile label="Pendientes de revisión" value={forms.pendingDuplicates} />
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <LineChartCard title="Envíos por mes (últimos 12 meses)" data={forms.submissionsMonthly} />
          <BarChartCard title="Resultado del envío" data={forms.matchResultBreakdown} />
        </div>
      </section>
    </div>
  );
}
