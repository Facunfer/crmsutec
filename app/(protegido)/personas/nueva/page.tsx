import { requirePermission } from "@/lib/auth/guard";
import { listAreaOptions, listOrgTreeOptions } from "@/lib/organizations/areas";
import { PersonForm } from "../PersonForm";
import { createPersonAction } from "../acciones";

export default async function NuevaPersonaPage() {
  const actor = await requirePermission("people.create");
  const orgTree = await listOrgTreeOptions(actor);
  const areas = await listAreaOptions(actor, orgTree);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-brand-900">Nueva persona</h1>
      <PersonForm action={createPersonAction} areas={areas} orgTree={orgTree} submitLabel="Crear persona" />
    </div>
  );
}
