import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { getFormById, listFormActions, listFormFields } from "@/lib/forms/queries";
import { listFieldDefinitions } from "@/lib/people/field-definitions";
import { listAssociations } from "@/lib/associations/queries";
import { MetaForm } from "./MetaForm";
import { FieldsManager } from "./FieldsManager";
import { ActionsManager } from "./ActionsManager";
import { PublishControls } from "./PublishControls";

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  published: "Publicado",
  unpublished: "Despublicado",
  archived: "Archivado",
};

export default async function FormDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("forms.view");
  const { id } = await params;

  const form = await getFormById(id);
  if (!form) notFound();

  const [fields, actions, fieldDefinitions, associations] = await Promise.all([
    listFormFields(id),
    listFormActions(id),
    listFieldDefinitions({ onlyActive: true }),
    listAssociations(),
  ]);

  const canEdit = can(actor, "forms.edit") && form.status !== "archived";
  const canPublish = can(actor, "forms.publish");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-brand-900">{form.name}</h1>
          <p className="text-sm text-brand-500">
            <code>/f/{form.slug}</code> · {STATUS_LABEL[form.status] ?? form.status}
            {form.publishedVersion ? ` · versión publicada v${form.publishedVersion}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href={`/formularios/${id}/respuestas`} className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50">
            Ver respuestas
          </Link>
          {canPublish ? <PublishControls formId={id} status={form.status} hasPublishedVersion={!!form.publishedVersion} /> : null}
        </div>
      </div>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Datos del formulario</h2>
        <MetaForm formId={id} form={form} canEdit={canEdit} />
      </section>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Campos</h2>
        <FieldsManager formId={id} fields={fields} fieldDefinitions={fieldDefinitions} canEdit={canEdit} />
      </section>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Acciones al enviarse (sumar a una asociación)</h2>
        <ActionsManager formId={id} actions={actions} associations={associations} canEdit={canEdit} />
      </section>
    </div>
  );
}
