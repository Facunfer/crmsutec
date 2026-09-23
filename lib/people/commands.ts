import { getDb } from "../db/client.js";
import { dateOnly } from "../db/date-only.js";
import { assertServerOnly } from "../server-only.js";
import { assertPermission } from "../auth/guard.js";
import { toJsonb } from "../db/json.js";
import { can, isMasterGlobal, type SessionUser } from "../permissions/can.js";
import { normalizeDni, normalizeEmail, normalizePhone } from "./normalize.js";
import type { PersonInput } from "./schema.js";
import { canAccessOrganization, canAccessPerson, orgScope } from "../scope/organizations.js";
import { isOwnerOrganization, OWNER_AS_WORK_UNIT_MESSAGE } from "../organizations/areas.js";

assertServerOnly("lib/people/commands.ts");

// AAAA-MM-DD como fecha sin hora: no depende de la zona horaria del proceso (ver lib/db/date-only.ts).
function toDateOrNull(value: string | null) {
  return dateOnly(value ? value.slice(0, 10) : null);
}

export class PersonCommandError extends Error {
  code?: "DNI_DUPLICATE" | "IDENTITY_CONFLICT" | "OPTIMISTIC_LOCK" | "VALIDATION";
  /** Con DNI_DUPLICATE, el id de la persona existente — para armar el enlace a su ficha (sección 9 del prompt). */
  blockedByPersonId?: string;
  constructor(
    message: string,
    code?: "DNI_DUPLICATE" | "IDENTITY_CONFLICT" | "OPTIMISTIC_LOCK" | "VALIDATION",
    blockedByPersonId?: string
  ) {
    super(message);
    this.code = code;
    this.blockedByPersonId = blockedByPersonId;
  }
}

/** Mensaje único para todo conflicto de identificación de un usuario que no es MASTER_GLOBAL. */
export const IDENTITY_CONFLICT_MESSAGE =
  "No se pudo completar el alta porque existe un conflicto de identificación. El caso requiere revisión.";

/**
 * Un DNI repetido bloquea el alta, pero decir CÓMO (en otra unidad, en la propia,
 * quién es) permitiría enumerar DNIs de personas fuera del alcance. Por eso un
 * usuario que no es MASTER_GLOBAL recibe siempre el mismo mensaje genérico, sin
 * nombre, unidad, id ni otro dato, y sin distinguir dónde está el conflicto.
 * MASTER_GLOBAL conserva el detalle necesario para resolverlo.
 */
function dniConflictError(
  actor: SessionUser,
  blocker: { id: string; name: string; inScope: boolean },
  detailPrefix: string
): PersonCommandError {
  if (!isMasterGlobal(actor)) return new PersonCommandError(IDENTITY_CONFLICT_MESSAGE, "IDENTITY_CONFLICT");
  return new PersonCommandError(`${detailPrefix}: ${blocker.name}.`, "DNI_DUPLICATE", blocker.id);
}

/** 23505 (unique_violation): la base es la última defensa ante dos altas simultáneas con el mismo DNI. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

export interface NormalizedPersonInput {
  firstName: string;
  lastName: string;
  dni: string;
  email: string | null;
  phone: string | null;
  organizationId: string | null;
  birthDate: string | null;
  declaredAge: number | null;
}

export function normalizePersonInput(input: PersonInput): NormalizedPersonInput {
  // El DNI es obligatorio para toda persona (0021): sin DNI no hay persona. La base lo vuelve a exigir
  // (NOT NULL + formato), pero acá se corta antes con un mensaje claro.
  if (!input.dni || !input.dni.trim()) {
    throw new PersonCommandError("El DNI es obligatorio.", "VALIDATION");
  }
  const dni = normalizeDni(input.dni);
  if (!dni) {
    throw new PersonCommandError("El DNI ingresado no es válido: deben ser 7 u 8 dígitos.", "VALIDATION");
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

/**
 * DNI → bloqueo; email/teléfono → advertencia (sección 9 del prompt).
 *
 * El DNI es único en toda la base, así que un DNI repetido bloquea aunque la
 * otra persona sea de otra unidad; pero entonces NO se revela quién es (ni su
 * id): `id` queda vacío y el nombre genérico. Las advertencias por email/teléfono
 * solo consideran personas dentro del alcance del usuario.
 */
export async function findDuplicates(
  actor: SessionUser,
  normalized: NormalizedPersonInput,
  excludePersonId?: string
): Promise<{ dniBlockedBy: { id: string; name: string; inScope: boolean } | null; warnings: DuplicateWarning[] }> {
  const db = await getDb();
  const inScope = orgScope(actor, "people.organization_id");

  let dniBlockedBy: { id: string; name: string; inScope: boolean } | null = null;
  if (normalized.dni) {
    let q = db
      .selectFrom("people")
      .select(["id", "first_name", "last_name", inScope.as("in_scope")])
      .where("dni", "=", normalized.dni)
      .where("status", "!=", "merged");
    if (excludePersonId) q = q.where("id", "!=", excludePersonId);
    const match = await q.executeTakeFirst();
    if (match) {
      dniBlockedBy = match.in_scope
        ? { id: match.id, name: `${match.first_name} ${match.last_name}`, inScope: true }
        : { id: "", name: "una persona de otra unidad", inScope: false };
    }
  }

  const warnings: DuplicateWarning[] = [];
  if (normalized.email) {
    let q = db
      .selectFrom("people")
      .select(["id", "first_name", "last_name"])
      .where("email", "=", normalized.email)
      .where("status", "!=", "merged")
      .where(inScope);
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
      .where("status", "!=", "merged")
      .where(inScope);
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

  // La persona nueva tiene que quedar dentro del alcance de quien la crea (un
  // usuario con alcance limitado no puede crear personas sin unidad ni ajenas).
  if (!(await canAccessOrganization(actor, normalized.organizationId))) {
    throw new PersonCommandError(
      "Indicá una unidad organizativa dentro de tu alcance.",
      "VALIDATION"
    );
  }

  if (normalized.organizationId && (await isOwnerOrganization(normalized.organizationId))) {
    throw new PersonCommandError(OWNER_AS_WORK_UNIT_MESSAGE, "VALIDATION");
  }

  const { dniBlockedBy, warnings } = await findDuplicates(actor, normalized);

  if (dniBlockedBy) throw dniConflictError(actor, dniBlockedBy, "Ya existe una persona con ese DNI");

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
    .executeTakeFirstOrThrow()
    .catch((err: unknown) => {
      // Carrera entre dos altas con el mismo DNI: gana una, la otra recibe el mismo conflicto genérico.
      if (isUniqueViolation(err)) throw new PersonCommandError(IDENTITY_CONFLICT_MESSAGE, "IDENTITY_CONFLICT");
      throw err;
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

  // Una persona fuera del alcance se trata como inexistente, aunque se conozca su id.
  if (!(await canAccessPerson(actor, personId))) {
    throw new PersonCommandError("La persona no existe.");
  }

  const db = await getDb();
  const existing = await db.selectFrom("people").selectAll().where("id", "=", personId).executeTakeFirst();
  if (!existing) {
    throw new PersonCommandError("La persona no existe.");
  }

  // Sin people.view_sensitive el DNI/email/teléfono llegan enmascarados o vacíos: se parte de los valores
  // guardados (el DNI sigue siendo obligatorio y no se puede borrar ni cambiar a ciegas).
  const sensitiveAllowed = can(actor, "people.view_sensitive");
  const normalized = normalizePersonInput(
    sensitiveAllowed ? input : { ...input, dni: existing.dni, email: existing.email ?? "", phone: existing.phone ?? "" }
  );

  // La repartición no se cambia editando la ficha: un cambio deja historial y
  // afecta quién ve a la persona, así que va por traslado (lib/people/transfers.ts).
  if (normalized.organizationId !== existing.organization_id) {
    throw new PersonCommandError(
      "La unidad organizativa no se cambia desde la edición: usá el traslado de repartición.",
      "VALIDATION"
    );
  }

  // Quien no tiene people.view_sensitive tampoco puede escribir estos campos
  // a ciegas: la UI ya los deshabilita/enmascara (PersonForm), pero esto es
  // lo que realmente lo garantiza — nunca confiar en que el cliente no
  // manda un DNI/email/teléfono real igual saltándose el formulario.
  if (!can(actor, "people.view_sensitive")) {
    normalized.dni = existing.dni;
    normalized.email = existing.email;
    normalized.phone = existing.phone;
  }

  const { dniBlockedBy, warnings } = await findDuplicates(actor, normalized, personId);

  if (dniBlockedBy) throw dniConflictError(actor, dniBlockedBy, "Ya existe otra persona con ese DNI");

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
    .executeTakeFirst()
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) throw new PersonCommandError(IDENTITY_CONFLICT_MESSAGE, "IDENTITY_CONFLICT");
      throw err;
    });

  if (!updated) {
    throw new PersonCommandError(
      "Alguien más editó esta persona mientras la estabas editando. Recargá la ficha y aplicá tus cambios de nuevo.",
      "OPTIMISTIC_LOCK"
    );
  }


  return { ok: true };
}

export async function setPersonActive(actor: SessionUser, personId: string, active: boolean): Promise<void> {
  assertPermission(actor, "people.deactivate");

  if (!(await canAccessPerson(actor, personId))) {
    throw new PersonCommandError("La persona no existe.");
  }

  const db = await getDb();
  await db
    .updateTable("people")
    .set({ status: active ? "active" : "inactive", updated_by: actor.id, updated_at: new Date() })
    .where("id", "=", personId)
    .execute();

}
