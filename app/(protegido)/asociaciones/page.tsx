import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { listAssociationTypes, listAssociations } from "@/lib/associations/queries";
import { CreateAssociationForm } from "./CreateAssociationForm";

export default async function AsociacionesPage() {
  const actor = await requirePermission("associations.view");
  const [associations, types] = await Promise.all([listAssociations(), listAssociationTypes()]);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-brand-900">Asociaciones</h1>

      {can(actor, "associations.create") ? <CreateAssociationForm types={types} /> : null}

      <div className="overflow-x-auto rounded-lg bg-white p-4 shadow-sm">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="py-2 pr-4 font-medium">Nombre</th>
              <th className="py-2 pr-4 font-medium">Tipo</th>
              <th className="py-2 pr-4 font-medium">Miembros activos</th>
              <th className="py-2 pr-4 font-medium">Estado</th>
              <th className="py-2 pr-4 font-medium">Alta</th>
            </tr>
          </thead>
          <tbody>
            {associations.map((a) => (
              <tr key={a.id} className="border-b border-brand-50">
                <td className="py-2 pr-4">
                  <Link href={`/asociaciones/${a.id}`} className="text-brand-700 hover:underline">
                    {a.name}
                  </Link>
                  {a.description ? <div className="text-xs text-brand-400">{a.description}</div> : null}
                </td>
                <td className="py-2 pr-4">{a.typeName}</td>
                <td className="py-2 pr-4">{a.memberCount}</td>
                <td className="py-2 pr-4">
                  <span
                    className={
                      a.status === "active"
                        ? "rounded-full bg-estado-ok/10 px-2 py-0.5 text-xs text-estado-ok"
                        : "rounded-full bg-brand-100 px-2 py-0.5 text-xs text-brand-400"
                    }
                  >
                    {a.status === "active" ? "Activa" : "Inactiva"}
                  </span>
                </td>
                <td className="py-2 pr-4">{new Intl.DateTimeFormat("es-AR").format(a.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {associations.length === 0 ? (
          <p className="py-4 text-sm text-brand-400">Todavía no se creó ninguna asociación.</p>
        ) : null}
      </div>
    </div>
  );
}
