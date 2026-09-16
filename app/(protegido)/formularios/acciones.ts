"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guard";
import { createForm, FormCommandError } from "@/lib/forms/commands";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function createFormAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireUser();

  let createdId: string;
  try {
    const result = await createForm(actor, {
      name: String(formData.get("name") ?? ""),
      slug: String(formData.get("slug") ?? ""),
    });
    createdId = result.id;
  } catch (err) {
    return { ok: false, error: err instanceof FormCommandError ? err.message : "No se pudo crear el formulario." };
  }

  revalidatePath("/formularios");
  redirect(`/formularios/${createdId}`);
}
