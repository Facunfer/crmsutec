"use client";

import { useState, useTransition } from "react";
import type { InvitationRow } from "@/lib/meetings/invitations";
import { withdrawInvitationAction } from "./acciones";

const RESPONSE_LABEL: Record<string, string> = { pending: "pendiente", confirmed: "sí", declined: "no" };
const ATTENDANCE_LABEL: Record<string, string> = { unknown: "—", attended: "sí", absent: "no" };

export function InvitationsList({
  meetingId,
  invitations,
  canManage,
}: {
  meetingId: string;
  invitations: InvitationRow[];
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const active = invitations.filter((i) => !i.withdrawn);

  function withdraw(invitationId: string) {
    startTransition(async () => {
      const result = await withdrawInvitationAction(meetingId, invitationId);
      setError(result.ok ? null : result.error ?? "No se pudo quitar.");
    });
  }

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-brand-900">Invitados ({active.length})</h2>
      {error ? <p className="mb-2 text-sm text-estado-riesgo">{error}</p> : null}
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-brand-100 text-xs uppercase text-brand-400">
            <th className="py-1.5 pr-4">Persona</th>
            <th className="py-1.5 pr-4">Invitado</th>
            <th className="py-1.5 pr-4">Confirmó</th>
            <th className="py-1.5 pr-4">Asistió</th>
            {canManage ? <th className="py-1.5 pr-4"></th> : null}
          </tr>
        </thead>
        <tbody>
          {active.map((inv) => (
            <tr key={inv.id} className="border-b border-brand-50">
              <td className="py-1.5 pr-4">
                {inv.firstName} {inv.lastName}
              </td>
              <td className="py-1.5 pr-4">{new Intl.DateTimeFormat("es-AR").format(inv.invitedAt)}</td>
              <td className="py-1.5 pr-4">{RESPONSE_LABEL[inv.responseStatus] ?? inv.responseStatus}</td>
              <td className="py-1.5 pr-4">{ATTENDANCE_LABEL[inv.attendanceStatus] ?? inv.attendanceStatus}</td>
              {canManage ? (
                <td className="py-1.5 pr-4">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => withdraw(inv.id)}
                    className="text-xs text-brand-500 hover:underline disabled:opacity-50"
                  >
                    quitar
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {active.length === 0 ? <p className="py-2 text-sm text-brand-400">Todavía no hay invitados.</p> : null}
    </section>
  );
}
