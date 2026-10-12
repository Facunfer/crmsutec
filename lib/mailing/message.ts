import { assertServerOnly } from "../server-only.js";
import type { MailConfig } from "./config.js";
import { formatAddress, headerSafe } from "./email.js";
import type { OutboundMessage } from "./providers/types.js";
import { createUnsubscribeToken } from "./tokens.js";
import { renderMessage, type MergeVars } from "./template.js";

assertServerOnly("lib/mailing/message.ts");

export interface CampaignContent {
  id: string;
  subject: string;
  preheader: string | null;
  htmlBody: string;
  textBody: string;
  replyTo: string | null;
}

export interface SenderIdentity {
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
}

export interface RecipientForMessage {
  id: string;
  normalizedEmail: string;
  mergeVars: MergeVars;
}

/** Arma el mensaje saliente de UN destinatario: variables escapadas, enlace de baja firmado y cabeceras List-Unsubscribe (RFC 8058). */
export function buildOutboundMessage(
  campaign: CampaignContent,
  sender: SenderIdentity,
  recipient: RecipientForMessage,
  config: Pick<MailConfig, "publicBaseUrl" | "unsubscribeSecret">
): OutboundMessage {
  if (!config.publicBaseUrl || !config.unsubscribeSecret) throw new Error("Falta PUBLIC_BASE_URL o MAIL_UNSUBSCRIBE_SECRET.");
  const token = createUnsubscribeToken(recipient.id, config.unsubscribeSecret);
  const pageUrl = `${config.publicBaseUrl}/unsubscribe/${token}`;
  const oneClickUrl = `${config.publicBaseUrl}/api/unsubscribe/${token}`;
  const rendered = renderMessage({
    subject: campaign.subject,
    preheader: campaign.preheader,
    htmlBody: campaign.htmlBody,
    textBody: campaign.textBody,
    vars: recipient.mergeVars,
    unsubscribeUrl: pageUrl,
  });
  return {
    to: recipient.normalizedEmail,
    from: formatAddress(sender.fromName, sender.fromEmail),
    replyTo: campaign.replyTo ?? sender.replyTo ? headerSafe((campaign.replyTo ?? sender.replyTo)!) : null,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: { "List-Unsubscribe": `<${oneClickUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    tags: { campaign_id: campaign.id },
  };
}
