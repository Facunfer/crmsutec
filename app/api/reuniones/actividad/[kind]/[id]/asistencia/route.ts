import type { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { AttendanceExportError, exportAttendanceCsv } from "@/lib/activities/attendance-export";

/** Exporta el registro de asistencia de una actividad (CSV). Solo quien gestiona la actividad (`meetings.edit`), dentro de su alcance. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ kind: string; id: string }> }): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return new Response("No autorizado.", { status: 401 });
  if (!can(user, "meetings.edit")) return new Response("No tenés permiso para exportar.", { status: 403 });

  const { kind, id } = await params;
  if (kind !== "reunion" && kind !== "campana") return new Response("La actividad no existe.", { status: 404 });

  try {
    const csv = await exportAttendanceCsv(user, kind, id);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="asistencia-${kind}-${id}.csv"`,
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch (err) {
    if (err instanceof AttendanceExportError) return new Response("La actividad no existe.", { status: 404 });
    throw err;
  }
}
