import { createHash, randomBytes } from "node:crypto";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/meetings/tokens.ts");

/** ≥128 bits, base64url, nunca derivado de un ID (decisión D10). */
export function generateInvitationToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
