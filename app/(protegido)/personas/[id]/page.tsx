import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import {
  computeDisplayAge,
  getPersonById,
  getPersonFormSubmissions,
  getPersonMeetingActivity,
} from "@/lib/people/queries";
import { applyMasking } from "@/lib/people/masking";
import { listActiveOrganizationOptions } from "@/lib/organizations/queries";
import { listRecentAuditForEntity } from "@/lib/audit/queries";
import { PersonForm, type PersonFormInitialValues } from "../PersonForm";
import { updatePersonAction } from "../acciones";
import { PersonActions } from "./PersonActions";

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short" }).format(date);
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

const RESPONSE_LABEL: Record<string, string> = {
  pending: "pendiente",
  confirmed: "sí",
  declined: "no",
};
const ATTENDANCE_LABEL: Record<string, string> = {
  unknown: "—",
  attended: "sí",
  absent: "no",
};

export default async function PersonaFichaPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("people.view");
  const { id } = await params;

  const person = await getPersonById(id);
  if (!person) notFound();

  const canSeeSensitive = can(actor, "people.view_sensitive");
  const masked = applyMasking(person, canSeeSensitive);
  const { age, estimated } = computeDisplayAge(person);

  const [organizations, meetingActivity, formSubmissions, auditEntries] = await Promise.all([
    listActiveOrganizationOptions(),
    getPersonMeetingActivity(id),
    getPersonFormSubmissions(id),
    can(actor, "audit.view") ? listRecentAuditForEntity("person", id) : Promise.resolve([]),
  ]);

  const attendedCount = meetingActivity.filter((m) => m.attendanceStatus === "attended").length;
  const finishedInvitations = meetingActivity.length;
  const attendanceRate = finishedInvitations > 0 ? Math.round((attendedCount / finishedInvitations) * 100) : null;

  const initialValues: PersonFormInitialValues = {
    firstName: person.firstName,
    lastName: person.lastName,
    dni: person.dni ?? "",
    email: person.email ?? "",
    phone: person.phone ?? "",
    organizationId: person.organizationId ?? "",
    birthDate: person.birthDate ? person.birthDate.toISOString().slice(0, 10) : "",
    declaredAge: person.declaredAge !== null ? String(person.declaredAge) : "",
  };

  const boundUpdateAction = updatePersonAction.bind(null, id, person.version);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-brand-900">
            {masked.firstName} {masked.lastName}
          </h1>
          <p className="text-sm text-brand-400">
            Alta {formatDate(person.createdAt)} · origen: {person.origin} ·{" "}
            {person.status === "active" ? "activa" : person.status === "inactive" ? "inactiva" : "fusionada"}
          </p>
        </div>
        {can(actor, "people.deactivate") ? (
          <PersonActions personId={id} active={person.status === "active"} />
        ) : null}
      </div>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Datos personales e información organizacional</h2>
        {can(actor, "people.edit") ? (
          <PersonForm action={boundUpdateAction} organizations={organizations} initialValues={initialValues} />
        ) : (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-brand-400">DNI</dt>
            <dd>{masked.dni ?? "—"}</dd>
            <dt className="text-brand-400">Email</dt>
            <dd>{masked.email ?? "—"}</dd>
            <dt className="text-brand-400">Teléfono</dt>
            <dd>{masked.phone ?? "—"}</dd>
            <dt className="text-brand-400">Organismo</dt>
            <dd>{masked.organizationName ?? "—"}</dd>
            <dt className="text-brand-400">Edad</dt>
            <dd>
              {age ?? "—"} {estimated ? "(estimada)" : ""}
            </dd>
          </dl>
        )}
      </section>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Actividad</h2>
        <div className="mb-3 flex gap-6 text-sm text-brand-700">
          <span>{meetingActivity.length} invitación(es) a reuniones</span>
          <span>{formSubmissions.length} formulario(s) completados</span>
          {attendanceRate !== null ? <span>{attendanceRate}% de asistencia</span> : null}
        </div>

        {meetingActivity.length > 0 ? (
          <table className="mb-4 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-brand-100 text-xs uppercase text-brand-400">
                <th className="py-1.5 pr-4">Reunión</th>
                <th className="py-1.5 pr-4">Fecha</th>
                <th className="py-1.5 pr-4">Invitado</th>
                <th className="py-1.5 pr-4">Confirmó</th>
                <th className="py-1.5 pr-4">Asistió</th>
              </tr>
            </thead>
            <tbody>
              {meetingActivity.map((m) => (
                <tr key={m.meetingId} className="border-b border-brand-50">
                  <td className="py-1.5 pr-4">{m.meetingName}</td>
                  <td className="py-1.5 pr-4">{formatDate(m.startsAt)}</td>
                  <td className="py-1.5 pr-4">sí</td>
                  <td className="py-1.5 pr-4">{RESPONSE_LABEL[m.responseStatus] ?? m.responseStatus}</td>
                  <td className="py-1.5 pr-4">{ATTENDANCE_LABEL[m.attendanceStatus] ?? m.attendanceStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mb-4 text-sm text-brand-400">
            Sin reuniones registradas todavía — el módulo de Reuniones se construye en la Etapa 6.
          </p>
        )}

        {formSubmissions.length === 0 ? (
          <p className="text-sm text-brand-400">
            Sin formularios completados todavía — el módulo de Formularios se construye en la Etapa 8.
          </p>
        ) : (
          <ul className="text-sm">
            {formSubmissions.map((f) => (
              <li key={f.submissionId}>
                {f.formName} — {formatDate(f.createdAt)}
              </li>
            ))}
          </ul>
        )}
      </section>

      {can(actor, "audit.view") ? (
        <section className="rounded-lg bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-brand-900">Últimas acciones de auditoría</h2>
          {auditEntries.length === 0 ? (
            <p className="text-sm text-brand-400">Sin acciones registradas.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {auditEntries.map((entry) => (
                <li key={entry.id} className="text-brand-700">
                  <span className="font-mono text-xs text-brand-400">{formatDateTime(entry.createdAt)}</span>{" "}
                  {entry.action}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
