import { describe, expect, it } from "vitest";
import { normalizeDni, normalizeEmail, normalizePhone } from "../../lib/people/normalize.js";

describe("normalizeDni", () => {
  it("acepta 7 u 8 dígitos y limpia puntos/espacios", () => {
    expect(normalizeDni("30.111.222")).toBe("30111222");
    expect(normalizeDni("3111222")).toBe("3111222");
  });
  it("rechaza longitudes fuera de rango", () => {
    expect(normalizeDni("123")).toBeNull();
    expect(normalizeDni("123456789")).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("normaliza a minúsculas y recorta espacios", () => {
    expect(normalizeEmail("  Persona@Ejemplo.COM ")).toBe("persona@ejemplo.com");
  });
  it("rechaza formatos inválidos", () => {
    expect(normalizeEmail("no-es-un-email")).toBeNull();
  });
});

describe("normalizePhone (D9: librería especializada AR)", () => {
  it("acepta un celular argentino con 0 y 15 y lo lleva a E.164", () => {
    const result = normalizePhone("011 15-1234-5678");
    expect(result).not.toBeNull();
    expect(result).toMatch(/^\+549/);
  });
  it("rechaza algo que no es un teléfono", () => {
    expect(normalizePhone("abc")).toBeNull();
  });
});
