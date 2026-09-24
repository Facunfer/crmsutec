import { z } from "zod";
import { parseLocalDateTimeInBusinessTz } from "../datetime.js";

export const meetingInputSchema = z
  .object({
    name: z.string().trim().min(1, "El nombre es obligatorio."),
    description: z.string().trim().optional().or(z.literal("")),
    startsAt: z.string().min(1, "La fecha/hora de inicio es obligatoria."),
    endsAt: z.string().min(1, "La fecha/hora de fin es obligatoria."),
    locationName: z.string().trim().optional().or(z.literal("")),
    address: z.string().trim().optional().or(z.literal("")),
    notes: z.string().trim().optional().or(z.literal("")),
    // Solo lo usa la creación manual (punto 5): "Reunión" o "Capacitación". Los demás valores de meeting_type
    // (operativo_salud, jornada, evento, otro) son exclusivos de la carga histórica y no se ofrecen acá.
    meetingType: z.enum(["reunion", "capacitacion"]).optional(),
    qrMode: z.enum(["static", "rotating"]).optional(),
    checkinToleranceBeforeMinutes: z.coerce.number().int().min(0).max(240).optional(),
    checkinToleranceAfterMinutes: z.coerce.number().int().min(0).max(240).optional(),
    allowUninvitedCheckin: z.coerce.boolean().optional(),
  })
  .refine(
    (data) => parseLocalDateTimeInBusinessTz(data.endsAt) > parseLocalDateTimeInBusinessTz(data.startsAt),
    {
      message: "La fecha/hora de fin tiene que ser posterior a la de inicio.",
      path: ["endsAt"],
    }
  );

export type MeetingInput = z.infer<typeof meetingInputSchema>;

export function parseMeetingForm(formData: FormData): MeetingInput {
  return meetingInputSchema.parse({
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? ""),
    startsAt: String(formData.get("startsAt") ?? ""),
    endsAt: String(formData.get("endsAt") ?? ""),
    locationName: String(formData.get("locationName") ?? ""),
    address: String(formData.get("address") ?? ""),
    notes: String(formData.get("notes") ?? ""),
    meetingType: formData.has("meetingType") ? String(formData.get("meetingType")) : undefined,
    qrMode: formData.has("qrMode") ? String(formData.get("qrMode")) : undefined,
    checkinToleranceBeforeMinutes: formData.has("checkinToleranceBeforeMinutes")
      ? String(formData.get("checkinToleranceBeforeMinutes"))
      : undefined,
    checkinToleranceAfterMinutes: formData.has("checkinToleranceAfterMinutes")
      ? String(formData.get("checkinToleranceAfterMinutes"))
      : undefined,
    allowUninvitedCheckin: formData.has("allowUninvitedCheckin") ? formData.get("allowUninvitedCheckin") === "true" : undefined,
  });
}
