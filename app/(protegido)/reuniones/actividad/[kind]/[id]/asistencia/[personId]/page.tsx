import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth/guard";
import { getPersonActivityTimeline } from "@/lib/activities/attendance-report";
import type { ActivityKind } from "@/lib/activities/hub";

const SOURCE_STYLE: Record<string, string> = {
  formulario: "bg-brand-100 text-brand-700",
  "inscripción": "bg-brand-50 text-brand-700",
  asistencia: "bg-estado-ok/10 text-estado-ok",
  "interacción": "bg-estado-alerta/10 text-estado-alerta",
};

function formatWhen(date: Date): string {
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "medium", timeZone: "America/Argentina/Buenos_Aires" }).format(date);
}

/** Historia de UNA persona en una actividad: respuesta al formulario, inscripción, asistencia (con correcciones y revocaciones) e interacción. */
export default async function HistorialPersonaPage({ params }: { params: Promise<{ kind: string; id: string; personId: string }> }) {
  const actor = await requirePermission("meetings.view");
  const { kind, id, personId } = await params;
  if (kind !== "reunion" && kind !== "campana") notFound();

  const result = await getPersonActivityTimeline(actor, kind as ActivityKind, id, personId);
  if (!result) notFound();
  const back = `/reuniones/actividad/${kind}/${id}/asistencia`;

  return (
    <div className="space-y-4">
      <div>
        <Link href={back} className="text-xs text-brand-400 hover:underline">
          ← volver al registro de asistencia
        </Link>
        <h1 className="text-xl font-semibold text-brand-900">
          {result.person.lastName}, {result.person.firstName}
        </h1>
        <p className="mt-1 text-sm text-brand-500">Qué pasó con esta persona en la actividad, en orden cronológico.</p>
      </div>

      {result.entries.length === 0 ? (
        <p className="rounded-lg bg-white p-4 text-sm text-brand-500 shadow-sm">Todavía no hay hechos registrados para esta persona en la actividad.</p>
      ) : (
        <ol className="space-y-2">
          {result.entries.map((entry, i) => (
            <li key={i} className="rounded-lg bg-white p-3 shadow-sm">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-brand-400">{formatWhen(entry.at)}</span>
                <span className={`rounded-full px-2 py-0.5 ${SOURCE_STYLE[entry.source] ?? "bg-brand-50 text-brand-700"}`}>{entry.source}</span>
                {entry.dateNumber ? <span className="rounded-full bg-brand-50 px-2 py-0.5 text-brand-700">Fecha {entry.dateNumber}</span> : null}
              </div>
              <div className="mt-1 text-sm font-medium text-brand-900">{entry.label}</div>
              <div className="text-xs text-brand-500">
                {entry.actor}
                {entry.reason ? ` · Motivo: ${entry.reason}` : ""}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
