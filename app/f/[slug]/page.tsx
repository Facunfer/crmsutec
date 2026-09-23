import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { getPublicForm } from "@/lib/forms/submit";
import { listAssociationsForPublicForm } from "@/lib/forms/queries";
import { FormRenderer } from "./FormRenderer";

export const metadata: Metadata = {
  title: "Formulario",
  robots: { index: false, follow: false },
};

const MESSAGES: Record<string, string> = {
  not_found: "Este formulario no existe.",
  not_available: "Este formulario no está disponible en este momento.",
};

export default async function PublicFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getPublicForm(slug);

  if (result.kind !== "ok") {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 px-4 text-center">
        <p className="text-base text-brand-700">{MESSAGES[result.kind] ?? "No pudimos mostrar este formulario."}</p>
      </main>
    );
  }

  const needsAssociations = result.schema.fields.some((f) => f.visible && f.fieldType === "association");
  // El alcance lo fija la unidad del formulario (servidor): el visitante no la elige ni la ve.
  const associations = needsAssociations ? await listAssociationsForPublicForm(result.ownerOrganizationId) : [];

  return (
    <main className="mx-auto min-h-screen max-w-lg px-4 py-8">
      <FormRenderer
        slug={slug}
        idempotencyKey={randomUUID()}
        name={result.schema.name}
        consentText={result.schema.consentText}
        fields={result.schema.fields}
        associations={associations}
      />
    </main>
  );
}
