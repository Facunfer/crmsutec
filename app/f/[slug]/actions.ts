"use server";

import { headers } from "next/headers";
import { getPublicForm, submitForm } from "@/lib/forms/submit";

export interface SubmitFormState {
  status: "idle" | "ok" | "error" | "validation_error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

async function getIp(): Promise<string> {
  const hdrs = await headers();
  return hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
}

export async function submitFormAction(
  slug: string,
  idempotencyKey: string,
  _prevState: SubmitFormState,
  formData: FormData
): Promise<SubmitFormState> {
  const publicForm = await getPublicForm(slug);
  if (publicForm.kind !== "ok") {
    return { status: "error", message: "Este formulario no está disponible en este momento." };
  }

  const rawEntries: Record<string, string | string[]> = {};
  for (const field of publicForm.schema.fields) {
    if (!field.visible) continue;
    if (field.fieldType === "checkbox") {
      rawEntries[field.key] = formData.getAll(field.key).map(String);
    } else {
      rawEntries[field.key] = String(formData.get(field.key) ?? "");
    }
  }
  if (publicForm.schema.consentText) {
    rawEntries.__consent = formData.get("__consent") === "true" ? "true" : "false";
  }

  const ip = await getIp();
  const hdrs = await headers();
  const userAgent = hdrs.get("user-agent") ?? undefined;

  const result = await submitForm(slug, rawEntries, idempotencyKey, ip, userAgent);

  if (result.kind === "ok") return { status: "ok", message: result.successMessage };
  if (result.kind === "validation_error") return { status: "validation_error", fieldErrors: result.fieldErrors };
  if (result.kind === "rate_limited") return { status: "error", message: "Demasiados intentos. Probá de nuevo en unos minutos." };
  return { status: "error", message: "Este formulario no está disponible en este momento." };
}
