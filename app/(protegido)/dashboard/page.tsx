import { requirePermission } from "@/lib/auth/guard";
import { getDashboardCounts } from "@/lib/analytics/queries";

export default async function DashboardPage() {
  const actor = await requirePermission("dashboard.view");

  // Solo lo accesible al usuario (mismo alcance que Visualización).
  const counts = await getDashboardCounts(actor);
  const userCount = counts.users;
  const peopleCount = counts.people;
  const associationCount = counts.associations;
  const meetingCount = counts.meetings;
  const invitedCount = counts.invited;
  const confirmedCount = counts.confirmed;
  const submissionCount = counts.submissions;

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold text-brand-900">Dashboard</h1>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{userCount}</div>
          <div className="text-sm text-brand-500">Usuarios del sistema</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{peopleCount}</div>
          <div className="text-sm text-brand-500">Personas cargadas</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{associationCount}</div>
          <div className="text-sm text-brand-500">Asociaciones</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{meetingCount}</div>
          <div className="text-sm text-brand-500">Reuniones</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{invitedCount}</div>
          <div className="text-sm text-brand-500">Invitaciones vigentes</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{confirmedCount}</div>
          <div className="text-sm text-brand-500">Confirmaciones</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{submissionCount}</div>
          <div className="text-sm text-brand-500">Envíos de formularios</div>
        </div>
      </div>
      <p className="mt-8 text-sm text-brand-400">
        Para gráficos y tendencias, ver <a href="/visualizacion" className="text-brand-600 hover:underline">Visualización</a>.
      </p>
    </div>
  );
}
