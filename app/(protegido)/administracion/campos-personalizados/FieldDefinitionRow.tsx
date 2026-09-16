"use client";

import { useActionState } from "react";
import type { FieldDefinitionItem } from "@/lib/people/field-definitions";
import { FIELD_TYPE_LABELS } from "@/lib/forms/field-type-labels";
import { toggleFieldDefinitionActiveAction, type ActionResult } from "./acciones";

const initialState: ActionResult = { ok: false };

export function FieldDefinitionRow({ definition }: { definition: FieldDefinitionItem }) {
  const [state, dispatch, pending] = useActionState(toggleFieldDefinitionActiveAction.bind(null, definition.id, !definition.active), initialState);

  return (
    <tr className="border-b border-brand-50">
      <td className="py-1.5 pr-4 font-mono text-xs">{definition.key}</td>
      <td className="py-1.5 pr-4">
        {definition.label}
        {definition.required ? <span className="ml-1 text-xs text-brand-400">(obligatorio)</span> : null}
        {definition.sensitive ? <span className="ml-1 text-xs text-estado-riesgo">(sensible)</span> : null}
      </td>
      <td className="py-1.5 pr-4">{FIELD_TYPE_LABELS[definition.fieldType]}</td>
      <td className="py-1.5 pr-4">{definition.active ? "activo" : "inactivo"}</td>
      <td className="py-1.5 pr-4">
        <button type="button" disabled={pending} onClick={() => dispatch()} className="text-xs text-brand-500 hover:underline disabled:opacity-50">
          {definition.active ? "desactivar" : "activar"}
        </button>
        {state.error ? <span className="ml-2 text-xs text-estado-riesgo">{state.error}</span> : null}
      </td>
    </tr>
  );
}
