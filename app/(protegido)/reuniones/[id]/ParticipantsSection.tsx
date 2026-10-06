import Link from "next/link";
import type { MeetingParticipant, MeetingParticipants } from "@/lib/meetings/participants";
import type { ActivityMetrics } from "@/lib/activities/labels";
import { FactChips, MetricsPanel } from "../ActivityWidgets";

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
            <th className="py-2 pr-4 font-medium">Hechos</th>
            <th className="py-2 pr-4 font-medium">Procedencia</th>
            <th className="py-2 pr-4 font-medium">Fecha</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.personId} className="border-b border-brand-50">
              <td className="py-1.5 pr-4">
                <Link href={`/personas/${p.personId}`} className="text-brand-700 hover:underline">
                  {[p.lastName, p.firstName].filter(Boolean).join(", ")}
                </Link>
              </td>
              <td className="py-1.5 pr-4">{p.dni ?? "—"}</td>
              <td className="py-1.5 pr-4">{p.areaName ?? "—"}</td>
              <td className="py-1.5 pr-4">{p.reparticionName ?? "—"}</td>
              <td className="py-1.5 pr-4">
                <FactChips facts={p.facts} provenance={p.provenance.join(" · ")} />
              </td>
              {/* La referencia técnica de la fuente queda solo como detalle (tooltip), nunca como texto principal. */}
              <td className="py-1.5 pr-4 text-xs text-brand-500" title={p.technicalRefs.length ? `Fuente: ${p.technicalRefs.join(", ")}` : undefined}>
                {p.provenance.join(" · ") || "—"}
              </td>
              <td className="py-1.5 pr-4">{formatDate(p)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Personas de la reunión: cada una con sus HECHOS independientes (invitación, respuesta, inscripción, participación, asistencia),
 * nunca un único estado. Solo personas del alcance del usuario. Las participaciones de campaña sin jornada probada van aparte.
 */
export function ParticipantsSection({ participants, metrics }: { participants: MeetingParticipants; metrics: ActivityMetrics | null }) {
  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-brand-900">Resumen de esta jornada</h2>
      {metrics ? <MetricsPanel metrics={metrics} /> : null}

      <h2 className="mb-1 mt-6 text-sm font-semibold text-brand-900">Personas</h2>
      <p className="mb-3 text-xs text-brand-400">
        {participants.assigned.length} persona(s) vinculadas a esta jornada. Inscribirse, aceptar una invitación o figurar en un registro no es asistir.
        Solo se muestran las personas dentro de tu alcance.
      </p>
      {participants.assigned.length === 0 ? <p className="text-sm text-brand-400">Sin personas vinculadas a esta jornada (dentro de tu alcance).</p> : <Table rows={participants.assigned} />}

      {participants.campaign ? (
        <div className="mt-6">
          <h3 className="mb-1 text-sm font-semibold text-brand-900">Sin jornada asignada (personas generales de «{participants.campaign.name}»)</h3>
          <p className="mb-3 text-xs text-brand-400">
            La fuente no permite probar a qué jornada corresponden; no se les asignó ninguna ni una fecha. «Participó» en este grupo se lee como participación
            en la campaña con jornada no determinada; para inscripciones nuevas del CRM no implica asistencia.
          </p>
          {participants.campaign.participants.length === 0 ? (
            <p className="text-sm text-brand-400">Ninguna dentro de tu alcance.</p>
          ) : (
            <Table rows={participants.campaign.participants} />
          )}
        </div>
      ) : null}
    </section>
  );
}
