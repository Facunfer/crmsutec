import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_QR_SECRET = "test-secret-not-for-prod-0123456789";

const { signRotatingQrToken, signStaticQrToken, verifyQrSignature, isQrWithinWindow, DEFAULT_ROTATION_SECONDS } = await import(
  "../../lib/attendance/qr.js"
);

let meetingId: string;

beforeAll(() => {
  meetingId = randomUUID();
});

describe("firma y verificación de QR de asistencia", () => {
  it("un token recién firmado (rotativo) verifica y está dentro de la ventana", () => {
    const { token } = signRotatingQrToken(meetingId, 1);
    const payload = verifyQrSignature(token);
    expect(payload).not.toBeNull();
    expect(payload?.m).toBe(meetingId);
    expect(payload?.v).toBe(1);
    expect(isQrWithinWindow(payload!)).toBe(true);
  });

  it("una firma manipulada se rechaza", () => {
    const { token } = signRotatingQrToken(meetingId, 1);
    const [payloadB64] = token.split(".");
    const tampered = `${payloadB64}.firma-invalida-cualquier-cosa`;
    expect(verifyQrSignature(tampered)).toBeNull();
  });

  it("un payload manipulado (cambiando la versión) invalida la firma", () => {
    const { token } = signRotatingQrToken(meetingId, 1);
    const [payloadB64, sig] = token.split(".");
    const original = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf-8"));
    const tamperedPayload = Buffer.from(JSON.stringify({ ...original, v: 2 })).toString("base64url");
    expect(verifyQrSignature(`${tamperedPayload}.${sig}`)).toBeNull();
  });

  it("un token firmado con una versión vieja verifica su propia firma, pero eso no basta: quien llama debe comparar contra la versión vigente", () => {
    const { token } = signRotatingQrToken(meetingId, 5);
    const payload = verifyQrSignature(token);
    expect(payload).not.toBeNull();
    expect(payload?.v).toBe(5); // se auto-verifica; la vigencia real la valida checkin.ts contra la DB
  });

  it("tolera la ventana rotativa anterior, pero no dos ventanas atrás", () => {
    const now = Date.now();
    const windowIndex = Math.floor(now / 1000 / DEFAULT_ROTATION_SECONDS);
    const previousWindowPayload = { m: meetingId, v: 1, mode: "rotating" as const, w: windowIndex - 1 };
    const twoWindowsAgoPayload = { m: meetingId, v: 1, mode: "rotating" as const, w: windowIndex - 2 };
    expect(isQrWithinWindow(previousWindowPayload)).toBe(true);
    expect(isQrWithinWindow(twoWindowsAgoPayload)).toBe(false);
  });

  it("un QR estático es válido dentro de su rango y expira fuera de él", () => {
    const now = new Date();
    const from = new Date(now.getTime() - 60_000);
    const to = new Date(now.getTime() + 60_000);
    const token = signStaticQrToken(meetingId, 1, from, to);
    const payload = verifyQrSignature(token);
    expect(payload).not.toBeNull();
    expect(isQrWithinWindow(payload!)).toBe(true);

    const expiredFrom = new Date(now.getTime() - 120_000);
    const expiredTo = new Date(now.getTime() - 60_000);
    const expiredToken = signStaticQrToken(meetingId, 1, expiredFrom, expiredTo);
    const expiredPayload = verifyQrSignature(expiredToken);
    expect(isQrWithinWindow(expiredPayload!)).toBe(false);
  });

  it("una basura cualquiera no verifica", () => {
    expect(verifyQrSignature("no-es-un-token")).toBeNull();
    expect(verifyQrSignature("")).toBeNull();
  });
});
