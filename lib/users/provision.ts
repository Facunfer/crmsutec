import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { sql, type Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { hashPassword } from "../auth/passwords.js";
import { assertMasterActor } from "../imports/gabriel/preflight.js";
import { OWNER_TYPE_KEY } from "../organizations/areas.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/users/provision.ts");

/**
 * Alta de un usuario de PRUEBA acotado a un Área (p. ej. `cultura.test@sutecba.local`, rol ADMIN, alcance = Cultura y
 * sus dependencias, sin acceso global). Es un comando de operación, no de la interfaz.
 *
 *  - Dry-run por defecto: solo comprueba y describe; no escribe nada ni genera contraseña.
 *  - Apply: crea el usuario con contraseña TEMPORAL fuerte (debe cambiarla al primer ingreso), afiliación = el Área,
 *    UN alcance sobre el Área (con dependientes) y los módulos indicados. La contraseña NUNCA se imprime: se guarda solo
 *    en un archivo local (fuera de Git, sin sobrescribir uno existente).
 *  - El alcance es el del Área: nunca se da alcance sobre SUTECBA (no contiene personas de ningún área) ni acceso global.
 */
export const DEFAULT_SCOPED_TEST_MODULES = ["dashboard", "personas", "asociaciones", "reuniones", "formularios", "visualizacion", "interacciones", "etiquetas", "administracion"] as const;

export class ProvisionError extends Error {}

export interface ProvisionInput {
  createdBy: string;
  email: string;
  fullName: string;
  roleKey: string;
  /** official_code del Área (ministerio, procuración…). */
  areaOfficialCode: string;
  includeDescendants?: boolean;
  moduleKeys?: readonly string[];
  /** Archivo donde se guarda la contraseña temporal. Debe quedar FUERA del repositorio y no existir. */
  credentialsFile: string;
  dryRun: boolean;
}

export interface ProvisionResult {
  mode: "dry-run" | "applied";
  email: string;
  role: string;
  area: { id: string; officialCode: string; name: string };
  scope: { organizationId: string; includeDescendants: boolean };
  modules: string[];
  globalAccess: false;
  mustChangePassword: true;
  userId?: string;
  credentialsFile: string;
  problems: string[];
}

/** Contraseña temporal fuerte: 24 caracteres aleatorios con mayúsculas, minúsculas, dígitos y símbolo. */
export function generateStrongPassword(): string {
  const base = randomBytes(18).toString("base64url");
  return `${base}Aa1!`;
}

function assertOutsideRepo(path: string): void {
  const abs = resolve(path);
  const rel = relative(process.cwd(), abs);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new ProvisionError("El archivo de credenciales debe quedar FUERA del repositorio (nunca en Git).");
}

export async function provisionScopedUser(db: Kysely<Database>, input: ProvisionInput): Promise<ProvisionResult> {
  const email = input.email.trim().toLowerCase();
  const modules = [...new Set(input.moduleKeys ?? DEFAULT_SCOPED_TEST_MODULES)];
  const includeDescendants = input.includeDescendants ?? true;
  const credentialsFile = resolve(input.credentialsFile);
  assertOutsideRepo(credentialsFile);
  if (input.roleKey === "MASTER_GLOBAL") throw new ProvisionError("Un usuario acotado a un Área no puede ser MASTER_GLOBAL.");

  const problems: string[] = [];
  const state = await db.transaction().execute(async (trx) => {
    await sql`set transaction read only`.execute(trx);
    await assertMasterActor(trx, input.createdBy).catch((e: Error) => problems.push(e.message));
    const role = await trx.selectFrom("roles").select("id").where("key", "=", input.roleKey).executeTakeFirst();
    if (!role) problems.push(`El rol ${input.roleKey} no existe.`);
    const area = await trx
      .selectFrom("organizations")
      .innerJoin("organization_types", "organization_types.id", "organizations.type_id")
      .select(["organizations.id", "organizations.name", "organizations.official_code", "organizations.active", "organizations.parent_id", "organization_types.key as type"])
      .where("organizations.official_code", "=", input.areaOfficialCode)
      .executeTakeFirst();
    if (!area) problems.push(`No existe una organización con official_code ${input.areaOfficialCode}.`);
    else {
      if (!area.active) problems.push("El Área no está activa.");
      if (area.type === OWNER_TYPE_KEY) problems.push("SUTECBA no es un Área: no se le da alcance sobre la organización propietaria.");
      if (area.parent_id !== null) problems.push("El código indicado no es un Área (raíz): usá el de la jurisdicción principal.");
    }
    const existing = await trx.selectFrom("users").select("id").where(({ fn }) => fn("lower", ["email"]), "=", email).executeTakeFirst();
    if (existing) problems.push("Ya existe un usuario con ese email.");
    const known = await trx.selectFrom("modules").select("key").where("key", "in", modules).execute();
    for (const m of modules) if (!known.some((k) => k.key === m)) problems.push(`El módulo ${m} no existe.`);
    return { roleId: role?.id ?? null, area: area ?? null };
  });
  if (existsSync(credentialsFile)) problems.push("El archivo de credenciales ya existe: no se sobrescribe.");

  const summary = (userId?: string): ProvisionResult => ({
    mode: input.dryRun ? "dry-run" : "applied",
    email,
    role: input.roleKey,
    area: { id: state.area?.id ?? "", officialCode: input.areaOfficialCode, name: state.area?.name ?? "" },
    scope: { organizationId: state.area?.id ?? "", includeDescendants },
    modules,
    globalAccess: false,
    mustChangePassword: true,
    userId,
    credentialsFile,
    problems,
  });

  if (input.dryRun) return summary();
  if (problems.length > 0) throw new ProvisionError(`No se crea el usuario: ${problems.join(" | ")}`);

  const password = generateStrongPassword();
  const passwordHash = await hashPassword(password);
  // El archivo primero (sin sobrescribir): si la transacción falla, se elimina. La contraseña nunca va a consola.
  mkdirSync(dirname(credentialsFile), { recursive: true });
  writeFileSync(
    credentialsFile,
    [
      "SUTECBA — usuario de prueba (contraseña TEMPORAL: se debe cambiar en el primer ingreso)",
      `email: ${email}`,
      `contraseña temporal: ${password}`,
      `rol: ${input.roleKey} · alcance: ${state.area!.name} (${input.areaOfficialCode})${includeDescendants ? " y dependencias" : ""} · sin acceso global`,
      "",
    ].join("\n"),
    { encoding: "utf-8", flag: "wx" }
  );

  try {
    const userId = await db.transaction().execute(async (trx) => {
      const user = await trx
        .insertInto("users")
        .values({
          email,
          password_hash: passwordHash,
          full_name: input.fullName.trim(),
          role_id: state.roleId!,
          must_change_password: true,
          primary_organization_id: state.area!.id,
          created_by: input.createdBy,
          updated_by: input.createdBy,
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("user_scopes")
        .values({ user_id: user.id, organization_id: state.area!.id, include_descendants: includeDescendants, granted_by: input.createdBy } as never)
        .execute();
      for (const moduleKey of modules) {
        await trx.insertInto("user_modules").values({ user_id: user.id, module_key: moduleKey, granted_by: input.createdBy } as never).execute();
      }
      return user.id;
    });
    return summary(userId);
  } catch (err) {
    try {
      unlinkSync(credentialsFile);
    } catch {
      /* el archivo era nuestro y recién creado */
    }
    throw err;
  }
}
