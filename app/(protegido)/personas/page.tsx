import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { getTrafficKpis, listPeoplePage, type PeopleFilterSpec, type PeopleSort } from "@/lib/people/queries";
import { paramReaderFromRecord, parsePeopleFilter, peopleFilterToParams } from "@/lib/people/filter-params";
import { applyMasking } from "@/lib/people/masking";
import { listAreaOptions, listOrgTreeOptions } from "@/lib/organizations/areas";
import { listAssociations } from "@/lib/associations/queries";
import { listTagNamesForPeople, listVisibleTags } from "@/lib/tags/queries";
import { FilterBar } from "./FilterBar";
import { PeopleGrid, type PersonDisplayRow } from "./PeopleGrid";
import { TrafficKpiCards } from "./TrafficKpis";

const PAGE_SIZE = 20;

export default async function PersonasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requirePermission("people.view");
  const sp = await searchParams;

  // Etiquetas visibles para el usuario (alcance y sensibilidad): alimentan el filtro; una etiqueta no visible no filtra ni revela nada.
  const visibleTags = can(actor, "tags.view") ? await listVisibleTags(actor) : [];
  const reader = paramReaderFromRecord(sp);
  // Mismo parser que la exportación y la selección total hacia Mailing: grilla, CSV y audiencia ven el mismo universo.
  const filter: PeopleFilterSpec = parsePeopleFilter(reader, { visibleTagIds: new Set(visibleTags.map((t) => t.id)) });
  const sort: PeopleSort = {
    field: (reader.get("sort") as PeopleSort["field"]) || "name",
    direction: (reader.get("dir") as PeopleSort["direction"]) || "asc",
  };
  const page = reader.get("page") ? Math.max(1, Number(reader.get("page"))) : 1;

  const [{ rows, total }, kpis, orgTree, associations] = await Promise.all([
    listPeoplePage(actor, filter, sort, page, PAGE_SIZE),
    getTrafficKpis(actor, filter),
    listOrgTreeOptions(actor),
    can(actor, "associations.manage_members") ? listAssociations(actor) : Promise.resolve([]),
  ]);
  const areas = await listAreaOptions(actor, orgTree);
  const tagsByPerson = await listTagNamesForPeople(actor, rows.map((r) => r.id));
  const activeAssociations = associations.filter((a) => a.status === "active");

  const canSeeSensitive = can(actor, "people.view_sensitive");
  const displayRows: PersonDisplayRow[] = rows.map((row) => {
    const masked = applyMasking(row, canSeeSensitive);
    return {
      id: masked.id,
      firstName: masked.firstName,
      lastName: masked.lastName,
      dni: masked.dni,
      email: masked.email,
      phone: masked.phone,
      areaName: row.areaName,
      reparticionName: row.reparticionName,
      lastInteractionDate: row.lastInteractionDate,
      daysSinceInteraction: row.daysSinceInteraction,
      trafficLight: row.trafficLight,
      status: masked.status,
      tags: tagsByPerson.get(row.id) ?? [],
    };
  });

  // Filtros de la URL (sin semáforo ni página): base de los KPIs clicables. `exportQueryString` los incluye todos.
  const baseParams = peopleFilterToParams(filter);
  const exportParams = new URLSearchParams(baseParams);
  if (filter.trafficLight) exportParams.set("traffic", filter.trafficLight);
  exportParams.set("sort", sort.field);
  exportParams.set("dir", sort.direction);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-brand-900">Personas</h1>
        {can(actor, "people.create") ? (
          <Link
            href="/personas/nueva"
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Nueva persona
          </Link>
        ) : null}
      </div>

      <TrafficKpiCards kpis={kpis} active={filter.trafficLight} baseQuery={baseParams.toString()} />

      <FilterBar areas={areas} orgTree={orgTree} tags={visibleTags.map((t) => ({ id: t.id, name: t.name }))} />

      <PeopleGrid
        rows={displayRows}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        sort={sort}
        filter={filter}
        canExport={can(actor, "people.export")}
        canDeactivate={can(actor, "people.deactivate")}
        canAddToAssociation={can(actor, "associations.manage_members")}
        canCreateMailing={can(actor, "mailing.create") && can(actor, "people.view")}
        associations={activeAssociations.map((a) => ({ id: a.id, name: a.name }))}
        exportQueryString={exportParams.toString()}
      />
    </div>
  );
}
