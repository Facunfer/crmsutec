import { describe, expect, it } from "vitest";
import { IdentityDecisionsError, parseIdentityDecisions, IDENTITY_DECISION_VALUES } from "../../lib/imports/gabriel/identity-decisions.js";
import { blockedDnis, planFromSources } from "../../lib/imports/gabriel/plan-hash.js";
import { cuilFor, f07File, f09File } from "../helpers/gabriel-fixtures.js";

const BLOCKED = ["30000001", "30000002", "30000003"];
const row = (dni: string, decision: string, extra: Record<string, unknown> = {}) => ({ dni, decision, canonical_first_name: null, canonical_last_name: null, notes: null, ...extra });
const problemsOf = (rows: any[], blocked = BLOCKED) => {
  try {
    parseIdentityDecisions(rows, blocked);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(IdentityDecisionsError);
    return (e as IdentityDecisionsError).problems;
  }
};

describe("lector de decisiones humanas de identidades bloqueadas", () => {
  it("acepta exclusivamente los cuatro valores permitidos", () => {
    expect([...IDENTITY_DECISION_VALUES]).toEqual(["MERGE_SAME_PERSON", "KEEP_BLOCKED", "SOURCE_ERROR", "REVIEW_LATER"]);
    const ok = parseIdentityDecisions(
      [row("30000003", "REVIEW_LATER"), row("30000001", "MERGE_SAME_PERSON", { canonical_first_name: "María José", canonical_last_name: "O'Brien-García" }), row("30000002", "KEEP_BLOCKED", { notes: "verificar con el afiliado" })],
      BLOCKED
    );
    expect(ok.map((d) => [d.dni, d.decision])).toEqual([["30000001", "MERGE_SAME_PERSON"], ["30000002", "KEEP_BLOCKED"], ["30000003", "REVIEW_LATER"]]);
    expect(ok[0]).toMatchObject({ canonicalFirstName: "María José", canonicalLastName: "O'Brien-García" });
    expect(ok[1]).toMatchObject({ canonicalFirstName: null, notes: "verificar con el afiliado" });
  });

  it("un valor inválido (otra ortografía, minúsculas, valor inventado) aborta", () => {
    for (const bad of ["merge_same_person", "MERGE", "Keep_Blocked", "APROBAR", "SI", "source error"]) {
      expect(problemsOf([row("30000001", bad), row("30000002", "KEEP_BLOCKED"), row("30000003", "KEEP_BLOCKED")]).join(" ")).toMatch(/decisión inválida/);
    }
  });

  it("MERGE_SAME_PERSON exige first_name y last_name canónicos válidos", () => {
    const others = [row("30000002", "KEEP_BLOCKED"), row("30000003", "KEEP_BLOCKED")];
    expect(problemsOf([row("30000001", "MERGE_SAME_PERSON"), ...others]).join(" ")).toMatch(/exige canonical_first_name y canonical_last_name/);
    expect(problemsOf([row("30000001", "MERGE_SAME_PERSON", { canonical_first_name: "Ana" }), ...others]).join(" ")).toMatch(/exige/);
    expect(problemsOf([row("30000001", "MERGE_SAME_PERSON", { canonical_first_name: "  ", canonical_last_name: "Paz" }), ...others]).join(" ")).toMatch(/exige/);
    expect(problemsOf([row("30000001", "MERGE_SAME_PERSON", { canonical_first_name: "An4", canonical_last_name: "Paz" }), ...others]).join(" ")).toMatch(/no es válido/);
    expect(problemsOf([row("30000001", "MERGE_SAME_PERSON", { canonical_first_name: "A", canonical_last_name: "Paz" }), ...others]).join(" ")).toMatch(/no es válido/);
  });

  it("nombre canónico con una decisión que no es MERGE_SAME_PERSON es inconsistente", () => {
    for (const d of ["KEEP_BLOCKED", "SOURCE_ERROR", "REVIEW_LATER"]) {
      expect(problemsOf([row("30000001", d, { canonical_first_name: "Ana", canonical_last_name: "Paz" }), row("30000002", "KEEP_BLOCKED"), row("30000003", "KEEP_BLOCKED")]).join(" ")).toMatch(/no admite nombre\/apellido canónico/);
    }
  });

  it("exige una decisión por CADA identidad bloqueada y ninguna para las que no lo están; sin duplicados", () => {
    expect(problemsOf([row("30000001", "KEEP_BLOCKED"), row("30000002", "KEEP_BLOCKED")]).join(" ")).toMatch(/\*\*\*003: identidad bloqueada sin decisión/);
    expect(problemsOf([row("30000001", "KEEP_BLOCKED"), row("30000002", ""), row("30000003", "KEEP_BLOCKED")]).join(" ")).toMatch(/falta la decisión/);
    expect(problemsOf([row("30000001", "KEEP_BLOCKED"), row("30000002", "KEEP_BLOCKED"), row("30000003", "KEEP_BLOCKED"), row("39999999", "KEEP_BLOCKED")]).join(" ")).toMatch(/no es una identidad bloqueada/);
    expect(problemsOf([row("30000001", "KEEP_BLOCKED"), row("30000001", "SOURCE_ERROR"), row("30000002", "KEEP_BLOCKED"), row("30000003", "KEEP_BLOCKED")]).join(" ")).toMatch(/repetido/);
    expect(problemsOf([row("123", "KEEP_BLOCKED"), row("30000001", "KEEP_BLOCKED"), row("30000002", "KEEP_BLOCKED"), row("30000003", "KEEP_BLOCKED")]).join(" ")).toMatch(/DNI inválido/);
  });

  it("los mensajes de error no exponen el DNI completo", () => {
    const text = problemsOf([row("30000001", "INVENTADA"), row("30000002", "KEEP_BLOCKED")]).join(" ");
    expect(text).not.toContain("30000001");
    expect(text).not.toContain("30000003");
    expect(text).toContain("***001");
  });

  it("un archivo completo y válido pasa; el resultado no depende del orden de las filas", () => {
    const a = parseIdentityDecisions([row("30000002", "SOURCE_ERROR"), row("30000001", "KEEP_BLOCKED"), row("30000003", "REVIEW_LATER")], BLOCKED);
    const b = parseIdentityDecisions([row("30000003", "REVIEW_LATER"), row("30000001", "KEEP_BLOCKED"), row("30000002", "SOURCE_ERROR")], BLOCKED);
    expect(a).toEqual(b);
  });
});

describe("las decisiones humanas forman parte del JSON canónico (plan_hash)", () => {
  // Dos identidades bloqueadas: mismo DNI con nombres incompatibles entre F09 y F07.
  const mk = () => [
    f09File([{ last: "Vega", first: "Elena", dni: "31000001", email: "e@example.com" }, { last: "Paz", first: "Ana", dni: "31000002", email: "a@example.com" }]),
    f07File([{ last: "Otro", first: "Nombre", cuil: cuilFor("31000001") }, { last: "Distinto", first: "Persona", cuil: cuilFor("31000002") }]),
  ];
  const files = mk();

  it("sin decisiones el hash es el de siempre; con decisiones cambia, y cambia con cada decisión", () => {
    const base = planFromSources(files);
    expect(blockedDnis(base.plan)).toEqual(["31000001", "31000002"]);
    expect(planFromSources(files).planHash).toBe(base.planHash);

    const keep = planFromSources(files, { identityDecisionRows: [row("31000001", "KEEP_BLOCKED"), row("31000002", "KEEP_BLOCKED")] });
    expect(keep.planHash).not.toBe(base.planHash);
    const other = planFromSources(files, { identityDecisionRows: [row("31000001", "SOURCE_ERROR"), row("31000002", "KEEP_BLOCKED")] });
    expect(other.planHash).not.toBe(keep.planHash);
    const merge = planFromSources(files, { identityDecisionRows: [row("31000001", "MERGE_SAME_PERSON", { canonical_first_name: "Elena", canonical_last_name: "Vega" }), row("31000002", "KEEP_BLOCKED")] });
    const mergeOther = planFromSources(files, { identityDecisionRows: [row("31000001", "MERGE_SAME_PERSON", { canonical_first_name: "Elena", canonical_last_name: "Vegas" }), row("31000002", "KEEP_BLOCKED")] });
    expect(merge.planHash).not.toBe(mergeOther.planHash);
    // Las notas son texto libre: no cambian el plan.
    const withNotes = planFromSources(files, { identityDecisionRows: [row("31000001", "KEEP_BLOCKED", { notes: "hola" }), row("31000002", "KEEP_BLOCKED")] });
    expect(withNotes.planHash).toBe(keep.planHash);
  });

  it("decisiones inválidas o que no coinciden con las bloqueadas de ESTE plan abortan el plan", () => {
    expect(() => planFromSources(files, { identityDecisionRows: [row("31000001", "KEEP_BLOCKED")] })).toThrow(IdentityDecisionsError); // falta una
    expect(() => planFromSources(files, { identityDecisionRows: [row("31000001", "KEEP_BLOCKED"), row("31000002", "QUIZAS")] })).toThrow(IdentityDecisionsError);
    expect(() => planFromSources(files, { identityDecisionRows: [row("31000001", "KEEP_BLOCKED"), row("31000002", "KEEP_BLOCKED"), row("39999999", "KEEP_BLOCKED")] })).toThrow(/no es una identidad bloqueada/);
  });

  it("el plan consume las decisiones: MERGE crea una persona con el nombre canónico; KEEP_BLOCKED sigue bloqueada", () => {
    const withDecisions = planFromSources(files, { identityDecisionRows: [row("31000001", "MERGE_SAME_PERSON", { canonical_first_name: "Elena", canonical_last_name: "Vega" }), row("31000002", "KEEP_BLOCKED")] });
    expect(withDecisions.plan.people.blocked).toHaveLength(1);
    expect(withDecisions.plan.people.toCreate).toHaveLength(1);
    expect(withDecisions.plan.people.toCreate[0]).toMatchObject({ dni: "31000001", firstName: "Elena", lastName: "Vega" });
  });

  it("los reportes técnicos con decisiones no contienen DNI ni variantes de nombre", async () => {
    const { summarizeDecisions, toSafeReport } = await import("../../scripts/import-gabriel.js");
    const result = planFromSources(files, { identityDecisionRows: [row("31000001", "MERGE_SAME_PERSON", { canonical_first_name: "Elena", canonical_last_name: "Vega" }), row("31000002", "KEEP_BLOCKED")] });
    const report = JSON.stringify([toSafeReport(result.plan, result.planHash), summarizeDecisions(result.plan, result.decisions!, { fileName: "decisiones.json", sha256: "a".repeat(64) })]);
    for (const value of ["31000001", "31000002", "Elena", "Vega", "Distinto", "e@example.com"]) expect(report).not.toContain(value);
  });
});
