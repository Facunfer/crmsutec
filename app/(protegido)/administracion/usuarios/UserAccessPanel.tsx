"use client";

import { useActionState } from "react";
import type { OrganizationOption } from "@/lib/organizations/queries";
import type { ModuleOption, UserAccessItem } from "@/lib/users/administration";
import {
  grantModuleAction,
  grantScopeAction,
  revokeModuleAction,
  revokeScopeAction,
  type ActionResult,
} from "./acciones";

const initialState: ActionResult = { ok: false };

function RevokeButton({
  action,
  label,
}: {
  action: (prev: ActionResult) => Promise<ActionResult>;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <form action={formAction} className="inline">
      <button type="submit" disabled={pending} className="ml-1 text-xs text-estado-riesgo hover:underline">
        {label}
      </button>
      {state.error ? <span className="ml-1 text-xs text-estado-riesgo">{state.error}</span> : null}
    </form>
  );
}

export function UserAccessPanel({
  userId,
  access,
  organizations,
  modules,
  editable,
}: {
  userId: string;
  access: UserAccessItem;
  organizations: OrganizationOption[];
  modules: ModuleOption[];
  editable: boolean;
}) {
  const [scopeState, scopeAction, scopePending] = useActionState(
    grantScopeAction.bind(null, userId),
    initialState
  );
  const [moduleState, moduleAction, modulePending] = useActionState(
    grantModuleAction.bind(null, userId),
    initialState
  );

  return (
    <div className="space-y-2 text-xs text-brand-700">
      <div>
        <span className="font-medium">Alcances:</span>{" "}
        {access.scopes.length === 0 ? <span className="text-brand-400">ninguno</span> : null}
        {access.scopes.map((scope) => (
          <span key={scope.id} className="mr-2 inline-block rounded-full bg-brand-50 px-2 py-0.5">
            {scope.organizationName}
            {scope.includeDescendants ? " + dependientes" : ""}
            {editable ? (
              <RevokeButton action={revokeScopeAction.bind(null, userId, scope.id)} label="quitar" />
            ) : null}
          </span>
        ))}
        {editable && organizations.length > 0 ? (
          <form action={scopeAction} className="mt-1 flex flex-wrap items-center gap-2">
            <select name="organizationId" className="rounded-md border border-brand-200 px-1 py-0.5">
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1">
              <input type="checkbox" name="includeDescendants" /> incluye dependientes
            </label>
            <button type="submit" disabled={scopePending} className="text-brand-600 hover:underline">
              agregar alcance
            </button>
          </form>
        ) : null}
        {scopeState.error ? <p className="text-estado-riesgo">{scopeState.error}</p> : null}
      </div>

      <div>
        <span className="font-medium">Módulos:</span>{" "}
        {access.modules.length === 0 ? <span className="text-brand-400">ninguno</span> : null}
        {access.modules.map((module) => (
          <span key={module.id} className="mr-2 inline-block rounded-full bg-brand-50 px-2 py-0.5">
            {module.moduleName}
            {editable ? (
              <RevokeButton action={revokeModuleAction.bind(null, userId, module.id)} label="quitar" />
            ) : null}
          </span>
        ))}
        {editable && modules.length > 0 ? (
          <form action={moduleAction} className="mt-1 flex items-center gap-2">
            <select name="moduleKey" className="rounded-md border border-brand-200 px-1 py-0.5">
              {modules.map((module) => (
                <option key={module.key} value={module.key}>
                  {module.name}
                </option>
              ))}
            </select>
            <button type="submit" disabled={modulePending} className="text-brand-600 hover:underline">
              habilitar módulo
            </button>
          </form>
        ) : null}
        {moduleState.error ? <p className="text-estado-riesgo">{moduleState.error}</p> : null}
      </div>
    </div>
  );
}
