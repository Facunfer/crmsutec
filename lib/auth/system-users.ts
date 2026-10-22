import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/auth/system-users.ts");

type Db = Kysely<Database> | Transaction<Database>;

/**
 * Usuario de sistema «Sistema (formularios)»: autor de las inscripciones automáticas que nacen de una respuesta pública.
 *
 * En `meeting_participations` y `meeting_registration_events` una inscripción operativa exige un usuario (`recorded_by`) y «sin usuario»
 * significa histórica/importada (0041/0042). Una respuesta pública no tiene usuario: en vez de aflojar esas reglas, el acto se atribuye a este
 * usuario, que es INACTIVO (el login lo rechaza), tiene una contraseña imposible, rol LECTURA y ningún alcance. Lo crea la migración 0048 en
 * una base con roles y, de forma idempotente, el seed y esta función (bases nuevas, donde los roles los crea el seed).
 */
export const FORM_SYSTEM_USER_EMAIL = "sistema.formularios@sutecba.local";
const FORM_SYSTEM_USER_NAME = "Sistema (formularios)";
/** No es un hash bcrypt válido: ninguna contraseña lo verifica. */
const UNUSABLE_PASSWORD_HASH = "!sin-acceso";

export async function ensureFormSystemUser(db: Db): Promise<string> {
  const existing = await db.selectFrom("users").select("id").where("email", "=", FORM_SYSTEM_USER_EMAIL).executeTakeFirst();
  if (existing) return existing.id;

  const role = await db.selectFrom("roles").select("id").where("key", "=", "LECTURA").executeTakeFirst();
  if (!role) throw new Error("Falta el rol LECTURA: ejecutá el seed antes de usar inscripciones automáticas.");

  const created = await db
    .insertInto("users")
    .values({
      email: FORM_SYSTEM_USER_EMAIL,
      password_hash: UNUSABLE_PASSWORD_HASH,
      full_name: FORM_SYSTEM_USER_NAME,
      role_id: role.id,
      status: "inactive",
      must_change_password: true,
    })
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst();
  if (created) return created.id;

  // Otra transacción lo creó entre la lectura y el insert.
  const again = await db.selectFrom("users").select("id").where("email", "=", FORM_SYSTEM_USER_EMAIL).executeTakeFirstOrThrow();
  return again.id;
}
