import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv, resolvePgliteDataDir } from "../lib/db/env.js";
import {
  assertNoForeignFootprint,
  assertNotBlockedTarget,
  assertOrBootstrapSystemIdentity,
  describeTarget,
  GuardViolationError,
} from "../lib/db/guards.js";
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from "../lib/permissions/catalog.js";
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

/** Reutilizable desde el CLI y desde tests de integración. No cierra la conexión. */
export async function runSeed(): Promise<void> {
  const env = loadEnv();
  const pgliteDataDir = resolvePgliteDataDir(env);
  console.log(`[seed] destino: ${describeTarget(env, pgliteDataDir)}`);

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

  for (const permission of PERMISSIONS) {
    await db
      .insertInto("permissions")
      .values({ key: permission.key, description: permission.description })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ description: permission.description })
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

  for (const setting of DEFAULT_SETTINGS) {
    await db
      .insertInto("app_settings")
      .values({ key: setting.key, value: toJsonb(setting.value) })
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();
  }

  console.log(
    `[seed] listo. ${ROLES.length} roles, ${PERMISSIONS.length} permisos, ` +
      `${DEFAULT_SETTINGS.length} configuraciones por defecto (sin sobreescribir existentes). ` +
      `Sin personas de ejemplo.`
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
