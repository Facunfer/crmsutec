import { describe, expect, it } from "vitest";
import { applyMasking, maskDni, maskEmail, maskPhone } from "../../lib/people/masking.js";

describe("enmascarado de datos sensibles (sección 9 del prompt)", () => {
  it("enmascara DNI dejando los extremos", () => {
    expect(maskDni("30111222")).toBe("30****22");
  });
  it("enmascara email preservando dominio", () => {
    expect(maskEmail("persona@ejemplo.com")).toBe("p*****a@ejemplo.com");
  });
  it("enmascara teléfono dejando los últimos 4", () => {
    expect(maskPhone("+5491112345678")).toBe("**********5678");
  });
  it("applyMasking no toca nada si el usuario tiene people.view_sensitive", () => {
    const row = { dni: "30111222", email: "a@b.com", phone: "+5491112345678" };
    expect(applyMasking(row, true)).toEqual(row);
  });
  it("applyMasking enmascara los tres campos si no tiene el permiso", () => {
    const row = { dni: "30111222", email: "a@b.com", phone: "+5491112345678" };
    const masked = applyMasking(row, false);
    expect(masked.dni).not.toBe(row.dni);
    expect(masked.email).not.toBe(row.email);
    expect(masked.phone).not.toBe(row.phone);
  });
});
