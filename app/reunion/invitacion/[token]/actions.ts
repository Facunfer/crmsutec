"use server";

import { headers } from "next/headers";
import { respondToInvitation, checkInByInvitationToken } from "@/lib/meetings/public";

export interface RespondState {
  status: "idle" | "ok" | "error";
  response?: "confirmed" | "declined";
  message?: string;
}

export async function respondAction(
  token: string,
  _prevState: RespondState,
  response: "confirmed" | "declined"
): Promise<RespondState> {
  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";

  const result = await respondToInvitation(token, response, ip);

  if (result.ok) {
    return { status: "ok", response };
  }

  const messages: Record<string, string> = {
    invalid: "Este enlace no es válido.",
    locked: "Ya no se puede cambiar la respuesta: la reunión ya empezó.",
    rate_limited: "Demasiados intentos. Probá de nuevo en unos minutos.",
  };
  return { status: "error", message: messages[result.reason] ?? "No se pudo registrar tu respuesta." };
}

export interface CheckinState {
  status: "idle" | "ok" | "error";
  checkedInAt?: string;
  message?: string;
}

export async function checkinAction(token: string, _prevState: CheckinState): Promise<CheckinState> {
  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
  const userAgent = hdrs.get("user-agent") ?? undefined;

  const result = await checkInByInvitationToken(token, ip, userAgent);
  if (result.ok) {
    return { status: "ok", checkedInAt: result.checkedInAt.toISOString() };
  }

  const messages: Record<string, string> = {
    invalid: "Este enlace no es válido.",
    not_active: "La acreditación para esta reunión no está abierta en este momento.",
    rate_limited: "Demasiados intentos. Probá de nuevo en unos minutos.",
  };
  return { status: "error", message: messages[result.reason] ?? "No se pudo registrar tu llegada." };
}
