import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { getMeetingById } from "@/lib/meetings/queries";
import { MEETING_TRANSITIONS, STATUS_LABEL } from "@/lib/meetings/state-machine";
import { StatusActions } from "../StatusActions";
import { QrDisplay } from "./QrDisplay";
import { RegenerateQrButton } from "./RegenerateQrButton";
import { LiveClock } from "./LiveClock";
import { LivePanel } from "./LivePanel";

export default async function AsistenciaPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("meetings.view");
  const { id } = await params;

  const meeting = await getMeetingById(id);
  if (!meeting) notFound();

  const canChangeStatus = can(actor, "meetings.change_status");
  const availableTransitions = canChangeStatus ? MEETING_TRANSITIONS[meeting.status] : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/reuniones/${id}`} className="text-xs text-brand-400 hover:underline">
            ← volver a la reunión
          </Link>
          <h1 className="text-xl font-semibold text-brand-900">{meeting.name}</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-brand-100 px-3 py-1 text-xs text-brand-700">{STATUS_LABEL[meeting.displayStatus]}</span>
          <StatusActions meetingId={id} availableTransitions={availableTransitions} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
        <section className="rounded-lg bg-white p-4 shadow-sm">
          <QrDisplay meetingId={id} />
          {canChangeStatus ? (
            <div className="mt-3">
              <RegenerateQrButton meetingId={id} />
            </div>
          ) : null}
        </section>
        <section className="flex flex-col justify-center rounded-lg bg-white p-4 shadow-sm">
          <LiveClock />
        </section>
      </div>

      <LivePanel meetingId={id} />
    </div>
  );
}
