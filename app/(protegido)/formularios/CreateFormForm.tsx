"use client";

import { useActionState, useState } from "react";
import { createFormAction, type ActionResult } from "./acciones";

const initialState: ActionResult = { ok: false };

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function CreateFormForm() {
  const [state, dispatch, pending] = useActionState(createFormAction, initialState);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  return (
    <form action={dispatch} className="flex flex-wrap items-end gap-3 rounded-lg bg-white p-4 shadow-sm">
      <div>
        <label className="block text-xs text-brand-500">Nombre</label>
        <input
          name="name"
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
          className="mt-1 w-64 rounded-md border border-brand-200 px-2 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Slug (URL pública: /f/…)</label>
        <input
          name="slug"
          required
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value);
            setSlugTouched(true);
          }}
          className="mt-1 w-48 rounded-md border border-brand-200 px-2 py-1.5 text-sm font-mono"
        />
      </div>
      <button type="submit" disabled={pending} className="rounded-md bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
        {pending ? "Creando..." : "Crear formulario"}
      </button>
      {state.error ? <p className="text-sm text-estado-riesgo">{state.error}</p> : null}
    </form>
  );
}
