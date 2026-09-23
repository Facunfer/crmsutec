"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import type { AreaOption, OrgTreeOption } from "@/lib/organizations/areas";

/** Filtros reflejados en la URL (sección 9 del prompt): compartibles y recargables. Se resuelven en el servidor. */
export function FilterBar({ areas, orgTree }: { areas: AreaOption[]; orgTree: OrgTreeOption[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const formRef = useRef<HTMLFormElement>(null);
  const [areaId, setAreaId] = useState(searchParams.get("area") ?? "");
  const [repId, setRepId] = useState(searchParams.get("rep") ?? "");

  // Repartición dependiente: solo las unidades DENTRO del Área elegida (con su camino, para entender la jerarquía).
  const units = useMemo(() => orgTree.filter((o) => o.areaId === areaId && o.depth > 0), [orgTree, areaId]);

  function apply() {
    if (!formRef.current) return;
    const data = new FormData(formRef.current);
    const params = new URLSearchParams();
    for (const key of ["q", "area", "rep", "traffic", "lastFrom", "lastTo", "status", "ageMin", "ageMax"]) {
      const value = String(data.get(key) ?? "").trim();
      if (value) params.set(key, value);
    }
    router.push(`/personas?${params.toString()}`);
  }

  const field = "mt-1 rounded-md border border-brand-200 px-2 py-1.5 text-sm";

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
      className="flex flex-wrap items-end gap-3 rounded-lg bg-white p-4 shadow-sm"
    >
      <div>
        <label className="block text-xs text-brand-500">Buscar</label>
        <input name="q" defaultValue={searchParams.get("q") ?? ""} placeholder="nombre, apellido, DNI, email, teléfono" className={`${field} w-56`} />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Área</label>
        <select
          name="area"
          value={areaId}
          onChange={(e) => {
            setAreaId(e.target.value);
            setRepId("");
          }}
          className={field}
        >
          <option value="">— todas —</option>
          {areas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Repartición</label>
        <select name="rep" value={repId} disabled={!areaId} onChange={(e) => setRepId(e.target.value)} className={`${field} max-w-xs disabled:bg-brand-50`}>
          <option value="">{areaId ? "— todas las del área —" : "— elegí un Área —"}</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {`${"  ".repeat(Math.max(0, u.path.split(" › ").length - 1))}${u.path.split(" › ").at(-1)}`}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Semáforo</label>
        <select name="traffic" defaultValue={searchParams.get("traffic") ?? ""} className={field}>
          <option value="">— todos —</option>
          <option value="green">Verde (hasta 30 días)</option>
          <option value="yellow">Amarillo (31–60 días)</option>
          <option value="red">Rojo (más de 60 días)</option>
          <option value="gray">Gris (nunca)</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Última interacción desde</label>
        <input name="lastFrom" type="date" defaultValue={searchParams.get("lastFrom") ?? ""} className={field} />
      </div>
      <div>
        <label className="block text-xs text-brand-500">hasta</label>
        <input name="lastTo" type="date" defaultValue={searchParams.get("lastTo") ?? ""} className={field} />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Estado</label>
        <select name="status" defaultValue={searchParams.get("status") ?? "active"} className={field}>
          <option value="active">Activas</option>
          <option value="inactive">Inactivas</option>
          <option value="all">Todas</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Edad mín.</label>
        <input name="ageMin" type="number" min={0} defaultValue={searchParams.get("ageMin") ?? ""} className={`${field} w-20`} />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Edad máx.</label>
        <input name="ageMax" type="number" min={0} defaultValue={searchParams.get("ageMax") ?? ""} className={`${field} w-20`} />
      </div>
      <button type="submit" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
        Filtrar
      </button>
    </form>
  );
}
