import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createPerson, updatePerson, setPersonActive, PersonCommandError } = await import(
  "../../lib/people/commands.js"
);
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL_PERMISSIONS = new Set(PERMISSIONS.map((p) => p.key));

function fakeActor(id: string) {
  return {
    id,
    email: "actor@sutecba.local",
    fullName: "Actor",
    roleId: "n/a",
    roleKey: "MASTER_GLOBAL" as const,
    mustChangePassword: false,
    permissions: ALL_PERMISSIONS as ReadonlySet<any>,
  };
}

let actorId: string;

beforeAll(async () => {
  await applyMigrations(parseFlags([]));
  await runSeed();

  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({
      email: "people-test-actor@sutecba.local",
      password_hash: await hashPassword("x-password-123"),
      full_name: "Actor",
      role_id: role.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  actorId = user.id;
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("duplicados (sección 9: DNI bloquea, email/teléfono advierte)", () => {
  it("bloquea un segundo alta con el mismo DNI", async () => {
    const actor = fakeActor(actorId);
    await createPerson(actor, {
      firstName: "Ana",
      lastName: "Test",
      dni: "30222333",
      email: "",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "",
    });

    await expect(
      createPerson(actor, {
        firstName: "Otra",
        lastName: "Persona",
        dni: "30222333",
        email: "",
        phone: "",
        organizationId: "",
        birthDate: "",
        declaredAge: "",
      })
    ).rejects.toThrow(PersonCommandError);
  });

  it("advierte (no bloquea) si coincide el email, y permite confirmar de todas formas", async () => {
    const actor = fakeActor(actorId);
    await createPerson(actor, {
      firstName: "Bruno",
      lastName: "Test",
      dni: "",
      email: "bruno.test@sutecba.local",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "",
    });

    const firstAttempt = await createPerson(actor, {
      firstName: "Otro",
      lastName: "Bruno",
      dni: "",
      email: "bruno.test@sutecba.local",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "",
    });
    expect("needsConfirmation" in firstAttempt).toBe(true);

    const confirmed = await createPerson(
      actor,
      {
        firstName: "Otro",
        lastName: "Bruno",
        dni: "",
        email: "bruno.test@sutecba.local",
        phone: "",
        organizationId: "",
        birthDate: "",
        declaredAge: "",
      },
      { confirmDuplicates: true }
    );
    expect("id" in confirmed).toBe(true);
  });
});

describe("bloqueo optimista (sección 9 del prompt)", () => {
  it("rechaza un update con una versión vieja", async () => {
    const actor = fakeActor(actorId);
    const created = await createPerson(actor, {
      firstName: "Carla",
      lastName: "Test",
      dni: "30444555",
      email: "",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "",
    });
    if (!("id" in created)) throw new Error("no debería pedir confirmación");

    const firstEdit = await updatePerson(actor, created.id, 1, {
      firstName: "Carla",
      lastName: "Editada",
      dni: "30444555",
      email: "",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "",
    });
    expect("ok" in firstEdit).toBe(true);

    await expect(
      updatePerson(actor, created.id, 1, {
        firstName: "Carla",
        lastName: "Otra edición pisando la anterior",
        dni: "30444555",
        email: "",
        phone: "",
        organizationId: "",
        birthDate: "",
        declaredAge: "",
      })
    ).rejects.toThrow(PersonCommandError);
  });
});

describe("desactivar no borra (R8)", () => {
  it("setPersonActive(false) deja la fila con status inactive, no la elimina", async () => {
    const actor = fakeActor(actorId);
    const created = await createPerson(actor, {
      firstName: "Diego",
      lastName: "Test",
      dni: "30666777",
      email: "",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "",
    });
    if (!("id" in created)) throw new Error("no debería pedir confirmación");

    await setPersonActive(actor, created.id, false);

    const db = await getDb();
    const row = await db.selectFrom("people").select(["id", "status"]).where("id", "=", created.id).executeTakeFirst();
    expect(row).toBeDefined();
    expect(row?.status).toBe("inactive");
  });
});
