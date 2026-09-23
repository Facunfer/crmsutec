"use client";

import { useActionState, type ReactNode } from "react";
import type { FormVersionField } from "@/lib/forms/version-schema";
/** Solo lo mínimo que un visitante público necesita para elegir una asociación. */
type PublicAssociationOption = { id: string; name: string };
import { submitFormAction, type SubmitFormState } from "./actions";

const initialState: SubmitFormState = { status: "idle" };

function Field({ field, error, associations }: { field: FormVersionField; error?: string; associations: PublicAssociationOption[] }) {
  const base = "mt-1 w-full rounded-md border border-brand-200 px-3 py-2 text-base";
  const label = (
    <label className="block text-sm font-medium text-brand-900">
      {field.label}
      {field.required ? <span className="text-estado-riesgo"> *</span> : null}
    </label>
  );

  let input: ReactNode;
  switch (field.fieldType) {
    case "textarea":
      input = <textarea name={field.key} required={field.required} rows={3} className={base} />;
      break;
    case "number":
      input = <input type="number" name={field.key} required={field.required} className={base} />;
      break;
    case "date":
      input = <input type="date" name={field.key} required={field.required} className={base} />;
      break;
    case "select":
      input = (
        <select name={field.key} required={field.required} defaultValue="" className={base}>
          <option value="" disabled>
            Elegí una opción
          </option>
          {(field.options.choices ?? []).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
      break;
    case "radio":
      input = (
        <div className="mt-1 space-y-1">
          {(field.options.choices ?? []).map((c) => (
            <label key={c.value} className="flex items-center gap-2 text-sm">
              <input type="radio" name={field.key} value={c.value} required={field.required} /> {c.label}
            </label>
          ))}
        </div>
      );
      break;
    case "checkbox":
      input = (
        <div className="mt-1 space-y-1">
          {(field.options.choices ?? []).map((c) => (
            <label key={c.value} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name={field.key} value={c.value} /> {c.label}
            </label>
          ))}
        </div>
      );
      break;
    case "association":
      input = (
        <select name={field.key} required={field.required} defaultValue="" className={base}>
          <option value="" disabled>
            Elegí una opción
          </option>
          {associations.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      );
      break;
    default:
      input = <input type="text" name={field.key} required={field.required} className={base} />;
  }

  return (
    <div>
      {field.fieldType !== "checkbox" && field.fieldType !== "radio" ? label : <p className="text-sm font-medium text-brand-900">{field.label}{field.required ? <span className="text-estado-riesgo"> *</span> : null}</p>}
      {input}
      {error ? <p className="mt-1 text-sm text-estado-riesgo">{error}</p> : null}
    </div>
  );
}

export function FormRenderer({
  slug,
  idempotencyKey,
  name,
  consentText,
  fields,
  associations,
}: {
  slug: string;
  idempotencyKey: string;
  name: string;
  consentText: string | null;
  fields: FormVersionField[];
  associations: PublicAssociationOption[];
}) {
  const [state, dispatch, pending] = useActionState(submitFormAction.bind(null, slug, idempotencyKey), initialState);

  if (state.status === "ok") {
    return (
      <div className="rounded-md bg-estado-ok/10 p-4 text-center text-sm text-estado-ok">
        {state.message}
      </div>
    );
  }

  const visibleFields = fields.filter((f) => f.visible).sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <form action={dispatch} className="space-y-4">
      <h1 className="text-lg font-semibold text-brand-900">{name}</h1>
      {visibleFields.map((field) => (
        <Field key={field.key} field={field} error={state.fieldErrors?.[field.key]} associations={associations} />
      ))}
      {consentText ? (
        <div>
          <label className="flex items-start gap-2 text-sm text-brand-700">
            <input type="checkbox" name="__consent" value="true" required className="mt-1" />
            <span>{consentText}</span>
          </label>
          {state.fieldErrors?.__consent ? <p className="mt-1 text-sm text-estado-riesgo">{state.fieldErrors.__consent}</p> : null}
        </div>
      ) : null}
      {state.status === "error" && state.message ? <p className="text-sm text-estado-riesgo">{state.message}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-brand-600 px-4 py-3 text-base font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? "Enviando..." : "Enviar"}
      </button>
    </form>
  );
}
