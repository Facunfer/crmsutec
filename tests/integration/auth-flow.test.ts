import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createSession, loadSessionUser, bumpPermissionsVersion, revokeAllSessionsForUser } =
  await import("../../lib/auth/session.js");
const { checkLoginRateLimit, recordLoginAttempt } = await import("../../lib/auth/rate-limit.js");
const { createUser, updateUser, setUserActive, resetUserAccess, UserCommandError } = await import(
  "../../lib/users/commands.js"
);
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { countActiveMasterGlobal } = await import("../../lib/users/queries.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL_PERMISSIONS = new Set(PERMISSIONS.map((p) => p.key));

async function insertBootstrapMaster(email: string) {
  const db = await getDb();
  const role = await db
    .selectFrom("roles")
    .select("id")
    .where("key", "=", "MASTER_GLOBAL")
    .executeTakeFirstOrThrow();
  const passwordHash = await hashPassword("bootstrap-password-123");
  const user = await db
    .insertInto("users")
    .values({ email, password_hash: passwordHash, full_name: "Bootstrap", role_id: role.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: user.id, roleId: role.id } as const;
}

function fakeSessionUser(id: string, roleKey: "MASTER_GLOBAL" | "ADMIN", permissions: Set<string>) {
  return {
    id,
    email: "actor@sutecba.local",
    fullName: "Actor de prueba",
    roleId: "n/a",
    roleKey,
    mustChangePassword: false,
    permissions: permissions as ReadonlySet<any>,
  };
}

beforeAll(async () => {
  await applyMigrations(parseFlags([]));
  await runSeed();
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("comandos de usuarios: reglas anti-bloqueo (sección 8)", () => {
  it("un MASTER_GLOBAL puede crear un ADMIN", async () => {
    const bootstrap = await insertBootstrapMaster("master1@sutecba.local");
    const actor = fakeSessionUser(bootstrap.id, "MASTER_GLOBAL", ALL_PERMISSIONS);

    const { userId, temporaryPassword } = await createUser(actor, {
      email: "admin1@sutecba.local",
      fullName: "Admin Uno",
      roleKey: "ADMIN",
    });

    expect(userId).toBeTruthy();
    expect(temporaryPassword.length).toBeGreaterThan(10);

    const db = await getDb();
    const created = await db.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirstOrThrow();
    expect(created.must_change_password).toBe(true);
  });

  it("un ADMIN no puede crear un MASTER_GLOBAL", async () => {
    const db = await getDb();
    const adminRole = await db.selectFrom("roles").select("id").where("key", "=", "ADMIN").executeTakeFirstOrThrow();
    const adminUser = await db
      .insertInto("users")
      .values({
        email: "admin2@sutecba.local",
        password_hash: await hashPassword("x-password-123"),
        full_name: "Admin Dos",
        role_id: adminRole.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const adminPermissions = new Set(
      PERMISSIONS.map((p) => p.key).filter((k) => k !== "roles.manage")
    );
    const adminActor = fakeSessionUser(adminUser.id, "ADMIN", adminPermissions);

    await expect(
      createUser(adminActor, { email: "otro-master@sutecba.local", fullName: "X", roleKey: "MASTER_GLOBAL" })
    ).rejects.toThrow(UserCommandError);
  });

  it("nadie puede cambiar su propio rol", async () => {
    const bootstrap = await insertBootstrapMaster("master-self@sutecba.local");
    const actor = fakeSessionUser(bootstrap.id, "MASTER_GLOBAL", ALL_PERMISSIONS);

    await expect(updateUser(actor, bootstrap.id, { roleKey: "ADMIN" })).rejects.toThrow(UserCommandError);
  });

  it("no se puede desactivar al último MASTER_GLOBAL activo", async () => {
    const before = await countActiveMasterGlobal();
    const db = await getDb();
    // Deja exactamente uno activo para este caso: desactiva todos los demás.
    const masters = await db
      .selectFrom("users")
      .innerJoin("roles", "roles.id", "users.role_id")
      .select(["users.id"])
      .where("roles.key", "=", "MASTER_GLOBAL")
      .where("users.status", "=", "active")
      .execute();
    expect(before).toBe(masters.length);

    const [onlyOne, ...rest] = masters;
    for (const extra of rest) {
      await db.updateTable("users").set({ status: "inactive" }).where("id", "=", extra.id).execute();
    }

    const actor = fakeSessionUser(onlyOne!.id, "MASTER_GLOBAL", ALL_PERMISSIONS);
    await expect(setUserActive(actor, onlyOne!.id, false)).rejects.toThrow(UserCommandError);
  });
});

describe("sesión: invalidación inmediata (decisión D4)", () => {
  it("un usuario desactivado pierde el acceso en el siguiente request", async () => {
    const bootstrap = await insertBootstrapMaster("master-deact@sutecba.local");
    const actor = fakeSessionUser(bootstrap.id, "MASTER_GLOBAL", ALL_PERMISSIONS);
    const { userId } = await createUser(actor, {
      email: "para-desactivar@sutecba.local",
      fullName: "Para Desactivar",
      roleKey: "OPERADOR",
    });

    const { token } = await createSession(userId);
    const sessionUser = await loadSessionUser(token);
    expect(sessionUser?.roleKey).toBe("OPERADOR");

    await setUserActive(actor, userId, false);

    const afterDeactivation = await loadSessionUser(token);
    expect(afterDeactivation).toBeNull();
  });

  it("cambiar de rol invalida las sesiones existentes sin esperar el TTL", async () => {
    const bootstrap = await insertBootstrapMaster("master-role@sutecba.local");
    const actor = fakeSessionUser(bootstrap.id, "MASTER_GLOBAL", ALL_PERMISSIONS);
    const { userId } = await createUser(actor, {
      email: "cambia-rol@sutecba.local",
      fullName: "Cambia Rol",
      roleKey: "LECTURA",
    });

    const { token } = await createSession(userId);
    expect((await loadSessionUser(token))?.roleKey).toBe("LECTURA");

    await updateUser(actor, userId, { roleKey: "OPERADOR" });

    expect(await loadSessionUser(token)).toBeNull();

    const { token: newToken } = await createSession(userId);
    expect((await loadSessionUser(newToken))?.roleKey).toBe("OPERADOR");
  });

  it("resetear el acceso revoca las sesiones existentes", async () => {
    const bootstrap = await insertBootstrapMaster("master-reset@sutecba.local");
    const actor = fakeSessionUser(bootstrap.id, "MASTER_GLOBAL", ALL_PERMISSIONS);
    const { userId } = await createUser(actor, {
      email: "reset-acceso@sutecba.local",
      fullName: "Reset Acceso",
      roleKey: "LECTURA",
    });

    const { token } = await createSession(userId);
    expect(await loadSessionUser(token)).not.toBeNull();

    await resetUserAccess(actor, userId);

    expect(await loadSessionUser(token)).toBeNull();
  });

  it("revokeAllSessionsForUser y bumpPermissionsVersion invalidan por separado", async () => {
    const bootstrap = await insertBootstrapMaster("master-bump@sutecba.local");
    const { token } = await createSession(bootstrap.id);
    expect(await loadSessionUser(token)).not.toBeNull();

    await bumpPermissionsVersion(bootstrap.id);
    expect(await loadSessionUser(token)).toBeNull();

    const { token: token2 } = await createSession(bootstrap.id);
    await revokeAllSessionsForUser(bootstrap.id);
    expect(await loadSessionUser(token2)).toBeNull();
  });
});

describe("rate limit de login (D4/D13)", () => {
  it("bloquea por cuenta después del umbral configurado sin afectar otras cuentas", async () => {
    const identifier = "rate-limit-test@sutecba.local";
    for (let i = 0; i < 5; i++) {
      await recordLoginAttempt(identifier, "10.0.0.1", false);
    }
    const result = await checkLoginRateLimit(identifier, "10.0.0.1");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("account");

    const otherAccount = await checkLoginRateLimit("otra-cuenta@sutecba.local", "10.0.0.99");
    expect(otherAccount.allowed).toBe(true);
  });
});
