import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv, resolvePgliteDataDir } from "../lib/db/env.js";
import { activateMigrationConnection } from "../lib/db/script-env.js";
import {
  assertNoForeignFootprint,
  assertNotBlockedTarget,
  assertOrBootstrapSystemIdentity,
  describeTarget,
  GuardViolationError,
} from "../lib/db/guards.js";
import { MODULES, PERMISSIONS, ROLE_PERMISSIONS, ROLES } from "../lib/permissions/catalog.js";
import { toJsonb } from "../lib/db/json.js";
import type { Json } from "../lib/db/schema.js";

/** Configuración por defecto; solo se inserta si la clave todavía no existe. */
const DEFAULT_SETTINGS: Array<{ key: string; value: Json }> = [
  { key: "sutecba_tz", value: "America/Argentina/Buenos_Aires" },
  { key: "checkin_rate_limit_per_ip_per_10min", value: 30 },
  { key: "login_rate_limit_per_account_per_10min", value: 5 },
  { key: "qr_rotation_seconds", value: 45 },
  { key: "invitation_response_editable_until_meeting_start", value: true },
];

/**
 * Niveles genéricos de la estructura del Estado (sección 4 del prompt: tres
 * poderes, entes autárquicos, Legislatura, entes públicos no estatales,
 * jubilados/pensionados). Es taxonomía, no datos de negocio: los organismos
 * concretos (ej. "Ministerio de Educación") los carga un administrador
 * desde /administracion/organismos, nunca un seed.
 */
const ORGANIZATION_TYPES: Array<{ key: string; name: string; level: number }> = [
  { key: "poder", name: "Poder", level: 0 },
  { key: "ministerio", name: "Ministerio", level: 1 },
  { key: "ente_autarquico", name: "Ente autárquico", level: 1 },
  { key: "ente_publico_no_estatal", name: "Ente público no estatal", level: 1 },
  { key: "dependencia", name: "Dependencia", level: 2 },
  { key: "jubilados_pensionados", name: "Jubilados y pensionados", level: 0 },
  // Niveles intermedios del organigrama (ministerio → secretaría → … → repartición).
  { key: "secretaria", name: "Secretaría", level: 2 },
  { key: "subsecretaria", name: "Subsecretaría", level: 3 },
  { key: "direccion_general", name: "Dirección General", level: 4 },
  { key: "direccion", name: "Dirección", level: 5 },
  { key: "reparticion", name: "Repartición", level: 6 },
];

/**
 * Estructura interna del sindicato tal como la describe la sección 4 del
 * prompt (delegados, congresales, Consejo Directivo, comisiones,
 * agrupaciones, grupos de trabajo). Es taxonomía genérica del tipo de
 * organización, no contenido de este cliente en particular: nombres de
 * dirigentes o asociaciones concretas no se siembran nunca.
 */
const ASSOCIATION_TYPES: Array<{ key: string; name: string }> = [
  { key: "delegados_personal", name: "Delegados del personal" },
  { key: "delegados_congresales", name: "Delegados congresales" },
  { key: "consejo_directivo", name: "Consejo Directivo" },
  { key: "comision", name: "Comisión" },
  { key: "agrupacion", name: "Agrupación" },
  { key: "grupo_trabajo", name: "Grupo de trabajo" },
];

/** Catálogo de tipos de interacción (migración 0017); `sort_order` define el orden en los selectores. */
const INTERACTION_TYPES: Array<{ key: string; name: string; sortOrder: number }> = [
  { key: "consulta", name: "Consulta", sortOrder: 10 },
  { key: "llamada", name: "Llamada", sortOrder: 20 },
  { key: "gestion", name: "Gestión", sortOrder: 30 },
  { key: "visita", name: "Visita", sortOrder: 40 },
  { key: "participation", name: "Participación en actividad", sortOrder: 15 },
  { key: "otro", name: "Otro", sortOrder: 100 },
];

const INTERACTION_CHANNELS: Array<{ key: string; name: string; sortOrder: number }> = [
  { key: "presencial", name: "Presencial", sortOrder: 10 },
  { key: "telefono", name: "Teléfono", sortOrder: 20 },
  { key: "correo", name: "Correo", sortOrder: 30 },
  { key: "whatsapp", name: "WhatsApp", sortOrder: 40 },
  { key: "formulario", name: "Formulario", sortOrder: 50 },
  { key: "otro", name: "Otro", sortOrder: 100 },
];

/** Reutilizable desde el CLI y desde tests de integración. No cierra la conexión. */
export async function runSeed(): Promise<void> {
  const usingAdminConnection = activateMigrationConnection();
  const env = loadEnv();
  const pgliteDataDir = resolvePgliteDataDir(env);
  console.log(
    `[seed] destino: ${describeTarget(env, pgliteDataDir)}` +
      (usingAdminConnection ? " (conexión de migraciones)" : "")
  );

  assertNotBlockedTarget(env, pgliteDataDir);
  const db = await getDb();
  await assertNoForeignFootprint(db);
  await assertOrBootstrapSystemIdentity(db);

  for (const role of ROLES) {
    await db
      .insertInto("roles")
      .values({ key: role.key, name: role.name, is_system: true })
      .onConflict((oc) => oc.column("key").doUpdateSet({ name: role.name }))
      .execute();
  }

  // Los módulos van antes que los permisos: permissions.module_key referencia modules(key).
  for (const module of MODULES) {
    await db
      .insertInto("modules")
      .values({ key: module.key, name: module.name, sort_order: module.sortOrder, active: true })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ name: module.name, sort_order: module.sortOrder, active: true })
      )
      .execute();
  }

  for (const permission of PERMISSIONS) {
    await db
      .insertInto("permissions")
      .values({
        key: permission.key,
        description: permission.description,
        module_key: permission.moduleKey,
      })
      .onConflict((oc) =>
        oc
          .column("key")
          .doUpdateSet({ description: permission.description, module_key: permission.moduleKey })
      )
      .execute();
  }

  const roleRows = await db.selectFrom("roles").select(["id", "key"]).execute();
  const roleIdByKey = new Map(roleRows.map((r) => [r.key, r.id]));

  const permissionRows = await db.selectFrom("permissions").select(["id", "key"]).execute();
  const permissionIdByKey = new Map(permissionRows.map((r) => [r.key, r.id]));

  for (const [roleKey, permissionKeys] of Object.entries(ROLE_PERMISSIONS)) {
    const roleId = roleIdByKey.get(roleKey);
    if (!roleId) throw new Error(`Rol ${roleKey} no encontrado tras el seed de roles.`);

    const desiredIds = new Set(
      permissionKeys.map((k) => {
        const id = permissionIdByKey.get(k);
        if (!id) throw new Error(`Permiso ${k} no encontrado tras el seed de permisos.`);
        return id;
      })
    );

    const current = await db
      .selectFrom("role_permissions")
      .select("permission_id")
      .where("role_id", "=", roleId)
      .execute();
    const currentIds = new Set(current.map((r) => r.permission_id));

    const toAdd = [...desiredIds].filter((id) => !currentIds.has(id));
    const toRemove = [...currentIds].filter((id) => !desiredIds.has(id));

    if (toAdd.length > 0) {
      await db
        .insertInto("role_permissions")
        .values(toAdd.map((permission_id) => ({ role_id: roleId, permission_id })))
        .execute();
    }
    if (toRemove.length > 0) {
      await db
        .deleteFrom("role_permissions")
        .where("role_id", "=", roleId)
        .where("permission_id", "in", toRemove)
        .execute();
    }
  }

  for (const type of ORGANIZATION_TYPES) {
    await db
      .insertInto("organization_types")
      .values({ key: type.key, name: type.name, level: type.level, active: true })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ name: type.name, level: type.level, active: true })
      )
      .execute();
  }

  for (const type of ASSOCIATION_TYPES) {
    await db
      .insertInto("association_types")
      .values({ key: type.key, name: type.name, active: true })
      .onConflict((oc) => oc.column("key").doUpdateSet({ name: type.name, active: true }))
      .execute();
  }

  for (const type of INTERACTION_TYPES) {
    await db
      .insertInto("interaction_types")
      .values({ key: type.key, name: type.name, sort_order: type.sortOrder, active: true })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ name: type.name, sort_order: type.sortOrder, active: true })
      )
      .execute();
  }

  for (const channel of INTERACTION_CHANNELS) {
    await db
      .insertInto("interaction_channels")
      .values({ key: channel.key, name: channel.name, sort_order: channel.sortOrder, active: true })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ name: channel.name, sort_order: channel.sortOrder, active: true })
      )
      .execute();
  }

  for (const setting of DEFAULT_SETTINGS) {
    await db
      .insertInto("app_settings")
      .values({ key: setting.key, value: toJsonb(setting.value) })
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();
  }

  console.log(
    `[seed] listo. ${ROLES.length} roles, ${MODULES.length} módulos, ${PERMISSIONS.length} permisos, ` +
      `${ORGANIZATION_TYPES.length} tipos de organismo, ${ASSOCIATION_TYPES.length} tipos de asociación, ` +
      `${INTERACTION_TYPES.length} tipos y ${INTERACTION_CHANNELS.length} canales de interacción, ` +
      `${DEFAULT_SETTINGS.length} configuraciones por defecto (sin sobreescribir existentes). ` +
      `Sin personas, organismos ni asociaciones concretas de ejemplo.`
  );
}

async function main() {
  await runSeed();
  await closeDb();
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    if (err instanceof GuardViolationError) {
      console.error(`[seed] ABORTADO por guarda: ${err.message}`);
    } else {
      console.error("[seed] error:", err);
    }
    process.exitCode = 1;
  });
}
