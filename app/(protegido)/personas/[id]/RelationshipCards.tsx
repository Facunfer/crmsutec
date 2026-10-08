import { formatTimelineDate } from "@/lib/people/timeline-format";
import type { LastContact, PersonRelationship, RelationshipFact } from "@/lib/people/timeline";

function FactCard({ label, hint, fact, empty }: { label: string; hint: string; fact: RelationshipFact | null; empty: string }) {
  return (
    <div className="rounded-lg border border-brand-100 bg-white p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-brand-400" title={hint}>{label}</div>
      {fact ? (
        <>
          <div className="mt-1 text-sm font-semibold text-brand-900">{fact.undated ? "Fecha no registrada" : formatTimelineDate(fact.at, fact.precision)}</div>
          <div className="text-xs text-brand-600">{fact.undated ? fact.title : fact.title}</div>
          {fact.activityName ? <div className="text-xs text-brand-400">{fact.activityName}</div> : null}
        </>
      ) : (
        <div className="mt-1 text-sm text-brand-400">{empty}</div>
      )}
    </div>
  );
}

function ContactCard({ contact }: { contact: LastContact | null }) {
  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50 p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-brand-500" title="Solo cuenta una comunicación efectiva registrada. Actividad, participación, inscripción, asistencia y respuestas a invitaciones no mueven este dato.">
        Último contacto real
      </div>
      {contact ? (
        <>
          <div className="mt-1 text-sm font-semibold text-brand-900">
            {formatTimelineDate(contact.at, contact.precision)} (hace {contact.days} día{contact.days === 1 ? "" : "s"})
          </div>
          <div className="text-xs text-brand-600">
            Por {contact.channelLabel}
            {contact.detail ? ` · ${contact.detail.type}` : ""}
            {contact.detail?.responsible ? ` · ${contact.detail.responsible}` : ""}
          </div>
          {contact.detail?.outcome ? <div className="text-xs text-brand-400">Resultado: {contact.detail.outcome}</div> : null}
        </>
      ) : (
        <div className="mt-1 text-sm font-semibold text-brand-700">Sin contacto registrado</div>
      )}
    </div>
  );
}

/** Estado de relación: tarjetas SEPARADAS (nunca se mezclan contacto, actividad, inscripción, participación y asistencia). */
export function RelationshipCards({ relationship }: { relationship: PersonRelationship }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <ContactCard contact={relationship.lastContact} />
      <FactCard label="Última actividad" hint="Último hecho vigente con fecha real de cualquier categoría (invitación, respuesta, inscripción, participación, asistencia o interacción). No es contacto." fact={relationship.lastActivity} empty="Sin actividad registrada" />
      <FactCard label="Última inscripción vigente" hint="Inscripción no anulada." fact={relationship.lastRegistration} empty="Sin inscripciones" />
      <FactCard label="Última participación" hint="Fecha de la actividad en la que participó." fact={relationship.lastParticipation} empty="Sin participaciones" />
      <FactCard label="Última asistencia vigente" hint="Asistencia comprobada y no revocada." fact={relationship.lastAttendance} empty="Sin asistencias" />
    </div>
  );
}
