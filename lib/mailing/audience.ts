import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import type { Database } from "../db/schema.js";
import type { SessionUser } from "../permissions/can.js";
import { buildPeopleFilterQuery, type PeopleFilterSpec } from "../people/queries.js";
import { loadOrgDisplayNames } from "../organizations/display.js";
import { orgScope } from "../scope/organizations.js";
import { isValidEmail, normalizeEmail } from "./email.js";
import { buildMergeVars } from "./template.js";

assertServerOnly("lib/mailing/audience.ts");

/**
 * AUDIENCIA DE UN MAILING. Se describe con un `AudienceSpec` que SIEMPRE se resuelve en el servidor (nunca confiamos en una lista de
 * ids armada por el navegador para saltear el alcance) y se CONGELA al crear la campaña: después no se recalcula.
 *
 * El análisis es set-based: una consulta trae las personas con email, el resto (normalizar, deduplicar, suprimir) se hace en
 * memoria sobre ese conjunto y la inserción es en bloques con `unnest` (sin N+1).
 */
const uuid = z.string().uuid();

export const peopleFilterSchema = z
  .object({
    search: z.string().max(200).optional(),
    organizationIds: z.array(uuid).max(500).optional(),
    status: z.enum(["active", "inactive", "merged", "all"]).optional(),
    ageMin: z.number().int().min(0).max(130).optional(),
    ageMax: z.number().int().min(0).max(130).optional(),
    tagIds: z.array(uuid).max(50).optional(),
    areaId: uuid.optional(),
    reparticionId: uuid.optional(),
    trafficLight: z.enum(["green", "yellow", "red", "gray"]).optional(),
    lastInteractionFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    lastInteractionTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

export const audienceSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual_ids"), ids: z.array(uuid).min(1).max(50_000) }).strict(),
  z.object({ kind: z.literal("people_filter"), filter: peopleFilterSchema }).strict(),
  z.object({ kind: z.literal("tag"), tagIds: z.array(uuid).min(1).max(50) }).strict(),
]);

export type AudienceSpec = z.infer<typeof audienceSpecSchema>;

export class AudienceError extends Error {}

export interface AudienceStats {
  /** Personas seleccionadas (activas y dentro del alcance). */
  selected: number;
  withEmail: number;
  withoutEmail: number;
  /** Emails con formato inválido (por email distinto). */
  invalid: number;
  /** Personas que comparten un email con otra ya contada (se envía un solo mail). */
  duplicates: number;
  suppressed: number;
  /** Emails a los que efectivamente se va a enviar. */
  finalRecipients: number;
  /** Personas descartadas de una selección manual por estar inactivas. */
  inactiveExcluded: number;
}

export interface AudienceGroup {
  normalized: string;
  original: string;
  personIds: string[];
  status: "pending" | "suppressed" | "invalid";
  detail: string | null;
  vars: Record<string, string | null>;
}

export interface AudienceAnalysis {
  stats: AudienceStats;
  groups: AudienceGroup[];
  /** Resumen auditable de cómo se armó (sin ids manuales). */
  specSummary: Record<string, unknown>;
}

interface PersonRow {
  id: string;
  email: string | null;
  first_name: string;
  last_name: string;
  organization_id: string | null;
}

const CHUNK = 2000;

function* chunks<T>(items: readonly T[], size = CHUNK): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

async function fetchSelection(
  db: Kysely<Database>,
  actor: SessionUser,
  spec: AudienceSpec
): Promise<{ selected: number; inactiveExcluded: number; withEmail: PersonRow[]; summary: Record<string, unknown> }> {
  const hasEmail = sql<boolean>`people.email is not null and btrim(people.email) <> ''`;

  if (spec.kind === "manual_ids") {
    const ids = [...new Set(spec.ids)];
    // Alcance primero: una persona fuera del alcance NO se descarta en silencio, se rechaza la campaña entera.
    let visible = 0;
    let activeCount = 0;
    const rows: PersonRow[] = [];
    for (const part of chunks(ids, 5000)) {
      const r = await sql<PersonRow & { status: string }>`
        select people.id, people.email, people.first_name, people.last_name, people.organization_id, people.status
        from people
        where people.id = any(${part}::uuid[]) and ${orgScope(actor, "people.organization_id")}`.execute(db);
      visible += r.rows.length;
      for (const row of r.rows) {
        if (row.status === "active") {
          activeCount += 1;
          rows.push(row);
        }
      }
    }
    if (visible !== ids.length) {
      throw new AudienceError("La selección incluye personas fuera de tu alcance o inexistentes. La campaña no se creó.");
    }
    return {
      selected: activeCount,
      inactiveExcluded: visible - activeCount,
      withEmail: rows.filter((r) => r.email && r.email.trim() !== ""),
      summary: { kind: "manual_ids", count: ids.length },
    };
  }

  const filter: PeopleFilterSpec =
    spec.kind === "tag" ? { tagIds: spec.tagIds, status: "active" } : { ...(spec.filter as PeopleFilterSpec), status: "active" };
  const count = await buildPeopleFilterQuery(db, actor, filter).select(sql<number>`count(people.id)`.as("n")).executeTakeFirstOrThrow();
  const rows = (await buildPeopleFilterQuery(db, actor, filter)
    .where(hasEmail)
    .select(["people.id", "people.email", "people.first_name", "people.last_name", "people.organization_id"])
    .execute()) as PersonRow[];
  return {
    selected: Number((count as { n: number }).n),
    inactiveExcluded: 0,
    withEmail: rows,
    summary: spec.kind === "tag" ? { kind: "tag", tagIds: spec.tagIds } : { kind: "people_filter", filter },
  };
}

/**
 * Analiza la audiencia sin escribir nada. Es la ÚNICA función que decide quién recibe: la usan tanto la vista previa como la
 * creación de la campaña, así el número que se muestra es el que se congela.
 */
export async function analyzeAudience(actor: SessionUser, spec: AudienceSpec, dbOverride?: Kysely<Database>): Promise<AudienceAnalysis> {
  assertPermission(actor, "mailing.create");
  assertPermission(actor, "people.view");
  const db = dbOverride ?? (await getDb());
  const parsed = audienceSpecSchema.safeParse(spec);
  if (!parsed.success) throw new AudienceError("La especificación de la audiencia no es válida.");

  const selection = await fetchSelection(db, actor, parsed.data);
  const orgNames = await loadOrgDisplayNames(db);

  // Agrupar por email normalizado.
  const byEmail = new Map<string, { original: string; people: PersonRow[] }>();
  for (const person of selection.withEmail) {
    const normalized = normalizeEmail(person.email);
    const g = byEmail.get(normalized);
    if (g) g.people.push(person);
    else byEmail.set(normalized, { original: person.email ?? "", people: [person] });
  }

  const validEmails = [...byEmail.keys()].filter(isValidEmail);
  const suppressed = new Map<string, string>();
  for (const part of chunks(validEmails, 5000)) {
    const r = await sql<{ normalized_email: string; reason: string }>`
      select normalized_email, reason from mailing_suppressions
      where lifted_at is null and normalized_email = any(${part}::text[])`.execute(db);
    for (const row of r.rows) suppressed.set(row.normalized_email, row.reason);
  }

  const groups: AudienceGroup[] = [];
  let invalid = 0;
  let duplicates = 0;
  let suppressedCount = 0;
  let finalRecipients = 0;
  for (const [normalized, g] of byEmail) {
    const personIds = g.people.map((p) => p.id).sort();
    const valid = isValidEmail(normalized);
    let status: AudienceGroup["status"] = "pending";
    let detail: string | null = null;
    if (!valid) {
      status = "invalid";
      detail = "Formato de email inválido";
      invalid += 1;
    } else {
      duplicates += g.people.length - 1;
      const reason = suppressed.get(normalized);
      if (reason) {
        status = "suppressed";
        detail = reason;
        suppressedCount += 1;
      } else finalRecipients += 1;
    }
    // Personalización inequívoca solo si el email pertenece a UNA persona; compartido → neutro («Hola,»).
    const single = g.people.length === 1 ? g.people[0]! : null;
    const vars = single
      ? buildMergeVars({
          firstName: single.first_name,
          lastName: single.last_name,
          organizationName: single.organization_id ? orgNames.get(single.organization_id) ?? null : null,
        })
      : buildMergeVars(null);
    groups.push({ normalized, original: g.original, personIds, status, detail, vars });
  }

  const withEmail = selection.withEmail.length;
  return {
    stats: {
      selected: selection.selected,
      withEmail,
      withoutEmail: Math.max(0, selection.selected - withEmail),
      invalid,
      duplicates,
      suppressed: suppressedCount,
      finalRecipients,
      inactiveExcluded: selection.inactiveExcluded,
    },
    groups,
    specSummary: selection.summary,
  };
}

/** Inserta el snapshot (destinatarios + vínculos con personas) en bloques. Debe correr dentro de la transacción de creación. */
export async function persistSnapshot(trx: Transaction<Database>, campaignId: string, groups: readonly AudienceGroup[]): Promise<void> {
  for (const part of chunks(groups, CHUNK)) {
    const ids = part.map(() => randomUUID());
    await sql`
      insert into mailing_campaign_recipients
        (id, campaign_id, primary_person_id, person_count, normalized_email, email_snapshot, merge_vars, status, status_detail)
      select t.id, t.campaign_id, t.primary_person_id, t.person_count, t.normalized_email, t.email_snapshot, t.merge_vars::jsonb, t.status, t.status_detail
      from unnest(
        ${ids}::uuid[],
        ${part.map(() => campaignId)}::uuid[],
        ${part.map((g) => g.personIds[0] ?? null)}::uuid[],
        ${part.map((g) => g.personIds.length)}::int[],
        ${part.map((g) => g.normalized)}::text[],
        ${part.map((g) => g.original)}::text[],
        ${part.map((g) => JSON.stringify(g.vars))}::text[],
        ${part.map((g) => g.status)}::text[],
        ${part.map((g) => g.detail)}::text[]
      ) as t(id, campaign_id, primary_person_id, person_count, normalized_email, email_snapshot, merge_vars, status, status_detail)`.execute(trx);

    const recipientIds: string[] = [];
    const personIds: string[] = [];
    part.forEach((g, i) => {
      for (const p of g.personIds) {
        recipientIds.push(ids[i]!);
        personIds.push(p);
      }
    });
    for (let i = 0; i < recipientIds.length; i += 5000) {
      await sql`
        insert into mailing_campaign_recipient_people (recipient_id, person_id, campaign_id)
        select * from unnest(${recipientIds.slice(i, i + 5000)}::uuid[], ${personIds.slice(i, i + 5000)}::uuid[], ${recipientIds.slice(i, i + 5000).map(() => campaignId)}::uuid[])`.execute(trx);
    }
  }
}
