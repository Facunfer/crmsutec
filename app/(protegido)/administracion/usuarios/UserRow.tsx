"use client";

import { useActionState } from "react";
import type { RoleKey } from "@/lib/permissions/catalog";
import type { UserListItem } from "@/lib/users/queries";
import { resetAccessAction, toggleActiveAction, updateRoleAction, type ActionResult } from "./acciones";

const initialState: ActionResult = { ok: false };

export function UserRow({
  user,
  isSelf,
  assignableRoles,
  canTouch,
}: {
  user: UserListItem;
  isSelf: boolean;
  assignableRoles: RoleKey[];
  canTouch: boolean;
}) {
  const [roleState, roleAction, rolePending] = useActionState(
    updateRoleAction.bind(null, user.id),
    initialState
  );
  const [activeState, activeAction, activePending] = useActionState(
    toggleActiveAction.bind(null, user.id, user.status !== "active"),
    initialState
  );
  const [resetState, resetAction, resetPending] = useActionState(
    resetAccessAction.bind(null, user.id),
    initialState
  );

  const disabled = !canTouch || isSelf;

  return (
    <tr className="border-b border-brand-100 align-top">
      <td className="py-2 pr-4">
        <div className="text-sm font-medium text-brand-900">{user.fullName}</div>
        <div className="text-xs text-brand-400">{user.email}</div>
      </td>
      <td className="py-2 pr-4">
        <form action={roleAction} className="flex items-center gap-2">
          <select
            name="roleKey"
            defaultValue={user.roleKey}
            disabled={disabled || rolePending}
            className="rounded-md border border-brand-200 px-2 py-1 text-xs disabled:opacity-50"
          >
            {assignableRoles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          {!disabled ? (
            <button
              type="submit"
              disabled={rolePending}
              className="text-xs text-brand-600 hover:underline"
            >
              guardar
            </button>
          ) : null}
        </form>
        {roleState.error ? <p className="mt-1 text-xs text-estado-riesgo">{roleState.error}</p> : null}
      </td>
      <td className="py-2 pr-4">
        <span
          className={
            user.status === "active"
              ? "rounded-full bg-estado-ok/10 px-2 py-0.5 text-xs text-estado-ok"
              : "rounded-full bg-brand-100 px-2 py-0.5 text-xs text-brand-400"
          }
        >
          {user.status === "active" ? "Activo" : "Inactivo"}
        </span>
        {user.mustChangePassword ? (
          <span className="ml-2 text-xs text-estado-alerta">debe cambiar contraseña</span>
        ) : null}
      </td>
      <td className="py-2 pr-4">
        <div className="flex flex-wrap gap-2">
          <form action={activeAction}>
            <button
              type="submit"
              disabled={disabled || activePending}
              className="text-xs text-brand-600 hover:underline disabled:opacity-40"
            >
              {user.status === "active" ? "Desactivar" : "Reactivar"}
            </button>
          </form>
          <form action={resetAction}>
            <button
              type="submit"
              disabled={disabled || resetPending}
              className="text-xs text-brand-600 hover:underline disabled:opacity-40"
            >
              Resetear acceso
            </button>
          </form>
        </div>
        {activeState.error ? <p className="mt-1 text-xs text-estado-riesgo">{activeState.error}</p> : null}
        {resetState.error ? <p className="mt-1 text-xs text-estado-riesgo">{resetState.error}</p> : null}
        {resetState.ok && resetState.temporaryPassword ? (
          <p className="mt-1 rounded-md bg-estado-ok/10 px-2 py-1 text-xs text-estado-ok">
            Nueva contraseña temporal:{" "}
            <span className="font-mono font-semibold">{resetState.temporaryPassword}</span>
          </p>
        ) : null}
        {isSelf ? <p className="mt-1 text-xs text-brand-300">este es tu propio usuario</p> : null}
      </td>
    </tr>
  );
}
