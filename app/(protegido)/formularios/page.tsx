import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { listForms } from "@/lib/forms/queries";
import { listOwnerOrganizationOptions } from "@/lib/organizations/ownership";
import { CreateFormForm } from "./CreateFormForm";

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  published: "Publicado",
  unpublished: "Despublicado",
  archived: "Archivado",
};

export default async function FormulariosPage() {
  const actor = await requirePermission("forms.view");
  const forms = await listForms(actor);
  const canCreate = can(actor, "forms.create");
  const canReview = can(actor, "forms.review_duplicates");
  const totalPending = forms.reduce((acc, f) => acc + f.pendingReviewCount, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-brand-900">Formularios</h1>
        {canReview ? (
          <Link
            href="/formularios/revision"
            className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50"
          >
            Revisión de duplicados{totalPending > 0 ? ` (${totalPending})` : ""}
          </Link>
        ) : null}
      </div>

      {canCreate ? <CreateFormForm organizations={await listOwnerOrganizationOptions(actor.id)} /> : null}

      <div className="overflow-x-auto rounded-lg bg-white p-4 shadow-sm">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="py-2 pr-4 font-medium">Nombre</th>
              <th className="py-2 pr-4 font-medium">Slug</th>
              <th className="py-2 pr-4 font-medium">Estado</th>
              <th className="py-2 pr-4 font-medium">Envíos</th>
              <th className="py-2 pr-4 font-medium">Pendientes de revisión</th>
            </tr>
          </thead>
          <tbody>
            {forms.map((f) => (
              <tr key={f.id} className="border-b border-brand-50">
                <td className="py-1.5 pr-4">
                  <Link href={`/formularios/${f.id}`} className="text-brand-700 hover:underline">
                    {f.name}
                  </Link>
                </td>
                <td className="py-1.5 pr-4 font-mono text-xs">{f.slug}</td>
                <td className="py-1.5 pr-4">{STATUS_LABEL[f.status] ?? f.status}</td>
                <td className="py-1.5 pr-4">{f.submissionCount}</td>
                <td className="py-1.5 pr-4">{f.pendingReviewCount > 0 ? f.pendingReviewCount : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {forms.length === 0 ? <p className="py-4 text-sm text-brand-400">Todavía no se creó ningún formulario.</p> : null}
      </div>
    </div>
  );
}
