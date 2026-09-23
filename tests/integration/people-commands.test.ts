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
    enabledModules: ALL_MODULE_KEYS,
    permissions: ALL_PERMISSIONS as ReadonlySet<any>,
  };
}

let actorId: string;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
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
      dni: "30555001",
      email: "bruno.test@sutecba.local",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "",
    });

    const firstAttempt = await createPerson(actor, {
      firstName: "Otro",
      lastName: "Bruno",
      dni: "30555002",
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
        dni: "30555002",
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

describe("sin people.view_sensitive, updatePerson ignora DNI/email/teléfono (hallazgo real de la Etapa 10)", () => {
  function actorWithoutSensitive(id: string) {
    const withoutViewSensitive = new Set([...ALL_PERMISSIONS].filter((k) => k !== "people.view_sensitive"));
    return { ...fakeActor(id), permissions: withoutViewSensitive as ReadonlySet<any> };
  }

  it("un editor sin el permiso no puede cambiar el DNI/email/teléfono aunque los mande en el formulario", async () => {
    const admin = fakeActor(actorId);
    const created = await createPerson(admin, {
      firstName: "Nora",
      lastName: "Original",
      dni: "30666111",
      email: "nora@example.com",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "",
    });
    if (!("id" in created)) throw new Error("no debería pedir confirmación");

    const limitedActor = actorWithoutSensitive(actorId);
    const result = await updatePerson(limitedActor, created.id, 1, {
      firstName: "Nora",
      lastName: "Editada",
      dni: "30666999", // intento de cambiar el DNI real
      email: "otro@example.com", // intento de cambiar el email real
      phone: "+541100000000",
      organizationId: "",
      birthDate: "",
      declaredAge: "",
    });
    expect("ok" in result).toBe(true);

    const db = await getDb();
    const person = await db.selectFrom("people").selectAll().where("id", "=", created.id).executeTakeFirstOrThrow();
    expect(person.first_name).toBe("Nora"); // esto sí se pudo editar
    expect(person.last_name).toBe("Editada");
    expect(person.dni).toBe("30666111"); // el servidor lo ignoró, no "30666999"
    expect(person.email).toBe("nora@example.com"); // ídem
  });

  it("un editor CON el permiso sí puede cambiar esos campos", async () => {
    const admin = fakeActor(actorId);
    const created = await createPerson(admin, {
      firstName: "Oscar",
      lastName: "Original",
      dni: "30666222",
      email: "",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "",
    });
    if (!("id" in created)) throw new Error("no debería pedir confirmación");

    const result = await updatePerson(admin, created.id, 1, {
      firstName: "Oscar",
      lastName: "Original",
      dni: "30666333",
      email: "",
      phone: "",
      organizationId: "",
      birthDate: "",
      declaredAge: "",
    });
    expect("ok" in result).toBe(true);

    const db = await getDb();
    const person = await db.selectFrom("people").select("dni").where("id", "=", created.id).executeTakeFirstOrThrow();
    expect(person.dni).toBe("30666333");
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
