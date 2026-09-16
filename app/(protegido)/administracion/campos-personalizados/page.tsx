import { requirePermission } from "@/lib/auth/guard";
import { listFieldDefinitions } from "@/lib/people/field-definitions";
import { CreateFieldDefinitionForm } from "./CreateFieldDefinitionForm";
import { FieldDefinitionRow } from "./FieldDefinitionRow";

export default async function CamposPersonalizadosPage() {
  await requirePermission("people.manage_custom_fields");

  const definitions = await listFieldDefinitions();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-brand-900">Campos personalizados</h1>

      <CreateFieldDefinitionForm />

      <div className="overflow-x-auto rounded-lg bg-white p-4 shadow-sm">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="py-2 pr-4 font-medium">Clave</th>
              <th className="py-2 pr-4 font-medium">Etiqueta</th>
              <th className="py-2 pr-4 font-medium">Tipo</th>
              <th className="py-2 pr-4 font-medium">Estado</th>
              <th className="py-2 pr-4 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {definitions.map((def) => (
              <FieldDefinitionRow key={def.id} definition={def} />
            ))}
          </tbody>
        </table>
        {definitions.length === 0 ? <p className="py-4 text-sm text-brand-400">Todavía no se definió ningún campo.</p> : null}
      </div>
    </div>
  );
}
