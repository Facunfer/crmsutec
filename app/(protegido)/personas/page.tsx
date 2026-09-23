import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { getTrafficKpis, listPeoplePage, type PeopleFilterSpec, type PeopleSort } from "@/lib/people/queries";
import { isTrafficLight } from "@/lib/people/traffic";
import { applyMasking } from "@/lib/people/masking";
import { listAreaOptions, listOrgTreeOptions } from "@/lib/organizations/areas";
import { listAssociations } from "@/lib/associations/queries";
import { FilterBar } from "./FilterBar";
import { PeopleGrid, type PersonDisplayRow } from "./PeopleGrid";
import { TrafficKpiCards } from "./TrafficKpis";

const PAGE_SIZE = 20;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export default async function PersonasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requirePermission("people.view");
  const sp = await searchParams;

  const filter: PeopleFilterSpec = {
    search: sp.q || undefined,
    areaId: sp.area || undefined,
    reparticionId: sp.rep || undefined,
    trafficLight: isTrafficLight(sp.traffic) ? sp.traffic : undefined,
    lastInteractionFrom: sp.lastFrom && ISO_DAY.test(sp.lastFrom) ? sp.lastFrom : undefined,
    lastInteractionTo: sp.lastTo && ISO_DAY.test(sp.lastTo) ? sp.lastTo : undefined,
    status: (sp.status as PeopleFilterSpec["status"]) || "active",
    ageMin: sp.ageMin ? Number(sp.ageMin) : undefined,
    ageMax: sp.ageMax ? Number(sp.ageMax) : undefined,
  };
  const sort: PeopleSort = {
    field: (sp.sort as PeopleSort["field"]) || "name",
    direction: (sp.dir as PeopleSort["direction"]) || "asc",
  };
  const page = sp.page ? Math.max(1, Number(sp.page)) : 1;

  const [{ rows, total }, kpis, orgTree, associations] = await Promise.all([
    listPeoplePage(actor, filter, sort, page, PAGE_SIZE),
    getTrafficKpis(actor, filter),
    listOrgTreeOptions(actor),
    can(actor, "associations.manage_members") ? listAssociations(actor) : Promise.resolve([]),
  ]);
  const areas = await listAreaOptions(actor, orgTree);
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
    };
  });

  // Filtros de la URL (sin semáforo ni página): base de los KPIs clicables. `exportQueryString` los incluye todos.
  const baseParams = new URLSearchParams();
  if (filter.search) baseParams.set("q", filter.search);
  if (filter.areaId) baseParams.set("area", filter.areaId);
  if (filter.reparticionId) baseParams.set("rep", filter.reparticionId);
  if (filter.lastInteractionFrom) baseParams.set("lastFrom", filter.lastInteractionFrom);
  if (filter.lastInteractionTo) baseParams.set("lastTo", filter.lastInteractionTo);
  if (filter.status) baseParams.set("status", filter.status);
  if (filter.ageMin !== undefined) baseParams.set("ageMin", String(filter.ageMin));
  if (filter.ageMax !== undefined) baseParams.set("ageMax", String(filter.ageMax));
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

      <FilterBar areas={areas} orgTree={orgTree} />

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
        associations={activeAssociations.map((a) => ({ id: a.id, name: a.name }))}
        exportQueryString={exportParams.toString()}
      />
    </div>
  );
}
