import type { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { getLivePanelData, quickSearchForAccreditation } from "@/lib/attendance/live";

/** Polling del panel en vivo (D12): todo derivado en el momento, nada cacheado. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return new Response("No autorizado.", { status: 401 });
  if (!can(user, "meetings.view")) return new Response("No tenés permiso.", { status: 403 });

  const { id } = await params;
  const search = request.nextUrl.searchParams.get("q");

  if (search) {
    const results = await quickSearchForAccreditation(id, search);
    return Response.json({ results });
  }

  const data = await getLivePanelData(id);
  return Response.json(data);
}
