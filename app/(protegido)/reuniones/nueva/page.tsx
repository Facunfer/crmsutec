import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { listAreaOptions, listOrgTreeOptions } from "@/lib/organizations/areas";
import { NuevaActividadForm } from "./NuevaActividadForm";

/** Alta unificada: reunión de un día o campaña con varias fechas, con su formulario de inscripción y un QR de asistencia por fecha. */
export default async function NuevaActividadPage() {
  const actor = await requirePermission("meetings.create");
  const orgTree = await listOrgTreeOptions(actor);
  const areas = await listAreaOptions(actor, orgTree);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/reuniones" className="text-xs text-brand-400 hover:underline">
          ← volver a Actividades
        </Link>
        <h1 className="text-xl font-semibold text-brand-900">Nueva actividad</h1>
        <p className="mt-1 max-w-2xl text-sm text-brand-500">
          Creá una reunión de un día o una campaña con varias fechas. Se arma el formulario de inscripción y cada fecha tiene su propio QR de asistencia.
        </p>
      </div>
      <NuevaActividadForm areas={areas} orgTree={orgTree} canPublish={can(actor, "meetings.change_status")} />
    </div>
  );
}
