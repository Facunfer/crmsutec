import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { countPeople, listPeoplePage } = await import("../../lib/people/queries.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;

// MASTER_GLOBAL: alcance global (no necesita un usuario real en la base).
const master = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "master@sutecba.local",
  fullName: "Master",
  roleId: "n/a",
  roleKey: "MASTER_GLOBAL" as const,
  mustChangePassword: false,
  enabledModules: ALL_MODULE_KEYS,
  permissions: new Set() as ReadonlySet<any>,
};

let orgId: string;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();

  const db = await getDb();
  const type = await db.selectFrom("organization_types").select("id").where("key", "=", "ministerio").executeTakeFirstOrThrow();
  const org = await db
    .insertInto("organizations")
    .values({ name: "Organismo de prueba", type_id: type.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  orgId = org.id;

  const thirtyYearsAgo = new Date();
  thirtyYearsAgo.setFullYear(thirtyYearsAgo.getFullYear() - 30);
  const sixtyYearsAgo = new Date();
  sixtyYearsAgo.setFullYear(sixtyYearsAgo.getFullYear() - 60);

  await db
    .insertInto("people")
    .values([
      { first_name: "María", last_name: "Gómez", dni: "31000001", organization_id: orgId, birth_date: thirtyYearsAgo },
      { first_name: "Pedro", last_name: "Pérez", dni: "31000002", organization_id: null, birth_date: sixtyYearsAgo },
      { first_name: "Lucía", last_name: "López", dni: "31000003", organization_id: orgId, status: "inactive" },
    ])
    .execute();
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("resolvedor de audiencia de Personas (sección 6.2: un solo lugar)", () => {
  it("por defecto solo cuenta activas", async () => {
    const count = await countPeople(master, {});
    expect(count).toBe(2);
  });

  it("status: 'all' incluye inactivas", async () => {
    const count = await countPeople(master, { status: "all" });
    expect(count).toBe(3);
  });

  it("filtra por organismo", async () => {
    const count = await countPeople(master, { organizationIds: [orgId] });
    expect(count).toBe(1); // María activa; Lucía es del mismo organismo pero está inactiva
  });

  it("busca por nombre/apellido/DNI sin importar mayúsculas", async () => {
    const count = await countPeople(master, { search: "gómez" });
    expect(count).toBe(1);
    const byDni = await countPeople(master, { search: "31000002" });
    expect(byDni).toBe(1);
  });

  it("filtra por rango de edad usando birth_date", async () => {
    const youngOnly = await countPeople(master, { ageMin: 25, ageMax: 35 });
    expect(youngOnly).toBe(1);
    const oldOnly = await countPeople(master, { ageMin: 55 });
    expect(oldOnly).toBe(1);
  });

  it("el conteo previo coincide con el total de la página (mismo resolvedor)", async () => {
    const { total } = await listPeoplePage(master, { status: "all" }, { field: "name", direction: "asc" }, 1, 10);
    const count = await countPeople(master, { status: "all" });
    expect(total).toBe(count);
  });
});
