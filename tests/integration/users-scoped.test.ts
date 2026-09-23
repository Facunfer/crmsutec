import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { ROLE_PERMISSIONS, PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { PermissionError } = await import("../../lib/auth/guard.js");
const {
  createUser,
  updateUser,
  setUserActive,
  resetUserAccess,
  grantUserScope,
  revokeUserScope,
  grantUserModule,
  UserCommandError,
} = await import("../../lib/users/commands.js");
const {
  getUserAdminMode,
  isUserAdministrable,
  listAdministrableUsers,
  listAssignableRoles,
  listGrantableModules,
  listGrantableOrganizations,
  getUserAccess,
} = await import("../../lib/users/administration.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;

type Perms = ReadonlySet<any>;
function session(id: string, roleKey: string, permissions: Iterable<string>) {
  return {
    id,
    email: `${id}@sutecba.local`,
    fullName: "Actor de prueba",
    roleId: "n/a",
    roleKey: roleKey as any,
    mustChangePassword: false,
    enabledModules: ALL_MODULE_KEYS,
    permissions: new Set(permissions) as Perms,
  };
}

// Organigrama de prueba:  A ─┬─ A1        B ── B1
//                          └─ A2
const orgIds = new Map<string, string>();
const userIds = new Map<string, string>();
const o = (name: string): string => orgIds.get(name)!;
const u = (email: string): string => userIds.get(email)!;
let master: ReturnType<typeof session>;
let admin: ReturnType<typeof session>; // ADMIN con alcance A (+ dependientes) y módulos personas/dashboard
let adminNoDesc: ReturnType<typeof session>; // ADMIN con alcance A, sin dependientes
let delegado: ReturnType<typeof session>; // rol reducido con users.manage_scoped
let lectura: ReturnType<typeof session>;

async function makeOrg(name: string, parentId: string | null) {
  const db = await getDb();
  const type = await db.selectFrom("organization_types").select("id").where("key", "=", "reparticion").executeTakeFirstOrThrow();
  const row = await db
    .insertInto("organizations")
    .values({ name, type_id: type.id, parent_id: parentId })
    .returning("id")
    .executeTakeFirstOrThrow();
  orgIds.set(name, row.id);
}

async function makeMaster(email: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const row = await db
    .insertInto("users")
    .values({ email, password_hash: await hashPassword("bootstrap-password-123"), full_name: email, role_id: role.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function create(
  email: string,
  roleKey: string,
  scopes: Array<[string, boolean]>,
  moduleKeys: string[] = []
) {
  const { userId } = await createUser(master, {
    email,
    fullName: email,
    roleKey: roleKey as any,
    scopes: scopes.map(([name, include]) => ({ organizationId: o(name), includeDescendants: include })),
    moduleKeys,
  });
  userIds.set(email, userId);
  return userId;
}

async function permissionsVersion(userId: string): Promise<number> {
  const db = await getDb();
  const row = await db.selectFrom("users").select("permissions_version").where("id", "=", userId).executeTakeFirstOrThrow();
  return row.permissions_version;
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();

  await makeOrg("A", null);
  await makeOrg("A1", o("A"));
  await makeOrg("A2", o("A"));
  await makeOrg("B", null);
  await makeOrg("B1", o("B"));

  const masterId = await makeMaster("master@sutecba.local");
  master = session(masterId, "MASTER_GLOBAL", PERMISSIONS.map((p) => p.key));

  // Rol reducido: puede administrar usuarios/alcances pero tiene muchos menos permisos que ADMIN.
  const db = await getDb();
  const roleRow = await db
    .insertInto("roles")
    .values({ key: "DELEGADO_TEST", name: "Delegado de prueba" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const delegadoPerms = ["users.manage_scoped", "scopes.manage", "people.view"] as const;
  const permRows = await db.selectFrom("permissions").select(["id", "key"]).where("key", "in", [...delegadoPerms]).execute();
  await db
    .insertInto("role_permissions")
    .values(permRows.map((p) => ({ role_id: roleRow.id, permission_id: p.id })))
    .execute();

  const adminId = await create("admin@sutecba.local", "ADMIN", [["A", true]], ["personas", "dashboard"]);
  const adminNoDescId = await create("admin-nodesc@sutecba.local", "ADMIN", [["A", false]], ["personas"]);
  const delegadoId = await create("delegado@sutecba.local", "DELEGADO_TEST", [["A", true]], ["personas", "dashboard"]);
  const lecturaId = await create("lectura@sutecba.local", "LECTURA", [["A", true]], ["dashboard"]);

  admin = session(adminId, "ADMIN", ROLE_PERMISSIONS.ADMIN);
  adminNoDesc = session(adminNoDescId, "ADMIN", ROLE_PERMISSIONS.ADMIN);
  delegado = session(delegadoId, "DELEGADO_TEST", delegadoPerms);
  lectura = session(lecturaId, "LECTURA", ROLE_PERMISSIONS.LECTURA);

  await create("op-a@sutecba.local", "OPERADOR", [["A", false]], ["personas"]);
  await create("op-a1@sutecba.local", "OPERADOR", [["A1", false]], ["personas"]);
  await create("op-a2@sutecba.local", "OPERADOR", [["A2", false]], ["personas"]);
  await create("op-b1@sutecba.local", "OPERADOR", [["B1", false]], ["personas"]);
  await create("op-mixto@sutecba.local", "OPERADOR", [["A1", false], ["B1", false]], ["personas"]);
  await makeMaster("otro-master@sutecba.local");
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const emailsOf = (items: Array<{ email: string }>) => items.map((u) => u.email);

describe("modo de administración: users.manage vs users.manage_scoped", () => {
  it("MASTER_GLOBAL es global; ADMIN es delegado; LECTURA no administra usuarios", () => {
    expect(getUserAdminMode(master)).toBe("global");
    expect(getUserAdminMode(admin)).toBe("scoped");
    expect(getUserAdminMode(lectura)).toBe("none");
  });

  it("13) sin users.manage ni users.manage_scoped no se accede al módulo ni a sus comandos", async () => {
    await expect(createUser(lectura, { email: "x@sutecba.local", fullName: "X", roleKey: "LECTURA" })).rejects.toThrow(PermissionError);
    await expect(updateUser(lectura, u("op-a1@sutecba.local"), { fullName: "Y" })).rejects.toThrow(PermissionError);
    await expect(setUserActive(lectura, u("op-a1@sutecba.local"), false)).rejects.toThrow(PermissionError);
    await expect(resetUserAccess(lectura, u("op-a1@sutecba.local"))).rejects.toThrow(PermissionError);
    await expect(grantUserModule(lectura, u("op-a1@sutecba.local"), "dashboard")).rejects.toThrow(PermissionError);
    await expect(listAdministrableUsers(lectura)).rejects.toThrow(PermissionError);
  });
});

describe("visibilidad de usuarios por alcance", () => {
  it("1) MASTER_GLOBAL ve a todos los usuarios, incluidos otros master", async () => {
    const emails = emailsOf(await listAdministrableUsers(master));
    for (const e of ["admin@sutecba.local", "op-b1@sutecba.local", "op-a1@sutecba.local", "otro-master@sutecba.local"]) {
      expect(emails).toContain(e);
    }
  });

  it("1b) MASTER_GLOBAL administra a cualquier usuario", async () => {
    await expect(updateUser(master, u("op-b1@sutecba.local"), { fullName: "Operador B1" })).resolves.toBeUndefined();
    expect(await isUserAdministrable(master, u("op-b1@sutecba.local"))).toBe(true);
  });

  it("2) ADMIN con alcance sobre A ve a un usuario de A", async () => {
    const emails = emailsOf(await listAdministrableUsers(admin));
    expect(emails).toContain("op-a@sutecba.local");
  });

  it("3) ADMIN con alcance A no ve al usuario exclusivamente de B", async () => {
    const emails = emailsOf(await listAdministrableUsers(admin));
    expect(emails).not.toContain("op-b1@sutecba.local");
    expect(await isUserAdministrable(admin, u("op-b1@sutecba.local"))).toBe(false);
  });

  it("3b) un usuario con alcances en A y B no queda completamente contenido, así que no se ve", async () => {
    expect(emailsOf(await listAdministrableUsers(admin))).not.toContain("op-mixto@sutecba.local");
  });

  it("4) include_descendants=true incluye a los usuarios de las dependencias", async () => {
    const emails = emailsOf(await listAdministrableUsers(admin));
    expect(emails).toContain("op-a1@sutecba.local");
    expect(emails).toContain("op-a2@sutecba.local");
  });

  it("5) include_descendants=false no incluye a los usuarios de las dependencias", async () => {
    const emails = emailsOf(await listAdministrableUsers(adminNoDesc));
    expect(emails).toContain("op-a@sutecba.local");
    expect(emails).not.toContain("op-a1@sutecba.local");
    expect(emails).not.toContain("op-a2@sutecba.local");
  });

  it("un delegado nunca ve ni administra a un MASTER_GLOBAL", async () => {
    expect(emailsOf(await listAdministrableUsers(admin))).not.toContain("otro-master@sutecba.local");
    const db = await getDb();
    const otro = await db.selectFrom("users").select("id").where("email", "=", "otro-master@sutecba.local").executeTakeFirstOrThrow();
    expect(await isUserAdministrable(admin, otro.id)).toBe(false);
    await expect(setUserActive(admin, otro.id, false)).rejects.toThrow(UserCommandError);
    await expect(resetUserAccess(admin, otro.id)).rejects.toThrow(UserCommandError);
  });

  it("un delegado no puede modificar ni resetear a un usuario fuera de sus alcances", async () => {
    const outside = u("op-b1@sutecba.local");
    await expect(updateUser(admin, outside, { fullName: "Hack" })).rejects.toThrow(UserCommandError);
    await expect(setUserActive(admin, outside, false)).rejects.toThrow(UserCommandError);
    await expect(resetUserAccess(admin, outside)).rejects.toThrow(UserCommandError);
    await expect(grantUserModule(admin, outside, "dashboard")).rejects.toThrow(UserCommandError);
  });

  it("un delegado sí administra a un usuario dentro de sus alcances", async () => {
    const inside = u("op-a1@sutecba.local");
    await expect(updateUser(admin, inside, { fullName: "Operador A1" })).resolves.toBeUndefined();
    const { temporaryPassword } = await resetUserAccess(admin, inside);
    expect(temporaryPassword.length).toBeGreaterThan(10);
  });
});

describe("anti-escalada de privilegios", () => {
  it("6) ADMIN no puede crear un MASTER_GLOBAL", async () => {
    await expect(
      createUser(admin, {
        email: "nuevo-master@sutecba.local",
        fullName: "Nuevo Master",
        roleKey: "MASTER_GLOBAL",
        scopes: [{ organizationId: o("A1"), includeDescendants: false }],
      })
    ).rejects.toThrow(UserCommandError);
  });

  it("6b) ADMIN no puede promover a un usuario a MASTER_GLOBAL", async () => {
    await expect(updateUser(admin, u("op-a1@sutecba.local"), { roleKey: "MASTER_GLOBAL" })).rejects.toThrow(UserCommandError);
  });

  it("7) un delegado no puede dar un rol cuyos permisos exceden los propios", async () => {
    await expect(
      createUser(delegado, {
        email: "excede@sutecba.local",
        fullName: "Excede",
        roleKey: "ADMIN",
        scopes: [{ organizationId: o("A1"), includeDescendants: false }],
        moduleKeys: ["personas"],
      })
    ).rejects.toThrow(/permisos/i);

    await expect(updateUser(delegado, u("op-a1@sutecba.local"), { roleKey: "ADMIN" })).rejects.toThrow(/permisos/i);
  });

  it("7b) los roles asignables de un delegado son solo los que no exceden sus permisos", async () => {
    const roles = await listAssignableRoles(delegado);
    expect(roles).not.toContain("MASTER_GLOBAL");
    expect(roles).not.toContain("ADMIN");
    expect(roles).not.toContain("OPERADOR");
    expect(roles).toContain("DELEGADO_TEST");

    const adminRoles = await listAssignableRoles(admin);
    expect(adminRoles).not.toContain("MASTER_GLOBAL");
    expect(adminRoles).toContain("ADMIN");
    expect(adminRoles).toContain("OPERADOR");

    expect(await listAssignableRoles(master)).toContain("MASTER_GLOBAL");
  });

  it("un ADMIN no puede otorgar users.manage ni organizations.manage (no los posee)", () => {
    for (const key of ["users.manage", "organizations.manage"] as const) {
      expect(ROLE_PERMISSIONS.ADMIN).not.toContain(key);
    }
  });

  it("8) ADMIN no puede otorgar módulos que él no posee (al crear ni sobre un usuario existente)", async () => {
    await expect(
      createUser(admin, {
        email: "modulo-ajeno@sutecba.local",
        fullName: "Módulo ajeno",
        roleKey: "OPERADOR",
        scopes: [{ organizationId: o("A1"), includeDescendants: false }],
        moduleKeys: ["visualizacion"],
      })
    ).rejects.toThrow(/módulo/i);

    await expect(grantUserModule(admin, u("op-a1@sutecba.local"), "visualizacion")).rejects.toThrow(/módulo/i);

    const grantable = (await listGrantableModules(admin)).map((m) => m.key).sort();
    expect(grantable).toEqual(["dashboard", "personas"]);
  });

  it("9) ADMIN no puede otorgar scopes fuera de los propios (al crear ni sobre un usuario existente)", async () => {
    await expect(
      createUser(admin, {
        email: "alcance-ajeno@sutecba.local",
        fullName: "Alcance ajeno",
        roleKey: "OPERADOR",
        scopes: [{ organizationId: o("B1"), includeDescendants: false }],
      })
    ).rejects.toThrow(/alcance/i);

    await expect(
      grantUserScope(admin, u("op-a1@sutecba.local"), { organizationId: o("B"), includeDescendants: false })
    ).rejects.toThrow(/alcance/i);

    const orgIds = (await listGrantableOrganizations(admin)).map((o) => o.id).sort();
    expect(orgIds).toEqual([o("A"), o("A1"), o("A2")].sort());
  });

  it("un ADMIN sin dependientes no puede dar un alcance que incluya dependientes", async () => {
    await expect(
      grantUserScope(adminNoDesc, u("op-a@sutecba.local"), { organizationId: o("A"), includeDescendants: true })
    ).rejects.toThrow(/alcance/i);
  });

  it("un delegado debe darle al menos un alcance al usuario que crea", async () => {
    await expect(
      createUser(admin, { email: "sin-alcance@sutecba.local", fullName: "Sin alcance", roleKey: "OPERADOR" })
    ).rejects.toThrow(/alcance/i);
  });

  it("10) ADMIN no puede modificar sus propios scopes", async () => {
    await expect(grantUserScope(admin, admin.id, { organizationId: o("A1"), includeDescendants: false })).rejects.toThrow(UserCommandError);

    const own = (await getUserAccess(admin.id)).scopes[0]!;
    await expect(revokeUserScope(admin, admin.id, own.id)).rejects.toThrow(UserCommandError);

    // Segunda barrera: aunque se salteara el comando, el trigger de la base lo rechaza.
    const db = await getDb();
    await expect(
      db
        .insertInto("user_scopes")
        .values({ user_id: admin.id, organization_id: o("A1"), include_descendants: false, granted_by: admin.id })
        .execute()
    ).rejects.toThrow(/propios alcances/);
  });

  it("11) ADMIN no puede modificar sus propios módulos", async () => {
    await expect(grantUserModule(admin, admin.id, "personas")).rejects.toThrow(UserCommandError);

    const db = await getDb();
    await expect(
      db.insertInto("user_modules").values({ user_id: admin.id, module_key: "dashboard", granted_by: admin.id }).execute()
    ).rejects.toThrow(/propios módulos/);
  });

  it("ADMIN no puede cambiar su propio rol", async () => {
    await expect(updateUser(admin, admin.id, { roleKey: "LECTURA" })).rejects.toThrow(/propio rol/);
  });
});

describe("invalidación de sesiones (permissions_version)", () => {
  it("12) conceder o revocar scopes y módulos incrementa permissions_version del usuario afectado", async () => {
    const target = u("op-a2@sutecba.local");

    let before = await permissionsVersion(target);
    await grantUserScope(admin, target, { organizationId: o("A1"), includeDescendants: false });
    const afterScope = await permissionsVersion(target);
    expect(afterScope).toBeGreaterThan(before);

    before = afterScope;
    await grantUserModule(admin, target, "dashboard");
    const afterModule = await permissionsVersion(target);
    expect(afterModule).toBeGreaterThan(before);

    before = afterModule;
    const scope = (await getUserAccess(target)).scopes.find((s) => s.organizationId === o("A1"))!;
    await revokeUserScope(admin, target, scope.id);
    expect(await permissionsVersion(target)).toBeGreaterThan(before);
  });

  it("los alcances revocados quedan registrados, no se borran", async () => {
    const db = await getDb();
    const revoked = await db
      .selectFrom("user_scopes")
      .select(["revoked_at", "revoked_by"])
      .where("user_id", "=", u("op-a2@sutecba.local"))
      .where("organization_id", "=", o("A1"))
      .executeTakeFirstOrThrow();
    expect(revoked.revoked_at).not.toBeNull();
    expect(revoked.revoked_by).toBe(admin.id);
  });
});

describe("creación de usuarios por un delegado", () => {
  it("crea el usuario con sus alcances y módulos, y queda administrable para quien lo creó", async () => {
    const { userId } = await createUser(admin, {
      email: "nuevo-a2@sutecba.local",
      fullName: "Nuevo A2",
      roleKey: "OPERADOR",
      scopes: [{ organizationId: o("A2"), includeDescendants: false }],
      moduleKeys: ["personas"],
    });

    const access = await getUserAccess(userId);
    expect(access.scopes.map((s) => s.organizationId)).toEqual([o("A2")]);
    expect(access.modules.map((m) => m.moduleKey)).toEqual(["personas"]);
    expect(await isUserAdministrable(admin, userId)).toBe(true);

    const db = await getDb();
    const row = await db.selectFrom("users").select("created_by").where("id", "=", userId).executeTakeFirstOrThrow();
    expect(row.created_by).toBe(admin.id);
  });

  it("si falla una validación no queda un usuario a medio crear", async () => {
    await expect(
      createUser(admin, {
        email: "a-medias@sutecba.local",
        fullName: "A medias",
        roleKey: "OPERADOR",
        scopes: [{ organizationId: o("A1"), includeDescendants: false }],
        moduleKeys: ["visualizacion"],
      })
    ).rejects.toThrow();
    const db = await getDb();
    const row = await db.selectFrom("users").select("id").where("email", "=", "a-medias@sutecba.local").executeTakeFirst();
    expect(row).toBeUndefined();
  });
});
