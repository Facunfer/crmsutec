import { requirePermission } from "@/lib/auth/guard";
import { listActiveOrganizationOptions } from "@/lib/organizations/queries";
import { PersonForm } from "../PersonForm";
import { createPersonAction } from "../acciones";

export default async function NuevaPersonaPage() {
  await requirePermission("people.create");
  const organizations = await listActiveOrganizationOptions();

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-brand-900">Nueva persona</h1>
      <PersonForm action={createPersonAction} organizations={organizations} submitLabel="Crear persona" />
    </div>
  );
}
