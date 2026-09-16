import Link from "next/link";
import { requirePermission } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { computeDisplayAge, listPeoplePage, type PeopleFilterSpec, type PeopleSort } from "@/lib/people/queries";
import { applyMasking } from "@/lib/people/masking";
import { listActiveOrganizationOptions } from "@/lib/organizations/queries";
import { listAssociations } from "@/lib/associations/queries";
import { FilterBar } from "./FilterBar";
import { PeopleGrid, type PersonDisplayRow } from "./PeopleGrid";

const PAGE_SIZE = 20;

export default async function PersonasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const actor = await requirePermission("people.view");
  const sp = await searchParams;

  const filter: PeopleFilterSpec = {
    search: sp.q || undefined,
    organizationIds: sp.org ? [sp.org] : undefined,
    status: (sp.status as PeopleFilterSpec["status"]) || "active",
    ageMin: sp.ageMin ? Number(sp.ageMin) : undefined,
    ageMax: sp.ageMax ? Number(sp.ageMax) : undefined,
  };
  const sort: PeopleSort = {
    field: (sp.sort as PeopleSort["field"]) || "name",
    direction: (sp.dir as PeopleSort["direction"]) || "asc",
  };
  const page = sp.page ? Math.max(1, Number(sp.page)) : 1;

  const [{ rows, total }, organizations, associations] = await Promise.all([
    listPeoplePage(filter, sort, page, PAGE_SIZE),
    listActiveOrganizationOptions(),
    can(actor, "associations.manage_members") ? listAssociations() : Promise.resolve([]),
  ]);
  const activeAssociations = associations.filter((a) => a.status === "active");

  const canSeeSensitive = can(actor, "people.view_sensitive");
  const displayRows: PersonDisplayRow[] = rows.map((row) => {
    const masked = applyMasking(row, canSeeSensitive);
    const { age, estimated } = computeDisplayAge(row);
    return {
      id: masked.id,
      firstName: masked.firstName,
      lastName: masked.lastName,
      dni: masked.dni,
      email: masked.email,
      phone: masked.phone,
      organizationName: masked.organizationName,
      age,
      ageEstimated: estimated,
      status: masked.status,
    };
  });

  const exportParams = new URLSearchParams();
  if (filter.search) exportParams.set("q", filter.search);
  if (filter.organizationIds?.[0]) exportParams.set("org", filter.organizationIds[0]);
  if (filter.status) exportParams.set("status", filter.status);
  if (filter.ageMin !== undefined) exportParams.set("ageMin", String(filter.ageMin));
  if (filter.ageMax !== undefined) exportParams.set("ageMax", String(filter.ageMax));
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

      <FilterBar organizations={organizations} />

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
