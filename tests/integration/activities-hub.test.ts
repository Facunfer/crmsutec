import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

/**
 * Actividades unificadas, paso 1e — el tablero de una actividad (fechas con su QR + formulario) y la acción «Nueva actividad».
 * Comportamiento real sobre PGlite: alcance, contenido y redirección.
 */

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.SUTECBA_QR_SECRET = "test-secret-not-for-prod-0123456789";

let currentToken: string | undefined;
vi.mock("../../lib/auth/cookies.js", () => ({ getSessionCookie: async () => currentToken }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createSession } = await import("../../lib/auth/session.js");
const { PERMISSIONS, ROLE_PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { createActivity } = await import("../../lib/activities/create.js");
const { getActivityHub } = await import("../../lib/activities/hub.js");
const { createActivityAction } = await import("../../app/(protegido)/reuniones/nueva/acciones.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));
let master: any;
let areaA: any;
let areaB: any;
let reunionesRoot: any;
let rootOrg: string;
let orgA: string;
let orgB: string;
let areaAUserId: string;
let seq = 0;

function actorOf(id: string, roleKey: string, permissions: Set<string>): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions };
}
async function makeUser(email: string, roleKey: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id, status: "active" } as never).returning("id").executeTakeFirstOrThrow()).id;
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
  master = actorOf(await makeUser("hub-master@sutecba.local", "MASTER_GLOBAL"), "MASTER_GLOBAL", ALL);
  areaAUserId = await makeUser("hub-area-a@sutecba.local", "ADMIN");
  const b = await makeUser("hub-area-b@sutecba.local", "ADMIN");
  const r = await makeUser("hub-reuniones@sutecba.local", "REUNIONES");
  for (const [u, o] of [[areaAUserId, orgA], [b, orgB], [r, rootOrg]] as const) {
    await db.insertInto("user_scopes").values({ user_id: u, organization_id: o, include_descendants: true, granted_by: master.id } as never).execute();
  }
  // La acción usa la sesión REAL (cookie → usuario): sus módulos habilitados salen de user_modules.
  for (const moduleKey of ["reuniones", "formularios", "dashboard"]) {
    await db.insertInto("user_modules").values({ user_id: areaAUserId, module_key: moduleKey, granted_by: master.id } as never).execute();
  }
  areaA = actorOf(areaAUserId, "ADMIN", new Set<string>(ROLE_PERMISSIONS.ADMIN));
  areaB = actorOf(b, "ADMIN", new Set<string>(ROLE_PERMISSIONS.ADMIN));
  reunionesRoot = actorOf(r, "REUNIONES", new Set<string>(ROLE_PERMISSIONS.REUNIONES));
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
const date = (offsetDays: number, extra: Record<string, unknown> = {}) => ({ startsAt: day(offsetDays, 9), endsAt: day(offsetDays, 12), ...extra });

describe("1e · tablero de una actividad", () => {
  it("reunión de un día: una fecha operable con su modo de QR, y su formulario público", async () => {
    const act = await createActivity(areaA, { kind: "single", name: "Charla del tablero", ownerOrganizationId: orgA, dates: [date(3, { locationName: "Sede central" })], qrMode: "static" });
    const hub = (await getActivityHub(areaA, "reunion", act.meetings[0]!.id))!;
    expect(hub).toMatchObject({ kind: "reunion", name: "Charla del tablero", statusLabel: "Programada", campaign: null });
    expect(hub.dates).toHaveLength(1);
    expect(hub.dates[0]).toMatchObject({ number: 1, locationName: "Sede central", status: "scheduled", qrMode: "static", canOperate: true });
    expect(hub.forms).toHaveLength(1);
    expect(hub.forms[0]).toMatchObject({ slug: act.form.slug, status: "published", enrollmentMode: "single_meeting", publicPath: `/f/${act.form.slug}` });
  });

  it("campaña: sus fechas en orden cronológico, numeradas, y un solo formulario común", async () => {
    const act = await createActivity(areaA, { kind: "campaign", name: "Campaña del tablero", ownerOrganizationId: orgA, dates: [date(9), date(2), date(5)] });
    const hub = (await getActivityHub(areaA, "campana", act.campaignId!))!;
    expect(hub).toMatchObject({ kind: "campana", name: "Campaña del tablero", statusLabel: "Programada" });
    expect(hub.dates.map((d) => d.number)).toEqual([1, 2, 3]);
    expect(hub.dates.map((d) => d.id)).toEqual(act.meetings.map((m) => m.id));
    expect(hub.dates.every((d) => d.canOperate && d.status === "scheduled")).toBe(true);
    expect(hub.forms).toHaveLength(1);
    expect(hub.forms[0]!.enrollmentMode).toBe("campaign_all");
  });

  it("un borrador se ve como borrador, con su formulario sin publicar", async () => {
    const act = await createActivity(areaA, { kind: "single", name: "Borrador del tablero", ownerOrganizationId: orgA, dates: [date(4)], publish: false });
    const hub = (await getActivityHub(areaA, "reunion", act.meetings[0]!.id))!;
    expect(hub.statusLabel).toBe("Borrador");
    expect(hub.forms[0]!.status).toBe("draft");
  });

  it("alcance: otra área no la ve (null, sin revelar que existe); el master y el usuario «solo reuniones» con alcance en la raíz sí", async () => {
    const act = await createActivity(areaA, { kind: "campaign", name: "Alcance del tablero", ownerOrganizationId: orgA, dates: [date(2), date(3)] });
    expect(await getActivityHub(areaB, "campana", act.campaignId!)).toBeNull();
    expect(await getActivityHub(areaB, "reunion", act.meetings[0]!.id)).toBeNull();
    expect((await getActivityHub(master, "campana", act.campaignId!))!.dates).toHaveLength(2);
    expect((await getActivityHub(reunionesRoot, "campana", act.campaignId!))!.dates.every((d) => d.canOperate)).toBe(true);
  });

  it("ids inválidos o inexistentes devuelven null", async () => {
    expect(await getActivityHub(master, "campana", "no-es-uuid")).toBeNull();
    expect(await getActivityHub(master, "campana", randomUUID())).toBeNull();
    expect(await getActivityHub(master, "reunion", randomUUID())).toBeNull();
  });
});

describe("1e · acción «Nueva actividad»", () => {
  const formDataOf = (payload: unknown, owner: string) => {
    const fd = new FormData();
    fd.set("payload", JSON.stringify(payload));
    fd.set("ownerOrganizationId", owner);
    return fd;
  };
  const redirectTarget = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (err: any) {
      const digest = String(err?.digest ?? "");
      if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2]!;
      throw err;
    }
    throw new Error("la acción no redirigió");
  };

  it("crea la reunión y redirige a su tablero", async () => {
    currentToken = (await createSession(areaAUserId)).token;
    const target = await redirectTarget(createActivityAction({ ok: false }, formDataOf({ kind: "single", name: "Acción única", dates: [date(3)] }, orgA)));
    const db = await getDb();
    const m = await db.selectFrom("meetings").select("id").where("name", "=", "Acción única").executeTakeFirstOrThrow();
    expect(target).toBe(`/reuniones/actividad/reunion/${m.id}`);
    const hub = await getActivityHub(areaA, "reunion", m.id);
    expect(hub!.forms).toHaveLength(1);
  });

  it("crea la campaña y redirige al tablero de la campaña", async () => {
    currentToken = (await createSession(areaAUserId)).token;
    const target = await redirectTarget(createActivityAction({ ok: false }, formDataOf({ kind: "campaign", name: "Acción campaña", dates: [date(2), date(4)] }, orgA)));
    const db = await getDb();
    const c = await db.selectFrom("campaigns").select("id").where("name", "=", "Acción campaña").executeTakeFirstOrThrow();
    expect(target).toBe(`/reuniones/actividad/campana/${c.id}`);
  });

  it("errores de datos o de alcance se devuelven como mensaje, sin crear nada", async () => {
    currentToken = (await createSession(areaAUserId)).token;
    const db = await getDb();
    const before = (await db.selectFrom("meetings").select("id").execute()).length;
    const outOfScope = await createActivityAction({ ok: false }, formDataOf({ kind: "single", name: "Otra área", dates: [date(3)] }, orgB));
    expect(outOfScope).toMatchObject({ ok: false });
    expect(outOfScope.error).toMatch(/fuera de tu alcance/);
    const noDates = await createActivityAction({ ok: false }, formDataOf({ kind: "campaign", name: "Una sola fecha", dates: [date(3)] }, orgA));
    expect(noDates.error).toMatch(/al menos dos fechas/);
    const notJson = await createActivityAction({ ok: false }, (() => { const fd = new FormData(); fd.set("payload", "{no es json"); fd.set("ownerOrganizationId", orgA); return fd; })());
    expect(notJson.ok).toBe(false);
    expect((await db.selectFrom("meetings").select("id").execute()).length).toBe(before);
  });

  it("sin sesión no se puede crear (requireUser)", async () => {
    currentToken = undefined;
    await expect(createActivityAction({ ok: false }, formDataOf({ kind: "single", name: "Sin sesión", dates: [date(3)] }, orgA))).rejects.toBeTruthy();
    const db = await getDb();
    expect(await db.selectFrom("meetings").select("id").where("name", "=", "Sin sesión").execute()).toHaveLength(0);
  });
});
