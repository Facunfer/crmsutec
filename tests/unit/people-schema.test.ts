import { describe, expect, it } from "vitest";
import { personInputSchema } from "../../lib/people/schema.js";

describe("personInputSchema.declaredAge (bug real: '' se coerción a 0)", () => {
  it("una edad declarada vacía queda como '', no como 0", () => {
    const parsed = personInputSchema.parse({
      firstName: "Ana",
      lastName: "Test",
      dni: "",
      email: "",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "",
    });
    expect(parsed.declaredAge).toBe("");
  });

  it("una edad declarada de 0 sigue siendo un valor válido y distinto de ''", () => {
    const parsed = personInputSchema.parse({
      firstName: "Ana",
      lastName: "Test",
      dni: "",
      email: "",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "0",
    });
    expect(parsed.declaredAge).toBe(0);
  });

  it("una edad declarada normal se parsea como número", () => {
    const parsed = personInputSchema.parse({
      firstName: "Ana",
      lastName: "Test",
      dni: "",
      email: "",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "42",
    });
    expect(parsed.declaredAge).toBe(42);
  });
});
