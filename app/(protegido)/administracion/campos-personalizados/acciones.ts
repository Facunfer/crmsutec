"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guard";
import { createFieldDefinition, setFieldDefinitionActive, FieldDefinitionError, type FieldDefinitionInput } from "@/lib/people/field-definitions";
import { parseOptionsText } from "@/lib/forms/schema";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function toMessage(err: unknown, fallback: string): string {
  return err instanceof FieldDefinitionError ? err.message : fallback;
}

export async function createFieldDefinitionAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    const fieldType = String(formData.get("fieldType") ?? "text") as FieldDefinitionInput["fieldType"];
    const optionsText = String(formData.get("optionsText") ?? "");
    await createFieldDefinition(actor, {
      key: String(formData.get("key") ?? ""),
      label: String(formData.get("label") ?? ""),
      fieldType,
      options: optionsText.trim() ? parseOptionsText(optionsText) : undefined,
      required: formData.get("required") === "true",
      sensitive: formData.get("sensitive") === "true",
    });
    revalidatePath("/administracion/campos-personalizados");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo crear el campo.") };
  }
}

export async function toggleFieldDefinitionActiveAction(id: string, nextActive: boolean, _prevState: ActionResult): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await setFieldDefinitionActive(actor, id, nextActive);
    revalidatePath("/administracion/campos-personalizados");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo actualizar el campo.") };
  }
}
