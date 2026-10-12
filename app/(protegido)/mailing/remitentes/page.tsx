import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { isMasterGlobal } from "@/lib/permissions/can";
import { listOwnerOrganizationOptions } from "@/lib/organizations/ownership";
import { listSenders } from "@/lib/mailing/senders";
import { SesBanner } from "../SesBanner";
import { SenderManager } from "./SenderManager";

export const dynamic = "force-dynamic";

export default async function RemitentesPage() {
  const actor = await requirePermission("mailing.manage_senders");
  const [senders, orgs] = await Promise.all([listSenders(actor, { includeInactive: true }), listOwnerOrganizationOptions(actor.id)]);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-brand-900">Remitentes</h1>
        <Link href="/mailing" className="text-sm text-brand-600 hover:underline">
          ← volver a Mailing
        </Link>
      </div>
      <SesBanner />
      <p className="text-sm text-brand-600">
        Cada campaña elige un remitente. Tener varios remitentes no multiplica la cuota: el tope diario de envíos es global. Un remitente solo puede usarse si su
        identidad (email o dominio) está verificada en Amazon SES.
      </p>
      <SenderManager
        senders={senders.map((s) => ({ ...s, verifiedAt: s.verifiedAt ? s.verifiedAt.toISOString() : null, verifiedCheckedAt: s.verifiedCheckedAt ? s.verifiedCheckedAt.toISOString() : null }))}
        organizations={orgs}
        canCreateGlobal={isMasterGlobal(actor)}
      />
    </div>
  );
}
