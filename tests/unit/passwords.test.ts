import { describe, expect, it } from "vitest";
import {
  hashPassword,
  looksLikeBcryptHash,
  validatePasswordStrength,
  verifyPassword,
} from "../../lib/auth/passwords.js";

describe("contraseñas (D4: sin compatibilidad con texto plano)", () => {
  it("hashea y verifica correctamente", async () => {
    const hash = await hashPassword("una-contraseña-larga-123");
    expect(looksLikeBcryptHash(hash)).toBe(true);
    await expect(verifyPassword("una-contraseña-larga-123", hash)).resolves.toBe(true);
    await expect(verifyPassword("otra-cosa", hash)).resolves.toBe(false);
  });

  it("looksLikeBcryptHash rechaza texto plano", () => {
    expect(looksLikeBcryptHash("contraseña123")).toBe(false);
  });

  it("validatePasswordStrength exige un mínimo de longitud", () => {
    expect(validatePasswordStrength("corta")).not.toBeNull();
    expect(validatePasswordStrength("una-contraseña-suficientemente-larga")).toBeNull();
  });
});
