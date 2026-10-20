import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Centinela de COMPORTAMIENTO (S8). No busca texto en el código: ejecuta cada Server Action y cada ruta protegida SIN sesión y exige que
 * (a) se rechace y (b) no se haya tocado la base antes de la autorización. Una función nueva que olvide el guard, o que consulte antes de
 * autorizar, rompe este test aunque el texto «requireUser(» aparezca en un comentario.
 */

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_QR_SECRET = "test-qr-secret-".padEnd(48, "x");

const h = vi.hoisted(() => ({ dbTouched: 0, revalidated: 0 }));
vi.mock("../../lib/auth/cookies.js", () => ({ getSessionCookie: async () => undefined, clearSessionCookie: async () => undefined, setSessionCookie: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => void h.revalidated++, revalidateTag: () => void h.revalidated++ }));
vi.mock("../../lib/db/client.js", () => ({
  getDb: async () => {
    h.dbTouched += 1;
    throw new Error("BASE_TOCADA_SIN_AUTORIZAR");
  },
  closeDb: async () => undefined,
  execRawSql: async () => undefined,
  deferProcessShutdownToApp: () => () => undefined,
}));

const ROOT = process.cwd();
const walk = (dir: string): string[] =>
  (readdirSync(dir, { recursive: true }) as string[]).map((e) => join(dir, e)).filter((p) => /\.(ts|tsx)$/.test(p));
const rel = (p: string) => relative(ROOT, p).replaceAll("\\", "/");

beforeEach(() => {
  h.dbTouched = 0;
  h.revalidated = 0;
});

// ---------------------------------------------------------------------------------------------------------------------
// Server Actions protegidas: TODOS los archivos «use server» de app/(protegido), no solo los que se llaman acciones.ts.
// ---------------------------------------------------------------------------------------------------------------------
const PROTECTED_ACTION_FILES = walk(join(ROOT, "app", "(protegido)"))
  .filter((p) => readFileSync(p, "utf8").trimStart().startsWith('"use server"'))
  .map(rel)
  .sort();

/** Las Server Actions exportan solo funciones async: se descubren por lo que el módulo REALMENTE exporta. */
async function exportedActions(file: string): Promise<Array<[string, (...args: unknown[]) => Promise<unknown>]>> {
  const mod = (await import(/* @vite-ignore */ join(ROOT, file))) as Record<string, unknown>;
  return Object.entries(mod).filter((e): e is [string, (...args: unknown[]) => Promise<unknown>] => typeof e[1] === "function");
}

describe("centinela: Server Actions protegidas, sin sesión", () => {
  it("encuentra los archivos de acciones (incluidos los que no se llaman acciones.ts)", () => {
    expect(PROTECTED_ACTION_FILES.length).toBeGreaterThanOrEqual(11);
    expect(PROTECTED_ACTION_FILES).toContain("app/(protegido)/actions.ts");
    expect(PROTECTED_ACTION_FILES).toContain("app/(protegido)/personas/[id]/timeline-actions.ts");
  });

  for (const file of PROTECTED_ACTION_FILES) {
    it(`${file}: cada acción exportada rechaza sin sesión y no toca la base`, async () => {
      const actions = await exportedActions(file);
      expect(actions.length).toBeGreaterThan(0);
      for (const [name, action] of actions) {
        h.dbTouched = 0;
        // Argumentos vacíos a propósito: la autorización debe ocurrir ANTES de leer cualquier entrada.
        const outcome = await action(undefined, undefined, undefined, undefined, undefined, undefined).then(
          (value) => ({ kind: "returned" as const, value }),
          (error: unknown) => ({ kind: "threw" as const, error })
        );
        expect(outcome.kind, `${file} → ${name}() devolvió un resultado sin sesión: ${JSON.stringify((outcome as { value?: unknown }).value)}`).toBe("threw");
        const err = (outcome as { error: { digest?: string; message?: string } }).error;
        expect(String(err.digest ?? ""), `${file} → ${name}() falló, pero no por falta de sesión: ${err.message}`).toMatch(/^NEXT_REDIRECT/);
        expect(h.dbTouched, `${file} → ${name}() consultó la base antes de autorizar`).toBe(0);
        expect(h.revalidated, `${file} → ${name}() revalidó caché sin sesión`).toBe(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Rutas (route handlers): cada una está CLASIFICADA. Una ruta nueva sin clasificar rompe el test.
// ---------------------------------------------------------------------------------------------------------------------
/** Públicas a propósito; su seguridad se prueba en sus propios tests (token firmado, webhook firmado, rate limit). */
const PUBLIC_ROUTES: Record<string, string> = {
  "app/api/unsubscribe/[token]/route.ts": "baja de mailing: el token firmado del enlace es la credencial",
  "app/api/mailing/webhooks/resend/route.ts": "webhook de Resend: firma Svix",
  "app/reunion/checkin/[qrToken]/route.ts": "check-in público: el QR firmado es la credencial",
};

const ROUTE_FILES = walk(join(ROOT, "app"))
  .filter((p) => /[\\/]route\.ts$/.test(p))
  .map(rel)
  .sort();
const PROTECTED_ROUTES = ROUTE_FILES.filter((f) => !(f in PUBLIC_ROUTES));
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

describe("centinela: route handlers", () => {
  it("toda ruta está clasificada como pública (con motivo) o protegida; no quedan rutas públicas fantasma", () => {
    expect(ROUTE_FILES.length).toBeGreaterThanOrEqual(7);
    for (const publicRoute of Object.keys(PUBLIC_ROUTES)) expect(ROUTE_FILES, `ruta pública inexistente: ${publicRoute}`).toContain(publicRoute);
    expect(PROTECTED_ROUTES).toEqual(
      expect.arrayContaining([
        "app/api/reuniones/[id]/qr/route.ts",
        "app/api/reuniones/[id]/live/route.ts",
        "app/api/personas/export/route.ts",
        "app/api/formularios/[id]/export/route.ts",
      ])
    );
  });

  for (const file of PROTECTED_ROUTES) {
    it(`${file}: responde 401 sin sesión, para cada método que exporta, sin tocar la base`, async () => {
      const mod = (await import(/* @vite-ignore */ join(ROOT, file))) as Record<string, unknown>;
      const handlers = HTTP_METHODS.filter((m) => typeof mod[m] === "function");
      expect(handlers.length, `${file} no exporta ningún método HTTP`).toBeGreaterThan(0);
      for (const method of handlers) {
        h.dbTouched = 0;
        const request = new NextRequest("https://crm.test/api/x?q=Alfa", { method });
        const response = await (mod[method] as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(request, {
          params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }),
        });
        expect(response.status, `${file} ${method}`).toBe(401);
        expect(h.dbTouched, `${file} ${method} tocó la base antes de autenticar`).toBe(0);
      }
    });
  }
});
