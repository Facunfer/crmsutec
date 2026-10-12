import { sql } from "kysely";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { isMasterGlobal, type SessionUser } from "../permissions/can.js";
import { canAccessOrganization, isUuid, orgScope } from "../scope/organizations.js";
import { headerSafe, normalizeEmail } from "./email.js";
import { getMailProvider } from "./providers/index.js";

assertServerOnly("lib/mailing/senders.ts");

export class SenderError extends Error {}

export interface SenderRow {
  id: string;
  name: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  active: boolean;
  isDefault: boolean;
  ownerOrganizationId: string | null;
  provider: "ses";
  providerIdentity: string | null;
  verifiedStatus: "pending" | "verified" | "failed" | "unknown";
  verifiedAt: Date | null;
  verifiedCheckedAt: Date | null;
}

interface DbSender {
  id: string; name: string; from_name: string; from_email: string; reply_to: string | null; active: boolean; is_default: boolean;
  owner_organization_id: string | null; provider: "ses"; provider_identity: string | null;
  verified_status: SenderRow["verifiedStatus"]; verified_at: Date | null; verified_checked_at: Date | null;
}

const toRow = (r: DbSender): SenderRow => ({
  id: r.id, name: r.name, fromName: r.from_name, fromEmail: r.from_email, replyTo: r.reply_to, active: r.active, isDefault: r.is_default,
  ownerOrganizationId: r.owner_organization_id, provider: r.provider, providerIdentity: r.provider_identity,
  verifiedStatus: r.verified_status, verifiedAt: r.verified_at, verifiedCheckedAt: r.verified_checked_at,
});

/** Remitente visible: global (sin unidad) o de una unidad dentro del alcance. MASTER_GLOBAL ve todos. */
function senderVisible(actor: SessionUser, alias = "s") {
  return orgScope(actor, `${alias}.owner_organization_id`, { includeNull: true });
}

/** Remitentes que el usuario puede ELEGIR para una campaña (activos y visibles). Con `includeInactive`, también los inactivos (administración). */
export async function listSenders(actor: SessionUser, options: { includeInactive?: boolean } = {}): Promise<SenderRow[]> {
  if (!actor.permissions.has("mailing.create") && !actor.permissions.has("mailing.manage_senders") && !actor.permissions.has("mailing.view")) {
    assertPermission(actor, "mailing.view");
  }
  const db = await getDb();
  const r = await sql<DbSender>`
    select s.* from mailing_senders s
    where ${senderVisible(actor)} and ${options.includeInactive ? sql`true` : sql`s.active = true`}
    order by s.is_default desc, s.name, s.id`.execute(db);
  return r.rows.map(toRow);
}

export async function getSender(actor: SessionUser, id: string): Promise<SenderRow | null> {
  if (!isUuid(id)) return null;
  const db = await getDb();
  const r = await sql<DbSender>`select s.* from mailing_senders s where s.id = ${id}::uuid and ${senderVisible(actor)}`.execute(db);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

const senderInput = z.object({
  name: z.string().trim().min(1).max(120),
  fromName: z.string().trim().min(1).max(120),
  fromEmail: z.string().trim().min(3).max(254),
  replyTo: z.string().trim().max(254).optional().nullable(),
  providerIdentity: z.string().trim().max(254).optional().nullable(),
  ownerOrganizationId: z.string().uuid().optional().nullable(),
  active: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});
export type SenderInput = z.input<typeof senderInput>;

function validate(input: SenderInput) {
  const parsed = senderInput.safeParse(input);
  if (!parsed.success) throw new SenderError(parsed.error.issues[0]?.message ?? "Datos del remitente inválidos.");
  const v = parsed.data;
  const fromEmail = normalizeEmail(v.fromEmail);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail)) throw new SenderError("El email del remitente no es válido.");
  const replyTo = v.replyTo ? normalizeEmail(v.replyTo) : null;
  if (replyTo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(replyTo)) throw new SenderError("El email de respuesta no es válido.");
  return {
    name: headerSafe(v.name),
    fromName: headerSafe(v.fromName),
    fromEmail,
    replyTo,
    providerIdentity: v.providerIdentity ? headerSafe(v.providerIdentity) : null,
    ownerOrganizationId: v.ownerOrganizationId ?? null,
    active: v.active ?? true,
    isDefault: v.isDefault ?? false,
  };
}

async function assertCanManageOwner(actor: SessionUser, ownerOrganizationId: string | null) {
  if (ownerOrganizationId === null) {
    if (!isMasterGlobal(actor)) throw new SenderError("Solo el Master global puede crear remitentes globales: elegí una unidad de tu alcance.");
    return;
  }
  if (!(await canAccessOrganization(actor, ownerOrganizationId))) throw new SenderError("La unidad no está dentro de tu alcance.");
}

export async function createSender(actor: SessionUser, input: SenderInput): Promise<{ id: string }> {
  assertPermission(actor, "mailing.manage_senders");
  const v = validate(input);
  await assertCanManageOwner(actor, v.ownerOrganizationId);
  const db = await getDb();
  try {
    return await db.transaction().execute(async (trx) => {
      if (v.isDefault) await sql`update mailing_senders set is_default = false, updated_at = now() where is_default`.execute(trx);
      const r = await sql<{ id: string }>`
        insert into mailing_senders (name, from_name, from_email, reply_to, active, is_default, owner_organization_id, provider_identity, created_by)
        values (${v.name}, ${v.fromName}, ${v.fromEmail}, ${v.replyTo}, ${v.active}, ${v.isDefault}, ${v.ownerOrganizationId}::uuid, ${v.providerIdentity}, ${actor.id}::uuid)
        returning id`.execute(trx);
      return { id: r.rows[0]!.id };
    });
  } catch (err) {
    if (/mailing_senders_from_email_unique_idx/.test(String((err as Error).message))) throw new SenderError("Ya existe un remitente con ese email.");
    throw err;
  }
}

export async function updateSender(actor: SessionUser, id: string, input: SenderInput): Promise<void> {
  assertPermission(actor, "mailing.manage_senders");
  const current = await getSender(actor, id);
  if (!current) throw new SenderError("Remitente no encontrado.");
  const v = validate(input);
  await assertCanManageOwner(actor, current.ownerOrganizationId);
  await assertCanManageOwner(actor, v.ownerOrganizationId);
  const identityChanged = v.fromEmail !== current.fromEmail || (v.providerIdentity ?? null) !== (current.providerIdentity ?? null);
  const db = await getDb();
  try {
    await db.transaction().execute(async (trx) => {
      if (v.isDefault) await sql`update mailing_senders set is_default = false, updated_at = now() where is_default and id <> ${id}::uuid`.execute(trx);
      await sql`
        update mailing_senders set name = ${v.name}, from_name = ${v.fromName}, from_email = ${v.fromEmail}, reply_to = ${v.replyTo},
          active = ${v.active}, is_default = ${v.isDefault}, owner_organization_id = ${v.ownerOrganizationId}::uuid,
          provider_identity = ${v.providerIdentity},
          verified_status = ${identityChanged ? "pending" : current.verifiedStatus}, verified_at = ${identityChanged ? null : current.verifiedAt},
          updated_at = now()
        where id = ${id}::uuid`.execute(trx);
    });
  } catch (err) {
    if (/mailing_senders_from_email_unique_idx/.test(String((err as Error).message))) throw new SenderError("Ya existe un remitente con ese email.");
    throw err;
  }
}

/** Consulta al proveedor si la identidad del remitente está verificada (email o dominio) y guarda el resultado. */
export async function refreshSenderVerification(actor: SessionUser, id: string): Promise<SenderRow> {
  assertPermission(actor, "mailing.manage_senders");
  const sender = await getSender(actor, id);
  if (!sender) throw new SenderError("Remitente no encontrado.");
  const provider = getMailProvider();
  const identity = sender.providerIdentity ?? sender.fromEmail;
  let status = await provider.getIdentityStatus(identity);
  if (status !== "verified" && !sender.providerIdentity) {
    const domain = sender.fromEmail.split("@")[1];
    if (domain) {
      const domainStatus = await provider.getIdentityStatus(domain);
      if (domainStatus === "verified") status = "verified";
      else if (status === "unknown") status = domainStatus;
    }
  }
  const db = await getDb();
  await sql`
    update mailing_senders set verified_status = ${status}, verified_checked_at = now(),
      verified_at = case when ${status} = 'verified' then coalesce(verified_at, now()) else null end, updated_at = now()
    where id = ${id}::uuid`.execute(db);
  return (await getSender(actor, id))!;
}

/** Un remitente es USABLE para enviar si es visible, está activo y verificado. */
export async function requireUsableSender(actor: SessionUser, senderId: string | null): Promise<SenderRow> {
  if (!senderId) throw new SenderError("Elegí un remitente.");
  const sender = await getSender(actor, senderId);
  if (!sender) throw new SenderError("El remitente no existe o no está disponible para vos.");
  if (!sender.active) throw new SenderError("El remitente está inactivo.");
  if (sender.verifiedStatus !== "verified") {
    throw new SenderError(`El remitente no está verificado en Amazon SES (estado: ${sender.verifiedStatus}). Verificalo antes de enviar.`);
  }
  return sender;
}
