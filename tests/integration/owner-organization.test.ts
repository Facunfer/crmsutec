import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { loadEnv } = await import("../../lib/db/env.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { ensureOwnerOrganization, planOwnerOrganization, readOwnerOrganizationState, OWNER_ORGANIZATION } = await import("../../lib/organizations/owner-organization.js");
const { runImport } = await import("../../lib/imports/gabriel/apply.js");
const { planFromSources } = await import("../../lib/imports/gabriel/plan-hash.js");
const fx = await import("../helpers/gabriel-fixtures.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
let masterId: string;
let adminRoleId: string;

async function makeUser(email: string, roleKey: string, status: "active" | "inactive" = "active") {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({ email, password_hash: await hashPassword("x-password-123"), full_name: "Usuario", role_id: role.id, status } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  return user.id;
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  masterId = await makeUser("owner-master@sutecba.local", "MASTER_GLOBAL");
  const db = await getDb();
  adminRoleId = (await db.selectFrom("roles").select("id").where("key", "=", "ADMIN").executeTakeFirstOrThrow()).id;
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function readLedger() {
  const db = await getDb();
  const database = await sql<{ database: string }>`select current_database() as database`.execute(db);
  const meta = await sql<{ system: string }>`select system from sutecba_meta where id = true`.execute(db);
  const migs = await sql<{ filename: string }>`select filename from sutecba_migrations`.execute(db);
  return { database: database.rows[0]!.database, system: meta.rows[0]?.system ?? null, migrations: migs.rows.map((r) => r.filename) };
}
async function asRuntimeRole<T>(run: () => Promise<T>): Promise<T> {
  const db = await getDb();
  await sql`set role sutecba_app`.execute(db);
  try {
    return await run();
  } finally {
    await sql`reset role`.execute(db);
  }
}
const count = async (t: string) => {
  const db = await getDb();
  return Number(((await (db as any).selectFrom(t).select((eb: any) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()) as any).n);
};

describe("organización raíz SUTECBA (propietaria de las actividades)", () => {
  it("dry-run: con la base vacía crearía el tipo y la organización; no escribe nada", async () => {
    const db = await getDb();
    const before = { types: await count("organization_types"), orgs: await count("organizations") };
    const state = await readOwnerOrganizationState(db);
    expect(planOwnerOrganization(state)).toEqual({ createType: true, createOrganization: true, problems: [] });
    expect({ types: await count("organization_types"), orgs: await count("organizations") }).toEqual(before);
  });

  it("crea el tipo `sindicato` y SUTECBA como raíz independiente, con el rol runtime (production simulado)", async () => {
    const ledger = await readLedger();
    const result = await asRuntimeRole(async () => ensureOwnerOrganization(await getDb(), { createdBy: masterId, env: { ...loadEnv(), SUTECBA_ENV: "production" }, ledger: async () => ledger }));
    expect(result).toMatchObject({ outcome: "created", typeCreated: true, runtimeRole: "sutecba_app" });

    const db = await getDb();
    const org = await db
      .selectFrom("organizations as o")
      .innerJoin("organization_types as t", "t.id", "o.type_id")
      .select(["o.id", "o.official_code", "o.name", "o.parent_id", "o.active", "o.valid_from", "o.valid_to", "t.key as type", "t.name as type_name", "t.level"])
      .where("o.official_code", "=", "SUTECBA")
      .executeTakeFirstOrThrow();
    expect(org).toMatchObject({ official_code: "SUTECBA", name: OWNER_ORGANIZATION.name, parent_id: null, active: true, type: "sindicato", type_name: "Sindicato" });
    expect(await db.selectFrom("organizations").select("id").where("parent_id", "=", org.id).execute()).toHaveLength(0);
  });

  it("es idempotente: la segunda corrida no crea nada", async () => {
    const before = { types: await count("organization_types"), orgs: await count("organizations") };
    const second = await ensureOwnerOrganization(await getDb(), { createdBy: masterId });
    expect(second).toMatchObject({ outcome: "noop_idempotent", typeCreated: false });
    expect({ types: await count("organization_types"), orgs: await count("organizations") }).toEqual(before);
    const types = await (await getDb()).selectFrom("organization_types").select("id").where("key", "=", "sindicato").execute();
    expect(types).toHaveLength(1);
  });

  it("no toca los tipos ya existentes", async () => {
    const db = await getDb();
    const keys = (await db.selectFrom("organization_types").select("key").execute()).map((t) => t.key);
    for (const k of ["ministerio", "secretaria", "direccion_general", "dependencia", "poder"]) expect(keys).toContain(k);
  });

  it("una segunda raíz no rompe los scopes: el árbol GCBA y SUTECBA son independientes", async () => {
    const db = await getDb();
    const type = await db.selectFrom("organization_types").select("id").where("key", "=", "ministerio").executeTakeFirstOrThrow();
    const mk = async (name: string, parent: string | null) => (await db.insertInto("organizations").values({ name, type_id: type.id, parent_id: parent }).returning("id").executeTakeFirstOrThrow()).id;
    const gcba = await mk("Ministerio GCBA", null);
    const gcbaChild = await mk("Dirección GCBA", gcba);
    const sutecba = (await db.selectFrom("organizations").select("id").where("official_code", "=", "SUTECBA").executeTakeFirstOrThrow()).id;

    const accessible = async (userId: string) => (await sql<{ organization_id: string }>`select organization_id from user_accessible_organizations(${userId}::uuid)`.execute(db)).rows.map((r) => r.organization_id).sort();
    const scoped = async (email: string, orgId: string) => {
      const id = await makeUser(email, "ADMIN");
      await db.insertInto("user_scopes").values({ user_id: id, organization_id: orgId, include_descendants: true, granted_by: masterId } as never).execute();
      return id;
    };
    const gcbaUser = await scoped("scope-gcba@sutecba.local", gcba);
    const sutecbaUser = await scoped("scope-sutecba@sutecba.local", sutecba);

    expect(await accessible(gcbaUser)).toEqual([gcba, gcbaChild].sort()); // no ve SUTECBA
    expect(await accessible(sutecbaUser)).toEqual([sutecba]); // solo SUTECBA: no arrastra ninguna repartición GCBA
    const all = await accessible(masterId);
    expect(all).toEqual(expect.arrayContaining([gcba, gcbaChild, sutecba])); // MASTER_GLOBAL ve todo, incluida la segunda raíz
    const descendants = await sql<{ organization_id: string }>`select organization_id from organization_descendants(${sutecba}::uuid)`.execute(db);
    expect(descendants.rows.map((r) => r.organization_id)).toEqual([sutecba]);
    void adminRoleId;
  });

  it("como propietaria del lote y de las reuniones importadas: la importación funciona y las personas siguen en su repartición", async () => {
    const db = await getDb();
    const sutecba = (await db.selectFrom("organizations").select("id").where("official_code", "=", "SUTECBA").executeTakeFirstOrThrow()).id;
    const files = [fx.f09File([{ last: "Prop", first: "Ietaria", dni: "52000001", email: "p@example.com" }]), fx.agendaFile([["martes", "2026-03-10", "educacion 1"]])];
    const result = await runImport(db, files, { ownerOrganizationId: sutecba, createdBy: masterId, confirmedPlanHash: planFromSources(files).planHash } as never);
    expect(result.outcome).toBe("applied");
    const batch = await db.selectFrom("import_batches").select("owner_organization_id").where("id", "=", result.batchId).executeTakeFirstOrThrow();
    expect(batch.owner_organization_id).toBe(sutecba);
    const meetings = await db.selectFrom("meetings").select("owner_organization_id").where("origin", "=", "import" as never).execute();
    expect(meetings.length).toBeGreaterThan(0);
    expect(meetings.every((m) => m.owner_organization_id === sutecba)).toBe(true);
    // La persona NO queda en SUTECBA: su organización sigue siendo la repartición laboral (aquí, ninguna).
    const person = await db.selectFrom("people").select("organization_id").where("dni", "=", "52000001").executeTakeFirstOrThrow();
    expect(person.organization_id).toBeNull();
  });
});

describe("organización raíz SUTECBA: casos que NO se pisan", () => {
  const stateOf = async () => readOwnerOrganizationState(await getDb());
  it("SUTECBA con padre, otro nombre, otro tipo, inactiva o con hijos: problema, no se modifica", async () => {
    const base = await stateOf();
    const org = base.organization!;
    const bad = [
      { ...base, organization: { ...org, parent_id: randomUUID() } },
      { ...base, organization: { ...org, name: "Otro nombre" } },
      { ...base, organization: { ...org, type_key: "ministerio" } },
      { ...base, organization: { ...org, active: false } },
      { ...base, childrenOfOwner: 1 },
      { ...base, nameCollision: true },
    ];
    for (const state of bad) expect(planOwnerOrganization(state).problems.length).toBeGreaterThan(0);
    expect(planOwnerOrganization(base).problems).toEqual([]);
  });

  it("actor inexistente, inactivo o sin autoridad: aborta", async () => {
    const inactive = await makeUser("owner-inactivo@sutecba.local", "MASTER_GLOBAL", "inactive");
    const db = await getDb();
    const low = await makeUser("owner-bajo@sutecba.local", (await db.selectFrom("roles").select("key").where("key", "not in", ["MASTER_GLOBAL"]).executeTakeFirstOrThrow()).key);
    const before = await count("organizations");
    await expect(ensureOwnerOrganization(db, { createdBy: randomUUID() })).rejects.toThrow(/no existe/);
    await expect(ensureOwnerOrganization(db, { createdBy: inactive })).rejects.toThrow(/no está activo/);
    await expect(ensureOwnerOrganization(db, { createdBy: low })).rejects.toThrow(/autoridad suficiente/);
    expect(await count("organizations")).toBe(before);
  });

  it("production con la conexión administrativa (superusuario) aborta", async () => {
    await expect(ensureOwnerOrganization(await getDb(), { createdBy: masterId, env: { ...loadEnv(), SUTECBA_ENV: "production" } })).rejects.toThrow(/rol runtime sutecba_app/);
  });
});
