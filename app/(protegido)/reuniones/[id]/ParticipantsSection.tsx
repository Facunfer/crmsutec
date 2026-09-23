import Link from "next/link";
import type { MeetingParticipant, MeetingParticipants } from "@/lib/meetings/participants";

const BADGE: Record<MeetingParticipant["status"], string> = {
  attended: "bg-green-100 text-green-800",
  participated: "bg-green-100 text-green-800",
  approved: "bg-green-100 text-green-800",
  absent: "bg-red-100 text-red-800",
  registered: "bg-blue-100 text-blue-800",
  confirmed: "bg-blue-100 text-blue-800",
  invited: "bg-gray-100 text-gray-700",
  declined: "bg-gray-100 text-gray-700",
  pending: "bg-gray-100 text-gray-700",
};

function formatDate(p: MeetingParticipant): string {
  if (!p.date) return "—";
  // date_only: solo el día (nunca se muestra una hora que no se conoce).
  return new Intl.DateTimeFormat("es-AR", p.datePrecision === "date_only" ? { dateStyle: "short", timeZone: "America/Argentina/Buenos_Aires" } : { dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" }).format(p.date);
}

function Table({ rows }: { rows: MeetingParticipant[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead>
          <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
            <th className="py-2 pr-4 font-medium">Persona</th>
            <th className="py-2 pr-4 font-medium">DNI</th>
            <th className="py-2 pr-4 font-medium">Área</th>
            <th className="py-2 pr-4 font-medium">Repartición</th>
            <th className="py-2 pr-4 font-medium">Estado</th>
            <th className="py-2 pr-4 font-medium">Origen</th>
            <th className="py-2 pr-4 font-medium">Fecha</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.personId} className="border-b border-brand-50">
              <td className="py-1.5 pr-4">
                <Link href={`/personas/${p.personId}`} className="text-brand-700 hover:underline">
                  {p.lastName}, {p.firstName}
                </Link>
              </td>
              <td className="py-1.5 pr-4">{p.dni ?? "—"}</td>
              <td className="py-1.5 pr-4">{p.areaName ?? "—"}</td>
              <td className="py-1.5 pr-4">{p.reparticionName ?? "—"}</td>
              <td className="py-1.5 pr-4">
                <span className={`rounded-full px-2 py-0.5 text-xs ${BADGE[p.status]}`}>{p.statusLabel}</span>
              </td>
              <td className="py-1.5 pr-4 text-xs text-brand-500">{p.origins.join(" · ")}</td>
              <td className="py-1.5 pr-4">{formatDate(p)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Participantes de la reunión (desde meeting_participations + invitaciones + check-in), solo personas del alcance del
 * usuario. Las participaciones de campaña sin jornada probada van aparte y NO se llaman asistentes.
 */
export function ParticipantsSection({ participants }: { participants: MeetingParticipants }) {
  const attended = participants.assigned.filter((p) => p.status === "attended" || p.status === "participated").length;
  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold text-brand-900">Participantes</h2>
      <p className="mb-3 text-xs text-brand-400">
        {participants.assigned.length} persona(s) vinculadas a esta jornada · {attended} participaron / asistieron. Inscribirse o confirmar no es asistir.
        Solo se muestran las personas dentro de tu alcance.
      </p>
      {participants.assigned.length === 0 ? <p className="text-sm text-brand-400">Sin participantes vinculados a esta jornada (dentro de tu alcance).</p> : <Table rows={participants.assigned} />}

      {participants.campaign ? (
        <div className="mt-6">
          <h3 className="mb-1 text-sm font-semibold text-brand-900">Sin jornada asignada (participantes generales de la campaña)</h3>
          <p className="mb-3 text-xs text-brand-400">
            La fuente no permite probar a qué jornada corresponden; no se les asignó ninguna ni una fecha. Para la carga histórica inicial esto se considera
            participación igual («Participó — jornada no determinada»); para inscripciones nuevas del CRM esto no implica asistencia.
          </p>
          {participants.campaign.participants.length === 0 ? (
            <p className="text-sm text-brand-400">Ninguno dentro de tu alcance.</p>
          ) : (
            <Table rows={participants.campaign.participants} />
          )}
        </div>
      ) : null}
    </section>
  );
}
