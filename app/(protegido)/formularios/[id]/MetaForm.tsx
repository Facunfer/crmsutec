"use client";

import { useActionState } from "react";
import type { FormDetail } from "@/lib/forms/queries";
import { updateFormMetaAction, type ActionResult } from "./acciones";

const initialState: ActionResult = { ok: false };

function toLocalInput(date: Date | null): string {
  if (!date) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MATCH_FIELDS = [
  { value: "dni", label: "DNI" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Teléfono" },
];

export function MetaForm({ formId, form, canEdit }: { formId: string; form: FormDetail; canEdit: boolean }) {
  const [state, dispatch, pending] = useActionState(updateFormMetaAction.bind(null, formId), initialState);
  const matchFields = new Set(form.identificationPolicy.matchFields ?? []);

  if (!canEdit) {
    return (
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt className="text-brand-400">Nombre</dt>
        <dd>{form.name}</dd>
        <dt className="text-brand-400">Mensaje de éxito</dt>
        <dd>{form.successMessage ?? "—"}</dd>
        <dt className="text-brand-400">Texto de consentimiento</dt>
        <dd>{form.consentText ?? "—"}</dd>
        <dt className="text-brand-400">Política de actualización</dt>
        <dd>{form.updatePolicy === "fill_empty_only" ? "Completar solo datos vacíos" : "Siempre revisar a mano"}</dd>
      </dl>
    );
  }

  return (
    <form action={dispatch} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs text-brand-500">Nombre</label>
          <input name="name" defaultValue={form.name} required className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Slug (URL pública: /f/…)</label>
          <input name="slug" defaultValue={form.slug} required className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm font-mono" />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Abre</label>
          <input name="opensAt" type="datetime-local" defaultValue={toLocalInput(form.opensAt)} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Cierra</label>
          <input name="closesAt" type="datetime-local" defaultValue={toLocalInput(form.closesAt)} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Mensaje de éxito (se muestra al enviar)</label>
        <input name="successMessage" defaultValue={form.successMessage ?? ""} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Texto de consentimiento (se muestra antes de enviar)</label>
        <textarea name="consentText" defaultValue={form.consentText ?? ""} rows={2} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Identificar a la persona por (en orden de prioridad)</label>
        <div className="mt-1 flex gap-4 text-sm">
          {MATCH_FIELDS.map((f) => (
            <label key={f.value} className="flex items-center gap-1">
              <input type="checkbox" name="matchFields" value={f.value} defaultChecked={matchFields.has(f.value)} />
              {f.label}
            </label>
          ))}
        </div>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Si coincide con alguien que ya existe</label>
        <select name="updatePolicy" defaultValue={form.updatePolicy} className="mt-1 w-full max-w-sm rounded-md border border-brand-200 px-2 py-1.5 text-sm">
          <option value="fill_empty_only">Completar solo los datos que tenía vacíos</option>
          <option value="always_flag_for_review">Nunca actualizar sola: siempre mandar a revisión</option>
        </select>
      </div>
      <button type="submit" disabled={pending} className="rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
        {pending ? "Guardando..." : "Guardar"}
      </button>
      {state.error ? <p className="text-sm text-estado-riesgo">{state.error}</p> : null}
    </form>
  );
}
