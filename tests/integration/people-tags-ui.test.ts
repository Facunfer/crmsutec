import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

/** Etiquetas y observaciones visibles en Personas: filtro por etiqueta, nombres por página, ficha. */
process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { listPeoplePage, listPersonObservations } = await import("../../lib/people/queries.js");
const { listTagNamesForPeople, listVisibleTags, listPersonTags } = await import("../../lib/tags/queries.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = PERMISSIONS.map((p) => p.key);
const actorOf = (id: string, roleKey: string, perms: string[] = ALL): any => ({ id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: new Set(ALL_MODULE_KEYS), permissions: new Set(perms) });
const O: Record<string, string> = {};
const P: Record<string, string> = {};
let master: any, masterNoTags: any, scoped: any;
let abogado = "";
let rowId = "";

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  const db = await getDb();
  const type = async (key: string, name: string, level: number) => (await db.selectFrom("organization_types").select("id").where("key", "=", key).executeTakeFirst())?.id ?? (await db.insertInto("organization_types").values({ key, name, level } as never).returning("id").executeTakeFirstOrThrow()).id;
  const tMin = await type("ministerio", "Ministerio", 1);
  O.A = (await db.insertInto("organizations").values({ name: "Área A", type_id: tMin, official_code: "A" }).returning("id").executeTakeFirstOrThrow()).id;
  O.B = (await db.insertInto("organizations").values({ name: "Área B", type_id: tMin, official_code: "B" }).returning("id").executeTakeFirstOrThrow()).id;
  const role = async (k: string) => (await db.selectFrom("roles").select("id").where("key", "=", k).executeTakeFirstOrThrow()).id;
  const user = async (email: string, k: string) => (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: await role(k), status: "active" } as never).returning("id").executeTakeFirstOrThrow()).id;
  const mId = await user("tags-master@x.local", "MASTER_GLOBAL");
  const sId = await user("tags-scoped@x.local", "ADMIN");
  await db.insertInto("user_scopes").values({ user_id: sId, organization_id: O.A!, include_descendants: true, granted_by: mId } as never).execute();
  master = actorOf(mId, "MASTER_GLOBAL");
  masterNoTags = actorOf(mId, "MASTER_GLOBAL", ALL.filter((p) => p !== "tags.view"));
  scoped = actorOf(sId, "ADMIN");
  const person = async (key: string, dni: string, org: string | null) => {
    P[key] = (await db.insertInto("people").values({ first_name: key, last_name: "Apellido", dni, organization_id: org, origin: "import" } as never).returning("id").executeTakeFirstOrThrow()).id;
  };
  await person("enA", "70000001", O.A!);
  await person("enB", "70000002", O.B!);
  await person("sinOrg", "70000003", null);
  abogado = (await db.insertInto("tags").values({ name: "abogado", normalized_name: "abogado", category: "clasificacion", is_controlled: true, created_by: mId } as never).returning("id").executeTakeFirstOrThrow()).id;
  const other = (await db.insertInto("tags").values({ name: "otra", normalized_name: "otra", created_by: mId } as never).returning("id").executeTakeFirstOrThrow()).id;
  for (const k of ["enA", "enB", "sinOrg"]) await db.insertInto("person_tags").values({ person_id: P[k]!, tag_id: abogado, assigned_by: mId } as never).execute();
  await db.insertInto("person_tags").values({ person_id: P.enA!, tag_id: other, assigned_by: mId } as never).execute();
  const file = await db.insertInto("import_files").values({ original_name: "t.xlsx", content_hash: "c".repeat(64), created_by: mId } as never).returning("id").executeTakeFirstOrThrow();
  rowId = (await db.insertInto("import_rows").values({ file_id: file.id, sheet: "s", row_number: 1, raw_data: sql`'{}'::jsonb`, row_hash: "d".repeat(64) } as never).returning("id").executeTakeFirstOrThrow()).id;
  for (const k of ["enA", "enB"]) await db.insertInto("person_observations").values({ person_id: P[k]!, category: "colegio_votacion", value: k === "enA" ? "CPACF" : "La Plata", source_kind: "import", import_row_id: rowId, created_by: mId } as never).execute();
}, 300000);

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("etiquetas y observaciones en Personas", () => {
  it("el catálogo visible incluye «abogado» para Master y para un usuario con alcance (etiqueta global); sin tags.view no hay catálogo", async () => {
    expect((await listVisibleTags(master)).map((t) => t.name)).toContain("abogado");
    expect((await listVisibleTags(scoped)).map((t) => t.name)).toContain("abogado");
    expect(await listVisibleTags(masterNoTags)).toEqual([]);
  });

  it("filtrar por «abogado» trae solo personas con esa etiqueta y dentro del alcance (sin organización no entra a un usuario de área)", async () => {
    const m = await listPeoplePage(master, { tagIds: [abogado] }, { field: "name", direction: "asc" }, 1, 50);
    expect(m.total).toBe(3);
    const s = await listPeoplePage(scoped, { tagIds: [abogado] }, { field: "name", direction: "asc" }, 1, 50);
    expect(s.rows.map((r) => r.id)).toEqual([P.enA!]);
    expect((await listPeoplePage(masterNoTags, { tagIds: [abogado] }, { field: "name", direction: "asc" }, 1, 50)).total).toBe(0);
  });

  it("los nombres de etiquetas de una página son los vigentes y visibles; sin tags.view no se muestra ninguno", async () => {
    const ids = [P.enA!, P.enB!, P.sinOrg!];
    const byPerson = await listTagNamesForPeople(master, ids);
    expect(byPerson.get(P.enA!)).toEqual(["abogado", "otra"]);
    expect(byPerson.get(P.enB!)).toEqual(["abogado"]);
    expect((await listTagNamesForPeople(masterNoTags, ids)).size).toBe(0);
    expect(await listTagNamesForPeople(master, [])).toEqual(new Map());
    expect((await listPersonTags(master, P.enA!)).map((t) => t.name)).toEqual(["abogado", "otra"]);
  });

  it("las observaciones de la ficha muestran el colegio de votación y respetan el alcance", async () => {
    expect((await listPersonObservations(master, P.enA!)).map((o) => [o.category, o.value])).toEqual([["colegio_votacion", "CPACF"]]);
    expect((await listPersonObservations(scoped, P.enA!)).length).toBe(1);
    expect(await listPersonObservations(scoped, P.enB!)).toEqual([]); // fuera de su alcance
    expect(await listPersonObservations(scoped, P.sinOrg!)).toEqual([]);
    expect(await listPersonObservations(master, "no-es-uuid")).toEqual([]);
  });
});
