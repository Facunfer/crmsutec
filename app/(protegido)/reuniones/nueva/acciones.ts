"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { ActivityCommandError, createActivity } from "@/lib/activities/create";

export interface ActivityActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Crea la actividad completa (reunión de un día o campaña con varias fechas, su formulario y un QR por fecha) en UNA transacción.
 * El cuerpo viaja como JSON en `payload` (las fechas y las preguntas son listas dinámicas); la unidad responsable viaja como un campo normal
 * del selector Área → Repartición. Todo se vuelve a validar en el servidor: permisos, alcance de la unidad y cada dato.
 */
export async function createActivityAction(_prevState: ActivityActionResult, formData: FormData): Promise<ActivityActionResult> {
  const actor = await requireUser();

  let target: string;
  try {
    const raw = JSON.parse(String(formData.get("payload") ?? "")) as Record<string, unknown>;
    const created = await createActivity(actor, { ...raw, ownerOrganizationId: String(formData.get("ownerOrganizationId") ?? "") } as never);
    target = created.kind === "campaign" ? `/reuniones/actividad/campana/${created.campaignId}` : `/reuniones/actividad/reunion/${created.meetings[0]!.id}`;
  } catch (err) {
    if (err instanceof ActivityCommandError) return { ok: false, error: err.message };
    if (err instanceof Error && /permiso/i.test(err.message)) return { ok: false, error: err.message };
    return { ok: false, error: "No se pudo crear la actividad. Revisá los datos e intentá de nuevo." };
  }

  revalidatePath("/reuniones");
  redirect(target);
}
