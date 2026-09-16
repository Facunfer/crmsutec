"use client";

import { useActionState, useState } from "react";
import { createFieldDefinitionAction, type ActionResult } from "./acciones";
import { FIELD_TYPE_LABELS, FIELD_TYPES_WITH_CHOICES } from "@/lib/forms/field-type-labels";
import type { PersonFieldType } from "@/lib/db/schema";

const initialState: ActionResult = { ok: false };

export function CreateFieldDefinitionForm() {
  const [state, dispatch, pending] = useActionState(createFieldDefinitionAction, initialState);
  const [fieldType, setFieldType] = useState<PersonFieldType>("text");
  const hasChoices = FIELD_TYPES_WITH_CHOICES.includes(fieldType);

  return (
    <form action={dispatch} className="grid grid-cols-1 gap-3 rounded-lg bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <label className="block text-xs text-brand-500">Clave (para usar en código)</label>
        <input name="key" required placeholder="ej: talle_ropa" className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Etiqueta</label>
        <input name="label" required placeholder="ej: Talle de ropa" className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Tipo</label>
        <select
          name="fieldType"
          value={fieldType}
          onChange={(e) => setFieldType(e.target.value as PersonFieldType)}
          className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
        >
          {Object.entries(FIELD_TYPE_LABELS)
            .filter(([key]) => key !== "association")
            .map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
        </select>
      </div>
      <div className="flex items-end gap-3">
        <label className="flex items-center gap-1 text-xs text-brand-500">
          <input type="checkbox" name="required" value="true" /> obligatorio
        </label>
        <label className="flex items-center gap-1 text-xs text-brand-500">
          <input type="checkbox" name="sensitive" value="true" /> sensible
        </label>
      </div>
      {hasChoices ? (
        <div className="sm:col-span-2 lg:col-span-4">
          <label className="block text-xs text-brand-500">Opciones (una por línea, "valor|etiqueta")</label>
          <textarea name="optionsText" rows={3} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
      ) : null}
      <div className="sm:col-span-2 lg:col-span-4 flex items-center gap-3">
        <button type="submit" disabled={pending} className="rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {pending ? "Creando..." : "Crear campo"}
        </button>
        {state.error ? <p className="text-sm text-estado-riesgo">{state.error}</p> : null}
      </div>
    </form>
  );
}
