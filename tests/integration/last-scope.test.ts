import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb, execRawSql } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { ROLE_PERMISSIONS, PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { createUser, grantUserScope, revokeUserScope, UserCommandError } = await import("../../lib/users/commands.js");
const { getUserAccess, isUserAdministrable } = await import("../../lib/users/administration.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;

function session(id: string, roleKey: string, permissions: Iterable<string>) {
  return {
    id,
    email: `${id}@sutecba.local`,
    fullName: "Actor de prueba",
    roleId: "n/a",
    roleKey: roleKey as any,
    mustChangePassword: false,
    enabledModules: ALL_MODULE_KEYS,
    permissions: new Set(permissions) as ReadonlySet<any>,
  };
}

const orgIds = new Map<string, string>();
const o = (name: string) => orgIds.get(name)!;
let master: ReturnType<typeof session>;
let admin: ReturnType<typeof session>;
let seq = 0;

async function makeOrg(name: string, parentId: string | null) {
  const db = await getDb();
  const type = await db.selectFrom("organization_types").select("id").where("key", "=", "reparticion").executeTakeFirstOrThrow();
  const row = await db.insertInto("organizations").values({ name, type_id: type.id, parent_id: parentId }).returning("id").executeTakeFirstOrThrow();
  orgIds.set(name, row.id);
}

/** Usuario nuevo (rol OPERADOR) con los alcances indicados, creado por el master. */
async function makeUser(scopes: string[]) {
  const { userId } = await createUser(master, {
    email: `u${++seq}@sutecba.local`,
    fullName: `Usuario ${seq}`,
    roleKey: "OPERADOR",
    scopes: scopes.map((name) => ({ organizationId: o(name), includeDescendants: false })),
    moduleKeys: ["personas"],
  });
  return userId;
}

async function activeScopes(userId: string) {
  return (await getUserAccess(userId)).scopes;
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  await makeOrg("A", null);
  await makeOrg("A1", o("A"));
  await makeOrg("A2", o("A"));
  await makeOrg("B", null);

  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const masterRow = await db
    .insertInto("users")
    .values({ email: "master@sutecba.local", password_hash: await hashPassword("bootstrap-password-123"), full_name: "Master", role_id: role.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  master = session(masterRow.id, "MASTER_GLOBAL", PERMISSIONS.map((p) => p.key));

  const { userId } = await createUser(master, {
    email: "admin@sutecba.local",
    fullName: "Admin",
    roleKey: "ADMIN",
    scopes: [{ organizationId: o("A"), includeDescendants: true }],
    moduleKeys: ["administracion", "personas"],
  });
  admin = session(userId, "ADMIN", ROLE_PERMISSIONS.ADMIN);
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("un delegado no puede revocar el último alcance activo", () => {
  it("1) ADMIN delegado no puede quitar el último scope activo", async () => {
    const target = await makeUser(["A1"]);
    const [only] = await activeScopes(target);

    await expect(revokeUserScope(admin, target, only!.id)).rejects.toThrow(/último alcance/);
    expect(await activeScopes(target)).toHaveLength(1);
    expect(await isUserAdministrable(admin, target)).toBe(true);
  });

  it("2) ADMIN puede revocar un scope si al usuario le queda otro válido", async () => {
    const target = await makeUser(["A1", "A2"]);
    const scopes = await activeScopes(target);
    const a1 = scopes.find((s) => s.organizationId === o("A1"))!;

    await expect(revokeUserScope(admin, target, a1.id)).resolves.toBeUndefined();
    const left = await activeScopes(target);
    expect(left.map((s) => s.organizationId)).toEqual([o("A2")]);

    // ...pero ese que queda ya es el último.
    await expect(revokeUserScope(admin, target, left[0]!.id)).rejects.toThrow(/último alcance/);
  });

  it("3) MASTER_GLOBAL sí puede revocar el último scope, deliberadamente", async () => {
    const target = await makeUser(["B"]);
    const [only] = await activeScopes(target);

    await expect(revokeUserScope(master, target, only!.id)).resolves.toBeUndefined();
    expect(await activeScopes(target)).toHaveLength(0);

    const db = await getDb();
    const row = await db.selectFrom("user_scopes").select(["revoked_at", "revoked_by"]).where("id", "=", only!.id).executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_by).toBe(master.id);
  });

  it("4) dos revocaciones simultáneas de los dos últimos scopes no lo esquivan: solo prospera una", async () => {
    const target = await makeUser(["A1", "A2"]);
    const [first, second] = await activeScopes(target);

    const results = await Promise.allSettled([
      revokeUserScope(admin, target, first!.id),
      revokeUserScope(admin, target, second!.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(UserCommandError);
    expect(await activeScopes(target)).toHaveLength(1);
  });

  it("4b) un alcance que no es del usuario indicado no se revoca (no sirve para tocar otro usuario)", async () => {
    const victim = await makeUser(["A1"]);
    const other = await makeUser(["A1", "A2"]);
    const victimScope = (await activeScopes(victim))[0]!;

    await expect(revokeUserScope(admin, other, victimScope.id)).rejects.toThrow(UserCommandError);
    expect(await activeScopes(victim)).toHaveLength(1);
  });

  it("5) el usuario sigue siendo administrable después de una revocación válida", async () => {
    const target = await makeUser(["A1", "A2"]);
    const a1 = (await activeScopes(target)).find((s) => s.organizationId === o("A1"))!;

    await revokeUserScope(admin, target, a1.id);
    expect(await isUserAdministrable(admin, target)).toBe(true);
  });
});

describe("migración 0020: la misma garantía en la base", () => {
  // 0020 ya forma parte de db/migrations: acá está aplicada desde el beforeAll general.
  it("un UPDATE directo que revoca todos los alcances de un usuario, por un no-master, se rechaza", async () => {
    const target = await makeUser(["A1", "A2"]);
    const db = await getDb();

    await expect(
      db
        .updateTable("user_scopes")
        .set({ revoked_at: new Date(), revoked_by: admin.id })
        .where("user_id", "=", target)
        .where("revoked_at", "is", null)
        .execute()
    ).rejects.toThrow(/último alcance/);
    expect(await activeScopes(target)).toHaveLength(2);
  });

  it("revocar uno solo de dos, o que lo haga el master, sigue permitido", async () => {
    const db = await getDb();
    const target = await makeUser(["A1", "A2"]);
    const [first] = await activeScopes(target);

    await db.updateTable("user_scopes").set({ revoked_at: new Date(), revoked_by: admin.id }).where("id", "=", first!.id).execute();
    expect(await activeScopes(target)).toHaveLength(1);

    await db
      .updateTable("user_scopes")
      .set({ revoked_at: new Date(), revoked_by: master.id })
      .where("user_id", "=", target)
      .where("revoked_at", "is", null)
      .execute();
    expect(await activeScopes(target)).toHaveLength(0);
  });

  it("reemplazar un alcance (conceder el nuevo y revocar el viejo, en ese orden) está permitido", async () => {
    const target = await makeUser(["A1"]);
    const [old] = await activeScopes(target);
    await grantUserScope(admin, target, { organizationId: o("A2"), includeDescendants: false });
    await revokeUserScope(admin, target, old!.id);
    expect((await activeScopes(target)).map((s) => s.organizationId)).toEqual([o("A2")]);
  });

  it("el trigger existe, es único y la migración figura como aplicada", async () => {
    const db = await getDb();
    const triggers = await sql<{ tgname: string }>`select tgname from pg_trigger where tgrelid = 'public.user_scopes'::regclass and not tgisinternal`.execute(db);
    expect(triggers.rows.filter((r) => r.tgname === "user_scopes_keep_last_scope")).toHaveLength(1);

    const applied = await db.selectFrom("sutecba_migrations").select("filename").where("filename", "=", "0020_keep_last_user_scope.sql").executeTakeFirst();
    expect(applied).toBeDefined();
  });

  it("la migración es idempotente (se puede volver a ejecutar sin error)", async () => {
    const sqlText = readFileSync(join(process.cwd(), "db", "migrations", "0020_keep_last_user_scope.sql"), "utf-8");
    await expect(execRawSql(sqlText)).resolves.toBeUndefined();
  });
});
