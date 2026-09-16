import type { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { exportSubmissionsCsv } from "@/lib/forms/export";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return new Response("No autorizado.", { status: 401 });
  if (!can(user, "forms.export_submissions")) return new Response("No tenés permiso para exportar.", { status: 403 });

  const { id } = await params;
  const csv = await exportSubmissionsCsv(user, id);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="respuestas-${id}.csv"`,
      "X-Robots-Tag": "noindex",
    },
  });
}
