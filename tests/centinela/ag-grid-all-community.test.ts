import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Decisión D16: si alguien recorta `AllCommunityModule` por una lista de
 * módulos puntuales, una prop sin su módulo registrado no truena en
 * producción — simplemente no hace nada. Este test fija la única forma de
 * registro permitida.
 */
describe("centinela: AG Grid registra AllCommunityModule completo", () => {
  it("components/grid/DataGrid.tsx registra AllCommunityModule, no una lista recortada", () => {
    const source = readFileSync("components/grid/DataGrid.tsx", "utf-8");
    expect(source).toMatch(/ModuleRegistry\.registerModules\(\[AllCommunityModule\]\)/);
  });
});
