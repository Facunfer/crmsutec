"use client";

import { useMemo, useState } from "react";
import type { AssociationListItem } from "@/lib/associations/queries";
import type { OrganizationItem } from "@/lib/organizations/queries";
import type { CreatedInvitationLink } from "@/lib/meetings/invitations";
import { countAudienceAction, createInvitationBatchAction, searchPersonForInvitationAction } from "./acciones";

function downloadCsv(filename: string, links: CreatedInvitationLink[], baseUrl: string) {
  const header = "Nombre,Enlace";
  const rows = links.map((l) => `"${l.personName.replace(/"/g, '""')}","${baseUrl}/reunion/invitacion/${l.token}"`);
  const csv = `﻿${[header, ...rows].join("\r\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function InvitationWizard({
  meetingId,
  associations,
  organizations,
}: {
  meetingId: string;
  associations: AssociationListItem[];
  organizations: OrganizationItem[];
}) {
  const [selectedPeople, setSelectedPeople] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedAssociationIds, setSelectedAssociationIds] = useState<Set<string>>(new Set());
  const [selectedOrgIds, setSelectedOrgIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ id: string; firstName: string; lastName: string }>>([]);
  const [count, setCount] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [batchResult, setBatchResult] = useState<
    { createdCount: number; revivedCount: number; alreadyInvitedCount: number; links: CreatedInvitationLink[] } | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const spec = useMemo(
    () => ({
      personIds: selectedPeople.map((p) => p.id),
      associationIds: [...selectedAssociationIds],
      organizationIds: [...selectedOrgIds],
    }),
    [selectedPeople, selectedAssociationIds, selectedOrgIds]
  );

  const summaryParts: string[] = [];
  if (selectedPeople.length > 0) summaryParts.push(`${selectedPeople.length} persona(s) elegidas a mano`);
  if (selectedAssociationIds.size > 0) {
    const names = associations.filter((a) => selectedAssociationIds.has(a.id)).map((a) => a.name);
    summaryParts.push(`miembros de ${names.join(", ")}`);
  }
  if (selectedOrgIds.size > 0) {
    const names = organizations.filter((o) => selectedOrgIds.has(o.id)).map((o) => o.name);
    summaryParts.push(`integrantes de ${names.join(", ")} (y sus dependencias)`);
  }

  async function runSearch() {
    const { results } = await searchPersonForInvitationAction(search);
    setSearchResults(results);
  }

  async function checkCount() {
    setPending(true);
    setError(null);
    const { count: c } = await countAudienceAction(spec);
    setCount(c);
    setPending(false);
  }

  async function confirm() {
    setPending(true);
    setError(null);
    setBatchResult(null);
    const result = await createInvitationBatchAction(meetingId, spec);
    setPending(false);
    if (result.ok) {
      setBatchResult(result.result);
      setSelectedPeople([]);
      setSelectedAssociationIds(new Set());
      setSelectedOrgIds(new Set());
      setCount(null);
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs text-brand-500">Agregar personas individuales</label>
        <div className="mt-1 flex gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="nombre o apellido (mín. 2 caracteres)"
            className="w-64 rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
          <button type="button" onClick={runSearch} className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50">
            Buscar
          </button>
        </div>
        {searchResults.length > 0 ? (
          <ul className="mt-2 space-y-1 rounded-md bg-brand-50 p-2 text-sm">
            {searchResults.map((r) => (
              <li key={r.id} className="flex items-center justify-between">
                <span>
                  {r.firstName} {r.lastName}
                </span>
                <button
                  type="button"
                  className="text-brand-600 hover:underline"
                  onClick={() => {
                    setSelectedPeople((prev) => (prev.some((p) => p.id === r.id) ? prev : [...prev, { id: r.id, name: `${r.firstName} ${r.lastName}` }]));
                    setCount(null);
                  }}
                >
                  agregar
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {selectedPeople.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {selectedPeople.map((p) => (
              <span key={p.id} className="rounded-full bg-brand-100 px-2 py-0.5 text-xs text-brand-700">
                {p.name}{" "}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPeople((prev) => prev.filter((x) => x.id !== p.id));
                    setCount(null);
                  }}
                  className="ml-1 text-brand-400 hover:text-brand-700"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div>
        <label className="block text-xs text-brand-500">Por asociación</label>
        <div className="mt-1 flex flex-wrap gap-3 text-sm">
          {associations.map((a) => (
            <label key={a.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={selectedAssociationIds.has(a.id)}
                onChange={(e) => {
                  setSelectedAssociationIds((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(a.id);
                    else next.delete(a.id);
                    return next;
                  });
                  setCount(null);
                }}
              />
              {a.name}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs text-brand-500">Por organismo (incluye sus dependencias)</label>
        <div className="mt-1 flex flex-wrap gap-3 text-sm">
          {organizations.map((o) => (
            <label key={o.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={selectedOrgIds.has(o.id)}
                onChange={(e) => {
                  setSelectedOrgIds((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(o.id);
                    else next.delete(o.id);
                    return next;
                  });
                  setCount(null);
                }}
              />
              {o.name}
            </label>
          ))}
        </div>
      </div>

      {summaryParts.length > 0 ? (
        <p className="rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-700">
          Audiencia: {summaryParts.join(" + ")}.
        </p>
      ) : (
        <p className="text-sm text-brand-400">Todavía no elegiste ninguna fuente de audiencia.</p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending || summaryParts.length === 0}
          onClick={checkCount}
          className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50 disabled:opacity-50"
        >
          Ver conteo previo
        </button>
        {count !== null ? <span className="text-sm text-brand-700">{count} persona(s) matchean.</span> : null}
        <button
          type="button"
          disabled={pending || count === null || count === 0}
          onClick={confirm}
          className="ml-auto rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Generar invitaciones
        </button>
      </div>

      {error ? <p className="text-sm text-estado-riesgo">{error}</p> : null}

      {batchResult ? (
        <div className="rounded-md bg-estado-ok/10 p-3 text-sm text-estado-ok">
          <p className="mb-2">
            {batchResult.createdCount} invitación(es) nueva(s), {batchResult.revivedCount} re-enviada(s) (habían sido
            retiradas), {batchResult.alreadyInvitedCount} ya estaban invitadas.
          </p>
          {batchResult.links.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => downloadCsv(`invitaciones-${meetingId}.csv`, batchResult.links, window.location.origin)}
                className="mb-2 rounded-md border border-estado-ok px-3 py-1 text-estado-ok hover:bg-estado-ok/10"
              >
                Descargar CSV de enlaces
              </button>
              <ul className="max-h-56 space-y-2 overflow-y-auto">
                {batchResult.links.map((l) => {
                  const link = `${typeof window !== "undefined" ? window.location.origin : ""}/reunion/invitacion/${l.token}`;
                  return (
                    <li key={l.personId} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <span>{l.personName}</span>
                        <button
                          type="button"
                          onClick={() => navigator.clipboard.writeText(link)}
                          className="text-xs text-estado-ok underline"
                        >
                          copiar enlace
                        </button>
                      </div>
                      <input
                        readOnly
                        value={link}
                        onFocus={(e) => e.currentTarget.select()}
                        className="w-full rounded border border-estado-ok/30 bg-white px-2 py-1 text-xs text-brand-700"
                      />
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs text-brand-500">
                Estos enlaces se muestran una sola vez — no quedan guardados en texto plano.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
