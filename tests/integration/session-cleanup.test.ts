import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

// El login real usa cookies() y headers() de Next: se sirven versiones de prueba.
let issuedToken: string | undefined;
vi.mock("../../lib/auth/cookies.js", () => ({
  setSessionCookie: async (token: string) => {
    issuedToken = token;
  },
  getSessionCookie: async () => issuedToken,
  clearSessionCookie: async () => {
    issuedToken = undefined;
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "10.55.0.1", "user-agent": "vitest" }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createSession, loadSessionUser, revokeAllSessionsForUser } = await import("../../lib/auth/session.js");
const { login } = await import("../../app/login/actions.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const PASSWORD = "Una-Clave-De-Prueba-123";

let userId: string;
let otherUserId: string;

/**
 * Ejecuta `run` con el rol runtime real (`sutecba_app`, el de producción): sin DELETE sobre
 * `sessions`, con RLS y con los GRANT de 0019. PGlite es superusuario por defecto, así que sin
 * `SET ROLE` un DELETE indebido pasaría desapercibido.
 */
async function asRuntimeRole<T>(run: () => Promise<T>): Promise<T> {
  const db = await getDb();
  await sql`set role sutecba_app`.execute(db);
  try {
    return await run();
  } finally {
    await sql`reset role`.execute(db);
  }
}

async function insertSession(forUser: string, values: { expiresAt: Date; revokedAt?: Date | null }) {
  const db = await getDb();
  const user = await db.selectFrom("users").select("permissions_version").where("id", "=", forUser).executeTakeFirstOrThrow();
  const row = await db
    .insertInto("sessions")
    .values({
      user_id: forUser,
      token_hash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      permissions_version_snapshot: user.permissions_version,
      expires_at: values.expiresAt,
      revoked_at: values.revokedAt ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function getSession(sessionId: string) {
  const db = await getDb();
  return db.selectFrom("sessions").select(["id", "revoked_at", "expires_at"]).where("id", "=", sessionId).executeTakeFirst();
}

const HOUR = 3_600_000;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();

  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const passwordHash = await hashPassword(PASSWORD);
  const make = async (email: string) =>
    (
      await db
        .insertInto("users")
        .values({ email, password_hash: passwordHash, full_name: email, role_id: role.id })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  userId = await make("sesiones@sutecba.local");
  otherUserId = await make("otro@sutecba.local");
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("limpieza de sesiones vencidas sin DELETE (rol runtime)", () => {
  it("1) el rol runtime no tiene DELETE sobre sessions, y aun así crear una sesión funciona", async () => {
    await asRuntimeRole(async () => {
      const db = await getDb();
      await expect(sql`delete from sessions where user_id = ${userId}::uuid`.execute(db)).rejects.toThrow(/permission denied/);
      await expect(createSession(userId, { ip: "10.0.0.1" })).resolves.toHaveProperty("token");
    });
  });

  it("2) una sesión vencida del mismo usuario queda revocada lógicamente (sin borrarse)", async () => {
    const expired = await insertSession(userId, { expiresAt: new Date(Date.now() - HOUR) });
    await asRuntimeRole(() => createSession(userId));

    const row = await getSession(expired);
    expect(row).toBeDefined(); // la fila sigue existiendo: no hubo borrado físico
    expect(row!.revoked_at).toBeInstanceOf(Date);
  });

  it("3) una sesión activa del mismo usuario no se revoca", async () => {
    const active = await insertSession(userId, { expiresAt: new Date(Date.now() + HOUR) });
    await asRuntimeRole(() => createSession(userId));
    expect((await getSession(active))!.revoked_at).toBeNull();
  });

  it("4) una sesión ya revocada conserva su fecha de revocación original", async () => {
    const originalRevocation = new Date(Date.now() - 5 * HOUR);
    const alreadyRevoked = await insertSession(userId, { expiresAt: new Date(Date.now() - 2 * HOUR), revokedAt: originalRevocation });
    await asRuntimeRole(() => createSession(userId));
    expect((await getSession(alreadyRevoked))!.revoked_at!.getTime()).toBe(originalRevocation.getTime());
  });

  it("5) la sesión recién creada no queda revocada y es válida", async () => {
    const { token } = await asRuntimeRole(() => createSession(userId));
    const user = await asRuntimeRole(() => loadSessionUser(token));
    expect(user?.id).toBe(userId);

    const db = await getDb();
    const revokedCount = await db
      .selectFrom("sessions")
      .select("id")
      .where("user_id", "=", userId)
      .where("expires_at", ">", new Date())
      .where("revoked_at", "is not", null)
      .execute();
    expect(revokedCount).toHaveLength(0);
  });

  it("solo toca las sesiones del usuario que inicia sesión", async () => {
    const othersExpired = await insertSession(otherUserId, { expiresAt: new Date(Date.now() - HOUR) });
    await asRuntimeRole(() => createSession(userId));
    expect((await getSession(othersExpired))!.revoked_at).toBeNull();
  });
});

describe("login completo con el rol runtime", () => {
  it("6) el login valida credenciales, crea la sesión y la sesión es válida", async () => {
    issuedToken = undefined;

    const outcome = await asRuntimeRole(async () => {
      const form = new FormData();
      form.set("email", "sesiones@sutecba.local");
      form.set("password", PASSWORD);
      return login({}, form).catch((err: { digest?: string }) => err);
    });

    // Un login correcto termina en redirect (NEXT_REDIRECT), no en un error.
    expect(String((outcome as { digest?: string }).digest ?? "")).toContain("NEXT_REDIRECT");
    expect(issuedToken).toBeTruthy();

    const user = await asRuntimeRole(() => loadSessionUser(issuedToken!));
    expect(user?.email).toBe("sesiones@sutecba.local");
    expect(user?.roleKey).toBe("MASTER_GLOBAL");
  });

  it("una contraseña incorrecta sigue rechazándose sin crear sesión", async () => {
    issuedToken = undefined;
    const result = await asRuntimeRole(async () => {
      const form = new FormData();
      form.set("email", "sesiones@sutecba.local");
      form.set("password", "incorrecta");
      return login({}, form);
    });
    expect(result.error).toBeTruthy();
    expect(issuedToken).toBeUndefined();
  });
});

describe("loadSessionUser sigue rechazando sesiones no válidas", () => {
  it("7) una sesión vencida (aunque no esté marcada) se rechaza", async () => {
    const { token } = await createSession(userId);
    const db = await getDb();
    await db.updateTable("sessions").set({ expires_at: new Date(Date.now() - 1000) }).where("user_id", "=", userId).execute();
    expect(await loadSessionUser(token)).toBeNull();
  });

  it("7b) una sesión revocada se rechaza", async () => {
    const { token } = await createSession(userId);
    expect(await loadSessionUser(token)).not.toBeNull();
    await revokeAllSessionsForUser(userId);
    expect(await loadSessionUser(token)).toBeNull();
  });

  it("7c) un token desconocido se rechaza", async () => {
    expect(await loadSessionUser("token-que-no-existe")).toBeNull();
  });
});
