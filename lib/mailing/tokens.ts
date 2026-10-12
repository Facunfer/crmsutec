import { createHmac, timingSafeEqual } from "node:crypto";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/mailing/tokens.ts");

/**
 * Token de baja: `<recipientId sin guiones, base64url>.<HMAC-SHA256 truncado>`. El id del destinatario es un UUID aleatorio (no
 * secuencial) y la firma impide fabricar enlaces. No expira (una baja debe poder hacerse siempre), es idempotente y nunca
 * se loguea.
 */
function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`unsub:${payload}`).digest("base64url").slice(0, 32);
}

export function createUnsubscribeToken(recipientId: string, secret: string): string {
  const payload = Buffer.from(recipientId.replace(/-/g, ""), "hex").toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyUnsubscribeToken(token: string, secret: string): string | null {
  if (typeof token !== "string" || token.length > 128) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const expected = sign(secret, payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const hex = Buffer.from(payload, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
