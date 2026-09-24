"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { DataGrid } from "@/components/grid/DataGrid";
import type { PeopleFilterSpec, PeopleSort } from "@/lib/people/queries";
import type { TrafficLight } from "@/lib/people/traffic";
import { bulkAddToAssociationAction, bulkSetActiveAction } from "./acciones";
import { TrafficBadge } from "./TrafficBadge";

export interface PersonDisplayRow {
  id: string;
  firstName: string;
  lastName: string;
  dni: string | null;
  email: string | null;
  phone: string | null;
  /** Área (jurisdicción principal) y Repartición (unidad específica; null si solo se conoce el Área). */
  areaName: string | null;
  reparticionName: string | null;
  lastInteractionDate: string | null;
  /** 'legacy_reference' = fecha técnica de la carga histórica (2026-01-01), nunca una fecha de asistencia comprobada. */
  lastInteractionBasis: "actual" | "legacy_reference" | null;
  daysSinceInteraction: number | null;
  trafficLight: TrafficLight;
  status: "active" | "inactive" | "merged";
}

function TrafficCell(props: ICellRendererParams<PersonDisplayRow>) {
  return props.data ? <TrafficBadge light={props.data.trafficLight} /> : null;
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
  canAddToAssociation,
  associations,
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
  canAddToAssociation: boolean;
  associations: Array<{ id: string; name: string }>;
  exportQueryString: string;
}) {
  // Selección acumulada entre páginas (sección 9): vive en este componente,
  // que no se remonta en la navegación por query params (solo recibe props
  // nuevas), así que sobrevive a cambiar de página/orden/filtro.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [bulkPending, setBulkPending] = useState(false);
  const [targetAssociationId, setTargetAssociationId] = useState("");

  const columnDefs = useMemo<ColDef<PersonDisplayRow>[]>(
    () => [
      { headerName: "Nombre", sortable: false, filter: false, flex: 1.2, valueGetter: (p) => (p.data ? `${p.data.lastName}, ${p.data.firstName}` : "") },
      { field: "dni", headerName: "DNI", sortable: false, filter: false, width: 120 },
      { field: "areaName", headerName: "Área", sortable: false, filter: false, flex: 1, valueFormatter: (p) => p.value ?? "—" },
      { field: "reparticionName", headerName: "Repartición", sortable: false, filter: false, flex: 1, valueFormatter: (p) => p.value ?? "—" },
      { field: "phone", headerName: "Teléfono", sortable: false, filter: false, width: 140 },
      { field: "email", headerName: "Email", sortable: false, filter: false, flex: 1 },
      {
        field: "lastInteractionDate",
        headerName: "Última interacción",
        sortable: false,
        filter: false,
        width: 200,
        valueGetter: (p) => {
          if (!p.data?.lastInteractionDate) return "Nunca";
          const fecha = p.data.lastInteractionDate.split("-").reverse().join("/");
          const dias = `${p.data.daysSinceInteraction} d`;
          return p.data.lastInteractionBasis === "legacy_reference" ? `Ref. ${fecha} (${dias}) — no comprobada` : `${fecha} (${dias})`;
        },
      },
      { headerName: "Semáforo", width: 110, sortable: false, filter: false, cellRenderer: TrafficCell },
      {
        field: "status",
        headerName: "Estado",
        sortable: false,
        filter: false,
        width: 100,
        hide: filter.status === undefined || filter.status === "active",
        valueFormatter: (p) => (p.value === "active" ? "Activa" : p.value === "inactive" ? "Inactiva" : "Fusionada"),
      },
      { headerName: "", width: 90, sortable: false, filter: false, cellRenderer: FichaLinkCell },
    ],
    [filter.status]
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

  async function runAddToAssociation() {
    if (!targetAssociationId) return;
    setBulkPending(true);
    setBulkMessage(null);
    const selection: Parameters<typeof bulkSetActiveAction>[0] = selectAllMatching
      ? { mode: "filter", filter }
      : { mode: "ids", ids: [...selectedIds] };
    const result = await bulkAddToAssociationAction(selection, targetAssociationId);
    setBulkPending(false);
    if (result.ok) {
      setBulkMessage(`${result.count ?? 0} persona(s) agregadas a la asociación.`);
      setSelectedIds(new Set());
      setSelectAllMatching(false);
    } else {
      setBulkMessage(result.error ?? "No se pudo agregar.");
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
          {canAddToAssociation && associations.length > 0 ? (
            <span className="flex items-center gap-1">
              <select
                value={targetAssociationId}
                onChange={(e) => setTargetAssociationId(e.target.value)}
                className="rounded-md border border-brand-200 px-2 py-1 text-xs"
              >
                <option value="">— elegir asociación —</option>
                {associations.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={bulkPending || !targetAssociationId}
                onClick={runAddToAssociation}
                className="text-brand-600 hover:underline disabled:opacity-50"
              >
                Agregar a asociación
              </button>
            </span>
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
