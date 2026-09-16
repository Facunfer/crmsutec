import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "./lib/auth/constants";

/**
 * Barrera barata en Edge: solo mira si existe la cookie, nunca toca la
 * base. La validación real (sesión vigente, permisos, usuario activo) pasa
 * siempre por lib/auth/guard.ts en el layout protegido y en cada acción.
 *
 * `?expirada=1` corta el bucle de redirección: si alguien llega a /login ya
 * con ese parámetro, no lo mandamos de nuevo a limpiar una cookie que puede
 * haber quedado corrupta o vencida sin invalidar antes.
 */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/personas",
  "/asociaciones",
  "/reuniones",
  "/formularios",
  "/visualizacion",
  "/administracion",
  "/sin-permiso",
];

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  if (!isProtected) {
    return NextResponse.next();
  }

  const hasCookie = request.cookies.has(SESSION_COOKIE_NAME);
  if (hasCookie) {
    return NextResponse.next();
  }

  if (searchParams.get("expirada") === "1") {
    // Ya venimos de un intento de redirección; no reintentar en loop.
    return NextResponse.next();
  }

  const loginUrl = new URL("/login?expirada=1", request.url);
  const response = NextResponse.redirect(loginUrl);
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/personas/:path*",
    "/asociaciones/:path*",
    "/reuniones/:path*",
    "/formularios/:path*",
    "/visualizacion/:path*",
    "/administracion/:path*",
    "/sin-permiso",
  ],
};
