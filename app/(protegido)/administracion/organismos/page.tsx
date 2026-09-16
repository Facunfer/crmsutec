import { requirePermission } from "@/lib/auth/guard";
import { listOrganizationTypes, listOrganizations } from "@/lib/organizations/queries";
import { CreateOrganizationForm } from "./CreateOrganizationForm";
import { OrganizationRow } from "./OrganizationRow";

export default async function OrganismosPage() {
  await requirePermission("organizations.manage");

  const [types, organizations] = await Promise.all([listOrganizationTypes(), listOrganizations()]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-brand-900">Organismos</h1>
        <p className="text-sm text-brand-500">
          Catálogo jerárquico de organismos (ministerios, entes autárquicos, poderes, dependencias,
          etc.). Los tipos son fijos; los organismos concretos se cargan acá — nunca se inventan
          desde un seed.
        </p>
      </div>

      <CreateOrganizationForm types={types} organizations={organizations} />

      <div className="overflow-x-auto rounded-lg bg-white p-4 shadow-sm">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="py-2 pr-4 font-medium">Organismo</th>
              <th className="py-2 pr-4 font-medium">Estado</th>
              <th className="py-2 pr-4 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {organizations.map((org) => (
              <OrganizationRow key={org.id} organization={org} types={types} organizations={organizations} />
            ))}
          </tbody>
        </table>
        {organizations.length === 0 ? (
          <p className="py-4 text-sm text-brand-400">Todavía no se cargó ningún organismo.</p>
        ) : null}
      </div>
    </div>
  );
}
