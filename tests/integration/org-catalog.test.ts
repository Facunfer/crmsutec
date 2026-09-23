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
const { applyCatalog, dryRunAgainstDatabase } = await import("../../lib/organizations/catalog/apply.js");
const { planCatalogFromSource } = await import("../../lib/organizations/catalog/plan.js");
const { runImport } = await import("../../lib/imports/gabriel/apply.js");
const { planFromSources } = await import("../../lib/imports/gabriel/plan-hash.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const fx = await import("../helpers/gabriel-fixtures.js");
const cf = await import("../helpers/org-catalog-fixtures.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
let userId: string;

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
  userId = await makeUser("catalog-actor@sutecba.local", "MASTER_GLOBAL");
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const count = async (table: string) => {
  const db = await getDb();
  const r = await (db as any).selectFrom(table).select((eb: any) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow();
  return Number(r.n);
};
const snapshot = async () => ({ types: await count("organization_types"), orgs: await count("organizations"), aliases: await count("organization_aliases") });

async function asRuntimeRole<T>(run: () => Promise<T>): Promise<T> {
  const db = await getDb();
  await sql`set role sutecba_app`.execute(db);
  try {
    return await run();
  } finally {
    await sql`reset role`.execute(db);
  }
}
async function readLedger() {
  const db = await getDb();
  const database = await sql<{ database: string }>`select current_database() as database`.execute(db);
  const meta = await sql<{ system: string }>`select system from sutecba_meta where id = true`.execute(db);
  const migs = await sql<{ filename: string }>`select filename from sutecba_migrations`.execute(db);
  return { database: database.rows[0]!.database, system: meta.rows[0]?.system ?? null, migrations: migs.rows.map((r) => r.filename) };
}

const catalog = cf.makeCatalog({
  orgs: cf.baseOrgs(),
  aliases: [
    cf.alias("Cultura", "MCGC"),
    cf.alias("CULTURA", "MCGC"),
    cf.alias("Ministerio de Cultura", "MCGC"),
    cf.alias("Patrimonio", "DGPAT"),
    cf.alias("Teatro Colon", "EATC"),
    cf.notAuto("TECBA", "PROBABLE", "MCGC"),
    cf.notAuto("area vaga", "REVISAR"),
  ],
  areas: [cf.area("DGPAT", "ARCHIVO", "pg:dgpat:archivo", "Sí", "ALIAS_SEGURO"), cf.area("DGPAT", "COSAS", null, "No", "REVISAR")],
});
const hash = planCatalogFromSource(catalog).planHash;
const apply = async (over: Record<string, unknown> = {}, cat = catalog) => {
  const db = await getDb();
  return applyCatalog(db, cat, { createdBy: userId, confirmedPlanHash: planCatalogFromSource(cat).planHash, ...over } as never);
};

describe("dry-run contra la base (solo lectura)", () => {
  it("informa qué crearía sin escribir nada", async () => {
    const db = await getDb();
    const before = await snapshot();
    const { plan, planHash } = await dryRunAgainstDatabase(db, catalog);
    expect(planHash).toBe(hash);
    expect(plan.counts).toMatchObject({ organizaciones_a_crear: 5, organizaciones_ya_existentes: 0, aliases_a_crear: 4, aliases_ambiguos: 0, errores: 0 });
    expect(plan.types.toCreate.map((t) => t.key)).toEqual(["departamento"]);
    expect(await snapshot()).toEqual(before);
  });

  it("es realmente de solo lectura: una escritura dentro de esa transacción falla", async () => {
    const db = await getDb();
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`set transaction read only`.execute(trx);
        await trx.insertInto("organization_types").values({ key: "x", name: "x", level: 1 }).execute();
      })
    ).rejects.toThrow();
  });
});

describe("apply del catálogo", () => {
  it("carga tipos, jerarquía y aliases aprobados escribiendo con el rol runtime sutecba_app (production simulado)", async () => {
    const ledger = await readLedger();
    const before = await snapshot();
    const result = await asRuntimeRole(() => apply({ env: { ...loadEnv(), SUTECBA_ENV: "production" }, ledger: async () => ledger }));
    expect(result.runtimeRole).toBe("sutecba_app");
    expect(result.outcome).toBe("applied");
    expect(result).toMatchObject({ typesCreated: 1, organizationsCreated: 5, aliasesCreated: 4 });
    const after = await snapshot();
    expect(after.orgs - before.orgs).toBe(5);
    expect(after.aliases - before.aliases).toBe(4);
  });

  it("la jerarquía y los tipos quedan como en el catálogo; official_code = canonical_key", async () => {
    const db = await getDb();
    const rows = await db
      .selectFrom("organizations as o")
      .innerJoin("organization_types as t", "t.id", "o.type_id")
      .leftJoin("organizations as p", "p.id", "o.parent_id")
      .select(["o.official_code", "o.name", "o.active", "t.key as type", "p.official_code as parent"])
      .execute();
    rows.sort((a, b) => String(a.official_code).localeCompare(String(b.official_code)));
    expect(rows).toEqual([
      { official_code: "DGPAT", name: "Dirección General de Patrimonio", active: true, type: "direccion_general", parent: "SSPCGC" },
      { official_code: "EATC", name: "Ente Autárquico Teatro Colón", active: true, type: "ente_autarquico", parent: null },
      { official_code: "MCGC", name: "Ministerio de Cultura", active: true, type: "ministerio", parent: null },
      { official_code: "pg:dgpat:archivo", name: "Departamento Archivo", active: true, type: "departamento", parent: "DGPAT" },
      { official_code: "SSPCGC", name: "Subsecretaría de Patrimonio", active: true, type: "subsecretaria", parent: "MCGC" },
    ]);
  });

  it("solo los AUTO_MAP quedan como alias aprobados, con quién y cuándo los validó; nada pendiente ni desde áreas", async () => {
    const db = await getDb();
    const aliases = await db
      .selectFrom("organization_aliases as a")
      .innerJoin("organizations as o", "o.id", "a.organization_id")
      .select(["a.alias", "a.normalized_alias", "a.status", "a.approved_by", "a.approved_at", "a.created_by", "o.official_code"])
      .execute();
    aliases.sort((x, y) => x.normalized_alias.localeCompare(y.normalized_alias));
    expect(aliases.map((a) => [a.normalized_alias, a.official_code, a.status])).toEqual([
      ["ministerio de cultura", "MCGC", "approved"],
      ["cultura", "MCGC", "approved"],
      ["patrimonio", "DGPAT", "approved"],
      ["teatro colon", "EATC", "approved"],
    ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
    expect(aliases.every((a) => a.approved_by === userId && a.created_by === userId && a.approved_at instanceof Date)).toBe(true);
  });


  it("segunda ejecución idéntica: no-op, sin duplicados", async () => {
    const before = await snapshot();
    const second = await apply();
    expect(second.outcome).toBe("noop_idempotent");
    expect(second).toMatchObject({ typesCreated: 0, organizationsCreated: 0, aliasesCreated: 0 });
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it("los alias cargados resuelven personas al importar; sin alias (o solo por nombre) queda sin unidad; nunca se crean organismos", async () => {
    const db = await getDb();
    const owner = await createTestOrganization("Unidad propietaria");
    const orgsBefore = await count("organizations");
    const files = [
      fx.f09File([
        { last: "Cul", first: "Tura", dni: "44100001", email: "c@example.com", organism: "cultura" },
        { last: "Pat", first: "Rimonio", dni: "44100002", email: "p@example.com", organism: "Patrimonio" },
        { last: "Por", first: "Nombre", dni: "44100003", email: "n@example.com", organism: "Ministerio de Cultura" }, // alias cargado ("Ministerio de Cultura" auto duplicado hacia MCGC → un solo alias por texto)
        { last: "Pro", first: "Bable", dni: "44100004", email: "b@example.com", organism: "TECBA" }, // PROBABLE: no se cargó
        { last: "Rev", first: "Isar", dni: "44100005", email: "r@example.com", organism: "area vaga" }, // REVISAR
        { last: "Nom", first: "Bre", dni: "44100006", email: "o@example.com", organism: "Departamento Archivo" }, // nombre oficial sin alias
      ]),
    ];
    const result = await runImport(db, files, { ownerOrganizationId: owner, createdBy: userId, confirmedPlanHash: planFromSources(files).planHash } as never);
    expect(result.peopleCreated).toBe(6);
    const orgOf = async (dni: string) => {
      const r = await db.selectFrom("people as p").leftJoin("organizations as o", "o.id", "p.organization_id").select("o.official_code").where("p.dni", "=", dni).executeTakeFirstOrThrow();
      return r.official_code;
    };
    expect(await orgOf("44100001")).toBe("MCGC");
    expect(await orgOf("44100002")).toBe("DGPAT");
    expect(await orgOf("44100003")).toBe("MCGC");
    expect(await orgOf("44100004")).toBeNull();
    expect(await orgOf("44100005")).toBeNull();
    expect(await orgOf("44100006")).toBeNull();
    expect(await count("organizations")).toBe(orgsBefore);
  });
});

describe("apply del catálogo: abortos y rollback", () => {
  const other = cf.makeCatalog({ orgs: [cf.org("Z1", "Zeta Uno", "Ministerio"), cf.org("Z2", "Zeta Dos", "Secretaría", "Z1")], aliases: [cf.alias("zeta", "Z1")] });

  it("hash del plan distinto: aborta sin escribir", async () => {
    const before = await snapshot();
    await expect(apply({ confirmedPlanHash: "0".repeat(64) }, other)).rejects.toThrow(/hash del plan/);
    expect(await snapshot()).toEqual(before);
  });

  it("catálogo con errores de estructura: aborta antes de escribir", async () => {
    const broken = cf.makeCatalog({ orgs: [cf.org("Q1", "Q", "Ministerio", "NOEXISTE")] });
    const before = await snapshot();
    await expect(apply({}, broken)).rejects.toThrow(/error\(es\) de estructura/);
    expect(await snapshot()).toEqual(before);
  });

  it("production con la conexión administrativa (superusuario) aborta", async () => {
    const before = await snapshot();
    await expect(apply({ env: { ...loadEnv(), SUTECBA_ENV: "production" } }, other)).rejects.toThrow(/rol runtime sutecba_app/);
    expect(await snapshot()).toEqual(before);
  });

  it("actor inexistente, inactivo o sin autoridad: aborta", async () => {
    const db = await getDb();
    const inactive = await makeUser("cat-inactivo@sutecba.local", "MASTER_GLOBAL", "inactive");
    const lowKey = (await db.selectFrom("roles").select("key").where("key", "!=", "MASTER_GLOBAL").executeTakeFirstOrThrow()).key;
    const low = await makeUser("cat-bajo@sutecba.local", lowKey);
    const before = await snapshot();
    await expect(apply({ createdBy: randomUUID() }, other)).rejects.toThrow(/no existe/);
    await expect(apply({ createdBy: inactive }, other)).rejects.toThrow(/no está activo/);
    await expect(apply({ createdBy: low }, other)).rejects.toThrow(/autoridad suficiente/);
    expect(await snapshot()).toEqual(before);
  });

  it("un conflicto contra lo ya cargado (misma clave, otro nombre) aborta sin tocar nada", async () => {
    const clash = cf.makeCatalog({ orgs: [cf.org("MCGC", "Ministerio de Otra Cosa", "Ministerio")] });
    const before = await snapshot();
    await expect(apply({}, clash)).rejects.toThrow(/ORG_CONFLICT_DB/);
    expect(await snapshot()).toEqual(before);
  });

  it("el apply toma el lock transaccional antes de escribir", async () => {
    const db = await getDb();
    await sql`
      create or replace function test_require_catalog_lock() returns trigger language plpgsql as $$
      begin
        if not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted) then
          raise exception 'apply sin lock advisory';
        end if;
        return new;
      end $$
    `.execute(db);
    await sql`create trigger test_require_catalog_lock before insert on organizations for each row execute function test_require_catalog_lock()`.execute(db);
    try {
      const result = await apply({}, other);
      expect(result.organizationsCreated).toBe(2);
    } finally {
      await sql`drop trigger test_require_catalog_lock on organizations`.execute(db);
    }
  });

  it("una falla tardía (al cargar aliases) revierte TODO: sin tipos, organizaciones ni aliases a medias", async () => {
    const db = await getDb();
    const failing = cf.makeCatalog({ orgs: [cf.org("R1", "Rollback Uno", "Ministerio"), cf.org("R2", "Rollback Dos", "Departamento", "R1")], aliases: [cf.alias("rollback", "R1")] });
    const before = await snapshot();
    await sql`create or replace function test_fail_alias() returns trigger language plpgsql as $$ begin raise exception 'falla inyectada'; end $$`.execute(db);
    await sql`create trigger test_fail_alias before insert on organization_aliases for each row execute function test_fail_alias()`.execute(db);
    try {
      await expect(apply({}, failing)).rejects.toThrow(/falla inyectada/);
    } finally {
      await sql`drop trigger test_fail_alias on organization_aliases`.execute(db);
    }
    expect(await snapshot()).toEqual(before);
    expect(await db.selectFrom("organizations").select("id").where("official_code", "in", ["R1", "R2"]).execute()).toHaveLength(0);
    const ok = await apply({}, failing);
    expect(ok.outcome).toBe("applied");
  });
});
