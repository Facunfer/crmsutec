"use client";

import { useMemo, useState } from "react";
import type { AreaOption, OrgTreeOption } from "@/lib/organizations/areas";

/**
 * Selector dependiente Área → Repartición.
 *
 * Submite UN solo valor: `name` (por defecto «organizationId») = la unidad más específica elegida. Si se elige
 * solamente el Área, el valor es el Área misma (repartición específica desconocida). El segundo selector solo ofrece
 * las unidades DENTRO del Área elegida y muestra la jerarquía con su camino («Secretaría › Dirección»).
 *
 * Solo ofrece lo que el servidor dejó disponible (alcance del usuario): esto es comodidad de UI; el servidor vuelve a
 * comprobar que la unidad esté dentro del alcance.
 */
export function AreaReparticionSelect({
  areas,
  tree,
  initialOrganizationId = "",
  name = "organizationId",
  disabled = false,
  areaLabel = "Área",
  reparticionLabel = "Repartición",
  required = false,
}: {
  areas: AreaOption[];
  tree: OrgTreeOption[];
  initialOrganizationId?: string;
  name?: string;
  disabled?: boolean;
  areaLabel?: string;
  reparticionLabel?: string;
  required?: boolean;
}) {
  const initial = tree.find((o) => o.id === initialOrganizationId);
  const [areaId, setAreaId] = useState(initial?.areaId ?? "");
  const [unitId, setUnitId] = useState(initial ? (initial.depth === 0 ? "" : initial.id) : "");

  const area = areas.find((a) => a.id === areaId);
  const units = useMemo(() => tree.filter((o) => o.areaId === areaId && o.depth > 0), [tree, areaId]);
  // Solo el Área: únicamente si el Área misma está al alcance (si no, hay que elegir una repartición).
  const value = unitId || (area?.selectable ? areaId : "");

  const selectClass = "mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm disabled:bg-brand-50 disabled:text-brand-400";

  return (
    <>
      <input type="hidden" name={name} value={disabled ? initialOrganizationId : value} />
      <div>
        <label className="block text-xs text-brand-500">
          {areaLabel}
          {required ? " *" : ""}
        </label>
        <select
          value={areaId}
          disabled={disabled}
          onChange={(e) => {
            setAreaId(e.target.value);
            setUnitId("");
          }}
          className={selectClass}
        >
          <option value="">— sin especificar —</option>
          {areas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-brand-500">{reparticionLabel}</label>
        <select value={unitId} disabled={disabled || !areaId} onChange={(e) => setUnitId(e.target.value)} className={selectClass}>
          <option value="">{areaId ? (area?.selectable ? "— solo el Área (repartición desconocida) —" : "— elegí una repartición —") : "— primero elegí el Área —"}</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {`${"  ".repeat(Math.max(0, u.path.split(" › ").length - 1))}${u.path.split(" › ").at(-1)}`}
            </option>
          ))}
        </select>
        {unitId && units.find((u) => u.id === unitId)?.path.includes(" › ") ? (
          <p className="mt-1 text-xs text-brand-400">{units.find((u) => u.id === unitId)!.path}</p>
        ) : null}
      </div>
    </>
  );
}
