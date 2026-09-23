import type { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { getDb } from "@/lib/db/client";
import { canAccessMeeting } from "@/lib/scope/organizations";
import { signRotatingQrToken, signStaticQrToken } from "@/lib/attendance/qr";

/** Polling del organizador para refrescar el QR en pantalla (D12): nunca cachear, siempre el token vigente. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return new Response("No autorizado.", { status: 401 });
  if (!can(user, "meetings.view")) return new Response("No tenés permiso.", { status: 403 });

  const { id } = await params;
  // Sin esto, cualquiera con meetings.view emitiría QR válidos de reuniones ajenas.
  if (!(await canAccessMeeting(user, id))) return new Response("La reunión no existe.", { status: 404 });

  const db = await getDb();
  const meeting = await db
    .selectFrom("meetings")
    .select(["id", "qr_mode", "qr_secret_version", "starts_at", "ends_at", "checkin_tolerance_before_minutes", "checkin_tolerance_after_minutes"])
    .where("id", "=", id)
    .executeTakeFirst();

  if (!meeting) return new Response("La reunión no existe.", { status: 404 });

  // Una actividad importada sin fecha/hora no tiene check-in por QR.
  if (!meeting.starts_at || !meeting.ends_at) {
    return new Response("La reunión no tiene fecha y hora para acreditar por QR.", { status: 409 });
  }

  if (meeting.qr_mode === "static") {
    const from = new Date(meeting.starts_at.getTime() - meeting.checkin_tolerance_before_minutes * 60_000);
    const to = new Date(meeting.ends_at.getTime() + meeting.checkin_tolerance_after_minutes * 60_000);
    const token = signStaticQrToken(meeting.id, meeting.qr_secret_version, from, to);
    return Response.json({ token, mode: "static", expiresAt: to.toISOString() });
  }

  const { token, expiresAt } = signRotatingQrToken(meeting.id, meeting.qr_secret_version);
  return Response.json({ token, mode: "rotating", expiresAt: expiresAt.toISOString() });
}
