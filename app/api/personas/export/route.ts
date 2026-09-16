import type { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { exportPeopleCsv } from "@/lib/people/export";
import type { PeopleFilterSpec, PeopleSort } from "@/lib/people/queries";

export async function GET(request: NextRequest): Promise<Response> {
  const user = await getSessionUser();
  if (!user) {
    return new Response("No autorizado.", { status: 401 });
  }
  if (!can(user, "people.export")) {
    return new Response("No tenés permiso para exportar.", { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  const filter: PeopleFilterSpec = {
    search: sp.get("q") || undefined,
    organizationIds: sp.get("org") ? [sp.get("org")!] : undefined,
    status: (sp.get("status") as PeopleFilterSpec["status"]) || "active",
    ageMin: sp.get("ageMin") ? Number(sp.get("ageMin")) : undefined,
    ageMax: sp.get("ageMax") ? Number(sp.get("ageMax")) : undefined,
  };
  const sort: PeopleSort = {
    field: (sp.get("sort") as PeopleSort["field"]) || "name",
    direction: (sp.get("dir") as PeopleSort["direction"]) || "asc",
  };

  const csv = await exportPeopleCsv(user, filter, sort);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="personas.csv"',
      "X-Robots-Tag": "noindex",
    },
  });
}
