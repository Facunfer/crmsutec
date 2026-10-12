import type { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { exportPeopleCsv } from "@/lib/people/export";
import type { PeopleFilterSpec, PeopleSort } from "@/lib/people/queries";
import { paramReaderFromSearchParams, parsePeopleFilter } from "@/lib/people/filter-params";

export async function GET(request: NextRequest): Promise<Response> {
  const user = await getSessionUser();
  if (!user) {
    return new Response("No autorizado.", { status: 401 });
  }
  if (!can(user, "people.export")) {
    return new Response("No tenés permiso para exportar.", { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  // Mismo parser que la grilla y Mailing (la visibilidad de las etiquetas la resuelve la consulta: una no visible no filtra ni revela).
  const filter: PeopleFilterSpec = parsePeopleFilter(paramReaderFromSearchParams(sp));
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
