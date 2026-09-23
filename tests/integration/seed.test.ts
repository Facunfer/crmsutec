import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { MODULES, PERMISSIONS, ROLE_PERMISSIONS, ROLES } = await import("../../lib/permissions/catalog.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;

async function snapshot() {
  const db = await getDb();
  const [modules, permissions, roles, rolePerms, orgTypes, assocTypes, iTypes, iChannels, settings] =
    await Promise.all([
      db.selectFrom("modules").selectAll().orderBy("key").execute(),
      db.selectFrom("permissions").select(["key", "description", "module_key"]).orderBy("key").execute(),
      db.selectFrom("roles").select(["key", "name", "is_system"]).orderBy("key").execute(),
      db
        .selectFrom("role_permissions")
        .innerJoin("roles", "roles.id", "role_permissions.role_id")
        .innerJoin("permissions", "permissions.id", "role_permissions.permission_id")
        .select(["roles.key as role", "permissions.key as permission"])
        .orderBy("roles.key")
        .orderBy("permissions.key")
        .execute(),
      db.selectFrom("organization_types").select(["key", "name", "level", "active"]).orderBy("key").execute(),
      db.selectFrom("association_types").select(["key", "name", "active"]).orderBy("key").execute(),
      db.selectFrom("interaction_types").select(["key", "name", "active", "sort_order"]).orderBy("key").execute(),
      db.selectFrom("interaction_channels").select(["key", "name", "active", "sort_order"]).orderBy("key").execute(),
      db.selectFrom("app_settings").selectAll().orderBy("key").execute(),
    ]);
  return { modules, permissions, roles, rolePerms, orgTypes, assocTypes, iTypes, iChannels, settings };
}

let first: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  first = await snapshot();
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("seed (catálogo → base)", () => {
  it("es idempotente: correrlo de nuevo deja exactamente el mismo estado", async () => {
    await runSeed();
    expect(await snapshot()).toEqual(first);
  });

  it("ningún permiso queda sin module_key y todos apuntan al módulo del catálogo", () => {
    expect(first.permissions.every((p) => p.module_key !== null)).toBe(true);
    const expected = new Map<string, string>(PERMISSIONS.map((p) => [p.key, p.moduleKey]));
    for (const p of first.permissions) expect(p.module_key).toBe(expected.get(p.key));
    expect(first.permissions).toHaveLength(PERMISSIONS.length);
  });

  it("los 10 módulos esperados existen y están activos", () => {
    expect(first.modules.map((m) => m.key).sort()).toEqual(MODULES.map((m) => m.key).sort());
    expect(first.modules.every((m) => m.active)).toBe(true);
  });

  it("role_permissions coincide exactamente con ROLE_PERMISSIONS", () => {
    for (const role of ROLES) {
      const inDb = first.rolePerms
        .filter((r) => r.role === role.key)
        .map((r) => r.permission)
        .sort();
      expect(inDb, role.key).toEqual([...ROLE_PERMISSIONS[role.key]].sort());
    }
  });

  it("quita de un rol los permisos que ya no le corresponden", async () => {
    const db = await getDb();
    const role = await db.selectFrom("roles").select("id").where("key", "=", "LECTURA").executeTakeFirstOrThrow();
    const extra = await db
      .selectFrom("permissions")
      .select("id")
      .where("key", "=", "people.export")
      .executeTakeFirstOrThrow();
    await db.insertInto("role_permissions").values({ role_id: role.id, permission_id: extra.id }).execute();

    await runSeed();
    expect(await snapshot()).toEqual(first);
  });

  it("carga los tipos y canales de interacción esperados", () => {
    expect(first.iTypes.map((t) => [t.key, t.name, t.sort_order, t.active])).toEqual([
      ["consulta", "Consulta", 10, true],
      ["gestion", "Gestión", 30, true],
      ["llamada", "Llamada", 20, true],
      ["otro", "Otro", 100, true],
      ["participation", "Participación en actividad", 15, true],
      ["visita", "Visita", 40, true],
    ]);
    expect(first.iChannels.map((c) => [c.key, c.name, c.sort_order, c.active])).toEqual([
      ["correo", "Correo", 30, true],
      ["formulario", "Formulario", 50, true],
      ["otro", "Otro", 100, true],
      ["presencial", "Presencial", 10, true],
      ["telefono", "Teléfono", 20, true],
      ["whatsapp", "WhatsApp", 40, true],
    ]);
  });

  it("carga los tipos de organización (con los niveles intermedios) y de asociación", () => {
    const org = new Map(first.orgTypes.map((t) => [t.key, t.level]));
    expect(org.size).toBe(11);
    expect(org.get("secretaria")).toBe(2);
    expect(org.get("subsecretaria")).toBe(3);
    expect(org.get("direccion_general")).toBe(4);
    expect(org.get("direccion")).toBe(5);
    expect(org.get("reparticion")).toBe(6);
    expect(first.orgTypes.every((t) => t.active)).toBe(true);
    expect(first.assocTypes).toHaveLength(6);
    expect(first.assocTypes.every((t) => t.active)).toBe(true);
  });

  it("no pisa configuraciones que un administrador ya cambió", async () => {
    const db = await getDb();
    await db.updateTable("app_settings").set({ value: "60" }).where("key", "=", "qr_rotation_seconds").execute();
    await runSeed();
    const row = await db
      .selectFrom("app_settings")
      .select("value")
      .where("key", "=", "qr_rotation_seconds")
      .executeTakeFirstOrThrow();
    expect(row.value).toBe(60);
  });
});
