import { describe, expect, it } from "vitest";
import { BirthDateDecisionsError, parseBirthDateDecisions } from "../../lib/people/birth-date-decisions.js";

// DNI sintéticos (sin relación con personas reales): mismo patrón usado en tests/helpers/gabriel-fixtures.ts.
const DNI_A = "90000001";
const DNI_B = "90000002";

describe("parseBirthDateDecisions", () => {
  it("acepta SOURCE_CONFIRMS_CORRECTION con fecha_candidata plausible", () => {
    const rows = [
      { dni: DNI_A, birth_date_actual_supabase: "2073-04-18", fecha_candidata: "1973-04-18", decision: "SOURCE_CONFIRMS_CORRECTION", notas: "edad+timestamp coinciden" },
      { dni: DNI_B, birth_date_actual_supabase: "2026-10-10", fecha_candidata: "", decision: "INVALID_SOURCE", notas: "" },
    ];
    const out = parseBirthDateDecisions(rows);
    expect(out).toHaveLength(2);
    expect(out.find((d) => d.dni === DNI_A)).toMatchObject({ decision: "SOURCE_CONFIRMS_CORRECTION", candidateBirthDate: "1973-04-18" });
    expect(out.find((d) => d.dni === DNI_B)).toMatchObject({ decision: "INVALID_SOURCE", candidateBirthDate: null });
  });

  it("exige fecha_candidata para SOURCE_CONFIRMS_CORRECTION", () => {
    const rows = [{ dni: DNI_A, birth_date_actual_supabase: "2073-04-18", fecha_candidata: "", decision: "SOURCE_CONFIRMS_CORRECTION" }];
    expect(() => parseBirthDateDecisions(rows)).toThrow(BirthDateDecisionsError);
  });

  it("rechaza fecha_candidata implausible (nunca reinterpreta un año de 2 dígitos)", () => {
    const rows = [{ dni: DNI_A, birth_date_actual_supabase: "2073-04-18", fecha_candidata: "0073-04-18", decision: "SOURCE_CONFIRMS_CORRECTION" }];
    expect(() => parseBirthDateDecisions(rows)).toThrow(BirthDateDecisionsError);
  });

  it("rechaza fecha_candidata en decisiones que no la admiten", () => {
    const rows = [{ dni: DNI_A, birth_date_actual_supabase: "2073-04-18", fecha_candidata: "1973-04-18", decision: "AMBIGUOUS_SOURCE" }];
    expect(() => parseBirthDateDecisions(rows)).toThrow(BirthDateDecisionsError);
  });

  it("exige birth_date_actual_supabase (control de concurrencia)", () => {
    const rows = [{ dni: DNI_A, birth_date_actual_supabase: "", fecha_candidata: "1973-04-18", decision: "SOURCE_CONFIRMS_CORRECTION" }];
    expect(() => parseBirthDateDecisions(rows)).toThrow(BirthDateDecisionsError);
  });

  it("rechaza decisión desconocida o DNI inválido", () => {
    expect(() => parseBirthDateDecisions([{ dni: DNI_A, birth_date_actual_supabase: "2073-04-18", fecha_candidata: "", decision: "GUESS" }])).toThrow(BirthDateDecisionsError);
    expect(() => parseBirthDateDecisions([{ dni: "abc", birth_date_actual_supabase: "2073-04-18", fecha_candidata: "", decision: "REVIEW_LATER" }])).toThrow(BirthDateDecisionsError);
  });

  it("acepta AMBIGUOUS_SOURCE y REVIEW_LATER sin fecha_candidata", () => {
    const rows = [
      { dni: DNI_A, birth_date_actual_supabase: "2073-04-18", fecha_candidata: "", decision: "AMBIGUOUS_SOURCE" },
      { dni: DNI_B, birth_date_actual_supabase: "2026-10-10", fecha_candidata: "", decision: "REVIEW_LATER" },
    ];
    const out = parseBirthDateDecisions(rows);
    expect(out.map((d) => d.decision).sort()).toEqual(["AMBIGUOUS_SOURCE", "REVIEW_LATER"]);
  });

  it("rechaza DNI repetido dentro del mismo archivo", () => {
    const repeated = [
      { dni: DNI_A, birth_date_actual_supabase: "2073-04-18", fecha_candidata: "1973-04-18", decision: "SOURCE_CONFIRMS_CORRECTION" },
      { dni: DNI_A, birth_date_actual_supabase: "2073-04-18", fecha_candidata: "1973-04-18", decision: "SOURCE_CONFIRMS_CORRECTION" },
    ];
    expect(() => parseBirthDateDecisions(repeated)).toThrow(BirthDateDecisionsError);
  });

  it("es repetible: el mismo archivo se puede volver a parsear sin que cambie nada externo (no exige cobertura contra un estado vivo)", () => {
    const rows = [{ dni: DNI_A, birth_date_actual_supabase: "1973-04-18", fecha_candidata: "", decision: "INVALID_SOURCE" }];
    expect(parseBirthDateDecisions(rows)).toHaveLength(1);
    expect(parseBirthDateDecisions(rows)).toHaveLength(1); // segunda vez, mismo resultado
  });
});
