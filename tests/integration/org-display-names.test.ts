import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { getPersonById, listPeoplePage } = await import("../../lib/people/queries.js");
const { listAreaOptions, listOrgTreeOptions, describeOrganization } = await import("../../lib/organizations/areas.js");
const { listMeetingParticipants } = await import("../../lib/meetings/participants.js");
const { listAdministrableUsers } = await import("../../lib/users/administration.js");
const { exportPeopleCsv } = await import("../../lib/people/export.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const O: Record<string, string> = {};
const P: Record<string, string> = {};
let master: any;
let masterId: string;
let meetingId: string;

const DGTAL_A = "Dirección General Técnica Administrativa y Legal";
const DGTAL_B = "Dirección General Técnica, Administrativa y Legal";

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  const db = await getDb();
  const type = async (key: string, level: number) => (await db.selectFrom("organization_types").select("id").where("key", "=", key).executeTakeFirst())?.id ?? (await db.insertInto("organization_types").values({ key, name: key, level } as never).returning("id").executeTakeFirstOrThrow()).id;
  const tMin = await type("ministerio", 1);
  const tDg = await type("direccion_general", 4);
  const tSind = await type("sindicato", 0);
  const org = async (code: string, name: string, typeId: string, parent: string | null) => {
    O[code] = (await db.insertInto("organizations").values({ name, type_id: typeId, parent_id: parent, official_code: code }).returning("id").executeTakeFirstOrThrow()).id;
  };
  await org("MHFGC", "Ministerio de Hacienda y Finanzas", tMin, null);
  await org("MCGC", "Ministerio de Cultura", tMin, null);
  await org("PG", "Procuración General", tMin, null);
  await org("DGTALMHF", DGTAL_A, tDg, O.MHFGC!);
  await org("DGTALMC", DGTAL_A, tDg, O.MCGC!);
  await org("DGTALPG", DGTAL_B, tDg, O.PG!);
  await org("EATC", "Ente Autárquico Teatro Colón", tDg, O.MCGC!);
  await org("SUTECBA", "Sindicato", tSind, null);

  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  masterId = (await db.insertInto("users").values({ email: "disp-master@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "M", role_id: role.id, status: "active", primary_organization_id: O.DGTALMHF } as never).returning("id").executeTakeFirstOrThrow()).id;
  master = { id: masterId, email: "m", fullName: "M", roleId: role.id, roleKey: "MASTER_GLOBAL", mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions: new Set(PERMISSIONS.map((p) => p.key)) };

  for (const [key, dni, o] of [["hac", "90000001", "DGTALMHF"], ["cul", "90000002", "DGTALMC"], ["pg", "90000003", "DGTALPG"], ["teatro", "90000004", "EATC"], ["raiz", "90000005", "MCGC"]] as const) {
    P[key] = (await db.insertInto("people").values({ first_name: key, last_name: "X", dni, organization_id: O[o]!, origin: "manual" } as never).returning("id").executeTakeFirstOrThrow()).id;
  }
  meetingId = (await db.insertInto("meetings").values({ name: "Actividad", owner_organization_id: O.SUTECBA!, organizer_user_id: masterId, created_by: masterId, origin: "import", status: "finished", meeting_type: "reunion", schedule_precision: "date_only", event_date: new Date("2026-03-10T00:00:00Z"), source_event_key: "reunion:disp", starts_at: null, ends_at: null } as never).returning("id").executeTakeFirstOrThrow()).id;
  for (const k of ["hac", "cul", "pg", "teatro"]) await db.insertInto("meeting_participations").values({ meeting_id: meetingId, person_id: P[k]!, participation_kind: "registration" } as never).execute();
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("Repartición: «Nombre oficial (CÓDIGO)» cuando el nombre no es único, en todas las pantallas", () => {
  it("tabla de Personas", async () => {
    const page = await listPeoplePage(master, {}, { field: "name", direction: "asc" }, 1, 50);
    const by = new Map(page.rows.map((r) => [r.firstName, r]));
    expect(by.get("hac")).toMatchObject({ areaName: "Ministerio de Hacienda y Finanzas", reparticionName: `${DGTAL_A} (DGTALMHF)` });
    expect(by.get("cul")).toMatchObject({ reparticionName: `${DGTAL_A} (DGTALMC)` });
    expect(by.get("pg")).toMatchObject({ reparticionName: `${DGTAL_B} (DGTALPG)` });
    // Nombre único: sin código. Y si solo se conoce el Área, sigue vacía.
    expect(by.get("teatro")).toMatchObject({ reparticionName: "Ente Autárquico Teatro Colón" });
    expect(by.get("raiz")).toMatchObject({ areaName: "Ministerio de Cultura", reparticionName: null });
  });

  it("detalle de Persona y exportación", async () => {
    expect(await getPersonById(master, P.hac!)).toMatchObject({ reparticionName: `${DGTAL_A} (DGTALMHF)` });
    expect(await getPersonById(master, P.teatro!)).toMatchObject({ reparticionName: "Ente Autárquico Teatro Colón" });
    const csv = await exportPeopleCsv(master, {}, { field: "name", direction: "asc" });
    expect(csv).toContain(`${DGTAL_A} (DGTALMC)`);
  });

  it("filtros y selector Área → Repartición", async () => {
    const tree = await listOrgTreeOptions(master);
    const label = (code: string) => tree.find((o) => o.id === O[code])!;
    expect(label("DGTALMHF").name).toBe(`${DGTAL_A} (DGTALMHF)`);
    expect(label("DGTALMHF").path).toBe(`${DGTAL_A} (DGTALMHF)`);
    expect(label("DGTALPG").path.endsWith("(DGTALPG)")).toBe(true);
    expect(label("EATC").name).toBe("Ente Autárquico Teatro Colón");
    const areas = await listAreaOptions(master, tree);
    expect(areas.map((a) => a.name)).toContain("Ministerio de Cultura");
    expect(await describeOrganization(O.DGTALMC!)).toMatchObject({ reparticion: { name: `${DGTAL_A} (DGTALMC)` } });
    // El dato de base no cambia: nombres y códigos oficiales intactos.
    const db = await getDb();
    const raw = await db.selectFrom("organizations").select(["name", "official_code"]).where("id", "=", O.DGTALMHF!).executeTakeFirstOrThrow();
    expect(raw).toEqual({ name: DGTAL_A, official_code: "DGTALMHF" });
  });

  it("Usuarios y participantes de reuniones", async () => {
    const users = await listAdministrableUsers(master);
    expect(users.find((u) => u.id === masterId)).toMatchObject({ areaName: "Ministerio de Hacienda y Finanzas", reparticionName: `${DGTAL_A} (DGTALMHF)` });
    const { assigned } = await listMeetingParticipants(master, meetingId);
    const by = new Map(assigned.map((p) => [p.firstName, p]));
    expect(by.get("hac")!.reparticionName).toBe(`${DGTAL_A} (DGTALMHF)`);
    expect(by.get("cul")!.reparticionName).toBe(`${DGTAL_A} (DGTALMC)`);
    expect(by.get("pg")!.reparticionName).toBe(`${DGTAL_B} (DGTALPG)`);
    expect(by.get("teatro")!.reparticionName).toBe("Ente Autárquico Teatro Colón");
  });
});
