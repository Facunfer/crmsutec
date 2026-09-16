import { describe, expect, it } from "vitest";

const { FIELD_TYPES, parseFieldOptions, isCorePersonMapping } = await import("../../lib/forms/field-types.js");

describe("catálogo de tipos de campo: validación", () => {
  it("un campo de texto obligatorio rechaza vacío y acepta cualquier texto", () => {
    const schema = FIELD_TYPES.text.buildSchema({ required: true, options: {} });
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse("Hola").success).toBe(true);
  });

  it("un campo de texto opcional acepta vacío", () => {
    const schema = FIELD_TYPES.text.buildSchema({ required: false, options: {} });
    expect(schema.safeParse("").success).toBe(true);
  });

  it("DNI obligatorio rechaza un valor con letras y acepta uno válido", () => {
    const schema = FIELD_TYPES.dni.buildSchema({ required: true, options: {} });
    expect(schema.safeParse("abc").success).toBe(false);
    expect(schema.safeParse("30111222").success).toBe(true);
  });

  it("email obligatorio rechaza algo sin arroba", () => {
    const schema = FIELD_TYPES.email.buildSchema({ required: true, options: {} });
    expect(schema.safeParse("no-es-email").success).toBe(false);
    expect(schema.safeParse("a@b.com").success).toBe(true);
  });

  it("número obligatorio: una cadena vacía NO puede colar como 0 (mismo caso que declaredAge)", () => {
    const schema = FIELD_TYPES.number.buildSchema({ required: true, options: {} });
    const result = schema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("número opcional: vacío se acepta y se transforma a null", () => {
    const schema = FIELD_TYPES.number.buildSchema({ required: false, options: {} });
    const result = schema.safeParse("");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBeNull();
  });

  it("select solo acepta valores de la lista de opciones declarada", () => {
    const schema = FIELD_TYPES.select.buildSchema({ required: true, options: { choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } });
    expect(schema.safeParse("a").success).toBe(true);
    expect(schema.safeParse("c").success).toBe(false);
  });

  it("checkbox (multi) obligatorio exige al menos una opción marcada", () => {
    const schema = FIELD_TYPES.checkbox.buildSchema({ required: true, options: { choices: [{ value: "a", label: "A" }] } });
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse(["a"]).success).toBe(true);
  });

  it("fecha exige formato YYYY-MM-DD", () => {
    const schema = FIELD_TYPES.date.buildSchema({ required: true, options: {} });
    expect(schema.safeParse("2026-01-15").success).toBe(true);
    expect(schema.safeParse("15/01/2026").success).toBe(false);
  });
});

describe("parseFieldOptions", () => {
  it("ignora entradas sin forma de opción y filtra valores vacíos", () => {
    const parsed = parseFieldOptions({ choices: [{ value: "a", label: "A" }, { value: "", label: "vacío" }, "no-es-objeto"] });
    expect(parsed.choices).toEqual([{ value: "a", label: "A" }]);
  });

  it("con algo que no es un objeto de opciones, devuelve vacío", () => {
    expect(parseFieldOptions(null)).toEqual({});
    expect(parseFieldOptions("cualquier cosa")).toEqual({});
  });
});

describe("isCorePersonMapping", () => {
  it("distingue mapeos a columnas núcleo de mapeos a campos personalizados", () => {
    expect(isCorePersonMapping("first_name")).toBe(true);
    expect(isCorePersonMapping("dni")).toBe(true);
    expect(isCorePersonMapping("talle_ropa")).toBe(false);
  });
});
