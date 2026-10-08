import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import {
  computeDisplayAge,
  getPersonById,
  getPersonFormSubmissions,
  getPersonTraffic,
  listPersonObservations,
} from "@/lib/people/queries";
import { listPersonTags } from "@/lib/tags/queries";
import { TrafficBadge } from "../TrafficBadge";
import { applyMasking } from "@/lib/people/masking";
import { listAreaOptions, listOrgTreeOptions } from "@/lib/organizations/areas";
import { PersonForm, type PersonFormInitialValues } from "../PersonForm";
import { TransferPanel } from "./TransferPanel";
import { updatePersonAction } from "../acciones";
import { PersonActions } from "./PersonActions";
import { RelationshipCards } from "./RelationshipCards";
import { PersonTimeline } from "./PersonTimeline";
import { getPersonRelationship, getPersonTechnicalInteractions, getPersonTimeline } from "@/lib/people/timeline";
import { toClientPage } from "@/lib/people/timeline-client";
import { isMasterGlobal } from "@/lib/permissions/can";
import { RealContactNotice } from "../../_components/RealContactNotice";

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short" }).format(date);
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

const OBSERVATION_LABEL: Record<string, string> = {
  colegio_votacion: "Colegio donde vota",
};


export default async function PersonaFichaPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("people.view");
  const { id } = await params;

  const person = await getPersonById(actor, id);
  if (!person) notFound();

  const canSeeSensitive = can(actor, "people.view_sensitive");
  const masked = applyMasking(person, canSeeSensitive);
  const { age, estimated } = computeDisplayAge(person);

  const [orgTree, relationship, timeline, technical, formSubmissions, traffic, personTags, observations] = await Promise.all([
    listOrgTreeOptions(actor),
    getPersonRelationship(actor, id),
    getPersonTimeline(actor, id, { limit: 30 }),
    isMasterGlobal(actor) ? getPersonTechnicalInteractions(actor, id) : Promise.resolve([]),
    getPersonFormSubmissions(actor, id),
    getPersonTraffic(actor, id),
    can(actor, "tags.view") ? listPersonTags(actor, id) : Promise.resolve([]),
    listPersonObservations(actor, id),
  ]);
  const areas = await listAreaOptions(actor, orgTree);

  const initialValues: PersonFormInitialValues = {
    firstName: person.firstName,
    lastName: person.lastName,
    nameUnsplit: person.nameSplitStatus === "unsplit",
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
          {personTags.length > 0 ? (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
              {personTags.map((t) => (
                <span key={t.id} className="rounded-full bg-brand-100 px-2.5 py-0.5 text-xs font-medium text-brand-700">
                  {t.name}
                </span>
              ))}
            </p>
          ) : null}
          {observations.length > 0 ? (
            <ul className="mt-2 space-y-0.5 text-xs text-brand-500">
              {observations.map((o) => (
                <li key={o.id}>
                  {OBSERVATION_LABEL[o.category] ?? o.category.replace(/_/g, " ")}: <span className="text-brand-700">{o.value}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {traffic ? (
            <p className="mt-1 flex items-center gap-2 text-sm text-brand-700">
              <TrafficBadge light={traffic.trafficLight} />
              <span>
                {traffic.lastInteractionDate
                  ? `Último contacto: ${traffic.lastInteractionDate.split("-").reverse().join("/")} (hace ${traffic.daysSinceInteraction} día${traffic.daysSinceInteraction === 1 ? "" : "s"})`
                  : "Sin contacto registrado"}
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
          <TransferPanel personId={id} currentOrganizationId={person.organizationId} areas={areas} orgTree={orgTree} />
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

      {relationship ? (
        <section className="rounded-lg bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-brand-900">Estado de relación</h2>
          <RelationshipCards relationship={relationship} />
          <div className="mt-3"><RealContactNotice /></div>
        </section>
      ) : null}

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Línea de tiempo</h2>
        {timeline ? <PersonTimeline personId={id} initial={toClientPage(timeline)} /> : <p className="text-sm text-brand-400">No se pudo cargar la línea de tiempo.</p>}
      </section>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Formularios</h2>
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

      {technical.length > 0 ? (
        <details className="rounded-lg bg-white p-4 text-sm shadow-sm">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-brand-400">
            Interacciones técnicas heredadas ({technical.length}) — solo Master, no son contacto
          </summary>
          <p className="mt-2 text-xs text-brand-400">
            Espejo técnico de participaciones históricas, conservado para trazabilidad. Ya figuran como «Participación» en la línea de tiempo.
          </p>
          <ul className="mt-2 space-y-1 text-xs text-brand-600">
            {technical.map((t) => (
              <li key={t.id}>
                {t.dateBasis === "legacy_reference" ? "Fecha técnica de referencia" : "Fecha de la actividad"} {t.occurredAt.toISOString().slice(0, 10)} · {t.subject} · {t.sourceKey}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
