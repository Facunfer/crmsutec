"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useRef } from "react";
import type { OrganizationOption } from "@/lib/organizations/queries";

/** Filtros reflejados en la URL (sección 9 del prompt): compartibles y recargables. */
export function FilterBar({ organizations }: { organizations: OrganizationOption[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const formRef = useRef<HTMLFormElement>(null);

  function apply() {
    if (!formRef.current) return;
    const data = new FormData(formRef.current);
    const params = new URLSearchParams();
    for (const key of ["q", "org", "status", "ageMin", "ageMax"]) {
      const value = String(data.get(key) ?? "").trim();
      if (value) params.set(key, value);
    }
    router.push(`/personas?${params.toString()}`);
  }

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
        <input
          name="q"
          defaultValue={searchParams.get("q") ?? ""}
          placeholder="nombre, apellido, DNI, email, teléfono"
          className="mt-1 w-56 rounded-md border border-brand-200 px-2 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Organismo</label>
        <select
          name="org"
          defaultValue={searchParams.get("org") ?? ""}
          className="mt-1 rounded-md border border-brand-200 px-2 py-1.5 text-sm"
        >
          <option value="">— todos —</option>
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Estado</label>
        <select
          name="status"
          defaultValue={searchParams.get("status") ?? "active"}
          className="mt-1 rounded-md border border-brand-200 px-2 py-1.5 text-sm"
        >
          <option value="active">Activas</option>
          <option value="inactive">Inactivas</option>
          <option value="all">Todas</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Edad mín.</label>
        <input
          name="ageMin"
          type="number"
          min={0}
          defaultValue={searchParams.get("ageMin") ?? ""}
          className="mt-1 w-20 rounded-md border border-brand-200 px-2 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Edad máx.</label>
        <input
          name="ageMax"
          type="number"
          min={0}
          defaultValue={searchParams.get("ageMax") ?? ""}
          className="mt-1 w-20 rounded-md border border-brand-200 px-2 py-1.5 text-sm"
        />
      </div>
      <button
        type="submit"
        className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
      >
        Filtrar
      </button>
    </form>
  );
}
