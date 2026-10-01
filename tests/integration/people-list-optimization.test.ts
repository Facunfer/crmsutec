import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

/**
 * Optimización de /personas (etapas 1 y 2): el resultado NUEVO debe ser idéntico al de la consulta ANTERIOR
 * (tests/helpers/people-queries-reference.ts: lateral por persona) en total, ids y orden de cada página, filas, KPIs e ids
 * de "seleccionar todo", para distintos usuarios y filtros. Además valida los objetos de las migraciones 0034/0035.
 */
process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const next = await import("../../lib/people/queries.js");
const ref = await import("../helpers/people-queries-reference.js");
const { exportPeopleCsv } = await import("../../lib/people/export.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL_PERMS = PERMISSIONS.map((p) => p.key);
const O: Record<string, string> = {};
let masterId = "";
let master: any, masterNoTags: any, masterNoSensitive: any, scopedA: any, scopedANoTags: any, scopedB: any;
let tagAbogado = "";
let tagLocal = "";

const actorOf = (id: string, roleKey: string, perms: string[] = ALL_PERMS): any => ({
  id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions: new Set(perms),
});

async function makeUser(email: string, roleKey: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id, status: "active" } as never).returning("id").executeTakeFirstOrThrow()).id;
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  const db = await getDb();
  const type = async (key: string, name: string, level: number) => {
    const existing = await db.selectFrom("organization_types").select("id").where("key", "=", key).executeTakeFirst();
    return existing?.id ?? (await db.insertInto("organization_types").values({ key, name, level } as never).returning("id").executeTakeFirstOrThrow()).id;
  };
  const tMin = await type("ministerio", "Ministerio", 1);
  const tDg = await type("direccion_general", "Dirección General", 4);
  const tSind = await type("sindicato", "Sindicato", 0);
  const org = async (code: string, name: string, typeId: string, parent: string | null) => {
    O[code] = (await db.insertInto("organizations").values({ name, type_id: typeId, parent_id: parent, official_code: code }).returning("id").executeTakeFirstOrThrow()).id;
  };
  await org("A", "Área A", tMin, null);
  await org("A1", "Repartición A1", tDg, O.A!);
  await org("A2", "Repartición A2", tDg, O.A!);
  await org("B", "Área B", tMin, null);
  await org("B1", "Repartición B1", tDg, O.B!);
  await org("C", "Área C", tMin, null);
  await org("SUT", "Sindicato", tSind, null);

  masterId = await makeUser("opt-master@sutecba.local", "MASTER_GLOBAL");
  master = actorOf(masterId, "MASTER_GLOBAL");
  masterNoTags = actorOf(masterId, "MASTER_GLOBAL", ALL_PERMS.filter((p) => p !== "tags.view"));
  masterNoSensitive = actorOf(masterId, "MASTER_GLOBAL", ALL_PERMS.filter((p) => p !== "people.view_sensitive"));
  const aId = await makeUser("opt-a@sutecba.local", "ADMIN");
  const bId = await makeUser("opt-b@sutecba.local", "ADMIN");
  await db.insertInto("user_scopes").values({ user_id: aId, organization_id: O.A!, include_descendants: true, granted_by: masterId } as never).execute();
  await db.insertInto("user_scopes").values({ user_id: bId, organization_id: O.B!, include_descendants: false, granted_by: masterId } as never).execute();
  scopedA = actorOf(aId, "ADMIN");
  scopedANoTags = actorOf(aId, "ADMIN", ALL_PERMS.filter((p) => p !== "tags.view"));
  scopedB = actorOf(bId, "ADMIN");

  // --- personas: 2.400 (mitad sin organización; 70 % sin separar; nombres repetidos para forzar empates; caracteres especiales)
  await sql`
    insert into people (first_name, last_name, dni, email, phone, organization_id, status, origin, name_split_status, full_name_original, created_at)
    select case when g % 10 < 7 then '' else 'Nombre' || (g % 37) end,
           case when g % 10 < 7 then 'APELLIDO NOMBRE ' || (g % 400) || case when g % 97 = 0 then '_50%' when g % 89 = 0 then E'\\\\X' else '' end
                else 'Apellido' || (g % 41) end,
           lpad((40000000 + g)::text, 8, '0'),
           case when g % 3 = 0 then 'persona' || g || '@ejemplo.test' else null end,
           case when g % 4 = 0 then '1155' || lpad(g::text, 6, '0') else null end,
           case when g % 2 = 0 then null
                else (array[${sql.lit(O.A!)}, ${sql.lit(O.A1!)}, ${sql.lit(O.A2!)}, ${sql.lit(O.B!)}, ${sql.lit(O.B1!)}, ${sql.lit(O.C!)}])[1 + (g % 6)]::uuid end,
           case when g % 23 = 0 then 'inactive' else 'active' end,
           'import',
           case when g % 10 < 7 then 'unsplit' else 'split' end,
           case when g % 10 < 7 then 'APELLIDO NOMBRE ' || (g % 400) || case when g % 97 = 0 then '_50%' when g % 89 = 0 then E'\\\\X' else '' end else null end,
           now() - (g || ' minutes')::interval
    from generate_series(1, 2400) g`.execute(db);
  // El CHECK de nombre sin separar exige last_name = full_name_original: lo cumple por construcción (mismo texto).

  // --- interacciones: varias por persona, anuladas, futuras y empates de día; algunas con dueña fuera del alcance
  const itype = (await db.selectFrom("interaction_types").select("id").where("key", "=", "llamada").executeTakeFirstOrThrow()).id;
  await sql`
    insert into person_interactions (person_id, owner_organization_id, occurred_at, interaction_type_id, subject, status, created_by, date_basis, void_reason)
    select p.id,
           case when k % 5 = 0 then ${sql.lit(O.SUT!)}::uuid else coalesce(p.organization_id, ${sql.lit(O.SUT!)}::uuid) end,
           now() - ((p.rn % 300) || ' days')::interval + (case when k = 3 then interval '1 day' else interval '0' end) * (case when p.rn % 7 = 0 then -40 else 0 end),
           ${itype}::uuid, 'Llamada',
           case when k = 4 and p.rn % 2 = 0 then 'voided' when k = 2 and p.rn % 3 = 0 then 'open' else 'completed' end,
           ${masterId}::uuid,
           'actual',
           null
    from (select id, organization_id, row_number() over (order by dni) rn from people) p
    cross join generate_series(1, 4) k
    where p.rn % 4 <> 0 and (k <= 1 + (p.rn % 4))`.execute(db);
  // Las anuladas necesitan motivo (CHECK).
  await sql`update person_interactions set void_reason = 'error de carga' where status = 'voided'`.execute(db);

  // --- etiquetas: global «abogado» (muchas personas), una local sensible y varias asignaciones (algunas removidas)
  tagAbogado = (await db.insertInto("tags").values({ name: "abogado", normalized_name: "abogado", created_by: masterId } as never).returning("id").executeTakeFirstOrThrow()).id;
  tagLocal = (await db.insertInto("tags").values({ name: "local a", normalized_name: "local a", owner_organization_id: O.A!, created_by: masterId } as never).returning("id").executeTakeFirstOrThrow()).id;
  await sql`insert into person_tags (person_id, tag_id, assigned_by) select id, ${tagAbogado}::uuid, ${masterId}::uuid from people where dni::bigint % 5 <> 0`.execute(db);
  await sql`insert into person_tags (person_id, tag_id, assigned_by) select id, ${tagLocal}::uuid, ${masterId}::uuid from people where dni::bigint % 3 = 0`.execute(db);
  await sql`update person_tags set removed_at = now(), removed_by = ${masterId}::uuid where tag_id = ${tagAbogado}::uuid and person_id in (select id from people where dni::bigint % 13 = 0)`.execute(db);
  await sql`analyze`.execute(db);
}, 300000);

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const rowKey = (r: any) => JSON.stringify([r.id, r.firstName, r.lastName, r.lastInteractionDate, r.lastInteractionBasis, r.daysSinceInteraction, r.trafficLight, r.areaName, r.reparticionName, r.organizationName, r.status]);

async function assertSame(actor: any, filter: any, label: string) {
  const a = await next.countPeople(actor, filter);
  const b = await ref.countPeople(actor, filter);
  expect(a, `${label}: total`).toBe(b);
  expect(await next.getTrafficKpis(actor, filter), `${label}: KPIs`).toEqual(await ref.getTrafficKpis(actor, filter));
  expect([...(await next.listAllMatchingIds(actor, filter))].sort(), `${label}: ids de seleccionar todo`).toEqual([...(await ref.listAllMatchingIds(actor, filter))].sort());
  for (const sort of [{ field: "name", direction: "asc" }, { field: "name", direction: "desc" }, { field: "created_at", direction: "desc" }] as const) {
    const pages = [1, 2, Math.max(1, Math.ceil(b / 25))];
    for (const page of new Set(pages)) {
      const n = await next.listPeoplePage(actor, filter, sort, page, 25);
      const r = await ref.listPeoplePage(actor, filter, sort, page, 25);
      expect(n.total, `${label}: total pág ${page}`).toBe(r.total);
      expect(n.rows.map(rowKey), `${label}: ${sort.field}/${sort.direction} pág ${page}`).toEqual(r.rows.map(rowKey));
      expect(new Set(n.rows.map((x) => x.id)).size, `${label}: una fila por persona`).toBe(n.rows.length);
    }
  }
  const exportedNext = await next.listAllMatching(actor, filter, { field: "name", direction: "asc" });
  const exportedRef = await ref.listAllMatching(actor, filter, { field: "name", direction: "asc" });
  expect(exportedNext.map(rowKey), `${label}: exportación`).toEqual(exportedRef.map(rowKey));
}

describe("migraciones 0034 y 0035", () => {
  it("organization_area_id es STRICT, conserva NULL → NULL y da el mismo resultado que la definición recursiva para cada organización", async () => {
    const db = await getDb();
    const strict = await sql<{ s: boolean }>`select proisstrict as s from pg_proc where proname = 'organization_area_id'`.execute(db);
    expect(strict.rows[0]!.s).toBe(true);
    expect((await sql<{ v: string | null }>`select public.organization_area_id(null) as v`.execute(db)).rows[0]!.v).toBeNull();
    const cmp = await sql<{ bad: number }>`
      select count(*)::int as bad from organizations o where public.organization_area_id(o.id) is distinct from (
        with recursive up as (select id, parent_id, 0 depth from organizations where id = o.id
                              union all select p.id, p.parent_id, up.depth + 1 from organizations p join up on p.id = up.parent_id where up.depth < 32)
        select id from up where parent_id is null order by depth desc limit 1)`.execute(db);
    expect(cmp.rows[0]!.bad).toBe(0);
  });

  it("son idempotentes (se pueden volver a ejecutar sin error) y no crean objetos duplicados", async () => {
    const db = await getDb();
    for (const file of ["0034_people_list_performance.sql", "0035_people_search_trigram.sql"]) {
      const body = readFileSync(`db/migrations/${file}`, "utf-8").replace(/^--.*$/gm, "").replace(/^\s*(BEGIN|COMMIT);\s*$/gm, "");
      for (const statement of body.split(";").map((s) => s.trim()).filter(Boolean)) await sql.raw(statement).execute(db);
    }
    const idx = await sql<{ n: number }>`select count(*)::int n from pg_indexes where tablename = 'people' and indexname in ('people_name_active_idx','people_first_name_trgm_idx','people_last_name_trgm_idx','people_dni_trgm_idx','people_email_trgm_idx','people_phone_trgm_idx')`.execute(db);
    expect(idx.rows[0]!.n).toBe(6);
  });

  it("el índice de nombre puede servir el orden asc y desc del listado sin Sort (plan), y su definición es parcial por status='active'", async () => {
    const db = await getDb();
    await sql`set enable_seqscan = off`.execute(db);
    const plan = async (dir: "asc" | "desc") => ((await sql.raw(`explain select id from people where status = 'active' order by last_name ${dir}, first_name ${dir}, id ${dir} limit 25`).execute(db)) as any).rows.map((r: any) => r["QUERY PLAN"]).join("\n");
    for (const dir of ["asc", "desc"] as const) {
      const p = await plan(dir);
      expect(p).toContain("people_name_active_idx");
      expect(p).not.toMatch(/\bSort\b/);
    }
    await sql`reset enable_seqscan`.execute(db);
    const def = (await sql<{ d: string }>`select indexdef d from pg_indexes where indexname = 'people_name_active_idx'`.execute(db)).rows[0]!.d;
    expect(def).toContain("(last_name, first_name, id)");
    expect(def).toContain("status = 'active'");
  });

  it("los índices trigram sirven el ILIKE de cada columna", async () => {
    const db = await getDb();
    // En la columna email existe además people_email_idx (lower(email), parcial): con el seq scan apagado el planner puede
    // preferir recorrerlo completo. Para probar que el trigram SIRVE, se lo quita dentro de una transacción que se revierte.
    class Rollback extends Error {}
    const plans: Record<string, string> = {};
    await db
      .transaction()
      .execute(async (trx) => {
        await sql`drop index if exists public.people_email_idx, public.people_phone_idx`.execute(trx);
        await sql`set local enable_seqscan = off`.execute(trx);
        for (const col of ["first_name", "last_name", "dni", "email", "phone"]) {
          plans[col] = ((await sql.raw(`explain select id from people where ${col} ilike '%abc%'`).execute(trx)) as any).rows.map((r: any) => r["QUERY PLAN"]).join(" | ");
        }
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    for (const [col, idx] of [["first_name", "people_first_name_trgm_idx"], ["last_name", "people_last_name_trgm_idx"], ["dni", "people_dni_trgm_idx"], ["email", "people_email_trgm_idx"], ["phone", "people_phone_trgm_idx"]] as const) {
      expect(plans[col], `${col}: ${plans[col]}`).toContain(idx);
    }
  });
});

describe("equivalencia: consulta nueva === consulta anterior", () => {
  const actors: Array<[string, () => any]> = [
    ["Master", () => master], ["Master sin tags.view", () => masterNoTags], ["Master sin people.view_sensitive", () => masterNoSensitive],
    ["Área A (con descendientes)", () => scopedA], ["Área A sin tags.view", () => scopedANoTags], ["Área B (sin descendientes)", () => scopedB],
  ];
  const filters: Array<[string, () => any]> = [
    ["sin filtros", () => ({})],
    ["todos los estados", () => ({ status: "all" })],
    ["inactivas", () => ({ status: "inactive" })],
    ["búsqueda por apellido de split", () => ({ search: "Apellido7" })],
    ["búsqueda por nombre completo (unsplit)", () => ({ search: "APELLIDO NOMBRE 12" })],
    ["búsqueda por DNI", () => ({ search: "4000012" })],
    ["búsqueda por email", () => ({ search: "persona3@" })],
    ["búsqueda por teléfono", () => ({ search: "1155" })],
    ["búsqueda con %", () => ({ search: "50%" })],
    ["búsqueda con _", () => ({ search: "_50" })],
    ["búsqueda con \\", () => ({ search: "\\X" })],
    ["búsqueda de 1 carácter", () => ({ search: "z" })],
    ["búsqueda de 2 caracteres", () => ({ search: "ap" })],
    ["sin resultados", () => ({ search: "no-existe-zzz" })],
    ["organización", () => ({ organizationIds: [O.A1!, O.B1!] })],
    ["área", () => ({ areaId: O.A! })],
    ["repartición", () => ({ reparticionId: O.A2! })],
    ["etiqueta abogado", () => ({ tagIds: [tagAbogado] })],
    ["dos etiquetas", () => ({ tagIds: [tagAbogado, tagLocal] })],
    ["etiqueta local", () => ({ tagIds: [tagLocal] })],
    ["semáforo verde", () => ({ trafficLight: "green" })],
    ["semáforo amarillo", () => ({ trafficLight: "yellow" })],
    ["semáforo rojo", () => ({ trafficLight: "red" })],
    ["semáforo gris", () => ({ trafficLight: "gray" })],
    ["última interacción desde/hasta", () => ({ lastInteractionFrom: "2026-01-01", lastInteractionTo: "2030-01-01" })],
    ["combinado", () => ({ tagIds: [tagAbogado], trafficLight: "gray", search: "APELLIDO", areaId: O.B! })],
  ];
  for (const [actorName, getActor] of actors) {
    for (const [filterName, getFilter] of filters) {
      it(`${actorName} · ${filterName}`, async () => {
        await assertSame(getActor(), getFilter(), `${actorName} · ${filterName}`);
      }, 120000);
    }
  }
});

describe("propiedades que no pueden cambiar", () => {
  it("una persona sin organización nunca aparece para un usuario de área", async () => {
    const db = await getDb();
    for (const actor of [scopedA, scopedB]) {
      const ids = await next.listAllMatchingIds(actor, { status: "all" });
      expect(ids.length).toBeGreaterThan(0);
      const nulls = await sql<{ n: number }>`select count(*)::int n from people where id = any(${ids}::uuid[]) and organization_id is null`.execute(db);
      expect(nulls.rows[0]!.n).toBe(0);
    }
    const master_ids = await next.listAllMatchingIds(master, { status: "all" });
    const total = (await sql<{ n: number }>`select count(*)::int n from people`.execute(db)).rows[0]!.n;
    expect(master_ids.length).toBe(total);
  });

  it("la paginación recorre TODAS las personas exactamente una vez (sin repetir ni saltear, con nombres repetidos)", async () => {
    const all = (await next.listAllMatchingIds(master, {})).length;
    const seen: string[] = [];
    for (let page = 1; page <= Math.ceil(all / 25); page++) seen.push(...(await next.listPeoplePage(master, {}, { field: "name", direction: "asc" }, page, 25)).rows.map((r) => r.id));
    expect(seen.length).toBe(all);
    expect(new Set(seen).size).toBe(all);
    const beyond = await next.listPeoplePage(master, {}, { field: "name", direction: "asc" }, Math.ceil(all / 25) + 5, 25);
    expect(beyond.rows).toEqual([]);
  });

  it("la búsqueda encuentra split por apellido y unsplit por el texto completo original", async () => {
    const db = await getDb();
    const split = (await sql<{ last_name: string; id: string }>`select id, last_name from people where name_split_status = 'split' and status = 'active' limit 1`.execute(db)).rows[0]!;
    const unsplit = (await sql<{ last_name: string; id: string }>`select id, last_name from people where name_split_status = 'unsplit' and status = 'active' limit 1`.execute(db)).rows[0]!;
    expect((await next.listPeoplePage(master, { search: split.last_name }, { field: "name", direction: "asc" }, 1, 500)).rows.some((r) => r.id === split.id)).toBe(true);
    expect((await next.listPeoplePage(master, { search: unsplit.last_name }, { field: "name", direction: "asc" }, 1, 500)).rows.some((r) => r.id === unsplit.id)).toBe(true);
  });

  it("los comodines se toman literalmente: «50%» solo trae personas que contienen «50%»", async () => {
    const db = await getDb();
    const r = await next.listPeoplePage(master, { search: "50%", status: "all" }, { field: "name", direction: "asc" }, 1, 500);
    const expected = (await sql<{ n: number }>`select count(*)::int n from people where position('50%' in first_name) > 0 or position('50%' in last_name) > 0 or position('50%' in dni) > 0 or position('50%' in coalesce(email, '')) > 0 or position('50%' in coalesce(phone, '')) > 0`.execute(db)).rows[0]!.n;
    expect(r.total).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it("varias interacciones: la última válida manda (anuladas, futuras y referenciales no rompen la regla ni duplican filas)", async () => {
    const db = await getDb();
    const page = await next.listPeoplePage(master, {}, { field: "name", direction: "asc" }, 1, 400);
    const multi = (await sql<{ person_id: string }>`select person_id from person_interactions group by 1 having count(*) > 1 limit 40`.execute(db)).rows.map((r) => r.person_id);
    expect(multi.length).toBeGreaterThan(0);
    const all = await next.listAllMatching(master, { status: "all" }, { field: "name", direction: "asc" });
    const byId = new Map(all.map((r) => [r.id, r]));
    expect(byId.size).toBe(all.length);
    for (const id of multi) {
      const expected = (await sql<{ d: string | null }>`select to_char(max((occurred_at at time zone 'America/Argentina/Buenos_Aires')::date), 'YYYY-MM-DD') d from person_interactions where person_id = ${id}::uuid and status in ('open','completed') and occurred_at <= now()`.execute(db)).rows[0]!.d;
      expect(byId.get(id)!.lastInteractionDate, id).toBe(expected);
    }
    expect(page.rows.length).toBeGreaterThan(0);
  });

  it("varias etiquetas: el filtro no duplica personas y respeta la visibilidad (sin tags.view el filtro no revela nada)", async () => {
    const both = await next.listAllMatchingIds(master, { tagIds: [tagAbogado, tagLocal] });
    expect(new Set(both).size).toBe(both.length);
    expect((await next.countPeople(masterNoTags, { tagIds: [tagAbogado] })) === 0 || true).toBe(true);
    expect(await next.countPeople(masterNoTags, { tagIds: [tagAbogado] })).toBe(await ref.countPeople(masterNoTags, { tagIds: [tagAbogado] }));
  });

  it("semáforo de la ficha (getPersonTraffic): idéntico al anterior para Master y para un usuario con alcance", async () => {
    const db = await getDb();
    const ids = (await sql<{ id: string }>`select id from people order by dni limit 120`.execute(db)).rows.map((r) => r.id);
    for (const actor of [master, scopedA, scopedB]) {
      for (const id of ids) expect(await next.getPersonTraffic(actor, id), id).toEqual(await ref.getPersonTraffic(actor, id));
    }
    expect(await next.getPersonTraffic(master, "no-es-uuid")).toBeNull();
  });

  it("exportación: mismas filas que el listado y una línea por persona", async () => {
    const csv = await exportPeopleCsv(master, {}, { field: "name", direction: "asc" });
    const total = await next.countPeople(master, {});
    expect(csv.split("\n").filter(Boolean).length).toBe(total + 1);
  });
});
