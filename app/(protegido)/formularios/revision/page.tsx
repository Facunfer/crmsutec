import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { listPendingDuplicateCandidates } from "@/lib/forms/queries";
import { CandidateRow } from "./CandidateRow";

export default async function RevisionDuplicadosPage() {
  const actor = await requirePermission("forms.review_duplicates");
  const candidates = await listPendingDuplicateCandidates(can(actor, "people.view_sensitive"));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-brand-900">Revisión de duplicados</h1>
        <p className="text-sm text-brand-500">
          Envíos de formularios que coinciden con alguien que ya está en la base, pero que necesitan que
          una persona confirme si es la misma o no antes de tocar ningún dato.
        </p>
      </div>

      <div className="space-y-3">
        {candidates.map((c) => (
          <CandidateRow key={c.id} candidate={c} />
        ))}
        {candidates.length === 0 ? (
          <p className="rounded-lg bg-white p-4 text-sm text-brand-400 shadow-sm">No hay nada pendiente de revisión.</p>
        ) : null}
      </div>
    </div>
  );
}
