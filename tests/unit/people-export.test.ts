import { describe, expect, it } from "vitest";
import { sanitizeCsvCell } from "../../lib/people/export.js";

describe("protección CSV/formula injection (sección 9 del prompt)", () => {
  it("antepone comilla a celdas que empiezan con =, +, - o @", () => {
    expect(sanitizeCsvCell("=SUM(A1)")).toBe('"\'=SUM(A1)"');
    expect(sanitizeCsvCell("+1234")).toBe('"\'+1234"');
    expect(sanitizeCsvCell("-1234")).toBe('"\'-1234"');
    expect(sanitizeCsvCell("@mention")).toBe('"\'@mention"');
  });

  it("deja intacto un valor normal, solo entre comillas", () => {
    expect(sanitizeCsvCell("Juan Pérez")).toBe('"Juan Pérez"');
  });

  it("escapa comillas internas", () => {
    expect(sanitizeCsvCell('Che "Toto"')).toBe('"Che ""Toto"""');
  });
});
