"use server";

import { cookies, headers } from "next/headers";
import { confirmCheckin, identifyForCheckin } from "@/lib/attendance/checkin";
import { verifyCheckinSession } from "@/lib/attendance/session-tokens";
import { CHECKIN_SESSION_COOKIE } from "@/lib/attendance/constants";

async function getIp(): Promise<string> {
  const hdrs = await headers();
  return hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
}

async function getSessionMeetingId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(CHECKIN_SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = verifyCheckinSession(token);
  return session?.m ?? null;
}

export interface IdentifyState {
  kind: "idle" | "need_confirmation" | "already_checked_in" | "not_found" | "rate_limited" | "no_session";
  firstName?: string;
  confirmToken?: string;
  checkedInAt?: string;
}

export async function identifyAction(_prevState: IdentifyState, formData: FormData): Promise<IdentifyState> {
  const meetingId = await getSessionMeetingId();
  if (!meetingId) return { kind: "no_session" };

  const identifier = String(formData.get("identifier") ?? "");
  const lastName = String(formData.get("lastName") ?? "");
  const ip = await getIp();

  const result = await identifyForCheckin(meetingId, identifier, lastName, ip);

  if (result.kind === "need_confirmation") {
    return { kind: "need_confirmation", firstName: result.firstName, confirmToken: result.confirmToken };
  }
  if (result.kind === "already_checked_in") {
    return { kind: "already_checked_in", firstName: result.firstName, checkedInAt: result.checkedInAt.toISOString() };
  }
  return { kind: result.kind };
}

export interface ConfirmState {
  kind: "idle" | "ok" | "already_checked_in" | "invalid" | "not_active" | "rate_limited";
  firstName?: string;
  checkedInAt?: string;
}

export async function confirmCheckinAction(
  confirmToken: string,
  _prevState: ConfirmState
): Promise<ConfirmState> {
  const hdrs = await headers();
  const ip = await getIp();
  const userAgent = hdrs.get("user-agent") ?? undefined;

  const result = await confirmCheckin(confirmToken, ip, userAgent);

  if (result.kind === "ok" || result.kind === "already_checked_in") {
    return { kind: result.kind, firstName: result.firstName, checkedInAt: result.checkedInAt.toISOString() };
  }
  return { kind: result.kind };
}
