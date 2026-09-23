import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { getMeetingAssociationIds, getMeetingById } from "@/lib/meetings/queries";
import { listInvitations } from "@/lib/meetings/invitations";
import { listMeetingParticipants } from "@/lib/meetings/participants";
import { formatMeetingWhen } from "@/lib/meetings/when";
import { listAssociations } from "@/lib/associations/queries";
import { listOrganizations } from "@/lib/organizations/queries";
import { canEditCoreFields, canManageInvitations, MEETING_TRANSITIONS, STATUS_LABEL } from "@/lib/meetings/state-machine";
import { MeetingInfoForm } from "./MeetingInfoForm";
import { StatusActions } from "./StatusActions";
import { AssociationsPicker } from "./AssociationsPicker";
import { InvitationWizard } from "./InvitationWizard";
import { InvitationsList } from "./InvitationsList";
import { ParticipantsSection } from "./ParticipantsSection";

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date);
}

export default async function ReunionFichaPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission("meetings.view");
  const { id } = await params;

  const meeting = await getMeetingById(actor, id);
  if (!meeting) notFound();

  const [associations, organizations, associationIds, invitations, participants] = await Promise.all([
    listAssociations(actor),
    listOrganizations(),
    getMeetingAssociationIds(actor, id),
    listInvitations(actor, id),
    listMeetingParticipants(actor, id),
  ]);
  // Un usuario de un área que ve la reunión solo por tener participantes suyos la mira en modo lectura.
  const isOwner = meeting.accessLevel === "owner";

  const canEdit = isOwner && can(actor, "meetings.edit");
  const canChangeStatus = isOwner && can(actor, "meetings.change_status");
  const canManageInv = isOwner && can(actor, "meetings.manage_invitations");

  const availableTransitions = canChangeStatus ? MEETING_TRANSITIONS[meeting.status] : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-brand-900">{meeting.name}</h1>
          <p className="text-sm text-brand-400">
            {formatMeetingWhen(meeting, { withEnd: true })} · organiza {meeting.organizerName ?? "—"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-brand-100 px-3 py-1 text-xs text-brand-700">{STATUS_LABEL[meeting.displayStatus]}</span>
          {isOwner && meeting.status !== "draft" ? (
            <Link href={`/reuniones/${id}/asistencia`} className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50">
              QR y asistencia
            </Link>
          ) : null}
          <StatusActions meetingId={id} availableTransitions={availableTransitions} />
        </div>
      </div>

      <ParticipantsSection participants={participants} />

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Datos</h2>
        {canEdit && canEditCoreFields(meeting.status) ? (
          <MeetingInfoForm
            meetingId={id}
            name={meeting.name}
            description={meeting.description ?? ""}
            startsAt={meeting.startsAt}
            endsAt={meeting.endsAt}
            locationName={meeting.locationName ?? ""}
            address={meeting.address ?? ""}
            notes={meeting.notes ?? ""}
          />
        ) : (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-brand-400">Lugar</dt>
            <dd>{meeting.locationName ?? "—"}</dd>
            <dt className="text-brand-400">Dirección</dt>
            <dd>{meeting.address ?? "—"}</dd>
            <dt className="text-brand-400">Descripción</dt>
            <dd>{meeting.description ?? "—"}</dd>
            <dt className="text-brand-400">Observaciones</dt>
            <dd>{meeting.notes ?? "—"}</dd>
          </dl>
        )}
      </section>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold text-brand-900">Asociaciones relacionadas</h2>
        <AssociationsPicker
          meetingId={id}
          associations={associations}
          selectedIds={associationIds}
          canEdit={canEdit && canEditCoreFields(meeting.status)}
        />
      </section>

      {canManageInv && canManageInvitations(meeting.status) ? (
        <section className="rounded-lg bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-brand-900">Invitar</h2>
          <InvitationWizard meetingId={id} associations={associations} organizations={organizations} />
        </section>
      ) : null}

      <InvitationsList meetingId={id} invitations={invitations} canManage={canManageInv && canManageInvitations(meeting.status)} />
    </div>
  );
}
