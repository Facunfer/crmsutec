import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { listSuppressions } from "@/lib/mailing/suppressions";
import { SuppressionManager } from "./SuppressionManager";

export const dynamic = "force-dynamic";

const REASON_LABEL: Record<string, string> = {
  hard_bounce: "Rebote permanente",
  complaint: "Queja",
  unsubscribe: "Baja",
  invalid: "Inválido",
  manual: "Manual",
};

export default async function SupresionesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requirePermission("mailing.manage_suppressions");
  const sp = await searchParams;
  const page = Math.max(Number(sp.page) || 1, 1);
  const { rows, total } = await listSuppressions(actor, { search: sp.q, page, pageSize: 50 });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-brand-900">Bajas y supresiones</h1>
        <Link href="/mailing" className="text-sm text-brand-600 hover:underline">
          ← volver a Mailing
        </Link>
      </div>
      <p className="text-sm text-brand-600">
        Un email suprimido no recibe ningún mailing masivo, sin excepciones. Levantar una supresión queda registrado con su motivo; nunca se borra.
      </p>
      <SuppressionManager
        total={total}
        page={page}
        search={sp.q ?? ""}
        reasonLabels={REASON_LABEL}
        rows={rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), liftedAt: r.liftedAt ? r.liftedAt.toISOString() : null }))}
      />
    </div>
  );
}
