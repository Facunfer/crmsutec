"use client";

import { useActionState } from "react";
import { confirmCheckinAction, identifyAction, type ConfirmState, type IdentifyState } from "./actions";

const initialIdentifyState: IdentifyState = { kind: "idle" };
const initialConfirmState: ConfirmState = { kind: "idle" };

const IDENTIFY_MESSAGES: Record<string, string> = {
  not_found: "No pudimos acreditarte con esos datos. Revisá que estén bien escritos o acercate a la mesa de acreditación.",
  rate_limited: "Demasiados intentos. Esperá un momento y probá de nuevo.",
  no_session: "Esta sesión venció. Volvé a escanear el código QR.",
};

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("es-AR", { timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" }).format(new Date(iso));
}

export function IdentifyForm({ meetingName }: { meetingName: string }) {
  const [identifyState, identifyDispatch, identifyPending] = useActionState(identifyAction, initialIdentifyState);
  const confirmTokenBoundAction =
    identifyState.kind === "need_confirmation" && identifyState.confirmToken
      ? confirmCheckinAction.bind(null, identifyState.confirmToken)
      : null;
  const [confirmState, confirmDispatch, confirmPending] = useActionState(
    confirmTokenBoundAction ?? (async (s: ConfirmState) => s),
    initialConfirmState
  );

  if (confirmState.kind === "ok" || confirmState.kind === "already_checked_in") {
    return (
      <div className="rounded-md bg-estado-ok/10 p-4 text-center text-sm text-estado-ok">
        {confirmState.kind === "ok" ? (
          <>¡Listo, {confirmState.firstName}! Quedaste registrado a las {confirmState.checkedInAt ? formatTime(confirmState.checkedInAt) : ""}.</>
        ) : (
          <>Ya estabas registrado a las {confirmState.checkedInAt ? formatTime(confirmState.checkedInAt) : ""}.</>
        )}
      </div>
    );
  }

  if (identifyState.kind === "already_checked_in") {
    return (
      <div className="rounded-md bg-estado-ok/10 p-4 text-center text-sm text-estado-ok">
        Ya estabas registrado, {identifyState.firstName}, a las {identifyState.checkedInAt ? formatTime(identifyState.checkedInAt) : ""}.
      </div>
    );
  }

  if (identifyState.kind === "need_confirmation") {
    return (
      <div className="space-y-3 text-center">
        <p className="text-base text-brand-900">¿Sos {identifyState.firstName}?</p>
        <button
          type="button"
          disabled={confirmPending}
          onClick={() => confirmDispatch()}
          className="w-full rounded-md bg-brand-600 px-4 py-3 text-base font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {confirmPending ? "Confirmando..." : "Sí, confirmar asistencia"}
        </button>
        {confirmState.kind !== "idle" ? (
          <p className="text-sm text-estado-riesgo">No se pudo confirmar. Volvé a intentar desde el QR.</p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={identifyDispatch} className="space-y-3">
      <p className="text-center text-sm text-brand-500">{meetingName}</p>
      <div>
        <label className="block text-xs text-brand-500">DNI, email o teléfono</label>
        <input
          name="identifier"
          required
          inputMode="text"
          className="mt-1 w-full rounded-md border border-brand-200 px-3 py-2 text-base"
        />
      </div>
      <div>
        <label className="block text-xs text-brand-500">Apellido</label>
        <input name="lastName" required className="mt-1 w-full rounded-md border border-brand-200 px-3 py-2 text-base" />
      </div>
      {identifyState.kind !== "idle" && IDENTIFY_MESSAGES[identifyState.kind] ? (
        <p className="text-center text-sm text-estado-riesgo">{IDENTIFY_MESSAGES[identifyState.kind]}</p>
      ) : null}
      <button
        type="submit"
        disabled={identifyPending}
        className="w-full rounded-md bg-brand-600 px-4 py-3 text-base font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {identifyPending ? "Buscando..." : "Continuar"}
      </button>
    </form>
  );
}
