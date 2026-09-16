"use client";

import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from "ag-grid-community";

/**
 * Registrado a nivel de módulo, no dentro del componente (decisión D16):
 * una prop sin su módulo registrado no truena en producción, simplemente
 * no hace nada, así que hay que registrar todo Community una sola vez.
 * `tests/centinela/ag-grid-all-community.test.ts` falla el build si esto
 * se recorta.
 */
ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  accentColor: "#6a4baa",
  fontFamily: "inherit",
});

export interface DataGridProps<T> {
  columnDefs: ColDef<T>[];
  rowData: T[];
  getRowId: (row: T) => string;
  onSelectionChanged?: (selectedIds: string[]) => void;
  height?: number;
}

/**
 * Wrapper genérico de AG Grid Community. Orden, filtro y paginación se
 * resuelven en el servidor (D16): esta grilla solo muestra la página que
 * ya llegó, no ordena ni filtra nada por su cuenta — por eso cada columna
 * pasada acá debería declarar `sortable: false`/`filter: false`.
 */
/**
 * Limitación conocida: las casillas no se muestran tildadas al volver a
 * una página ya visitada (cada página es un `rowData` nuevo y no
 * restauramos el estado visual de selección desde afuera). La selección
 * en sí SÍ se acumula correctamente entre páginas — la lleva el padre
 * (`PeopleGrid`) y se usa igual para las acciones masivas — es solo el
 * tilde visual el que no persiste. Aceptado para no complicar la
 * integración con la API imperativa de AG Grid en esta etapa.
 */
export function DataGrid<T>({
  columnDefs,
  rowData,
  getRowId,
  onSelectionChanged,
  height = 480,
}: DataGridProps<T>) {
  return (
    <div style={{ height }}>
      <AgGridReact<T>
        theme={theme}
        columnDefs={columnDefs}
        rowData={rowData}
        getRowId={(params) => getRowId(params.data)}
        rowSelection={onSelectionChanged ? { mode: "multiRow", checkboxes: true, headerCheckbox: true } : undefined}
        onSelectionChanged={
          onSelectionChanged
            ? (event) => onSelectionChanged(event.api.getSelectedRows().map((row) => getRowId(row)))
            : undefined
        }
        suppressCellFocus
        localeText={{ noRowsToShow: "Sin resultados para este filtro." }}
      />
    </div>
  );
}
