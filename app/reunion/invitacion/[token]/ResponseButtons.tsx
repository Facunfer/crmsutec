"use client";

import { useActionState } from "react";
import { respondAction, type RespondState } from "./actions";

const initialState: RespondState = { status: "idle" };

export function ResponseButtons({ token, currentResponse }: { token: string; currentResponse: "pending" | "confirmed" | "declined" }) {
  const [state, dispatch, pending] = useActionState(respondAction.bind(null, token), initialState);

  const response = state.status === "ok" ? state.response : currentResponse !== "pending" ? currentResponse : null;

  if (state.status === "ok" || (state.status === "idle" && currentResponse !== "pending")) {
    return (
      <div className="rounded-md bg-estado-ok/10 p-4 text-center text-sm text-estado-ok">
        {response === "confirmed" ? "Confirmaste tu asistencia. ¡Te esperamos!" : "Registramos que no vas a asistir."}
        <div className="mt-3 flex justify-center gap-3">
          <button type="button" disabled={pending} onClick={() => dispatch("confirmed")} className="text-xs underline">
            cambiar a &quot;voy a asistir&quot;
          </button>
          <button type="button" disabled={pending} onClick={() => dispatch("declined")} className="text-xs underline">
            cambiar a &quot;no voy a asistir&quot;
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => dispatch("confirmed")}
        className="w-full rounded-md bg-brand-600 px-4 py-3 text-base font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        Voy a asistir
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => dispatch("declined")}
        className="w-full rounded-md border border-brand-200 px-4 py-3 text-base font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-60"
      >
        No voy a asistir
      </button>
      {state.status === "error" ? <p className="text-center text-sm text-estado-riesgo">{state.message}</p> : null}
    </div>
  );
}
