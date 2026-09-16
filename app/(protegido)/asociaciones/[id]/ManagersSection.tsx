"use client";

import { useActionState, useState, useTransition } from "react";
import type { AssociationManagerRow } from "@/lib/associations/queries";
import type { UserListItem } from "@/lib/users/queries";
import {
  addManagerPersonAction,
  addManagerUserAction,
  removeManagerAction,
  searchManagerCandidatesAction,
  type SearchResult,
} from "./acciones";

const initialSearch: SearchResult = { results: [] };

export function ManagersSection({
  associationId,
  managers,
  users,
  canManage,
}: {
  associationId: string;
  managers: AssociationManagerRow[];
  users: UserListItem[];
  canManage: boolean;
}) {
  const [searchState, searchAction, searchPending] = useActionState(
    searchManagerCandidatesAction.bind(null, associationId),
    initialSearch
  );
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");

  function addPerson(personId: string) {
    startTransition(async () => {
      const result = await addManagerPersonAction(associationId, personId);
      setMessage(result.ok ? "Responsable agregado." : result.error ?? "No se pudo agregar.");
    });
  }

  function addUser() {
    if (!selectedUserId) return;
    startTransition(async () => {
      const result = await addManagerUserAction(associationId, selectedUserId);
      setMessage(result.ok ? "Responsable agregado." : result.error ?? "No se pudo agregar.");
    });
  }

  function remove(managerId: string) {
    startTransition(async () => {
      const result = await removeManagerAction(associationId, managerId);
      setMessage(result.ok ? null : result.error ?? "No se pudo quitar.");
    });
  }

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-brand-900">Responsables</h2>

      {canManage ? (
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div className="flex items-end gap-2">
            <div>
              <label className="block text-xs text-brand-500">Agregar usuario del sistema</label>
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="mt-1 rounded-md border border-brand-200 px-2 py-1.5 text-sm"
              >
                <option value="">— elegir —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={pending || !selectedUserId}
              onClick={addUser}
              className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50 disabled:opacity-50"
            >
              Agregar
            </button>
          </div>

          <form action={searchAction} className="flex items-end gap-2">
            <div>
              <label className="block text-xs text-brand-500">Buscar persona como responsable</label>
              <input
                name="search"
                placeholder="nombre o apellido"
                className="mt-1 w-56 rounded-md border border-brand-200 px-2 py-1.5 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={searchPending}
              className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50"
            >
              Buscar
            </button>
          </form>
        </div>
      ) : null}

      {searchState.error ? <p className="mb-2 text-xs text-estado-riesgo">{searchState.error}</p> : null}
      {searchState.results.length > 0 ? (
        <ul className="mb-4 space-y-1 rounded-md bg-brand-50 p-2 text-sm">
          {searchState.results.map((r) => (
            <li key={r.id} className="flex items-center justify-between">
              <span>
                {r.firstName} {r.lastName}
              </span>
              <button type="button" disabled={pending} onClick={() => addPerson(r.id)} className="text-brand-600 hover:underline disabled:opacity-50">
                agregar
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {message ? <p className="mb-2 text-sm text-brand-600">{message}</p> : null}

      <ul className="space-y-1 text-sm">
        {managers.map((m) => (
          <li key={m.managerId} className="flex items-center justify-between border-b border-brand-50 py-1">
            <span>
              {m.userName ? `${m.userName} (usuario)` : `${m.personName} (persona)`}
            </span>
            {canManage ? (
              <button type="button" disabled={pending} onClick={() => remove(m.managerId)} className="text-xs text-brand-500 hover:underline disabled:opacity-50">
                quitar
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {managers.length === 0 ? <p className="py-2 text-sm text-brand-400">Sin responsables asignados.</p> : null}
    </section>
  );
}
