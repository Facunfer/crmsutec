import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { getFormById, listSubmissions } from "@/lib/forms/queries";

const RESULT_LABEL: Record<string, string> = {
  pending: "procesando",
  created: "persona nueva",
  matched: "persona existente actualizada",
  needs_review: "en revisión",
  error: "error",
};

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" }).format(date);
}

export default async function FormSubmissionsPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("forms.view");
  const { id } = await params;

  const form = await getFormById(id);
  if (!form) notFound();

  const submissions = await listSubmissions(id);
  const canExport = can(actor, "forms.export_submissions");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/formularios/${id}`} className="text-xs text-brand-400 hover:underline">
            ← volver al formulario
          </Link>
          <h1 className="text-xl font-semibold text-brand-900">Respuestas — {form.name}</h1>
        </div>
        {canExport ? (
          <a href={`/api/formularios/${id}/export`} className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50">
            Exportar CSV
          </a>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-lg bg-white p-4 shadow-sm">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="py-2 pr-4 font-medium">Recibido</th>
              <th className="py-2 pr-4 font-medium">Versión</th>
              <th className="py-2 pr-4 font-medium">Resultado</th>
              <th className="py-2 pr-4 font-medium">Persona</th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((s) => (
              <tr key={s.id} className="border-b border-brand-50">
                <td className="py-1.5 pr-4">{formatDateTime(s.createdAt)}</td>
                <td className="py-1.5 pr-4">v{s.formVersion}</td>
                <td className="py-1.5 pr-4">{RESULT_LABEL[s.matchResult] ?? s.matchResult}</td>
                <td className="py-1.5 pr-4">
                  {s.personId ? (
                    <Link href={`/personas/${s.personId}`} className="text-brand-700 hover:underline">
                      {s.personName ?? s.personId}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {submissions.length === 0 ? <p className="py-4 text-sm text-brand-400">Todavía no hay respuestas.</p> : null}
      </div>
    </div>
  );
}
