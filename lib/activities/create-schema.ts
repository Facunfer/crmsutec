import { z } from "zod";
import { parseLocalDateTimeInBusinessTz } from "../datetime.js";

/**
 * Entrada de la creación unificada de una actividad (reunión de un día o campaña con varias fechas), con su formulario y un QR por fecha.
 * Sin `assertServerOnly` a propósito: lo comparten el servidor y el formulario del cliente (solo validación, sin base de datos).
 */

export const ACTIVITY_MAX_DATES = 60;
export const ACTIVITY_MAX_EXTRA_FIELDS = 20;

/** Tipos de pregunta que se pueden agregar a la plantilla (nombre, apellido, DNI, email y teléfono ya vienen incluidos). */
export const ACTIVITY_EXTRA_FIELD_TYPES = ["text", "textarea", "number", "date", "select", "radio", "checkbox"] as const;
const CHOICE_TYPES: ReadonlySet<string> = new Set(["select", "radio"]);

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

export const activityDateSchema = z
  .object({
    startsAt: z.string().min(1, "La fecha y hora de inicio es obligatoria."),
    endsAt: z.string().min(1, "La fecha y hora de fin es obligatoria."),
    locationName: optionalText(200),
    address: optionalText(300),
  })
  .refine((d) => parseLocalDateTimeInBusinessTz(d.endsAt) > parseLocalDateTimeInBusinessTz(d.startsAt), {
    message: "La fecha y hora de fin tiene que ser posterior a la de inicio.",
    path: ["endsAt"],
  });

export const activityExtraFieldSchema = z
  .object({
    label: z.string().trim().min(1, "La pregunta necesita un texto.").max(120),
    fieldType: z.enum(ACTIVITY_EXTRA_FIELD_TYPES),
    required: z.boolean().default(false),
    optionsText: optionalText(2000),
  })
  .refine((f) => !CHOICE_TYPES.has(f.fieldType) || (f.optionsText ?? "").split("\n").some((l) => l.trim() !== ""), {
    message: "Una pregunta de opciones necesita al menos una opción (una por línea).",
    path: ["optionsText"],
  });

export const activityFormSchema = z.object({
  /**
   * Inscripción desde el formulario. «auto» (por defecto): quien responde queda inscripto (reunión fija o todas las fechas de la campaña)
   * cuando se lo identifica sin ambigüedad por DNI. «never»: el formulario solo recibe respuestas, como hasta ahora.
   */
  enrollment: z.enum(["auto", "never"]).default("auto"),
  /** «never» (por defecto, regla R7): una persona que no existe queda «sin vincular». «when_valid_dni»: se crea la ficha si el DNI es válido. */
  personCreation: z.enum(["never", "when_valid_dni"]).default("never"),
  consentText: optionalText(2000),
  successMessage: optionalText(500),
  extraFields: z.array(activityExtraFieldSchema).max(ACTIVITY_MAX_EXTRA_FIELDS, `Se pueden agregar hasta ${ACTIVITY_MAX_EXTRA_FIELDS} preguntas.`).default([]),
});

export const activityInputSchema = z
  .object({
    kind: z.enum(["single", "campaign"]),
    name: z.string().trim().min(1, "El nombre es obligatorio.").max(160),
    description: optionalText(2000),
    ownerOrganizationId: z.string().uuid("Elegí la unidad responsable."),
    /** Solo para «single»: las fechas de una campaña son siempre jornadas. */
    meetingType: z.enum(["reunion", "capacitacion"]).optional(),
    campaignType: z.enum(["vaccination", "ophthalmology", "other"]).default("other"),
    dates: z.array(activityDateSchema).min(1, "Cargá al menos una fecha.").max(ACTIVITY_MAX_DATES, `Se pueden cargar hasta ${ACTIVITY_MAX_DATES} fechas.`),
    qrMode: z.enum(["static", "rotating"]).default("rotating"),
    checkinToleranceBeforeMinutes: z.coerce.number().int().min(0).max(240).default(30),
    checkinToleranceAfterMinutes: z.coerce.number().int().min(0).max(240).default(60),
    allowUninvitedCheckin: z.boolean().default(false),
    capacity: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(1, "La capacidad debe ser un entero positivo.").max(1000000).optional()),
    /** true: queda programada y el formulario publicado (el QR funciona al llegar la fecha). false: todo en borrador, sin exponer nada. */
    publish: z.boolean().default(true),
    form: activityFormSchema.default({ enrollment: "auto", personCreation: "never", extraFields: [] }),
  })
  .superRefine((input, ctx) => {
    if (input.kind === "single" && input.dates.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["dates"], message: "Una reunión de un día tiene exactamente una fecha. Para varias fechas usá «Campaña»." });
    }
    if (input.kind === "campaign" && input.dates.length < 2) {
      ctx.addIssue({ code: "custom", path: ["dates"], message: "Una campaña necesita al menos dos fechas. Para una sola fecha usá «Reunión de un día»." });
    }
  });

export type ActivityInput = z.input<typeof activityInputSchema>;
export type ActivityParsed = z.output<typeof activityInputSchema>;
export type ActivityExtraField = z.output<typeof activityExtraFieldSchema>;
