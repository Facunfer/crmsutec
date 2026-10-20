import { describe, expect, it } from "vitest";
import { assertQrConfigAtBoot, getQrRootSecret, isQrDisabled, QR_SECRET_MIN_LENGTH, QrConfigError, qrConfigStatus } from "../../lib/attendance/qr-config.js";

const GOOD = "s".repeat(QR_SECRET_MIN_LENGTH);

describe("qr-config (S7): el secreto de los QR es obligatorio cuando el QR está habilitado", () => {
  it("producción + QR habilitado + sin secreto => no arranca, y el mensaje no trae ningún secreto", () => {
    expect(() => assertQrConfigAtBoot({ SUTECBA_ENV: "production" })).toThrow(QrConfigError);
    expect(() => assertQrConfigAtBoot({ SUTECBA_ENV: "production", SUTECBA_QR_SECRET: "" })).toThrow(/falta SUTECBA_QR_SECRET/);
  });

  it("producción + secreto corto => no arranca, sin imprimir el valor", () => {
    const secret = "demasiado-corto-123";
    let message = "";
    try {
      assertQrConfigAtBoot({ SUTECBA_ENV: "production", SUTECBA_QR_SECRET: secret });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/menos de 32 caracteres/);
    expect(message).not.toContain(secret);
  });

  it("producción + secreto válido => arranca", () => {
    expect(() => assertQrConfigAtBoot({ SUTECBA_ENV: "production", SUTECBA_QR_SECRET: GOOD })).not.toThrow();
  });

  it("producción con el QR deshabilitado explícitamente => arranca sin secreto", () => {
    expect(() => assertQrConfigAtBoot({ SUTECBA_ENV: "production", SUTECBA_QR_DISABLED: "true" })).not.toThrow();
  });

  it("el opt-out es literal: «1», «TRUE» o vacío NO apagan el QR", () => {
    for (const value of ["1", "TRUE", "yes", ""]) {
      expect(isQrDisabled({ SUTECBA_QR_DISABLED: value })).toBe(false);
      expect(() => assertQrConfigAtBoot({ SUTECBA_ENV: "production", SUTECBA_QR_DISABLED: value })).toThrow(QrConfigError);
    }
  });

  it("fuera de producción el arranque no se bloquea (desarrollo, pruebas, staging sin QR)", () => {
    for (const env of ["local", "test", "staging", undefined]) {
      expect(() => assertQrConfigAtBoot({ SUTECBA_ENV: env })).not.toThrow();
    }
  });

  it("al USAR el secreto falla cerrado en cualquier entorno: nunca firma con un valor por defecto", () => {
    expect(() => getQrRootSecret({})).toThrow(QrConfigError);
    expect(() => getQrRootSecret({ SUTECBA_QR_SECRET: "corto" })).toThrow(QrConfigError);
    expect(() => getQrRootSecret({ SUTECBA_ENV: "local" })).toThrow(QrConfigError);
    expect(getQrRootSecret({ SUTECBA_QR_SECRET: GOOD })).toBe(GOOD);
  });

  it("con el QR deshabilitado tampoco se firma, aunque haya secreto", () => {
    expect(() => getQrRootSecret({ SUTECBA_QR_DISABLED: "true", SUTECBA_QR_SECRET: GOOD })).toThrow(/deshabilitada/);
    expect(qrConfigStatus({ SUTECBA_QR_DISABLED: "true" })).toEqual({ state: "disabled" });
  });
});
