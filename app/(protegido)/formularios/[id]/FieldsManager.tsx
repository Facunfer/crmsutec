"use client";

import { useState, useTransition } from "react";
import type { FormFieldRow } from "@/lib/forms/queries";
import type { FieldDefinitionItem } from "@/lib/people/field-definitions";
import { FIELD_TYPE_LABELS, CORE_PERSON_MAPPING_LABELS } from "@/lib/forms/field-type-labels";
import { removeFieldAction } from "./acciones";
import { FieldForm } from "./FieldForm";

export function FieldsManager({
  formId,
  fields,
  fieldDefinitions,
  canEdit,
}: {
  formId: string;
  fields: FormFieldRow[];
  fieldDefinitions: FieldDefinitionItem[];
  canEdit: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove(fieldId: string) {
    if (!window.confirm("¿Quitar este campo del formulario?")) return;
    startTransition(async () => {
      const result = await removeFieldAction(formId, fieldId);
      setError(result.ok ? null : result.error ?? "No se pudo quitar.");
    });
  }

  const mappingLabel = (mapping: string | null, defs: FieldDefinitionItem[]): string => {
    if (!mapping) return "—";
    if (CORE_PERSON_MAPPING_LABELS[mapping]) return CORE_PERSON_MAPPING_LABELS[mapping];
    return defs.find((d) => d.key === mapping)?.label ?? mapping;
  };

  return (
    <div className="space-y-3">
      {fields.length === 0 ? <p className="text-sm text-brand-400">Todavía no hay campos.</p> : null}
      {fields.map((field) =>
        editingId === field.id ? (
          <FieldForm key={field.id} formId={formId} field={field} fieldDefinitions={fieldDefinitions} onDone={() => setEditingId(null)} />
        ) : (
          <div key={field.id} className="flex items-center justify-between rounded-md border border-brand-100 p-3 text-sm">
            <div>
              <span className="font-medium">{field.label}</span>{" "}
              <span className="text-xs text-brand-400">
                ({field.key} · {FIELD_TYPE_LABELS[field.fieldType]}
                {field.required ? " · obligatorio" : ""}
                {!field.visible ? " · oculto" : ""}
                {field.personFieldMapping ? ` · mapea a ${mappingLabel(field.personFieldMapping, fieldDefinitions)}` : ""})
              </span>
            </div>
            {canEdit ? (
              <div className="flex gap-2">
                <button type="button" onClick={() => setEditingId(field.id)} className="text-xs text-brand-500 hover:underline">
                  editar
                </button>
                <button type="button" disabled={pending} onClick={() => remove(field.id)} className="text-xs text-estado-riesgo hover:underline disabled:opacity-50">
                  quitar
                </button>
              </div>
            ) : null}
          </div>
        )
      )}
      {error ? <p className="text-sm text-estado-riesgo">{error}</p> : null}

      {canEdit ? (
        adding ? (
          <FieldForm formId={formId} fieldDefinitions={fieldDefinitions} onDone={() => setAdding(false)} />
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50">
            + Agregar campo
          </button>
        )
      ) : null}
    </div>
  );
}
