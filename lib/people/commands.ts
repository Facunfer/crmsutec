import { getDb } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { writeAuditLog } from "../audit/log.js";
import { toJsonb } from "../db/json.js";
import { can, type SessionUser } from "../permissions/can.js";
import { normalizeDni, normalizeEmail, normalizePhone } from "./normalize.js";
import type { PersonInput } from "./schema.js";

assertServerOnly("lib/people/commands.ts");

function toDateOrNull(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

export class PersonCommandError extends Error {
  code?: "DNI_DUPLICATE" | "OPTIMISTIC_LOCK" | "VALIDATION";
  /** Con DNI_DUPLICATE, el id de la persona existente — para armar el enlace a su ficha (sección 9 del prompt). */
  blockedByPersonId?: string;
  constructor(
    message: string,
    code?: "DNI_DUPLICATE" | "OPTIMISTIC_LOCK" | "VALIDATION",
    blockedByPersonId?: string
  ) {
    super(message);
    this.code = code;
    this.blockedByPersonId = blockedByPersonId;
  }
}

export interface NormalizedPersonInput {
  firstName: string;
  lastName: string;
  dni: string | null;
  email: string | null;
  phone: string | null;
  organizationId: string | null;
  birthDate: string | null;
  declaredAge: number | null;
}

export function normalizePersonInput(input: PersonInput): NormalizedPersonInput {
  const dni = input.dni ? normalizeDni(input.dni) : null;
  if (input.dni && !dni) {
    throw new PersonCommandError("El DNI ingresado no es válido.", "VALIDATION");
  }
  const email = input.email ? normalizeEmail(input.email) : null;
  if (input.email && !email) {
    throw new PersonCommandError("El email ingresado no es válido.", "VALIDATION");
  }
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (input.phone && !phone) {
    throw new PersonCommandError("El teléfono ingresado no es válido.", "VALIDATION");
  }

  return {
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    dni,
    email,
    phone,
    organizationId: input.organizationId || null,
    birthDate: input.birthDate || null,
    declaredAge:
      input.declaredAge === "" || input.declaredAge === undefined ? null : Number(input.declaredAge),
  };
}

export interface DuplicateWarning {
  field: "email" | "phone";
  personId: string;
  personName: string;
}

/** DNI → bloqueo; email/teléfono → advertencia (sección 9 del prompt). */
export async function findDuplicates(
  normalized: NormalizedPersonInput,
  excludePersonId?: string
): Promise<{ dniBlockedBy: { id: string; name: string } | null; warnings: DuplicateWarning[] }> {
  const db = await getDb();

  let dniBlockedBy: { id: string; name: string } | null = null;
  if (normalized.dni) {
    let q = db
      .selectFrom("people")
      .select(["id", "first_name", "last_name"])
      .where("dni", "=", normalized.dni)
      .where("status", "!=", "merged");
    if (excludePersonId) q = q.where("id", "!=", excludePersonId);
    const match = await q.executeTakeFirst();
    if (match) dniBlockedBy = { id: match.id, name: `${match.first_name} ${match.last_name}` };
  }

  const warnings: DuplicateWarning[] = [];
  if (normalized.email) {
    let q = db
      .selectFrom("people")
      .select(["id", "first_name", "last_name"])
      .where("email", "=", normalized.email)
      .where("status", "!=", "merged");
    if (excludePersonId) q = q.where("id", "!=", excludePersonId);
    const match = await q.executeTakeFirst();
    if (match) {
      warnings.push({ field: "email", personId: match.id, personName: `${match.first_name} ${match.last_name}` });
    }
  }
  if (normalized.phone) {
    let q = db
      .selectFrom("people")
      .select(["id", "first_name", "last_name"])
      .where("phone", "=", normalized.phone)
      .where("status", "!=", "merged");
    if (excludePersonId) q = q.where("id", "!=", excludePersonId);
    const match = await q.executeTakeFirst();
    if (match) {
      warnings.push({ field: "phone", personId: match.id, personName: `${match.first_name} ${match.last_name}` });
    }
  }

  return { dniBlockedBy, warnings };
}

export async function createPerson(
  actor: SessionUser,
  input: PersonInput,
  options: { confirmDuplicates?: boolean } = {}
): Promise<{ id: string } | { needsConfirmation: true; warnings: DuplicateWarning[] }> {
  assertPermission(actor, "people.create");

  const normalized = normalizePersonInput(input);
  const { dniBlockedBy, warnings } = await findDuplicates(normalized);

  if (dniBlockedBy) {
    throw new PersonCommandError(
      `Ya existe una persona con ese DNI: ${dniBlockedBy.name}.`,
      "DNI_DUPLICATE",
      dniBlockedBy.id
    );
  }

  if (warnings.length > 0 && !options.confirmDuplicates) {
    return { needsConfirmation: true, warnings };
  }

  const db = await getDb();
  const created = await db
    .insertInto("people")
    .values({
      first_name: normalized.firstName,
      last_name: normalized.lastName,
      dni: normalized.dni,
      email: normalized.email,
      phone: normalized.phone,
      organization_id: normalized.organizationId,
      birth_date: toDateOrNull(normalized.birthDate),
      declared_age: normalized.declaredAge,
      declared_age_at: normalized.declaredAge !== null ? new Date() : null,
      origin: "manual",
      created_by: actor.id,
      updated_by: actor.id,
      custom_fields: toJsonb({}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await writeAuditLog({
    actorUserId: actor.id,
    action: "PERSON_CREATED",
    entityType: "person",
    entityId: created.id,
    after: { first_name: normalized.firstName, last_name: normalized.lastName, dni: normalized.dni },
  });

  return { id: created.id };
}

export interface UpdatePersonResult {
  ok: true;
}

export async function updatePerson(
  actor: SessionUser,
  personId: string,
  expectedVersion: number,
  input: PersonInput,
  options: { confirmDuplicates?: boolean } = {}
): Promise<UpdatePersonResult | { needsConfirmation: true; warnings: DuplicateWarning[] }> {
  assertPermission(actor, "people.edit");

  const db = await getDb();
  const existing = await db.selectFrom("people").selectAll().where("id", "=", personId).executeTakeFirst();
  if (!existing) {
    throw new PersonCommandError("La persona no existe.");
  }

  const normalized = normalizePersonInput(input);

  // Quien no tiene people.view_sensitive tampoco puede escribir estos campos
  // a ciegas: la UI ya los deshabilita/enmascara (PersonForm), pero esto es
  // lo que realmente lo garantiza — nunca confiar en que el cliente no
  // manda un DNI/email/teléfono real igual saltándose el formulario.
  if (!can(actor, "people.view_sensitive")) {
    normalized.dni = existing.dni;
    normalized.email = existing.email;
    normalized.phone = existing.phone;
  }

  const { dniBlockedBy, warnings } = await findDuplicates(normalized, personId);

  if (dniBlockedBy) {
    throw new PersonCommandError(
      `Ya existe otra persona con ese DNI: ${dniBlockedBy.name}.`,
      "DNI_DUPLICATE",
      dniBlockedBy.id
    );
  }

  if (warnings.length > 0 && !options.confirmDuplicates) {
    return { needsConfirmation: true, warnings };
  }

  // OJO: no usar `numUpdatedRows` acá — con PGlite (kysely-pglite) ese
  // contador viene en 0 aunque el UPDATE sí haya afectado la fila (bug del
  // driver, confirmado a mano: el mismo UPDATE reporta numUpdatedRows=0n
  // pero el valor SÍ cambia en la base). `.returning()` no tiene ese
  // problema: devuelve undefined cuando el WHERE de verdad no matcheó.
  const updated = await db
    .updateTable("people")
    .set({
      first_name: normalized.firstName,
      last_name: normalized.lastName,
      dni: normalized.dni,
      email: normalized.email,
      phone: normalized.phone,
      organization_id: normalized.organizationId,
      birth_date: toDateOrNull(normalized.birthDate),
      declared_age: normalized.declaredAge,
      declared_age_at: normalized.declaredAge !== null ? new Date() : existing.declared_age_at,
      version: expectedVersion + 1,
      updated_by: actor.id,
      updated_at: new Date(),
    })
    .where("id", "=", personId)
    .where("version", "=", expectedVersion)
    .returning("id")
    .executeTakeFirst();

  if (!updated) {
    throw new PersonCommandError(
      "Alguien más editó esta persona mientras la estabas editando. Recargá la ficha y aplicá tus cambios de nuevo.",
      "OPTIMISTIC_LOCK"
    );
  }

  await writeAuditLog({
    actorUserId: actor.id,
    action: "PERSON_UPDATED",
    entityType: "person",
    entityId: personId,
    before: { first_name: existing.first_name, last_name: existing.last_name, dni: existing.dni, email: existing.email, phone: existing.phone },
    after: { first_name: normalized.firstName, last_name: normalized.lastName, dni: normalized.dni, email: normalized.email, phone: normalized.phone },
  });

  return { ok: true };
}

export async function setPersonActive(actor: SessionUser, personId: string, active: boolean): Promise<void> {
  assertPermission(actor, "people.deactivate");

  const db = await getDb();
  await db
    .updateTable("people")
    .set({ status: active ? "active" : "inactive", updated_by: actor.id, updated_at: new Date() })
    .where("id", "=", personId)
    .execute();

  await writeAuditLog({
    actorUserId: actor.id,
    action: active ? "PERSON_UPDATED" : "PERSON_DEACTIVATED",
    entityType: "person",
    entityId: personId,
    after: { status: active ? "active" : "inactive" },
  });
}
