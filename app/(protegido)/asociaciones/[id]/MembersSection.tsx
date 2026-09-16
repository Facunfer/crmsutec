"use client";

import { useActionState, useState, useTransition } from "react";
import type { AssociationMemberRow } from "@/lib/associations/queries";
import { addMemberAction, removeMemberAction, searchMemberCandidatesAction, type SearchResult } from "./acciones";

const initialSearch: SearchResult = { results: [] };

export function MembersSection({
  associationId,
  members,
  canManage,
}: {
  associationId: string;
  members: AssociationMemberRow[];
  canManage: boolean;
}) {
  const [searchState, searchAction, searchPending] = useActionState(
    searchMemberCandidatesAction.bind(null, associationId),
    initialSearch
  );
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function handleAdd(personId: string) {
    startTransition(async () => {
      const result = await addMemberAction(associationId, personId);
      setMessage(result.ok ? "Persona agregada." : result.error ?? "No se pudo agregar.");
    });
  }

  function handleRemove(membershipId: string) {
    startTransition(async () => {
      const result = await removeMemberAction(associationId, membershipId);
      setMessage(result.ok ? null : result.error ?? "No se pudo quitar.");
    });
  }

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-brand-900">Miembros ({members.length})</h2>

      {canManage ? (
        <form action={searchAction} className="mb-3 flex items-end gap-2">
          <div>
            <label className="block text-xs text-brand-500">Buscar persona para agregar</label>
            <input
              name="search"
              placeholder="nombre, apellido o DNI (mín. 2 caracteres)"
              className="mt-1 w-64 rounded-md border border-brand-200 px-2 py-1.5 text-sm"
            />
          </div>
          <button type="submit" disabled={searchPending} className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50">
            Buscar
          </button>
        </form>
      ) : null}

      {searchState.error ? <p className="mb-2 text-xs text-estado-riesgo">{searchState.error}</p> : null}
      {searchState.results.length > 0 ? (
        <ul className="mb-4 space-y-1 rounded-md bg-brand-50 p-2 text-sm">
          {searchState.results.map((r) => (
            <li key={r.id} className="flex items-center justify-between">
              <span>
                {r.firstName} {r.lastName} {r.dni ? `(DNI ${r.dni})` : ""}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => handleAdd(r.id)}
                className="text-brand-600 hover:underline disabled:opacity-50"
              >
                agregar
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {message ? <p className="mb-2 text-sm text-brand-600">{message}</p> : null}

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-brand-100 text-xs uppercase text-brand-400">
            <th className="py-1.5 pr-4">Persona</th>
            <th className="py-1.5 pr-4">Desde</th>
            {canManage ? <th className="py-1.5 pr-4"></th> : null}
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.membershipId} className="border-b border-brand-50">
              <td className="py-1.5 pr-4">
                {m.firstName} {m.lastName}
              </td>
              <td className="py-1.5 pr-4">{new Intl.DateTimeFormat("es-AR").format(m.addedAt)}</td>
              {canManage ? (
                <td className="py-1.5 pr-4">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => handleRemove(m.membershipId)}
                    className="text-xs text-brand-500 hover:underline disabled:opacity-50"
                  >
                    quitar
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {members.length === 0 ? <p className="py-2 text-sm text-brand-400">Sin miembros todavía.</p> : null}
    </section>
  );
}
