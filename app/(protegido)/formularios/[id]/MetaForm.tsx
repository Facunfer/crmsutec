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

export interface LinkOption {
  id: string;
  name: string;
  /** Solo para reuniones: campaña a la que pertenecen (para validar en pantalla). */
  campaignId?: string | null;
}

const CREATION_LABEL: Record<string, string> = {
  never: "Nunca: una respuesta sin coincidencia queda «sin vincular» y un operador decide",
  when_valid_dni: "Crear la persona si la respuesta no coincide con nadie y trae un DNI válido",
};
const APPLY_LABEL: Record<string, string> = {
  never: "Nunca: un operador aplica los datos del formulario explícitamente",
  fill_empty_only: "Completar solo los datos que la persona vinculada tenía vacíos",
};

export function MetaForm({
  formId,
  form,
  canEdit,
  campaigns = [],
  meetings = [],
}: {
  formId: string;
  form: FormDetail;
  canEdit: boolean;
  campaigns?: LinkOption[];
  meetings?: LinkOption[];
}) {
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
        <dt className="text-brand-400">Descripción</dt>
        <dd>{form.description ?? "—"}</dd>
        <dt className="text-brand-400">Personas nuevas</dt>
        <dd>{CREATION_LABEL[form.personCreationPolicy]}</dd>
        <dt className="text-brand-400">Datos de personas existentes</dt>
        <dd>{APPLY_LABEL[form.applyDataPolicy]}</dd>
        <dt className="text-brand-400">Campaña</dt>
        <dd>{campaigns.find((c) => c.id === form.campaignId)?.name ?? "—"}</dd>
        <dt className="text-brand-400">Reunión / jornada</dt>
        <dd>{meetings.find((m) => m.id === (form.meetingId ?? form.defaultMeetingId))?.name ?? "—"}</dd>
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
        <label className="block text-xs text-brand-500">Descripción (interna)</label>
        <input name="description" defaultValue={form.description ?? ""} maxLength={2000} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="block text-xs text-brand-500">Campaña (opcional)</label>
          <select name="campaignId" defaultValue={form.campaignId ?? ""} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm">
            <option value="">— ninguna —</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-brand-500">Reunión fija (opcional)</label>
          <select name="meetingId" defaultValue={form.meetingId ?? ""} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm">
            <option value="">— ninguna —</option>
            {meetings.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-brand-500">Jornada por defecto de la campaña (opcional)</label>
          <select name="defaultMeetingId" defaultValue={form.defaultMeetingId ?? ""} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm">
            <option value="">— el operador elige —</option>
            {meetings.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
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
        <label className="block text-xs text-brand-500">Si la respuesta no coincide con nadie</label>
        <select name="personCreationPolicy" defaultValue={form.personCreationPolicy} className="mt-1 w-full max-w-xl rounded-md border border-brand-200 px-2 py-1.5 text-sm">
          {Object.entries(CREATION_LABEL).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Si la respuesta coincide con una persona existente</label>
        <select name="applyDataPolicy" defaultValue={form.applyDataPolicy} className="mt-1 w-full max-w-xl rounded-md border border-brand-200 px-2 py-1.5 text-sm">
          {Object.entries(APPLY_LABEL).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-brand-400">Completar un formulario nunca inscribe: la inscripción es una acción explícita del operador.</p>
      </div>
      <button type="submit" disabled={pending} className="rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
        {pending ? "Guardando..." : "Guardar"}
      </button>
      {state.error ? <p className="text-sm text-estado-riesgo">{state.error}</p> : null}
    </form>
  );
}
