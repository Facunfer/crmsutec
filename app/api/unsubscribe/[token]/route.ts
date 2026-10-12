import { NextResponse, type NextRequest } from "next/server";
import { loadMailConfig } from "@/lib/mailing/config";
import { confirmUnsubscribe } from "@/lib/mailing/suppressions";
import { allowUnsubscribeAttempt } from "@/lib/mailing/unsubscribe-limit";

/** Detrás de nginx request.url trae el host interno: se redirige siempre al dominio público configurado. */
function publicUrl(path: string, request: NextRequest): URL {
  const base = loadMailConfig().publicBaseUrl;
  return new URL(path, base ?? request.url);
}

export const dynamic = "force-dynamic";

/**
 * Baja pública. POST = confirmación (botón de la página, o «un clic» RFC 8058 que envían Gmail/Outlook con `List-Unsubscribe-Post`).
 * GET NO da de baja: redirige a la página de confirmación. Nunca se loguea el token.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return NextResponse.redirect(publicUrl(`/unsubscribe/${encodeURIComponent(token)}`, request), 303);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await allowUnsubscribeAttempt(token, request.headers.get("x-forwarded-for")))) {
    return new NextResponse("Demasiados intentos. Probá de nuevo en unos minutos.", { status: 429, headers: { "Retry-After": "600" } });
  }
  const result = await confirmUnsubscribe(token);
  const contentType = request.headers.get("content-type") ?? "";
  const fromBrowserForm = contentType.includes("application/x-www-form-urlencoded") && !(await request.clone().text()).includes("List-Unsubscribe=One-Click");
  if (fromBrowserForm) {
    return NextResponse.redirect(publicUrl(`/unsubscribe/${encodeURIComponent(token)}?listo=${result.ok ? "1" : "0"}`, request), 303);
  }
  return new NextResponse(result.ok ? "OK" : "Enlace inválido", { status: result.ok ? 200 : 400 });
}
