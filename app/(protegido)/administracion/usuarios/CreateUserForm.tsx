"use client";

import { useActionState } from "react";
import type { RoleKey } from "@/lib/permissions/catalog";
import { createUserAction, type ActionResult } from "./acciones";

const initialState: ActionResult = { ok: false };

export function CreateUserForm({ assignableRoles }: { assignableRoles: RoleKey[] }) {
  const [state, formAction, pending] = useActionState(createUserAction, initialState);

  return (
    <div className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-brand-900">Nuevo usuario</h2>
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-brand-500">Nombre y apellido</label>
          <input
            name="fullName"
            required
            className="mt-1 rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Email</label>
          <input
            name="email"
            type="email"
            required
            className="mt-1 rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Rol</label>
          <select name="roleKey" className="mt-1 rounded-md border border-brand-200 px-2 py-1.5 text-sm">
            {assignableRoles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {pending ? "Creando..." : "Crear"}
        </button>
      </form>
      {state.error ? (
        <p className="mt-2 text-sm text-estado-riesgo">{state.error}</p>
      ) : null}
      {state.ok && state.temporaryPassword ? (
        <p className="mt-2 rounded-md bg-estado-ok/10 px-3 py-2 text-sm text-estado-ok">
          Usuario creado. Contraseña temporal (se muestra una sola vez):{" "}
          <span className="font-mono font-semibold">{state.temporaryPassword}</span>
        </p>
      ) : null}
    </div>
  );
}
