import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { planBatches } from "@/lib/mailing/campaigns";
import { getCampaignDetail, getProviderAccountStatus } from "@/lib/mailing/queries";
import { listSenders } from "@/lib/mailing/senders";
import { buenosAiresDay } from "@/lib/mailing/quota";
import { loadMailConfig } from "@/lib/mailing/config";
import { SesBanner } from "../../SesBanner";
import { CampaignEditor } from "./CampaignEditor";

export const dynamic = "force-dynamic";

export default async function EditarCampanaPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("mailing.view");
  const { id } = await params;
  const detail = await getCampaignDetail(actor, id);
  if (!detail) notFound();
  const c = detail.campaign;
  if (c.status !== "draft" && c.status !== "ready") redirect(`/mailing/${id}`);

  const senders = await listSenders(actor);
  const account = await getProviderAccountStatus();
  const config = loadMailConfig();
  const plan = planBatches(c.totalRecipients, config.dailySendLimit, detail.quota.remaining, buenosAiresDay(), true);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-brand-900">{c.name}</h1>
        <Link href="/mailing" className="text-sm text-brand-600 hover:underline">
          ← volver a Mailing
        </Link>
      </div>
      <SesBanner />
      <CampaignEditor
        campaign={{
          id: c.id,
          name: c.name,
          subject: c.subject,
          preheader: c.preheader ?? "",
          senderId: c.senderId ?? "",
          replyTo: c.replyTo ?? "",
          htmlBody: c.htmlBody,
          textBody: c.textBody,
          status: c.status,
          stats: c.audienceStats,
          totalRecipients: c.totalRecipients,
        }}
        senders={senders.map((s) => ({ id: s.id, name: s.name, fromName: s.fromName, fromEmail: s.fromEmail, verifiedStatus: s.verifiedStatus, isDefault: s.isDefault }))}
        sandbox={account.sandbox === true}
        dailyLimit={config.dailySendLimit}
        quotaRemaining={detail.quota.remaining}
        estimatedDays={plan.length}
        canSend={can(actor, "mailing.send")}
        reinforcedThreshold={config.reinforcedConfirmationThreshold}
        configIssues={detail.configIssues.filter((i) => i.blocking).map((i) => i.key)}
      />
    </div>
  );
}
