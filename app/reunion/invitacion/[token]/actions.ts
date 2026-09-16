"use server";

import { headers } from "next/headers";
import { respondToInvitation } from "@/lib/meetings/public";

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
