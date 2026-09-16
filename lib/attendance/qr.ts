import { createHmac, timingSafeEqual } from "node:crypto";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/attendance/qr.ts");

/**
 * QR de asistencia (sección 12.1 del prompt): token = firma HMAC sobre un
 * identificador no predecible de la reunión + ventana temporal + modo +
 * versión de clave. Nada de IDs internos legibles sueltos en la URL: todo
 * va empaquetado en un único blob firmado.
 */

function getRootSecret(): string {
  const secret = process.env.SUTECBA_QR_SECRET;
  if (!secret) {
    throw new Error(
      "Falta SUTECBA_QR_SECRET en el entorno. Generar con: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\""
    );
  }
  return secret;
}

/**
 * El secreto real de cada reunión se deriva de SUTECBA_QR_SECRET + su id +
 * su `qr_secret_version` — así "regenerar el secreto" es solo incrementar
 * un entero en `meetings`, sin necesitar guardar un secreto nuevo aparte.
 */
function deriveMeetingSecret(meetingId: string, version: number): Buffer {
  return createHmac("sha256", getRootSecret()).update(`${meetingId}:${version}`).digest();
}

export type QrMode = "static" | "rotating";

export interface QrPayload {
  m: string; // meeting id
  v: number; // qr_secret_version con el que se firmó
  mode: QrMode;
  w?: number; // índice de ventana, solo rotativo
  iat?: number; // epoch segundos, solo estático
  exp?: number; // epoch segundos, solo estático
}

function signPayload(payload: QrPayload): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const secret = deriveMeetingSecret(payload.m, payload.v);
  const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

export const DEFAULT_ROTATION_SECONDS = 45;

function currentWindowIndex(rotationSeconds: number): number {
  return Math.floor(Date.now() / 1000 / rotationSeconds);
}

export function signRotatingQrToken(
  meetingId: string,
  version: number,
  rotationSeconds = DEFAULT_ROTATION_SECONDS
): { token: string; expiresAt: Date } {
  const window = currentWindowIndex(rotationSeconds);
  const token = signPayload({ m: meetingId, v: version, mode: "rotating", w: window });
  const windowEndsAt = (window + 1) * rotationSeconds * 1000;
  return { token, expiresAt: new Date(windowEndsAt) };
}

export function signStaticQrToken(meetingId: string, version: number, validFrom: Date, validTo: Date): string {
  return signPayload({
    m: meetingId,
    v: version,
    mode: "static",
    iat: Math.floor(validFrom.getTime() / 1000),
    exp: Math.floor(validTo.getTime() / 1000),
  });
}

/**
 * Solo valida la firma (que el token fue emitido por alguien con el
 * secreto correcto para ese meetingId+versión) — NO valida si esa versión
 * sigue siendo la vigente en la base. Eso lo hace quien llama, comparando
 * contra `meetings.qr_secret_version` (si no, "regenerar" no invalidaría
 * nada: el token se auto-verificaría siempre contra su propia versión).
 */
export function verifyQrSignature(token: string): QrPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  let payload: QrPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.m !== "string" || typeof payload.v !== "number") return null;
  if (payload.mode !== "static" && payload.mode !== "rotating") return null;

  const secret = deriveMeetingSecret(payload.m, payload.v);
  const expectedSig = createHmac("sha256", secret).update(payloadB64).digest("base64url");

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  return payload;
}

export function isQrWithinWindow(payload: QrPayload, rotationSeconds = DEFAULT_ROTATION_SECONDS): boolean {
  if (payload.mode === "rotating") {
    if (typeof payload.w !== "number") return false;
    const current = currentWindowIndex(rotationSeconds);
    // Tolera la ventana anterior (sección 12.1): un QR que acaba de rotar
    // en la pantalla del organizador todavía sirve un instante más.
    return payload.w === current || payload.w === current - 1;
  }
  if (payload.mode === "static") {
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return false;
    const now = Math.floor(Date.now() / 1000);
    return now >= payload.iat && now <= payload.exp;
  }
  return false;
}
