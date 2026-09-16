import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { writeAuditLog } from "../audit/log.js";
import { sanitizeCsvCell } from "../people/export.js";
import type { SessionUser } from "../permissions/can.js";
import { getFormById, listSubmissions } from "./queries.js";

assertServerOnly("lib/forms/export.ts");

export class FormExportError extends Error {}

const RESULT_LABEL: Record<string, string> = {
  pending: "procesando",
  created: "persona nueva",
  matched: "persona existente actualizada",
  needs_review: "en revisión",
  error: "error",
};

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join("; ");
  return String(value);
}

export async function exportSubmissionsCsv(actor: SessionUser, formId: string): Promise<string> {
  assertPermission(actor, "forms.export_submissions");

  const form = await getFormById(formId);
  if (!form) throw new FormExportError("El formulario no existe.");

  const submissions = await listSubmissions(formId);

  const dynamicKeys = new Set<string>();
  for (const s of submissions) Object.keys(s.rawPayload).forEach((k) => dynamicKeys.add(k));
  const keys = [...dynamicKeys];

  const header = ["Recibido", "Versión", "Resultado", "Persona", ...keys];
  const lines = [header.map(sanitizeCsvCell).join(",")];

  for (const s of submissions) {
    const row = [
      s.createdAt.toISOString(),
      `v${s.formVersion}`,
      RESULT_LABEL[s.matchResult] ?? s.matchResult,
      s.personName ?? "",
      ...keys.map((k) => stringifyCell(s.rawPayload[k])),
    ];
    lines.push(row.map(sanitizeCsvCell).join(","));
  }

  // BOM para que Excel detecte UTF-8 y no rompa acentos/ñ (mismo patrón que lib/people/export.ts).
  const csv = `﻿${lines.join("\r\n")}`;

  await writeAuditLog({
    actorUserId: actor.id,
    action: "FORM_SUBMISSIONS_EXPORTED",
    entityType: "form",
    entityId: formId,
    metadata: { count: submissions.length },
  });

  return csv;
}
