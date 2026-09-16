import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import {
  getAssociationById,
  getAssociationMetrics,
  listActiveMembers,
  listAssociationTypes,
  listManagers,
} from "@/lib/associations/queries";
import { listUsers } from "@/lib/users/queries";
import { AssociationInfoForm } from "./AssociationInfoForm";
import { StatusButton } from "./StatusButton";
import { MembersSection } from "./MembersSection";
import { ManagersSection } from "./ManagersSection";

export default async function AsociacionFichaPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("associations.view");
  const { id } = await params;

  const association = await getAssociationById(id);
  if (!association) notFound();

  const [types, members, managers, users, metrics] = await Promise.all([
    listAssociationTypes(),
    listActiveMembers(id),
    listManagers(id),
    listUsers(),
    getAssociationMetrics(id),
  ]);

  const canEdit = can(actor, "associations.edit");
  const canManageMembers = can(actor, "associations.manage_members");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-brand-900">{association.name}</h1>
          <p className="text-sm text-brand-400">
            {association.typeName} · alta {new Intl.DateTimeFormat("es-AR").format(association.createdAt)} ·{" "}
            {association.status === "active" ? "activa" : "inactiva"}
          </p>
        </div>
        {can(actor, "associations.deactivate") ? (
          <StatusButton associationId={id} active={association.status === "active"} />
        ) : null}
      </div>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Datos</h2>
        {canEdit ? (
          <AssociationInfoForm
            associationId={id}
            name={association.name}
            description={association.description ?? ""}
            typeId={association.typeId}
            types={types}
          />
        ) : (
          <p className="text-sm text-brand-700">{association.description ?? "Sin descripción."}</p>
        )}
      </section>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Métricas</h2>
        <div className="flex gap-6 text-sm text-brand-700">
          <span>{metrics.activeMembers} miembro(s) activo(s)</span>
          <span>{metrics.linkedMeetings} reunión(es) vinculada(s)</span>
          <span>
            {metrics.averageAttendanceRate !== null
              ? `${metrics.averageAttendanceRate}% asistencia promedio`
              : "asistencia promedio: sin datos todavía (Etapa 6)"}
          </span>
        </div>
        <button
          type="button"
          disabled
          title="No disponible todavía"
          className="mt-3 cursor-not-allowed rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-300"
        >
          Convocar a reunión (pronto)
        </button>
      </section>

      <ManagersSection associationId={id} managers={managers} users={users} canManage={canManageMembers} />

      <MembersSection associationId={id} members={members} canManage={canManageMembers} />
    </div>
  );
}
