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
const { applyCatalog } = await import("../../lib/organizations/catalog/apply.js");
const { planCatalogFromSource } = await import("../../lib/organizations/catalog/plan.js");
const { runImport } = await import("../../lib/imports/gabriel/apply.js");
const { planFromSources } = await import("../../lib/imports/gabriel/plan-hash.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const fx = await import("../helpers/gabriel-fixtures.js");
const cf = await import("../helpers/org-catalog-fixtures.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
let userId: string;
let ownerOrgId: string;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({ email: "ctx-actor@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  userId = user.id;
  ownerOrgId = await createTestOrganization("Unidad propietaria");
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const rejects = (p: Promise<unknown>, message?: RegExp) => expect(p).rejects.toThrow(message);

describe("0022: aliases contextuales en la base", () => {
  let mc: string, mh: string, pg: string, dgtalMc: string, dgtalMh: string, dgtalPg: string, otro: string;
  const mk = async (name: string, parent: string | null) => {
    const db = await getDb();
    const type = await db.selectFrom("organization_types").select("id").where("key", "=", "reparticion").executeTakeFirstOrThrow();
    return (await db.insertInto("organizations").values({ name, type_id: type.id, parent_id: parent }).returning("id").executeTakeFirstOrThrow()).id;
  };
  const insert = async (values: Record<string, unknown>) => {
    const db = await getDb();
    return db.insertInto("organization_aliases").values({ status: "approved", approved_by: userId, approved_at: new Date(), ...values } as never).execute();
  };

  beforeAll(async () => {
    mc = await mk("MC", null);
    mh = await mk("MH", null);
    pg = await mk("PG", null);
    dgtalMc = await mk("DGTAL MC", mc);
    dgtalMh = await mk("DGTAL MH", mh);
    dgtalPg = await mk("DGTAL PG", pg);
    otro = await mk("Otro", null);
  });

  it("la columna es nullable y el índice único global anterior fue reemplazado por uno global y uno contextual", async () => {
    const db = await getDb();
    const col = await sql<{ is_nullable: string }>`select is_nullable from information_schema.columns where table_name = 'organization_aliases' and column_name = 'context_organization_id'`.execute(db);
    expect(col.rows[0]!.is_nullable).toBe("YES");
    const idx = (await sql<{ indexname: string }>`select indexname from pg_indexes where tablename = 'organization_aliases'`.execute(db)).rows.map((r) => r.indexname);
    expect(idx).not.toContain("organization_aliases_approved_unique_idx");
    expect(idx).toEqual(expect.arrayContaining(["organization_aliases_approved_global_unique_idx", "organization_aliases_approved_context_unique_idx"]));
  });

  it("el mismo texto se puede aprobar en varios contextos (DGTAL + MC / MH / PG), no dos veces en el mismo", async () => {
    await insert({ alias: "DGTAL", organization_id: dgtalMc, context_organization_id: mc });
    await insert({ alias: "DGTAL", organization_id: dgtalMh, context_organization_id: mh });
    await insert({ alias: "dgtal", organization_id: dgtalPg, context_organization_id: pg });
    await rejects(insert({ alias: "Dgtal", organization_id: dgtalMc, context_organization_id: mc }));
    await rejects(insert({ alias: "DGTAL", organization_id: dgtalMh, context_organization_id: mc }));
  });

  it("un alias GLOBAL aprobado es único por texto", async () => {
    await insert({ alias: "Cultura Global", organization_id: mc });
    await rejects(insert({ alias: "cultura  global", organization_id: mh }));
  });

  it("un global no puede hacer sombra a los contextuales del mismo texto (ni al revés)", async () => {
    await rejects(insert({ alias: "DGTAL", organization_id: dgtalMc }), /global y contextual/);
    await insert({ alias: "Solo Global", organization_id: mc });
    await rejects(insert({ alias: "Solo Global", organization_id: dgtalMc, context_organization_id: mc }), /global y contextual/);
  });

  it("un alias contextual solo puede apuntar DENTRO de su contexto, y no a su propio contexto", async () => {
    await rejects(insert({ alias: "Fuera De Contexto", organization_id: dgtalMh, context_organization_id: mc }), /dentro de su contexto/);
    await rejects(insert({ alias: "Contexto Propio", organization_id: mc, context_organization_id: mc }));
    await insert({ alias: "Un Nivel Mas Abajo", organization_id: dgtalMc, context_organization_id: mc });
  });

  it("los alias pendientes/rechazados no chocan: solo cuentan los aprobados", async () => {
    const db = await getDb();
    await db.insertInto("organization_aliases").values({ organization_id: otro, alias: "Pendiente Repetido", status: "pending" } as never).execute();
    await db.insertInto("organization_aliases").values({ organization_id: mc, alias: "Pendiente Repetido", status: "pending" } as never).execute();
    await db.insertInto("organization_aliases").values({ organization_id: dgtalMc, context_organization_id: mc, alias: "DGTAL", status: "rejected" } as never).execute();
  });

  it("la guarda es independiente del orden de los triggers: sigue impidiendo la sombra aunque el trigger de normalización esté apagado", async () => {
    const db = await getDb();
    await sql`alter table organization_aliases disable trigger organization_aliases_normalize`.execute(db);
    try {
      // Sin el trigger de normalización, la guarda calcula y guarda ella misma el valor normalizado (el de los índices).
      await insert({ alias: "  Solo  CONTEXTUAL  Sin Normalizador ", organization_id: dgtalMc, context_organization_id: mc });
      const row = await db.selectFrom("organization_aliases").select("normalized_alias").where("alias", "=", "  Solo  CONTEXTUAL  Sin Normalizador ").executeTakeFirstOrThrow();
      expect(row.normalized_alias).toBe("solo contextual sin normalizador");
      await rejects(insert({ alias: "solo contextual sin normalizador", organization_id: mc }), /global y contextual/);
      await rejects(insert({ alias: "SOLO CONTEXTUAL SIN NORMALIZADOR", organization_id: dgtalMc, context_organization_id: mc }));
    } finally {
      await sql`alter table organization_aliases enable trigger organization_aliases_normalize`.execute(db);
    }
  });

  it("un alias aprobado toma un lock transaccional sobre su texto normalizado; uno pendiente no (serializa la comprobación)", async () => {
    const db = await getDb();
    const locks = async (trx: any) => Number((await sql<{ n: number }>`select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`.execute(trx)).rows[0]!.n);
    const outcome = await db.transaction().execute(async (trx) => {
      const before = await locks(trx);
      await trx.insertInto("organization_aliases").values({ organization_id: mc, alias: "Pendiente Sin Lock", status: "pending" } as never).execute();
      const afterPending = await locks(trx);
      await trx.insertInto("organization_aliases").values({ organization_id: mc, alias: "Aprobado Con Lock", status: "approved", approved_by: userId, approved_at: new Date() } as never).execute();
      const afterApproved = await locks(trx);
      await trx.insertInto("organization_aliases").values({ organization_id: dgtalMc, context_organization_id: mc, alias: "Otro Aprobado Con Lock", status: "approved", approved_by: userId, approved_at: new Date() } as never).execute();
      return { before, afterPending, afterApproved, afterSecond: await locks(trx) };
    });
    expect(outcome.afterPending).toBe(outcome.before);
    expect(outcome.afterApproved).toBe(outcome.before + 1);
    expect(outcome.afterSecond).toBe(outcome.before + 2); // un lock por texto normalizado distinto
    // Fuera de la transacción no queda ningún lock (son transaccionales).
    const held = await sql<{ n: number }>`select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`.execute(db);
    expect(held.rows[0]!.n).toBe(0);
  });

  it("dos contextuales con contextos distintos conviven; el mismo texto y contexto lo rechaza el UNIQUE", async () => {
    await insert({ alias: "Homonimo Nuevo", organization_id: dgtalMc, context_organization_id: mc });
    await insert({ alias: "Homonimo Nuevo", organization_id: dgtalMh, context_organization_id: mh });
    await rejects(insert({ alias: "homonimo  nuevo", organization_id: dgtalMc, context_organization_id: mc }), /unique|duplicate|único/i);
  });

  it("no se puede aprobar (UPDATE) un alias que rompe la regla", async () => {
    const db = await getDb();
    const row = await db.insertInto("organization_aliases").values({ organization_id: mc, alias: "DGTAL", status: "pending" } as never).returning("id").executeTakeFirstOrThrow();
    await rejects(db.updateTable("organization_aliases").set({ status: "approved", approved_by: userId, approved_at: new Date() }).where("id", "=", row.id).execute(), /global y contextual/);
  });
});

describe("0023: privilegios explícitos de la función del trigger de alias", () => {
  it("la función de la guarda ya no es ejecutable por PUBLIC, y las funciones de normalización conservan su acceso", async () => {
    const db = await getDb();
    const acl = async (name: string) =>
      (await sql<{ acl: string | null }>`select proacl::text as acl from pg_proc where proname = ${name}`.execute(db)).rows[0]!.acl ?? "";
    // «=X/…» es el EXECUTE de PUBLIC (grantee vacío).
    expect(await acl("sutecba_organization_aliases_context_guard")).not.toMatch(/(^|[{,])=X\//);
    // 0023 no otorga nada: sutecba_app no tiene EXECUTE sobre la función del trigger…
    const appExec = await sql<{ ok: boolean }>`select has_function_privilege('sutecba_app', 'public.sutecba_organization_aliases_context_guard()', 'EXECUTE') as ok`.execute(db);
    expect(appExec.rows[0]!.ok).toBe(false);
    // …y la de normalización, que sí necesita, sigue intacta.
    expect(await acl("sutecba_organization_alias_normalize")).toContain("sutecba_app=X");
  });

  it("aun sin EXECUTE, un alias se sigue aprobando como sutecba_app (el trigger se dispara igual) y las reglas siguen vigentes", async () => {
    const db = await getDb();
    const type = await db.selectFrom("organization_types").select("id").where("key", "=", "reparticion").executeTakeFirstOrThrow();
    const mk = async (name: string, parent: string | null) => (await db.insertInto("organizations").values({ name, type_id: type.id, parent_id: parent }).returning("id").executeTakeFirstOrThrow()).id;
    const root = await mk("Raiz 0023", null);
    const child = await mk("Hija 0023", root);
    await sql`set role sutecba_app`.execute(db);
    try {
      const values = { organization_id: child, context_organization_id: root, alias: "Alias 0023", status: "approved", approved_by: userId, approved_at: new Date() };
      await db.insertInto("organization_aliases").values(values as never).execute();
      await expect(db.insertInto("organization_aliases").values({ ...values, context_organization_id: null, organization_id: root } as never).execute()).rejects.toThrow(/global y contextual/);
      await expect(db.insertInto("organization_aliases").values({ ...values, alias: "Fuera 0023", organization_id: root, context_organization_id: child } as never).execute()).rejects.toThrow();
    } finally {
      await sql`reset role`.execute(db);
    }
  });
});

describe("catálogo con homónimos: carga y resolución de punta a punta", () => {
  const catalog = cf.makeCatalog({
    orgs: cf.homonymOrgs(),
    aliases: [
      cf.alias("Cultura", "MCGC"),
      cf.alias("Hacienda", "MHFGC"),
      cf.alias("Procuración General", "PG"),
      cf.alias("DG TECNICA ADMINISTRATIVA Y LEGAL", "DGTALPG", { filas_origen: "70" }),
      cf.alias("UNIDAD DE AUDITORIA INTERNA", "UAIPG", { filas_origen: "6" }),
    ],
  });
  const hash = planCatalogFromSource(catalog).planHash;
  beforeAll(async () => {
    // Parte de un estado limpio de alias: los del bloque anterior eran solo para probar los constraints.
    const db = await getDb();
    await sql`delete from organization_aliases`.execute(db);
  });
  const apply = async (over: Record<string, unknown> = {}) => {
    const db = await getDb();
    return applyCatalog(db, catalog, { createdBy: userId, confirmedPlanHash: hash, ...over } as never);
  };
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

  it("carga los alias globales y los contextuales (uno por jurisdicción) con el rol runtime; segunda corrida: no-op", async () => {
    const ledger = await readLedger();
    const result = await asRuntimeRole(() => apply({ env: { ...loadEnv(), SUTECBA_ENV: "production" }, ledger: async () => ledger }));
    expect(result.outcome).toBe("applied");
    expect(result.plan.counts).toMatchObject({ aliases_globales_a_crear: 3, aliases_contextuales_a_crear: 13, familias_de_homonimos: 2 });
    const db = await getDb();
    const rows = await sql<{ alias: string; org: string; ctx: string | null }>`
      select a.alias, o.official_code as org, c.official_code as ctx
      from organization_aliases a join organizations o on o.id = a.organization_id left join organizations c on c.id = a.context_organization_id
      where lower(a.alias) in ('dgtal', 'uai')`.execute(db);
    expect(rows.rows.map((r) => `${r.alias}|${r.ctx}|${r.org}`).sort()).toEqual(["DGTAL|MCGC|DGTALMC", "DGTAL|MHFGC|DGTALMHF", "DGTAL|PG|DGTALPG", "UAI|MCGC|UAIMC", "UAI|PG|UAIPG"]);
    // La homologación V2 (texto genérico → DGTALPG) ya no es global: el mismo texto en otra jurisdicción tiene su propia unidad.
    const generic = await sql<{ ctx: string | null; org: string }>`select c.official_code as ctx, o.official_code as org from organization_aliases a join organizations o on o.id = a.organization_id left join organizations c on c.id = a.context_organization_id where a.alias = 'DG TECNICA ADMINISTRATIVA Y LEGAL'`.execute(db);
    expect(generic.rows.map((r) => `${r.ctx}>${r.org}`).sort()).toEqual(["MCGC>DGTALMC", "MHFGC>DGTALMHF", "PG>DGTALPG"]);

    const second = await apply();
    expect(second.outcome).toBe("noop_idempotent");
  });

  it("Gabriel: fila explícita, archivo de Procuración y contexto de persona resuelven la unidad homónima correcta; sin contexto no se asigna", async () => {
    const db = await getDb();
    const files = [
      fx.f09File([
        { last: "Fila", first: "Explicita", dni: "51000001", email: "f1@example.com", organism: "Cultura / DGTAL" }, // → DGTALMC (contexto de fila)
        { last: "Sin", first: "Contexto", dni: "51000002", email: "f2@example.com", organism: "DGTAL" }, // → sin unidad
        { last: "Solo", first: "Cultura", dni: "51000003", email: "f3@example.com", organism: "Cultura" }, // → MCGC (global)
        { last: "Por", first: "Persona", dni: "51000004", email: "f4@example.com", organism: "Hacienda" },
        { last: "Conflicto", first: "Contexto", dni: "51000005", email: "f5@example.com", organism: "Cultura" },
      ]),
      // La misma persona en otras fuentes (un archivo por código, como en la corrida real): solo «DGTAL» en F02 y la
      // evidencia de Hacienda define el contexto; para la otra, Cultura + Hacienda + DGTAL no elige.
      fx.courseListFile("F02", "52010-RCP CRUZ MALTA.xlsx", { code: "52010", when: "09/09/2026 10 a 13 hs" }, [
        { cuil: fx.cuilFor("51000004"), last: "Por", first: "Persona", organism: "DGTAL" },
        { cuil: fx.cuilFor("51000005"), last: "Conflicto", first: "Contexto", organism: "DGTAL" },
      ]),
      fx.courseListFile("F05", "52469-INTELIGENCIA EMOCIONAL EN LA ORGANIZACION - A.G.C.xlsx", { code: "52469" }, [{ cuil: fx.cuilFor("51000005"), last: "Conflicto", first: "Contexto", organism: "Hacienda" }]),
      // Padrón PG (F07): archivo de una sola jurisdicción.
      fx.f07File([
        { last: "Procuracion", first: "Dgtal", cuil: fx.cuilFor("51000006"), organism: "DG TECNICA ADMINISTRATIVA Y LEGAL" },
        { last: "Procuracion", first: "Uai", cuil: fx.cuilFor("51000007"), organism: "UNIDAD DE AUDITORIA INTERNA" },
      ]),
    ];
    const result = await runImport(db, files, { ownerOrganizationId: ownerOrgId, createdBy: userId, confirmedPlanHash: planFromSources(files).planHash } as never);
    expect(result.peopleCreated).toBe(7);

    const orgOf = async (dni: string) => (await db.selectFrom("people as p").leftJoin("organizations as o", "o.id", "p.organization_id").select("o.official_code").where("p.dni", "=", dni).executeTakeFirstOrThrow()).official_code;
    expect(await orgOf("51000001")).toBe("DGTALMC");
    expect(await orgOf("51000002")).toBeNull();
    expect(await orgOf("51000003")).toBe("MCGC");
    expect(await orgOf("51000004")).toBe("DGTALMHF");
    expect(await orgOf("51000005")).toBeNull();
    expect(await orgOf("51000006")).toBe("DGTALPG");
    expect(await orgOf("51000007")).toBe("UAIPG");

    // La resolución contextual queda registrada en el staging de las filas.
    const staged = await sql<{ dni: string; res: string | null }>`select normalized_dni as dni, normalized_data->'organization'->>'resolution' as res from import_rows where normalized_dni in ('51000001','51000004','51000006')`.execute(db);
    const byDni = new Map(staged.rows.map((r) => [r.dni + ":" + r.res, true]));
    expect(byDni.has("51000001:row_context")).toBe(true);
    expect(byDni.has("51000004:person_context")).toBe(true);
    expect(byDni.has("51000006:file_context")).toBe(true);

    const issues = (await db.selectFrom("import_issues").select("code").execute()).map((i) => i.code);
    expect(issues).toContain("ORGANISM_CONTEXT_CONFLICT");
    expect(issues).toContain("ORGANISM_UNMAPPED");
    expect(result.plan.counts).toMatchObject({
      organizacion_resuelta_por_contexto_de_fila: 1,
      organizacion_resuelta_por_contexto_de_persona: 1,
      organizacion_resuelta_por_contexto_de_archivo: 2,
      organizacion_con_contexto_insuficiente: 1,
      organizacion_con_conflicto_de_contexto: 1,
    });
  });
});
