import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { assertTestEnvironment } = await import("../../lib/db/guards.js");
const { loadEnv } = await import("../../lib/db/env.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;

beforeAll(async () => {
  assertTestEnvironment(loadEnv());
  await applyMigrations(parseFlags([]));
});

afterAll(async () => {
  await closeDb();
  // PGlite puede tener una escritura en disco pendiente justo después de
  // destroy(); una pequeña espera evita un ENOENT de fondo al borrar el dir.
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true });
});

describe("guardas de entorno", () => {
  it("assertTestEnvironment rechaza si SUTECBA_ENV no es test", () => {
    expect(() => assertTestEnvironment({ ...loadEnv(), SUTECBA_ENV: "local" })).toThrow();
  });
});

describe("audit_logs es append-only (R8 / sección 15.1)", () => {
  it("permite insertar pero no actualizar ni borrar", async () => {
    const db = await getDb();
    const inserted = await db
      .insertInto("audit_logs")
      .values({ action: "TEST_ACTION", entity_type: "test", actor_type: "system" })
      .returning("id")
      .executeTakeFirstOrThrow();

    await expect(
      db.updateTable("audit_logs").set({ action: "OTRA" }).where("id", "=", inserted.id).execute()
    ).rejects.toThrow();

    await expect(
      db.deleteFrom("audit_logs").where("id", "=", inserted.id).execute()
    ).rejects.toThrow();
  });
});

describe("DNI único parcial (decisión D6/D7)", () => {
  it("rechaza un segundo activo con el mismo DNI", async () => {
    const db = await getDb();
    await db
      .insertInto("people")
      .values({ first_name: "Ana", last_name: "Test", dni: "30111222" })
      .execute();

    await expect(
      db
        .insertInto("people")
        .values({ first_name: "Otra", last_name: "Persona", dni: "30111222" })
        .execute()
    ).rejects.toThrow();
  });

  it("permite el mismo DNI si la fila anterior quedó 'merged'", async () => {
    const db = await getDb();
    await db
      .insertInto("people")
      .values({ first_name: "Bea", last_name: "Test", dni: "30333444" })
      .execute();
    await db.updateTable("people").set({ status: "merged" }).where("dni", "=", "30333444").execute();

    await expect(
      db
        .insertInto("people")
        .values({ first_name: "Bea 2", last_name: "Test", dni: "30333444" })
        .execute()
    ).resolves.not.toThrow();
  });
});

describe("sesiones llevan snapshot de permissions_version (decisión D4)", () => {
  it("guarda y compara la versión de permisos", async () => {
    const db = await getDb();
    const role = await db
      .insertInto("roles")
      .values({ key: "TEST_ROLE", name: "Rol de prueba" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const user = await db
      .insertInto("users")
      .values({
        email: "sesion.test@sutecba.local",
        password_hash: "x",
        full_name: "Test",
        role_id: role.id,
        permissions_version: 3,
      })
      .returning(["id", "permissions_version"])
      .executeTakeFirstOrThrow();

    const session = await db
      .insertInto("sessions")
      .values({
        user_id: user.id,
        token_hash: "hash-de-prueba",
        permissions_version_snapshot: user.permissions_version,
        expires_at: new Date(Date.now() + 3600_000),
      })
      .returning("permissions_version_snapshot")
      .executeTakeFirstOrThrow();

    expect(session.permissions_version_snapshot).toBe(3);
  });
});
