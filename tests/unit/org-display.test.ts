import { describe, expect, it } from "vitest";
import { buildDisplayNames, normalizeOrgName } from "../../lib/organizations/display.js";

const row = (id: string, name: string, code: string | null) => ({ id, name, official_code: code });

describe("presentación de nombres de unidades: «Nombre (CÓDIGO)» solo si el nombre no es único", () => {
  it("normaliza tildes, mayúsculas y puntuación", () => {
    expect(normalizeOrgName("Dirección General Técnica, Administrativa y Legal")).toBe(normalizeOrgName("DIRECCION GENERAL TECNICA ADMINISTRATIVA Y LEGAL"));
  });

  it("los homónimos (aunque difieran en coma o tilde) muestran el código; los únicos no", () => {
    const names = buildDisplayNames([
      row("1", "Dirección General Técnica Administrativa y Legal", "DGTALMHF"),
      row("2", "Dirección General Técnica Administrativa y Legal", "DGTALMC"),
      row("3", "Dirección General Técnica, Administrativa y Legal", "DGTALPG"),
      row("4", "Ente Autárquico Teatro Colón", "EATC"),
    ]);
    expect(names.get("1")).toBe("Dirección General Técnica Administrativa y Legal (DGTALMHF)");
    expect(names.get("2")).toBe("Dirección General Técnica Administrativa y Legal (DGTALMC)");
    expect(names.get("3")).toBe("Dirección General Técnica, Administrativa y Legal (DGTALPG)");
    expect(names.get("4")).toBe("Ente Autárquico Teatro Colón");
  });

  it("un código técnico de respaldo («slug:…») o ausente no se muestra", () => {
    const names = buildDisplayNames([row("1", "Unidad de Asesores", "slug:unidad-de-asesores"), row("2", "Unidad de Asesores", null), row("3", "Otra", "OTR")]);
    expect(names.get("1")).toBe("Unidad de Asesores");
    expect(names.get("2")).toBe("Unidad de Asesores");
    expect(names.get("3")).toBe("Otra");
  });
});
