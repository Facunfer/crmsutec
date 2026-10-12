"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guard";
import {
  addAssociationAction as addAssociationActionCommand,
  changeFormStatus,
  FormCommandError,
  publishForm,
  removeAction as removeActionCommand,
  removeField,
  reorderFields,
  updateFormMeta,
  upsertField,
} from "@/lib/forms/commands";
import { parseFieldForm, parseFormMetaForm, type FieldInput, type FormMetaInput } from "@/lib/forms/schema";
import { z } from "zod";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function toMessage(err: unknown, fallback: string): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message ?? fallback;
  if (err instanceof FormCommandError) return err.message;
  return fallback;
}

function parseMetaFromForm(formData: FormData): FormMetaInput {
  return parseFormMetaForm(formData);
}

export async function updateFormMetaAction(formId: string, _prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    const input = parseMetaFromForm(formData);
    await updateFormMeta(actor, formId, input);
    revalidatePath(`/formularios/${formId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo guardar.") };
  }
}

function parseFieldFromForm(formData: FormData): FieldInput {
  return parseFieldForm(formData);
}

export async function upsertFieldAction(formId: string, fieldId: string | null, _prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    const input = parseFieldFromForm(formData);
    await upsertField(actor, formId, fieldId, input);
    revalidatePath(`/formularios/${formId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo guardar el campo.") };
  }
}

export async function removeFieldAction(formId: string, fieldId: string): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await removeField(actor, formId, fieldId);
    revalidatePath(`/formularios/${formId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo quitar el campo.") };
  }
}

export async function reorderFieldsAction(formId: string, orderedFieldIds: string[]): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await reorderFields(actor, formId, orderedFieldIds);
    revalidatePath(`/formularios/${formId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo reordenar.") };
  }
}

export async function addAssociationActionAction(formId: string, associationId: string): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await addAssociationActionCommand(actor, formId, associationId);
    revalidatePath(`/formularios/${formId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo agregar la acción.") };
  }
}

export async function removeActionAction(formId: string, actionId: string): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await removeActionCommand(actor, formId, actionId);
    revalidatePath(`/formularios/${formId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo quitar la acción.") };
  }
}

export interface PublishResult extends ActionResult {
  version?: number;
}

export async function publishFormAction(formId: string): Promise<PublishResult> {
  const actor = await requireUser();
  try {
    const { version } = await publishForm(actor, formId);
    revalidatePath(`/formularios/${formId}`);
    revalidatePath("/formularios");
    return { ok: true, version };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo publicar.") };
  }
}

export async function changeFormStatusAction(formId: string, target: "unpublished" | "published" | "archived"): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await changeFormStatus(actor, formId, target);
    revalidatePath(`/formularios/${formId}`);
    revalidatePath("/formularios");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo cambiar el estado.") };
  }
}
