import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import {
  computeDisplayAge,
  getPersonById,
  getPersonFormSubmissions,
  getPersonMeetingActivity,
  getPersonTraffic,
} from "@/lib/people/queries";
import { TrafficBadge } from "../TrafficBadge";
import { applyMasking } from "@/lib/people/masking";
import { listAreaOptions, listOrgTreeOptions } from "@/lib/organizations/areas";
import { listActiveOrganizationOptions } from "@/lib/organizations/queries";
import { PersonForm, type PersonFormInitialValues } from "../PersonForm";
import { TransferPanel } from "./TransferPanel";
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

  const person = await getPersonById(actor, id);
  if (!person) notFound();

  const canSeeSensitive = can(actor, "people.view_sensitive");
  const masked = applyMasking(person, canSeeSensitive);
  const { age, estimated } = computeDisplayAge(person);

  const [orgTree, allOrganizations, meetingActivity, formSubmissions, traffic] = await Promise.all([
    listOrgTreeOptions(actor),
    can(actor, "people.transfer") ? listActiveOrganizationOptions() : Promise.resolve([]),
    getPersonMeetingActivity(actor, id),
    getPersonFormSubmissions(actor, id),
    getPersonTraffic(actor, id),
  ]);
  const areas = await listAreaOptions(actor, orgTree);

  const attendedCount = meetingActivity.filter((m) => m.invited && m.attendanceStatus === "attended").length;
  const finishedInvitations = meetingActivity.filter((m) => m.invited && ["attended", "absent"].includes(m.attendanceStatus)).length;
  const attendanceRate = finishedInvitations > 0 ? Math.round((attendedCount / finishedInvitations) * 100) : null;

  const initialValues: PersonFormInitialValues = {
    firstName: person.firstName,
    lastName: person.lastName,
    // Sin people.view_sensitive, ni el formulario de edición muestra el
    // valor real — el servidor además ignora estos campos si se los
    // manda igual (ver updatePerson en lib/people/commands.ts).
    dni: masked.dni ?? "",
    email: masked.email ?? "",
    phone: masked.phone ?? "",
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
          <p className="mt-1 text-sm text-brand-700">
            {person.areaName ?? "Sin área"} · {person.reparticionName ?? "Sin repartición específica"}
          </p>
          {traffic ? (
            <p className="mt-1 flex items-center gap-2 text-sm text-brand-700">
              <TrafficBadge light={traffic.trafficLight} />
              <span>
                {traffic.lastInteractionDate
                  ? `Última interacción: ${traffic.lastInteractionDate} (hace ${traffic.daysSinceInteraction} día${traffic.daysSinceInteraction === 1 ? "" : "s"})`
                  : "Nunca interactuamos"}
              </span>
            </p>
          ) : null}
        </div>
        {can(actor, "people.deactivate") ? (
          <PersonActions personId={id} active={person.status === "active"} />
        ) : null}
      </div>

      {person.organizationId && can(actor, "people.transfer") ? (
        <section className="rounded-lg bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-brand-900">Traslado de repartición</h2>
          <TransferPanel personId={id} currentOrganizationId={person.organizationId} destinations={allOrganizations} />
        </section>
      ) : null}

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Datos personales e información organizacional</h2>
        {can(actor, "people.edit") ? (
          <PersonForm action={boundUpdateAction} areas={areas} orgTree={orgTree} lockOrganization initialValues={initialValues} canEditSensitive={canSeeSensitive} />
        ) : (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-brand-400">DNI</dt>
            <dd>{masked.dni ?? "—"}</dd>
            <dt className="text-brand-400">Email</dt>
            <dd>{masked.email ?? "—"}</dd>
            <dt className="text-brand-400">Teléfono</dt>
            <dd>{masked.phone ?? "—"}</dd>
            <dt className="text-brand-400">Área</dt>
            <dd>{person.areaName ?? "—"}</dd>
            <dt className="text-brand-400">Repartición</dt>
            <dd>{person.reparticionName ?? "—"}</dd>
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
          <span>{meetingActivity.length} actividad(es)</span>
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
                <th className="py-1.5 pr-4">Estado</th>
              </tr>
            </thead>
            <tbody>
              {meetingActivity.map((m) => (
                <tr key={m.meetingId} className="border-b border-brand-50">
                  <td className="py-1.5 pr-4">{m.meetingName}</td>
                  <td className="py-1.5 pr-4">{m.startsAt ? new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeZone: "America/Argentina/Buenos_Aires", ...(m.datePrecision === "exact_datetime" ? { timeStyle: "short" as const } : {}) }).format(m.startsAt) : "Fecha pendiente"}</td>
                  <td className="py-1.5 pr-4">{m.invited ? "sí" : "—"}</td>
                  <td className="py-1.5 pr-4">{RESPONSE_LABEL[m.responseStatus] ?? m.responseStatus}</td>
                  <td className="py-1.5 pr-4">{m.statusLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mb-4 text-sm text-brand-400">Todavía no tiene actividades registradas.</p>
        )}

        {formSubmissions.length === 0 ? (
          <p className="text-sm text-brand-400">Todavía no completó ningún formulario.</p>
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
    </div>
  );
}
