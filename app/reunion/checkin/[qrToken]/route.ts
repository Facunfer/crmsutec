import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { resolveQrToken } from "@/lib/attendance/checkin";
import { signCheckinSession } from "@/lib/attendance/session-tokens";
import { CHECKIN_SESSION_COOKIE } from "@/lib/attendance/constants";

/**
 * Punto de entrada del QR (sección 12.1): valida la firma y la ventana,
 * y si es válido abre una sesión de check-in de 10 minutos en una cookie
 * firmada — así la persona tiene tiempo de identificarse aunque el QR de
 * la pantalla ya haya rotado. El id de la reunión nunca queda expuesto
 * suelto en la URL de acá en adelante: `/reunion/checkin` no lleva nada.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ qrToken: string }> }): Promise<Response> {
  const { qrToken } = await params;
  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";

  const result = await resolveQrToken(qrToken, ip);

  const target = new URL("/reunion/checkin", request.url);
  if (result.kind !== "ok") {
    target.searchParams.set("e", result.kind);
    return NextResponse.redirect(target);
  }

  const response = NextResponse.redirect(target);
  const sessionToken = signCheckinSession(result.meetingId);
  response.cookies.set(CHECKIN_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return response;
}
