"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { DataGrid } from "@/components/grid/DataGrid";
import type { PeopleFilterSpec, PeopleSort } from "@/lib/people/queries";
import { bulkSetActiveAction } from "./acciones";

export interface PersonDisplayRow {
  id: string;
  firstName: string;
  lastName: string;
  dni: string | null;
  email: string | null;
  phone: string | null;
  organizationName: string | null;
  age: number | null;
  ageEstimated: boolean;
  status: "active" | "inactive" | "merged";
}

function FichaLinkCell(props: ICellRendererParams<PersonDisplayRow>) {
  if (!props.data) return null;
  return (
    <Link href={`/personas/${props.data.id}`} className="text-brand-600 hover:underline">
      ver ficha
    </Link>
  );
}

export function PeopleGrid({
  rows,
  total,
  page,
  pageSize,
  sort,
  filter,
  canExport,
  canDeactivate,
  exportQueryString,
}: {
  rows: PersonDisplayRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: PeopleSort;
  filter: PeopleFilterSpec;
  canExport: boolean;
  canDeactivate: boolean;
  exportQueryString: string;
}) {
  // Selección acumulada entre páginas (sección 9): vive en este componente,
  // que no se remonta en la navegación por query params (solo recibe props
  // nuevas), así que sobrevive a cambiar de página/orden/filtro.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState(false);

  const columnDefs = useMemo<ColDef<PersonDisplayRow>[]>(
    () => [
      { field: "lastName", headerName: "Apellido", sortable: false, filter: false, flex: 1 },
      { field: "firstName", headerName: "Nombre", sortable: false, filter: false, flex: 1 },
      { field: "dni", headerName: "DNI", sortable: false, filter: false, width: 130 },
      { field: "email", headerName: "Email", sortable: false, filter: false, flex: 1 },
      { field: "phone", headerName: "Teléfono", sortable: false, filter: false, width: 150 },
      { field: "organizationName", headerName: "Organismo", sortable: false, filter: false, flex: 1 },
      {
        field: "age",
        headerName: "Edad",
        sortable: false,
        filter: false,
        width: 90,
        valueFormatter: (p) => (p.value === null || p.value === undefined ? "" : String(p.value)),
      },
      {
        field: "status",
        headerName: "Estado",
        sortable: false,
        filter: false,
        width: 110,
        valueFormatter: (p) =>
          p.value === "active" ? "Activa" : p.value === "inactive" ? "Inactiva" : "Fusionada",
      },
      { headerName: "", width: 90, sortable: false, filter: false, cellRenderer: FichaLinkCell },
    ],
    []
  );

  function sortHref(field: PeopleSort["field"]) {
    const params = new URLSearchParams(exportQueryString);
    const nextDir = sort.field === field && sort.direction === "asc" ? "desc" : "asc";
    params.set("sort", field);
    params.set("dir", nextDir);
    return `/personas?${params.toString()}`;
  }

  function pageHref(nextPage: number) {
    const params = new URLSearchParams(exportQueryString);
    params.set("page", String(nextPage));
    return `/personas?${params.toString()}`;
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selectionCount = selectAllMatching ? total : selectedIds.size;

  async function runBulk(active: boolean) {
    setBulkPending(true);
    setBulkMessage(null);
    const selection: Parameters<typeof bulkSetActiveAction>[0] = selectAllMatching
      ? { mode: "filter", filter }
      : { mode: "ids", ids: [...selectedIds] };
    const result = await bulkSetActiveAction(selection, active);
    setBulkPending(false);
    if (result.ok) {
      setBulkMessage(`${result.count ?? 0} persona(s) actualizadas.`);
      setSelectedIds(new Set());
      setSelectAllMatching(false);
    } else {
      setBulkMessage(result.error ?? "No se pudo actualizar.");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm text-brand-700">
        <span>{total} resultado(s)</span>
        <Link href={sortHref("name")} className="text-brand-500 hover:underline">
          ordenar por nombre {sort.field === "name" ? (sort.direction === "asc" ? "↑" : "↓") : ""}
        </Link>
        <Link href={sortHref("created_at")} className="text-brand-500 hover:underline">
          ordenar por alta {sort.field === "created_at" ? (sort.direction === "asc" ? "↑" : "↓") : ""}
        </Link>
        {canExport ? (
          <a
            href={`/api/personas/export?${exportQueryString}`}
            className="ml-auto rounded-md border border-brand-200 px-3 py-1 text-brand-700 hover:bg-brand-50"
          >
            Exportar CSV (este filtro)
          </a>
        ) : null}
      </div>

      {selectionCount > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-brand-50 px-3 py-2 text-sm">
          <span>{selectionCount} seleccionada(s)</span>
          {!selectAllMatching && selectedIds.size >= rows.length && total > rows.length ? (
            <button
              type="button"
              className="text-brand-600 hover:underline"
              onClick={() => setSelectAllMatching(true)}
            >
              seleccionar los {total} resultados del filtro
            </button>
          ) : null}
          {canDeactivate ? (
            <>
              <button
                type="button"
                disabled={bulkPending}
                onClick={() => runBulk(false)}
                className="text-brand-600 hover:underline disabled:opacity-50"
              >
                Desactivar seleccionadas
              </button>
              <button
                type="button"
                disabled={bulkPending}
                onClick={() => runBulk(true)}
                className="text-brand-600 hover:underline disabled:opacity-50"
              >
                Reactivar seleccionadas
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="text-brand-400 hover:underline"
            onClick={() => {
              setSelectedIds(new Set());
              setSelectAllMatching(false);
            }}
          >
            limpiar selección
          </button>
        </div>
      ) : null}
      {bulkMessage ? <p className="text-sm text-brand-600">{bulkMessage}</p> : null}

      <DataGrid<PersonDisplayRow>
        columnDefs={columnDefs}
        rowData={rows}
        getRowId={(row) => row.id}
        onSelectionChanged={(idsCheckedOnThisPage) => {
          setSelectAllMatching(false);
          const idsOnThisPage = new Set(rows.map((r) => r.id));
          setSelectedIds((prev) => {
            const next = new Set(prev);
            for (const id of idsOnThisPage) next.delete(id);
            for (const id of idsCheckedOnThisPage) next.add(id);
            return next;
          });
        }}
      />

      <div className="flex items-center gap-2 text-sm">
        <span>
          Página {page} de {totalPages}
        </span>
        {page > 1 ? (
          <Link href={pageHref(page - 1)} className="text-brand-600 hover:underline">
            anterior
          </Link>
        ) : null}
        {page < totalPages ? (
          <Link href={pageHref(page + 1)} className="text-brand-600 hover:underline">
            siguiente
          </Link>
        ) : null}
      </div>
    </div>
  );
}
