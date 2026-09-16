import { createHmac, timingSafeEqual } from "node:crypto";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/attendance/session-tokens.ts");

/**
 * Dos tokens efímeros firmados con SUTECBA_QR_SECRET, sin estado en base
 * (no hacen falta filas para algo que dura minutos):
 * - Sesión de check-in: se emite al escanear el QR, ~10 min, atada a la
 *   reunión (sección 12.1: "para que la persona tenga tiempo de
 *   identificarse aunque el QR ya haya rotado").
 * - Confirmación pendiente: entre "identificate" y "confirmá que sos vos"
 *   (sección 12.2), para no confiar en un personId que mande el cliente
 *   sin haber pasado por la identificación.
 */

function getRootSecret(): string {
  const secret = process.env.SUTECBA_QR_SECRET;
  if (!secret) throw new Error("Falta SUTECBA_QR_SECRET en el entorno.");
  return secret;
}

function sign(payload: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", getRootSecret()).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

function verify<T>(token: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  if (!b64 || !sig) return null;

  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf-8"));
  } catch {
    return null;
  }

  const expectedSig = createHmac("sha256", getRootSecret()).update(b64).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  return payload;
}

const CHECKIN_SESSION_TTL_MS = 10 * 60_000;

export interface CheckinSessionPayload {
  m: string; // meetingId
  exp: number; // epoch ms
}

export function signCheckinSession(meetingId: string): string {
  return sign({ m: meetingId, exp: Date.now() + CHECKIN_SESSION_TTL_MS });
}

export function verifyCheckinSession(token: string): CheckinSessionPayload | null {
  const payload = verify<CheckinSessionPayload>(token);
  if (!payload || typeof payload.m !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp < Date.now()) return null;
  return payload;
}

const PENDING_CHECKIN_TTL_MS = 2 * 60_000;

export interface PendingCheckinPayload {
  m: string; // meetingId
  p: string; // personId
  exp: number;
}

export function signPendingCheckin(meetingId: string, personId: string): string {
  return sign({ m: meetingId, p: personId, exp: Date.now() + PENDING_CHECKIN_TTL_MS });
}

export function verifyPendingCheckin(token: string): PendingCheckinPayload | null {
  const payload = verify<PendingCheckinPayload>(token);
  if (!payload || typeof payload.m !== "string" || typeof payload.p !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  if (payload.exp < Date.now()) return null;
  return payload;
}
