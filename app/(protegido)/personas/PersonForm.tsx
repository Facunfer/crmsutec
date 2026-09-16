"use client";

import Link from "next/link";
import { useActionState, useRef } from "react";
import type { OrganizationOption } from "@/lib/organizations/queries";
import type { PersonActionResult } from "./acciones";

const initialState: PersonActionResult = { ok: false };

export interface PersonFormInitialValues {
  firstName: string;
  lastName: string;
  dni: string;
  email: string;
  phone: string;
  organizationId: string;
  birthDate: string;
  declaredAge: string;
}

const EMPTY_VALUES: PersonFormInitialValues = {
  firstName: "",
  lastName: "",
  dni: "",
  email: "",
  phone: "",
  organizationId: "",
  birthDate: "",
  declaredAge: "",
};

export function PersonForm({
  action,
  organizations,
  initialValues = EMPTY_VALUES,
  submitLabel = "Guardar",
}: {
  action: (prevState: PersonActionResult, formData: FormData) => Promise<PersonActionResult>;
  organizations: OrganizationOption[];
  initialValues?: PersonFormInitialValues;
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const confirmDuplicatesRef = useRef<HTMLInputElement>(null);

  return (
    <form action={formAction} className="max-w-2xl space-y-4">
      <input ref={confirmDuplicatesRef} type="hidden" name="confirmDuplicates" defaultValue="false" />

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-brand-500">Nombre *</label>
          <input
            name="firstName"
            required
            defaultValue={initialValues.firstName}
            className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Apellido *</label>
          <input
            name="lastName"
            required
            defaultValue={initialValues.lastName}
            className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-brand-500">DNI</label>
          <input
            name="dni"
            defaultValue={initialValues.dni}
            className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Email</label>
          <input
            name="email"
            type="email"
            defaultValue={initialValues.email}
            className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Teléfono</label>
          <input
            name="phone"
            placeholder="011 15-1234-5678"
            defaultValue={initialValues.phone}
            className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Organismo</label>
          <select
            name="organizationId"
            defaultValue={initialValues.organizationId}
            className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          >
            <option value="">— sin especificar —</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-brand-500">Fecha de nacimiento</label>
          <input
            name="birthDate"
            type="date"
            defaultValue={initialValues.birthDate}
            className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-brand-500">Edad declarada (si no se sabe la fecha exacta)</label>
          <input
            name="declaredAge"
            type="number"
            min={0}
            max={130}
            defaultValue={initialValues.declaredAge}
            className="mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      {state.error ? (
        <p className="rounded-md bg-estado-riesgo/10 px-3 py-2 text-sm text-estado-riesgo">
          {state.error}{" "}
          {state.blockedByPersonId ? (
            <Link href={`/personas/${state.blockedByPersonId}`} className="underline">
              ver su ficha
            </Link>
          ) : null}
        </p>
      ) : null}

      {state.needsConfirmation ? (
        <div className="rounded-md bg-estado-alerta/10 px-3 py-2 text-sm text-estado-alerta">
          <p className="mb-1 font-medium">Encontramos posibles duplicados:</p>
          <ul className="mb-2 list-disc pl-5">
            {state.warnings?.map((w) => (
              <li key={`${w.field}-${w.personId}`}>
                Mismo {w.field === "email" ? "email" : "teléfono"} que {w.personName}
              </li>
            ))}
          </ul>
          <button
            type="submit"
            onClick={() => {
              if (confirmDuplicatesRef.current) confirmDuplicatesRef.current.value = "true";
            }}
            className="rounded-md bg-estado-alerta px-3 py-1.5 text-white"
          >
            Guardar de todas formas
          </button>
        </div>
      ) : (
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {pending ? "Guardando..." : submitLabel}
        </button>
      )}
    </form>
  );
}
