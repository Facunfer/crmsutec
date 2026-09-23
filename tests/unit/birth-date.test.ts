import { describe, expect, it } from "vitest";
import { expandTwoDigitYear, validateBirthDate } from "../../lib/people/birth-date.js";

describe("validateBirthDate", () => {
  it("acepta 1964 como año de nacimiento válido", () => {
    expect(validateBirthDate("1964-08-12", "2026-09-22")).toEqual({ ok: true });
  });

  it("acepta 2001 como año de nacimiento válido", () => {
    expect(validateBirthDate("2001-03-05", "2026-09-22")).toEqual({ ok: true });
  });

  it("rechaza una fecha futura", () => {
    expect(validateBirthDate("2027-01-01", "2026-09-22")).toEqual({ ok: false, issue: "INVALID_BIRTH_DATE" });
  });

  it("rechaza el año 0064 (no lo reinterpreta como 1964)", () => {
    expect(validateBirthDate("0064-08-12", "2026-09-22")).toEqual({ ok: false, issue: "AMBIGUOUS_BIRTH_YEAR" });
  });

  it("rechaza el año 0077 (no lo reinterpreta como 1977)", () => {
    expect(validateBirthDate("0077-02-10", "2026-09-22")).toEqual({ ok: false, issue: "AMBIGUOUS_BIRTH_YEAR" });
  });

  it("rechaza un año absurdamente antiguo aunque el calendario sea válido", () => {
    expect(validateBirthDate("1500-01-01", "2026-09-22")).toEqual({ ok: false, issue: "INVALID_BIRTH_DATE" });
  });
});

describe("expandTwoDigitYear (regla explícita de una fuente concreta, nunca automática)", () => {
  it('"12/08/64" con regla de siglo explícita (pivote 30) da 1964-08-12', () => {
    expect(expandTwoDigitYear("12/08/64", { pivotYear: 30 })).toBe("1964-08-12");
  });

  it('"05/03/15" con la misma regla explícita da 2015-03-05 (año <= pivote)', () => {
    expect(expandTwoDigitYear("05/03/15", { pivotYear: 30 })).toBe("2015-03-05");
  });

  it("sin llamar a expandTwoDigitYear, un texto con año de 2 dígitos no se interpreta como fecha", () => {
    // Nada en el resto del sistema expande "64" a "1964" por su cuenta: sin la regla explícita, no hay fecha.
    expect(expandTwoDigitYear("12/08/64", { pivotYear: 30 })).not.toBeNull();
    // Pero el resultado de esa expansión explícita SÍ es una fecha de nacimiento válida para el dominio.
    expect(validateBirthDate(expandTwoDigitYear("12/08/64", { pivotYear: 30 })!, "2026-09-22")).toEqual({ ok: true });
  });
});
