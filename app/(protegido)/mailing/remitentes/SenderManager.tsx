"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveSenderAction, verifySenderAction, type SenderFormInput, type VerifySenderResult } from "../acciones";

interface SenderItem {
  id: string;
  name: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  active: boolean;
  isDefault: boolean;
  ownerOrganizationId: string | null;
  providerIdentity: string | null;
  verifiedStatus: string;
  verifiedAt: string | null;
  verifiedCheckedAt: string | null;
}

const STATUS_LABEL: Record<string, string> = { verified: "Verificado", pending: "Pendiente", failed: "Falló", unknown: "Sin verificar" };
const empty: SenderFormInput = { name: "", fromName: "", fromEmail: "", replyTo: "", providerIdentity: "", ownerOrganizationId: "", active: true, isDefault: false };

export function SenderManager({
  senders,
  organizations,
  canCreateGlobal,
  region = null,
}: {
  senders: SenderItem[];
  organizations: Array<{ id: string; label: string }>;
  canCreateGlobal: boolean;
  region?: string | null;
}) {
  const router = useRouter();
  const [form, setForm] = useState<SenderFormInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ senderName: string; result: VerifySenderResult } | null>(null);
  const [pending, startTransition] = useTransition();
  const orgName = new Map(organizations.map((o) => [o.id, o.label]));

  function save() {
    if (!form) return;
    setError(null);
    startTransition(async () => {
      const r = await saveSenderAction(form);
      if (r.ok) {
        setForm(null);
        router.refresh();
      } else setError(r.error ?? "No se pudo guardar.");
    });
  }
  function verify(id: string, senderName: string) {
    setError(null);
    setChecked(null);
    startTransition(async () => {
      const r = await verifySenderAction(id);
      // Siempre se muestra el resultado de la consulta (también «sigue pendiente»): nunca falla en silencio.
      setChecked({ senderName, result: r });
      router.refresh();
    });
  }
  const input = "w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm";

  return (
    <div className="space-y-4">
      {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {pending ? <p className="rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-700">Consultando a Amazon SES…</p> : null}
      {checked ? (
        <p
          role="status"
          className={`rounded-md px-3 py-2 text-sm ${
            checked.result.outcome === "verified" ? "bg-green-50 text-green-800" : checked.result.outcome === "error" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"
          }`}
        >
          <strong>{checked.senderName}:</strong> {checked.result.detail ?? checked.result.error ?? "Sin respuesta."}
          {checked.result.identity ? ` (identidad consultada: ${checked.result.identity}${checked.result.region ? ` · región ${checked.result.region}` : ""})` : ""}
        </p>
      ) : null}
      {region ? <p className="text-xs text-brand-500">Región de Amazon SES configurada en el CRM: {region}.</p> : null}
      <div className="overflow-x-auto rounded-lg bg-white p-4 shadow-sm">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="py-2 pr-4 font-medium">Nombre</th>
              <th className="py-2 pr-4 font-medium">Remite como</th>
              <th className="py-2 pr-4 font-medium">Unidad</th>
              <th className="py-2 pr-4 font-medium">Verificación SES</th>
              <th className="py-2 pr-4 font-medium">Estado</th>
              <th className="py-2 pr-4 font-medium" />
            </tr>
          </thead>
          <tbody>
            {senders.map((s) => (
              <tr key={s.id} className="border-b border-brand-50">
                <td className="py-1.5 pr-4">
                  {s.name} {s.isDefault ? <span className="ml-1 rounded bg-brand-100 px-1.5 text-xs text-brand-700">por defecto</span> : null}
                </td>
                <td className="py-1.5 pr-4">
                  {s.fromName} &lt;{s.fromEmail}&gt;
                </td>
                <td className="py-1.5 pr-4">{s.ownerOrganizationId ? orgName.get(s.ownerOrganizationId) ?? "—" : "Global"}</td>
                <td className="py-1.5 pr-4">
                  {STATUS_LABEL[s.verifiedStatus] ?? s.verifiedStatus}
                  <span className="block text-[11px] text-brand-400">
                    {s.providerIdentity ?? s.fromEmail}
                    {s.verifiedCheckedAt ? ` · consultado ${new Date(s.verifiedCheckedAt).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" })}` : " · sin consultar"}
                  </span>
                </td>
                <td className="py-1.5 pr-4">{s.active ? "Activo" : "Inactivo"}</td>
                <td className="py-1.5 pr-4 text-right">
                  <button type="button" className="mr-3 text-brand-600 hover:underline disabled:opacity-50" disabled={pending} onClick={() => verify(s.id, s.name)}>
                    verificar en SES
                  </button>
                  <button
                    type="button"
                    className="text-brand-600 hover:underline"
                    onClick={() =>
                      setForm({
                        id: s.id,
                        name: s.name,
                        fromName: s.fromName,
                        fromEmail: s.fromEmail,
                        replyTo: s.replyTo ?? "",
                        providerIdentity: s.providerIdentity ?? "",
                        ownerOrganizationId: s.ownerOrganizationId ?? "",
                        active: s.active,
                        isDefault: s.isDefault,
                      })
                    }
                  >
                    editar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {senders.length === 0 ? <p className="py-4 text-sm text-brand-400">Todavía no hay remitentes.</p> : null}
      </div>

      {form ? (
        <div className="space-y-3 rounded-lg bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-brand-900">{form.id ? "Editar remitente" : "Nuevo remitente"}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-brand-500">Nombre interno</span>
              <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-brand-500">Nombre visible (From)</span>
              <input className={input} value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-brand-500">Email de envío</span>
              <input className={input} value={form.fromEmail} onChange={(e) => setForm({ ...form, fromEmail: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-brand-500">Responder a (opcional)</span>
              <input className={input} value={form.replyTo} onChange={(e) => setForm({ ...form, replyTo: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-brand-500">Identidad en SES (opcional; por defecto el email, o su dominio)</span>
              <input className={input} value={form.providerIdentity} onChange={(e) => setForm({ ...form, providerIdentity: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-brand-500">Unidad</span>
              <select className={input} value={form.ownerOrganizationId} onChange={(e) => setForm({ ...form, ownerOrganizationId: e.target.value })}>
                {canCreateGlobal ? <option value="">Global (todas las unidades)</option> : <option value="">— elegir unidad —</option>}
                {organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Activo
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> Por defecto
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={pending} onClick={save} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm text-white hover:bg-brand-700 disabled:opacity-50">
              Guardar
            </button>
            <button type="button" onClick={() => setForm(null)} className="text-sm text-brand-400 hover:underline">
              cancelar
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setForm({ ...empty })} className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50">
          Nuevo remitente
        </button>
      )}
    </div>
  );
}
