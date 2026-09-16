"use client";

import { useActionState } from "react";
import { checkinAction, type CheckinState } from "./actions";

const initialState: CheckinState = { status: "idle" };

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("es-AR", { timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(iso));
}

export function CheckinButton({
  token,
  alreadyCheckedIn,
  checkedInAt,
}: {
  token: string;
  alreadyCheckedIn: boolean;
  checkedInAt: string | null;
}) {
  const [state, dispatch, pending] = useActionState(checkinAction.bind(null, token), initialState);

  if (state.status === "ok" || (state.status === "idle" && alreadyCheckedIn)) {
    const time = state.status === "ok" ? state.checkedInAt : (checkedInAt ?? undefined);
    return (
      <div className="rounded-md bg-estado-ok/10 p-4 text-center text-sm text-estado-ok">
        Ya registramos tu llegada{time ? ` a las ${formatTime(time)}` : ""}.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => dispatch()}
        className="w-full rounded-md bg-brand-600 px-4 py-3 text-base font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? "Registrando..." : "Registrar mi llegada"}
      </button>
      {state.status === "error" ? <p className="text-center text-sm text-estado-riesgo">{state.message}</p> : null}
    </div>
  );
}
