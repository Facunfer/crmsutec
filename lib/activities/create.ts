import { randomBytes } from "node:crypto";
import { getDb } from "../db/client.js";
import { toJsonb } from "../db/json.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import type { SessionUser } from "../permissions/can.js";
import { parseLocalDateTimeInBusinessTz } from "../datetime.js";
import { canActorOwnInOrganization } from "../organizations/ownership.js";
import { FIELD_TYPES } from "../forms/field-types.js";
import { dniPublishError } from "../forms/publish-rules.js";
import { parseOptionsText } from "../forms/schema.js";
import { buildFormSnapshot, type SnapshotFieldRow } from "../forms/snapshot.js";
import type { FormEnrollmentMode, PersonFieldType } from "../db/schema.js";
import { activityInputSchema, type ActivityInput } from "./create-schema.js";

assertServerOnly("lib/activities/create.ts");

/**
 * Creación UNIFICADA de una actividad (Etapa 1b): una reunión de un día, o una campaña con varias fechas, junto con su formulario de
 * inscripción y las reuniones/jornadas (cada una con su propio QR de asistencia). TODO en UNA transacción: o se crea completo o no se
 * crea nada (ni campaña, ni reuniones, ni formulario, ni campos, ni versión publicada).
 *
 * Permisos: `meetings.create` + unidad dentro del alcance del usuario (misma regla que `createMeeting`). Si la actividad se publica
 * (por defecto) se exige además `meetings.change_status`, porque nace «programada» en lugar de pasar por borrador. El formulario asociado
 * se crea y publica bajo estos mismos permisos: NO exige el módulo «Formularios» (un usuario «solo reuniones» puede cargar actividades).
 *
 * Reglas de negocio que reutiliza sin cambiarlas:
 *   - un formulario público no crea personas salvo política explícita (`personCreation`, por defecto «never»);
 *   - la inscripción de quien responde la ejecuta el procesamiento del envío (paso 1c) según `forms.enrollment_mode`;
 *   - el QR de cada fecha vive en su reunión (`qr_mode`, secreto por reunión): crearla ya deja el QR disponible para la consola de asistencia.
 */

export class ActivityCommandError extends Error {}

export interface CreatedActivityMeeting {
  id: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  /** 1..N en orden cronológico. */
  number: number;
}

export interface CreatedActivity {
  kind: "single" | "campaign";
  campaignId: string | null;
  meetings: CreatedActivityMeeting[];
  form: { id: string; slug: string; publicPath: string; published: boolean; enrollmentMode: FormEnrollmentMode };
  status: "draft" | "scheduled";
}

const BA_TZ = "America/Argentina/Buenos_Aires";

function slugify(text: string): string {
  const base = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base || "actividad";
}

function fieldKey(label: string, used: Set<string>): string {
  let base = slugify(label).replace(/-/g, "_").replace(/^[^a-z]+/, "");
  if (!base) base = "pregunta";
  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}_${n++}`;
  used.add(key);
  return key;
}

const dayInBusinessTz = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: BA_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const shortDayInBusinessTz = (d: Date) => new Intl.DateTimeFormat("es-AR", { timeZone: BA_TZ, day: "2-digit", month: "2-digit" }).format(d);

export async function createActivity(actor: SessionUser, rawInput: ActivityInput): Promise<CreatedActivity> {
  assertPermission(actor, "meetings.create");

  const parsed = activityInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new ActivityCommandError(parsed.error.issues[0]?.message ?? "Los datos de la actividad no son válidos.");
  const input = parsed.data;
  if (input.publish) assertPermission(actor, "meetings.change_status");

  if (!(await canActorOwnInOrganization(actor.id, input.ownerOrganizationId))) {
    throw new ActivityCommandError("La unidad organizativa no existe, está inactiva o está fuera de tu alcance.");
  }

  // Fechas en orden cronológico (la numeración de las jornadas es la del calendario, no la del orden de carga).
  const dates = input.dates
    .map((d) => ({ ...d, start: parseLocalDateTimeInBusinessTz(d.startsAt), end: parseLocalDateTimeInBusinessTz(d.endsAt) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const isCampaign = input.kind === "campaign";
  const status = input.publish ? ("scheduled" as const) : ("draft" as const);
  const enrollmentMode: FormEnrollmentMode = input.form.enrollment === "never" ? "never" : isCampaign ? "campaign_all" : "single_meeting";

  const db = await getDb();
  return db.transaction().execute(async (trx): Promise<CreatedActivity> => {
    const suffix = randomBytes(3).toString("hex");

    // 1. Campaña (solo con varias fechas).
    let campaignId: string | null = null;
    if (isCampaign) {
      const campaign = await trx
        .insertInto("campaigns")
        .values({
          campaign_key: `act:${slugify(input.name)}-${suffix}`,
          name: input.name,
          campaign_type: input.campaignType,
          owner_organization_id: input.ownerOrganizationId,
          status,
          origin: "manual",
          start_date: dayInBusinessTz(dates[0]!.start),
          end_date: dayInBusinessTz(dates[dates.length - 1]!.end),
          created_by: actor.id,
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
      campaignId = campaign.id;
    }

    // 2. Una reunión por fecha: cada una tiene su propio QR de asistencia.
    const meetings: CreatedActivityMeeting[] = [];
    for (const [i, d] of dates.entries()) {
      const name = isCampaign ? `${input.name} · Jornada ${i + 1} (${shortDayInBusinessTz(d.start)})` : input.name;
      const row = await trx
        .insertInto("meetings")
        .values({
          owner_organization_id: input.ownerOrganizationId,
          name,
          description: input.description?.trim() || null,
          starts_at: d.start,
          ends_at: d.end,
          location_name: d.locationName?.trim() || null,
          address: d.address?.trim() || null,
          meeting_type: isCampaign ? "jornada" : (input.meetingType ?? "reunion"),
          organizer_user_id: actor.id,
          status,
          qr_mode: input.qrMode,
          checkin_tolerance_before_minutes: input.checkinToleranceBeforeMinutes,
          checkin_tolerance_after_minutes: input.checkinToleranceAfterMinutes,
          allow_uninvited_checkin: input.allowUninvitedCheckin,
          capacity: input.capacity ?? null,
          campaign_id: campaignId,
          created_by: actor.id,
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
      meetings.push({ id: row.id, name, startsAt: d.start, endsAt: d.end, number: i + 1 });
    }

    // 3. Formulario de inscripción (plantilla + preguntas propias), vinculado a la reunión o a la campaña.
    let slug = `${slugify(input.name)}-${suffix}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const taken = await trx.selectFrom("forms").select("id").where("slug", "=", slug).executeTakeFirst();
      if (!taken) break;
      slug = `${slugify(input.name)}-${randomBytes(3).toString("hex")}`;
    }

    const form = await trx
      .insertInto("forms")
      .values({
        owner_organization_id: input.ownerOrganizationId,
        slug,
        name: input.name,
        description: input.description?.trim() || null,
        consent_text: input.form.consentText?.trim() || null,
        success_message: input.form.successMessage?.trim() || (enrollmentMode === "never" ? "Recibimos tu respuesta. ¡Gracias!" : "¡Listo! Tu inscripción quedó registrada."),
        identification_policy: toJsonb({ matchFields: ["dni", "email", "phone"] }),
        person_creation_policy: input.form.personCreation,
        apply_data_policy: "never",
        campaign_id: campaignId,
        meeting_id: isCampaign ? null : meetings[0]!.id,
        enrollment_mode: enrollmentMode,
        created_by: actor.id,
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow();

    const used = new Set(["first_name", "last_name", "dni", "email", "phone"]);
    const template: Array<{ key: string; label: string; fieldType: PersonFieldType; required: boolean; mapping: string | null; options: unknown }> = [
      { key: "first_name", label: "Nombre", fieldType: "text", required: true, mapping: "first_name", options: null },
      { key: "last_name", label: "Apellido", fieldType: "text", required: true, mapping: "last_name", options: null },
      { key: "dni", label: "DNI", fieldType: "dni", required: true, mapping: "dni", options: null },
      { key: "email", label: "Email", fieldType: "email", required: false, mapping: "email", options: null },
      { key: "phone", label: "Teléfono", fieldType: "phone", required: false, mapping: "phone", options: null },
      ...input.form.extraFields.map((f) => ({
        key: fieldKey(f.label, used),
        label: f.label,
        fieldType: f.fieldType as PersonFieldType,
        required: f.required,
        mapping: null,
        options: FIELD_TYPES[f.fieldType as PersonFieldType].hasChoices ? toJsonb(parseOptionsText(f.optionsText ?? "") as never) : null,
      })),
    ];

    const fieldRows: SnapshotFieldRow[] = template.map((f, i) => ({
      key: f.key,
      label: f.label,
      field_type: f.fieldType,
      options: f.options,
      required: f.required,
      visible: true,
      sort_order: i + 1,
      person_field_mapping: f.mapping,
      description: null,
      validation: null,
    }));
    const dniError = dniPublishError(fieldRows.map((f) => ({ fieldType: f.field_type, required: f.required, visible: f.visible, personFieldMapping: f.person_field_mapping })));
    if (dniError) throw new ActivityCommandError(dniError);

    await trx
      .insertInto("form_fields")
      .values(
        fieldRows.map((f) => ({
          form_id: form.id,
          key: f.key,
          label: f.label,
          field_type: f.field_type,
          options: f.options,
          required: f.required,
          visible: f.visible,
          sort_order: f.sort_order,
          person_field_mapping: f.person_field_mapping,
          description: null,
          validation: null,
        })) as never
      )
      .execute();

    // 4. Publicar el formulario (versión 1, snapshot inmutable) si la actividad se publica.
    if (input.publish) {
      const snapshot = buildFormSnapshot(
        {
          name: input.name,
          consent_text: input.form.consentText?.trim() || null,
          success_message: input.form.successMessage?.trim() || (enrollmentMode === "never" ? "Recibimos tu respuesta. ¡Gracias!" : "¡Listo! Tu inscripción quedó registrada."),
          identification_policy: { matchFields: ["dni", "email", "phone"] },
        },
        fieldRows,
        []
      );
      await trx.insertInto("form_versions").values({ form_id: form.id, version: 1, schema: toJsonb(snapshot as never) }).execute();
      await trx.updateTable("forms").set({ status: "published", published_version: 1, updated_at: new Date() }).where("id", "=", form.id).execute();
    }

    return {
      kind: input.kind,
      campaignId,
      meetings,
      form: { id: form.id, slug, publicPath: `/f/${slug}`, published: input.publish, enrollmentMode },
      status,
    };
  });
}
