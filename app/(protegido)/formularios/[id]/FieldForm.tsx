"use client";

import { useActionState, useState } from "react";
import type { PersonFieldType } from "@/lib/db/schema";
import type { FormFieldRow } from "@/lib/forms/queries";
import type { FieldDefinitionItem } from "@/lib/people/field-definitions";
import { FIELD_TYPE_LABELS, FIELD_TYPES_WITH_CHOICES, CORE_PERSON_MAPPING_LABELS } from "@/lib/forms/field-type-labels";
import { upsertFieldAction, type ActionResult } from "./acciones";

const initialState: ActionResult = { ok: false };

function optionsToText(options: unknown): string {
  const choices = (options as { choices?: Array<{ value: string; label: string }> } | null)?.choices;
  if (!choices) return "";
  return choices.map((c) => (c.label && c.label !== c.value ? `${c.value}|${c.label}` : c.value)).join("\n");
}

export function FieldForm({
  formId,
  field,
  fieldDefinitions,
  onDone,
}: {
  formId: string;
  field?: FormFieldRow;
  fieldDefinitions: FieldDefinitionItem[];
  onDone?: () => void;
}) {
  const [state, dispatch, pending] = useActionState(upsertFieldAction.bind(null, formId, field?.id ?? null), initialState);
  const [fieldType, setFieldType] = useState<PersonFieldType>(field?.fieldType ?? "text");
  const hasChoices = FIELD_TYPES_WITH_CHOICES.includes(fieldType);

  return (
    <form
      action={async (formData) => {
        await dispatch(formData);
        onDone?.();
      }}
      className="grid grid-cols-1 gap-3 rounded-md border border-brand-100 p-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <div>
        <label className="block text-xs text-brand-500">Clave</label>
        <input name="key" defaultValue={field?.key} required disabled={!!field} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm disabled:bg-brand-50" />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Etiqueta</label>
        <input name="label" defaultValue={field?.label} required className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Tipo</label>
        <select
          name="fieldType"
          value={fieldType}
          onChange={(e) => setFieldType(e.target.value as PersonFieldType)}
          className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
        >
          {Object.entries(FIELD_TYPE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-brand-500">Mapea a (opcional)</label>
        <select name="personFieldMapping" defaultValue={field?.personFieldMapping ?? ""} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm">
          <option value="">— no mapea —</option>
          <optgroup label="Campo núcleo de Personas">
            {Object.entries(CORE_PERSON_MAPPING_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </optgroup>
          {fieldDefinitions.length > 0 ? (
            <optgroup label="Campo personalizado">
              {fieldDefinitions.map((def) => (
                <option key={def.key} value={def.key}>
                  {def.label}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </div>
      {hasChoices ? (
        <div className="sm:col-span-2 lg:col-span-4">
          <label className="block text-xs text-brand-500">Opciones (una por línea, "valor|etiqueta")</label>
          <textarea name="optionsText" defaultValue={optionsToText(field?.options)} rows={3} className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
        </div>
      ) : null}
      <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
        <label className="flex items-center gap-1 text-xs text-brand-500">
          <input type="checkbox" name="required" value="true" defaultChecked={field?.required} /> obligatorio
        </label>
        <label className="flex items-center gap-1 text-xs text-brand-500">
          <input type="checkbox" name="visible" value="true" defaultChecked={field?.visible ?? true} /> visible
        </label>
        <button type="submit" disabled={pending} className="ml-auto rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {pending ? "Guardando..." : field ? "Guardar campo" : "Agregar campo"}
        </button>
      </div>
      {state.error ? <p className="text-sm text-estado-riesgo sm:col-span-2 lg:col-span-4">{state.error}</p> : null}
    </form>
  );
}
