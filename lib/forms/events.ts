import type { Kysely, Transaction } from "kysely";
import { assertServerOnly } from "../server-only.js";
import { toJsonb } from "../db/json.js";
import type { Database, FormSubmissionEventType } from "../db/schema.js";

assertServerOnly("lib/forms/events.ts");

type Db = Kysely<Database> | Transaction<Database>;

export interface SubmissionEventInput {
  submission_id: string;
  event_type: FormSubmissionEventType;
  person_id: string;
  meeting_id?: string | null;
  participation_id?: string | null;
  /** null SOLO en los eventos automáticos (`auto_*`); la base lo exige. */
  recorded_by: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Historial append-only de acciones sobre respuestas de formulario (0043): provenance de quién vinculó, creó una persona, aplicó datos o
 * inscribió a partir de una respuesta. NO es una fuente de verdad: la inscripción canónica vive en `meeting_participations` (B4) y el
 * vínculo respuesta↔persona en `form_submissions.person_id`. Los comandos que mutan estado registran su evento en la MISMA transacción.
 */
export async function insertSubmissionEvents(db: Db, events: SubmissionEventInput[]): Promise<void> {
  if (events.length === 0) return;
  await db
    .insertInto("form_submission_events")
    .values(
      events.map((e) => ({
        submission_id: e.submission_id,
        event_type: e.event_type,
        person_id: e.person_id,
        meeting_id: e.meeting_id ?? null,
        participation_id: e.participation_id ?? null,
        recorded_by: e.recorded_by,
        reason: e.reason ?? null,
        details: toJsonb((e.details ?? {}) as never),
      }))
    )
    .execute();
}
