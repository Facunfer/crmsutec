"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, PermissionError } from "@/lib/auth/guard";
import { AudienceError, audienceSpecSchema, type AudienceSpec, type AudienceStats } from "@/lib/mailing/audience";
import {
  CampaignError,
  cancelCampaign,
  createCampaign,
  launchCampaign,
  markCampaignReady,
  pauseCampaign,
  previewAudience,
  resumeCampaign,
  sendTestEmail,
  updateCampaignDraft,
  type TestSendResult,
} from "@/lib/mailing/campaigns";
import { resolveUnknownRecipient } from "@/lib/mailing/queries";
import { SenderError, createSender, updateSender, verifySenderIdentity } from "@/lib/mailing/senders";
import { SuppressionError, addManualSuppression, liftSuppression } from "@/lib/mailing/suppressions";
import { loadMailConfig } from "@/lib/mailing/config";
import { buildMergeVars, findUnknownVariables, renderMessage } from "@/lib/mailing/template";

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  warnings?: string[];
}

function message(err: unknown, fallback: string): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message ?? fallback;
  if (err instanceof PermissionError) return "No tenés permiso para esta acción.";
  if (err instanceof CampaignError || err instanceof AudienceError || err instanceof SenderError || err instanceof SuppressionError) return err.message;
  return fallback;
}

/** Selección que manda el navegador: se traduce a un AudienceSpec que el servidor valida y resuelve (con alcance) por su cuenta. */
export type MailingSelection =
  | { mode: "ids"; ids: string[] }
  | { mode: "filter"; filter: unknown }
  | { mode: "tag"; tagIds: string[] };

function toSpec(selection: MailingSelection): AudienceSpec {
  const raw =
    selection.mode === "ids"
      ? { kind: "manual_ids", ids: selection.ids }
      : selection.mode === "tag"
        ? { kind: "tag", tagIds: selection.tagIds }
        : { kind: "people_filter", filter: selection.filter };
  return audienceSpecSchema.parse(raw);
}

export async function previewAudienceAction(
  selection: MailingSelection
): Promise<{ ok: boolean; error?: string; stats?: AudienceStats; threshold?: number }> {
  const actor = await requireUser();
  try {
    const result = await previewAudience(actor, toSpec(selection));
    return { ok: true, stats: result.stats, threshold: loadMailConfig().reinforcedConfirmationThreshold };
  } catch (err) {
    return { ok: false, error: message(err, "No se pudo calcular la audiencia.") };
  }
}

export async function createCampaignAction(selection: MailingSelection, name: string): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    const { id } = await createCampaign(actor, { name, spec: toSpec(selection) });
    revalidatePath("/mailing");
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: message(err, "No se pudo crear la campaña.") };
  }
}

export interface DraftInput {
  name: string;
  subject: string;
  preheader: string;
  senderId: string;
  replyTo: string;
  htmlBody: string;
  textBody: string;
}

export async function saveDraftAction(id: string, input: DraftInput, markReady: boolean): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    const { warnings } = await updateCampaignDraft(actor, id, {
      name: input.name,
      subject: input.subject,
      preheader: input.preheader,
      senderId: input.senderId || null,
      replyTo: input.replyTo || null,
      htmlBody: input.htmlBody,
      textBody: input.textBody,
    });
    if (markReady) await markCampaignReady(actor, id);
    revalidatePath(`/mailing/${id}`);
    revalidatePath(`/mailing/${id}/editar`);
    return { ok: true, warnings };
  } catch (err) {
    return { ok: false, error: message(err, "No se pudo guardar el borrador.") };
  }
}

/** Vista previa sin guardar: el HTML se sanitiza y las variables se escapan en el servidor; el navegador lo muestra en un iframe sin scripts. */
export async function renderPreviewAction(input: {
  subject: string;
  preheader: string;
  htmlBody: string;
  textBody: string;
  shared: boolean;
}): Promise<{ ok: boolean; html?: string; text?: string; subject?: string; unknown?: string[] }> {
  await requireUser();
  const config = loadMailConfig();
  const rendered = renderMessage({
    subject: input.subject.slice(0, 300),
    preheader: input.preheader.slice(0, 300),
    htmlBody: input.htmlBody.slice(0, 400_000),
    textBody: input.textBody.slice(0, 200_000),
    vars: input.shared ? buildMergeVars(null) : buildMergeVars({ firstName: "María", lastName: "Gómez", organizationName: "Área de ejemplo" }),
    unsubscribeUrl: `${config.publicBaseUrl ?? "https://crm.example"}/unsubscribe/vista-previa`,
  });
  return { ok: true, ...rendered, unknown: findUnknownVariables(`${input.subject} ${input.htmlBody} ${input.textBody}`) };
}

export async function sendTestAction(id: string, to: string): Promise<{ ok: boolean; error?: string; result?: TestSendResult }> {
  const actor = await requireUser();
  try {
    return { ok: true, result: await sendTestEmail(actor, id, to) };
  } catch (err) {
    return { ok: false, error: message(err, "No se pudo enviar la prueba.") };
  }
}

export async function launchAction(
  id: string,
  input: { confirmRecipients: number; acknowledgeSandbox: boolean; scheduledAt: string }
): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    const scheduled = input.scheduledAt ? new Date(input.scheduledAt) : null;
    if (scheduled && Number.isNaN(scheduled.getTime())) return { ok: false, error: "La fecha programada no es válida." };
    await launchCampaign(actor, id, { confirmRecipients: input.confirmRecipients, acknowledgeSandbox: input.acknowledgeSandbox, scheduledAt: scheduled });
    revalidatePath("/mailing");
    revalidatePath(`/mailing/${id}`);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: message(err, "No se pudo lanzar la campaña.") };
  }
}

async function transition(
  id: string,
  actor: Awaited<ReturnType<typeof requireUser>>,
  fn: (actor: Awaited<ReturnType<typeof requireUser>>) => Promise<unknown>,
  fallback: string
): Promise<ActionResult> {
  try {
    await fn(actor);
    revalidatePath("/mailing");
    revalidatePath(`/mailing/${id}`);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: message(err, fallback) };
  }
}

export async function pauseAction(id: string): Promise<ActionResult> {
  const actor = await requireUser();
  return transition(id, actor, (a) => pauseCampaign(a, id), "No se pudo pausar.");
}

export async function resumeAction(id: string): Promise<ActionResult> {
  const actor = await requireUser();
  return transition(id, actor, (a) => resumeCampaign(a, id), "No se pudo reanudar.");
}

export async function cancelAction(id: string, reason: string): Promise<ActionResult> {
  const actor = await requireUser();
  return transition(id, actor, (a) => cancelCampaign(a, id, reason), "No se pudo cancelar.");
}

export async function resolveUnknownAction(campaignId: string, recipientId: string, action: "requeue" | "mark_failed"): Promise<ActionResult> {
  const actor = await requireUser();
  return transition(campaignId, actor, (a) => resolveUnknownRecipient(a, recipientId, action), "No se pudo resolver el envío incierto.");
}

// ---------------------------------------------------------------------------------------------------------------------
// Remitentes y supresiones
// ---------------------------------------------------------------------------------------------------------------------
export interface SenderFormInput {
  id?: string;
  name: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  providerIdentity: string;
  ownerOrganizationId: string;
  active: boolean;
  isDefault: boolean;
}

export async function saveSenderAction(input: SenderFormInput): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    const payload = {
      name: input.name,
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      replyTo: input.replyTo || null,
      providerIdentity: input.providerIdentity || null,
      ownerOrganizationId: input.ownerOrganizationId || null,
      active: input.active,
      isDefault: input.isDefault,
    };
    if (input.id) await updateSender(actor, input.id, payload);
    else await createSender(actor, payload);
    revalidatePath("/mailing/remitentes");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: message(err, "No se pudo guardar el remitente.") };
  }
}

export interface VerifySenderResult extends ActionResult {
  /** Resultado de la consulta a SES, para mostrarlo siempre (también cuando no cambia nada). */
  outcome?: "verified" | "pending" | "failed" | "error";
  detail?: string;
  identity?: string;
  region?: string | null;
}

export async function verifySenderAction(id: string): Promise<VerifySenderResult> {
  const actor = await requireUser();
  try {
    const { check } = await verifySenderIdentity(actor, id);
    revalidatePath("/mailing/remitentes");
    // `ok` significa «se pudo consultar»: un error de SES vuelve visible con ok=false y el estado guardado intacto.
    return { ok: check.outcome !== "error", outcome: check.outcome, detail: check.message, identity: check.identity, region: check.region, error: check.outcome === "error" ? check.message : undefined };
  } catch (err) {
    return { ok: false, outcome: "error", error: message(err, "No se pudo verificar el remitente.") };
  }
}

export async function addSuppressionAction(email: string): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await addManualSuppression(actor, email);
    revalidatePath("/mailing/supresiones");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: message(err, "No se pudo agregar la supresión.") };
  }
}

export async function liftSuppressionAction(id: string, reason: string): Promise<ActionResult> {
  const actor = await requireUser();
  try {
    await liftSuppression(actor, id, reason);
    revalidatePath("/mailing/supresiones");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: message(err, "No se pudo levantar la supresión.") };
  }
}
