import { requirePermission } from "@/lib/auth/guard";
import { getDashboardCounts, getParticipationInteractionKpis } from "@/lib/analytics/queries";
import { getTrafficKpis } from "@/lib/people/queries";

export default async function DashboardPage() {
  const actor = await requirePermission("dashboard.view");

  // Solo lo accesible al usuario (mismo alcance que Visualización).
  const [counts, participation, traffic] = await Promise.all([
    getDashboardCounts(actor),
    getParticipationInteractionKpis(actor),
    getTrafficKpis(actor, { status: "active" }),
  ]);
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

      <h2 className="mb-1 mt-8 text-sm font-semibold uppercase tracking-wide text-brand-400">Participación e interacciones</h2>
      <p className="mb-3 text-xs text-brand-400">
        Cada número es un concepto distinto: no deberían coincidir entre sí. &quot;Filas físicas&quot; incluye inscripciones que conviven con su participación agregada por la
        carga histórica; &quot;participaciones lógicas&quot; cuenta solo participación real (attended/participated), sin ese doble conteo.
      </p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{participation.uniquePeopleParticipated}</div>
          <div className="text-sm text-brand-500">Personas que participaron</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{participation.logicalParticipations}</div>
          <div className="text-sm text-brand-500">Participaciones lógicas</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{participation.physicalParticipationRows}</div>
          <div className="text-sm text-brand-500">Filas físicas de participación</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{participation.totalInteractions}</div>
          <div className="text-sm text-brand-500">Interacciones</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{participation.uniquePeopleWithInteraction}</div>
          <div className="text-sm text-brand-500">Personas con interacción</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{participation.peopleWithRealLastInteraction}</div>
          <div className="text-sm text-brand-500">Última interacción con fecha real</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-700">{participation.peopleWithReferentialOnlyLastInteraction}</div>
          <div className="text-sm text-brand-500">Última interacción solo referencial (01/01/2026)</div>
        </div>
      </div>

      <h2 className="mb-1 mt-8 text-sm font-semibold uppercase tracking-wide text-brand-400">Semáforo (personas activas)</h2>
      <p className="mb-3 text-xs text-brand-400">Se calcula en el momento desde la última interacción: nunca es un color guardado.</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-estado-ok">{traffic.green}</div>
          <div className="text-sm text-brand-500">Verde (0–30 días)</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-estado-alerta">{traffic.yellow}</div>
          <div className="text-sm text-brand-500">Amarillo (31–60 días)</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-estado-riesgo">{traffic.red}</div>
          <div className="text-sm text-brand-500">Rojo (+60 días)</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow-sm">
          <div className="text-2xl font-semibold text-brand-400">{traffic.gray}</div>
          <div className="text-sm text-brand-500">Sin interacción nunca</div>
        </div>
      </div>

      <p className="mt-8 text-sm text-brand-400">
        Para gráficos y tendencias, ver <a href="/visualizacion" className="text-brand-600 hover:underline">Visualización</a>.
      </p>
    </div>
  );
}
