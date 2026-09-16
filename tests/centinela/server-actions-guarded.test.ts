import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Sección 15.3: "toda página protegida y toda acción/endpoint llaman al
 * guard correspondiente". La Etapa 0 detectó que en el CRM de referencia
 * esto se auditaba a mano con un `grep` en un runbook (riesgo #5) — acá se
 * automatiza como test que falla el build si alguien agrega una acción sin
 * revalidar la sesión.
 *
 * Convención: los archivos `acciones.ts` dentro de app/(protegido)/** solo
 * exponen Server Actions que mutan o leen datos privados; cada función
 * exportada debe llamar a requireUser()/requirePermission() antes de hacer
 * cualquier otra cosa.
 */

function findAccionesFiles(root: string): string[] {
  const entries = readdirSync(root, { recursive: true }) as string[];
  return entries
    .filter((entry) => entry.endsWith("acciones.ts"))
    .map((entry) => join(root, entry));
}

const PROTECTED_ACTION_FILES = findAccionesFiles(join(process.cwd(), "app", "(protegido)")).map(
  (absolute) => absolute.replace(process.cwd() + "\\", "").replace(process.cwd() + "/", "")
);

function splitExportedFunctions(source: string): string[] {
  const marker = "export async function ";
  const chunks: string[] = [];
  let index = source.indexOf(marker);
  while (index !== -1) {
    const next = source.indexOf(marker, index + marker.length);
    chunks.push(source.slice(index, next === -1 ? undefined : next));
    index = next;
  }
  return chunks;
}

describe("centinela: Server Actions protegidas revalidan sesión", () => {
  it("encuentra al menos un archivo acciones.ts para revisar", () => {
    expect(PROTECTED_ACTION_FILES.length).toBeGreaterThan(0);
  });

  for (const relativePath of PROTECTED_ACTION_FILES) {
    it(`${relativePath}: cada función exportada llama a requireUser()`, () => {
      const source = readFileSync(join(process.cwd(), relativePath), "utf-8");
      const functions = splitExportedFunctions(source);
      expect(functions.length).toBeGreaterThan(0);

      for (const fn of functions) {
        const name = fn.slice("export async function ".length, fn.indexOf("("));
        expect(fn.includes("requireUser("), `${relativePath} → ${name}() no llama a requireUser()`).toBe(
          true
        );
      }
    });
  }
});
