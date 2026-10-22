import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Actividades unificadas, paso 1g — quién puede qué, con SESIONES REALES (los módulos habilitados y los permisos los calcula el sistema, no la
 * prueba): MASTER_GLOBAL (todas las áreas), áreas con alcance (solo su órbita) y el usuario «solo reuniones» (un módulo, todas las áreas).
 */

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.SUTECBA_QR_SECRET = "test-secret-not-for-prod-0123456789";

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createSession, loadSessionUser } = await import("../../lib/auth/session.js");
const { can } = await import("../../lib/permissions/can.js");
const { createActivity } = await import("../../lib/activities/create.js");
const { getActivityHub } = await import("../../lib/activities/hub.js");
const { getAttendanceReport } = await import("../../lib/activities/attendance-report.js");
const { exportAttendanceCsv } = await import("../../lib/activities/attendance-export.js");
const { submitForm } = await import("../../lib/forms/submit.js");
const { listMeetings } = await import("../../lib/meetings/queries.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
type SessionActor = NonNullable<Awaited<ReturnType<typeof loadSessionUser>>>;
const actors = {} as Record<"master" | "admin" | "operador" | "reuniones" | "lectura" | "reunionesSinModulo", SessionActor>;
let rootOrg: string;
let orgA: string;
let orgB: string;
let masterId: string;
let seq = 0;

async function makeUser(email: string, roleKey: string, opts: { scope?: string; modules?: string[] }) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  const id = (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id, status: "active" } as never).returning("id").executeTakeFirstOrThrow()).id;
  if (opts.scope) await db.insertInto("user_scopes").values({ user_id: id, organization_id: opts.scope, include_descendants: true, granted_by: masterId } as never).execute();
  for (const moduleKey of opts.modules ?? []) await db.insertInto("user_modules").values({ user_id: id, module_key: moduleKey, granted_by: masterId } as never).execute();
  const actor = await loadSessionUser((await createSession(id)).token);
  if (!actor) throw new Error(`no se pudo cargar la sesión de ${email}`);
  return actor;
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  rootOrg = await createTestOrganization();
  const db = await getDb();
  const orgType = await db.selectFrom("organization_types").select("id").where("key", "=", "reparticion").executeTakeFirstOrThrow();
  const child = async (parent: string) => (await db.insertInto("organizations").values({ name: `Hija ${++seq}`, type_id: orgType.id, parent_id: parent }).returning("id").executeTakeFirstOrThrow()).id;
  orgA = await child(rootOrg);
  orgB = await child(rootOrg);
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  masterId = (await db.insertInto("users").values({ email: "roles-master@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Master", role_id: role.id, status: "active" } as never).returning("id").executeTakeFirstOrThrow()).id;
  actors.master = (await loadSessionUser((await createSession(masterId)).token))!;
  const all = ["dashboard", "personas", "reuniones", "formularios", "interacciones"];
  actors.admin = await makeUser("roles-admin@sutecba.local", "ADMIN", { scope: orgA, modules: all });
  actors.operador = await makeUser("roles-operador@sutecba.local", "OPERADOR", { scope: orgA, modules: all });
  // «solo reuniones» para TODAS las áreas: un solo módulo habilitado y alcance en la unidad raíz con descendientes
  actors.reuniones = await makeUser("roles-reuniones@sutecba.local", "REUNIONES", { scope: rootOrg, modules: ["reuniones"] });
  actors.lectura = await makeUser("roles-lectura@sutecba.local", "LECTURA", { scope: orgA, modules: ["dashboard", "personas", "reuniones", "formularios"] });
  // mismo rol REUNIONES pero SIN el módulo habilitado: los permisos no rigen
  actors.reunionesSinModulo = await makeUser("roles-sin-modulo@sutecba.local", "REUNIONES", { scope: rootOrg, modules: ["dashboard"] });
});

afterAll(async () => {
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const day = (offsetDays: number, hour = 9) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(hour)}:00`;
};
const date = (offsetDays: number) => ({ startsAt: day(offsetDays, 9), endsAt: day(offsetDays, 12) });
const single = (owner: string, name: string) => ({ kind: "single" as const, name, ownerOrganizationId: owner, dates: [date(3)] });
const campaign = (owner: string, name: string) => ({ kind: "campaign" as const, name, ownerOrganizationId: owner, dates: [date(2), date(4)] });

describe("1g · el usuario «solo reuniones»: un módulo, todas las áreas", () => {
  it("tiene habilitado únicamente el módulo Reuniones y ningún permiso de otros módulos", () => {
    const u = actors.reuniones;
    expect([...u.enabledModules]).toEqual(["reuniones"]);
    for (const permission of ["meetings.view", "meetings.create", "meetings.edit", "meetings.change_status", "meetings.accredit", "meetings.manage_invitations", "meetings.attendance_manual"] as const) {
      expect(can(u, permission), permission).toBe(true);
    }
    for (const permission of ["people.view", "people.create", "people.view_sensitive", "forms.view", "forms.create", "forms.publish", "mailing.view", "interactions.view", "imports.run", "associations.view", "users.manage_scoped", "organizations.manage"] as const) {
      expect(can(u, permission), permission).toBe(false);
    }
  });

  it("crea reuniones Y campañas (con su formulario y su QR) en CUALQUIER área, sin el módulo de formularios", async () => {
    for (const owner of [orgA, orgB, rootOrg]) {
      const one = await createActivity(actors.reuniones, single(owner, `Solo reuniones ${++seq}`));
      expect(one.form.published).toBe(true);
      expect(one.meetings).toHaveLength(1);
    }
    const camp = await createActivity(actors.reuniones, campaign(orgB, "Campaña de solo reuniones"));
    expect(camp.meetings).toHaveLength(2);
    expect(camp.form).toMatchObject({ published: true, enrollmentMode: "campaign_all" });
    // el formulario que creó funciona públicamente
    const r = await submitForm(camp.form.slug, { first_name: "Ana", last_name: "Gomez", dni: "33000111", email: "", phone: "" }, randomUUID(), "10.90.0.1", "agent");
    expect(r.kind).toBe("ok");
  });

  it("ve y opera sus actividades: tablero, registro de asistencia y CSV; y de otras áreas también (alcance en la raíz)", async () => {
    const mine = await createActivity(actors.reuniones, campaign(orgA, "Tablero de solo reuniones"));
    const hub = (await getActivityHub(actors.reuniones, "campana", mine.campaignId!))!;
    expect(hub.dates.every((d) => d.canOperate)).toBe(true);
    expect((await getAttendanceReport(actors.reuniones, "campana", mine.campaignId!))!.dates).toHaveLength(2);
    expect((await exportAttendanceCsv(actors.reuniones, "campana", mine.campaignId!)).startsWith("﻿")).toBe(true);
    // actividad creada por otro usuario en otra área
    const others = await createActivity(actors.admin, single(orgA, "De otra persona"));
    expect(await getActivityHub(actors.reuniones, "reunion", others.meetings[0]!.id)).not.toBeNull();
  });

  it("sin el módulo Reuniones habilitado, el rol no alcanza: no crea nada", async () => {
    expect(can(actors.reunionesSinModulo, "meetings.create")).toBe(false);
    await expect(createActivity(actors.reunionesSinModulo, single(orgA, "Sin módulo"))).rejects.toThrow(/permiso/i);
  });
});

describe("1g · matriz por rol", () => {
  it("MASTER_GLOBAL crea y ve en todas las áreas", async () => {
    for (const owner of [orgA, orgB]) expect((await createActivity(actors.master, single(owner, `Master ${++seq}`))).meetings).toHaveLength(1);
  });

  it("ADMIN y OPERADOR con alcance crean solo en su órbita; fuera de ella, error y nada creado", async () => {
    for (const who of ["admin", "operador"] as const) {
      const ok = await createActivity(actors[who], single(orgA, `${who} en su área ${++seq}`));
      expect(ok.meetings).toHaveLength(1);
      const db = await getDb();
      const before = (await db.selectFrom("meetings").select("id").execute()).length;
      await expect(createActivity(actors[who], single(orgB, `${who} fuera de su área`))).rejects.toThrow(/fuera de tu alcance/);
      await expect(createActivity(actors[who], campaign(orgB, `${who} campaña fuera`))).rejects.toThrow(/fuera de tu alcance/);
      expect((await db.selectFrom("meetings").select("id").execute()).length).toBe(before);
    }
  });

  it("LECTURA ve pero no crea, no exporta y no acredita", async () => {
    const act = await createActivity(actors.admin, single(orgA, "Para lectura"));
    await expect(createActivity(actors.lectura, single(orgA, "No debería"))).rejects.toThrow(/permiso/i);
    expect(can(actors.lectura, "meetings.view")).toBe(true);
    expect(can(actors.lectura, "meetings.accredit")).toBe(false);
    expect(can(actors.lectura, "meetings.edit")).toBe(false);
    expect(await getActivityHub(actors.lectura, "reunion", act.meetings[0]!.id)).not.toBeNull();
    await expect(exportAttendanceCsv(actors.lectura, "reunion", act.meetings[0]!.id)).rejects.toThrow(/permiso/i);
  });

  it("un área no ve las actividades de otra, y su lista de reuniones solo trae las suyas", async () => {
    const mineA = await createActivity(actors.admin, single(orgA, "Lista A"));
    const mineB = await createActivity(actors.master, single(orgB, "Lista B"));
    expect(await getActivityHub(actors.admin, "reunion", mineB.meetings[0]!.id)).toBeNull();
    const ids = (await listMeetings(actors.admin)).map((m) => m.id);
    expect(ids).toContain(mineA.meetings[0]!.id);
    expect(ids).not.toContain(mineB.meetings[0]!.id);
    const idsReuniones = (await listMeetings(actors.reuniones)).map((m) => m.id);
    expect(idsReuniones).toEqual(expect.arrayContaining([mineA.meetings[0]!.id, mineB.meetings[0]!.id]));
  });
});
