import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { listVisibleTags } from "@/lib/tags/queries";
import { NewMailingForm } from "./NewMailingForm";

export const dynamic = "force-dynamic";

export default async function NuevaCampanaPage() {
  const actor = await requirePermission("mailing.create");
  const tags = can(actor, "tags.view") ? await listVisibleTags(actor) : [];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-brand-900">Nueva campaña · Audiencia</h1>
        <Link href="/mailing" className="text-sm text-brand-600 hover:underline">
          ← volver a Mailing
        </Link>
      </div>
      <p className="text-sm text-brand-600">
        Elegí por etiqueta, o volvé a <Link className="underline" href="/personas">Personas</Link>, filtrá o seleccioná personas y usá «Crear mailing».
        Los pasos siguientes (remitente, contenido, vista previa, prueba y confirmación) se completan en la campaña en borrador.
      </p>
      <NewMailingForm tags={tags.map((t) => ({ id: t.id, name: t.name }))} />
    </div>
  );
}
