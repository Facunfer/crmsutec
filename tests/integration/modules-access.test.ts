import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

// Las páginas, acciones y rutas leen la cookie de sesión: en el test se sirve un token real.
let currentToken: string | undefined;
vi.mock("../../lib/auth/cookies.js", () => ({
  getSessionCookie: async () => currentToken,
}));

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createSession, loadSessionUser } = await import("../../lib/auth/session.js");
const { PERMISSIONS, MODULES } = await import("../../lib/permissions/catalog.js");
const { can } = await import("../../lib/permissions/can.js");
const { requirePermission } = await import("../../lib/auth/guard.js");
const { createUser, grantUserModule, revokeUserModule } = await import("../../lib/users/commands.js");
const { getUserAccess } = await import("../../lib/users/administration.js");
const { createForm } = await import("../../lib/forms/commands.js");
const { createAssociation, AssociationCommandError } = await import("../../lib/associations/commands.js");
const { Sidebar } = await import("../../components/sidebar/Sidebar.js");
const { default: FormulariosPage } = await import("../../app/(protegido)/formularios/page.js");
const { default: PersonasPage } = await import("../../app/(protegido)/personas/page.js");
const { default: UsuariosPage } = await import("../../app/(protegido)/administracion/usuarios/page.js");
const { createFormAction } = await import("../../app/(protegido)/formularios/acciones.js");
const { GET: exportPeople } = await import("../../app/api/personas/export/route.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;

const orgIds = new Map<string, string>();
const o = (name: string) => orgIds.get(name)!;
const ids = new Map<string, string>();
const id = (email: string) => ids.get(email)!;

let master: any;

async function makeOrg(name: string) {
  const db = await getDb();
  const type = await db.selectFrom("organization_types").select("id").where("key", "=", "reparticion").executeTakeFirstOrThrow();
  const row = await db.insertInto("organizations").values({ name, type_id: type.id }).returning("id").executeTakeFirstOrThrow();
  orgIds.set(name, row.id);
}

async function make(email: string, roleKey: string, scopes: string[], moduleKeys: string[]) {
  const { userId } = await createUser(master, {
    email,
    fullName: email,
    roleKey: roleKey as any,
    scopes: scopes.map((name) => ({ organizationId: o(name), includeDescendants: false })),
    moduleKeys,
  });
  ids.set(email, userId);
  return userId;
}

/** Sesión real: token → loadSessionUser, tal como llega en un request. */
async function sessionFor(email: string) {
  const { token } = await createSession(id(email));
  const user = await loadSessionUser(token);
  return { token, user: user! };
}

async function permissionsVersion(userId: string) {
  const db = await getDb();
  return (await db.selectFrom("users").select("permissions_version").where("id", "=", userId).executeTakeFirstOrThrow()).permissions_version;
}

/** ¿La llamada termina en un redirect a /sin-permiso? */
async function redirectTarget(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    const digest = (err as { digest?: string }).digest;
    return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT") ? digest : null;
  }
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  await makeOrg("A");
  await makeOrg("B");

  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const masterRow = await db
    .insertInto("users")
    .values({ email: "master@sutecba.local", password_hash: await hashPassword("bootstrap-password-123"), full_name: "Master", role_id: role.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  ids.set("master@sutecba.local", masterRow.id);
  ({ user: master } = await sessionFor("master@sutecba.local"));

  await make("op-forms@sutecba.local", "OPERADOR", ["A"], ["formularios", "personas", "dashboard"]);
  await make("op-sin-forms@sutecba.local", "OPERADOR", ["A"], ["personas", "dashboard"]);
  await make("reuniones-con-forms@sutecba.local", "REUNIONES", ["A"], ["formularios", "reuniones", "dashboard"]);
  await make("admin-sin-personas@sutecba.local", "ADMIN", ["A"], ["administracion", "dashboard"]);
  await make("admin-con-personas@sutecba.local", "ADMIN", ["A"], ["administracion", "personas", "dashboard"]);
  await make("admin-sin-admin@sutecba.local", "ADMIN", ["A"], ["personas", "formularios"]);
  await make("op-asoc@sutecba.local", "OPERADOR", ["A"], ["asociaciones"]);
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("autorización = permiso + módulo habilitado", () => {
  it("1) MASTER_GLOBAL accede a todos los módulos sin una sola fila en user_modules ni user_scopes", async () => {
    const db = await getDb();
    const modRows = await db.selectFrom("user_modules").select("id").where("user_id", "=", id("master@sutecba.local")).execute();
    const scopeRows = await db.selectFrom("user_scopes").select("id").where("user_id", "=", id("master@sutecba.local")).execute();
    expect(modRows).toHaveLength(0);
    expect(scopeRows).toHaveLength(0);

    expect([...master.enabledModules].sort()).toEqual(MODULES.map((m) => m.key).sort());
    for (const p of PERMISSIONS) expect(can(master, p.key), p.key).toBe(true);
  });

  it("1b) el bypass de MASTER_GLOBAL coincide con la función SQL user_enabled_modules", async () => {
    const { sql } = await import("kysely");
    const db = await getDb();
    const result = await sql<{ module_key: string }>`select module_key from user_enabled_modules(${id("master@sutecba.local")}::uuid)`.execute(db);
    expect(result.rows.map((r) => r.module_key).sort()).toEqual(MODULES.map((m) => m.key).sort());
  });

  it("2) usuario común con permiso + módulo habilitado accede", async () => {
    const { user } = await sessionFor("op-forms@sutecba.local");
    expect(can(user, "forms.view")).toBe(true);
    expect(can(user, "people.view")).toBe(true);
  });

  it("3) con el permiso pero sin el módulo, no accede", async () => {
    const { user } = await sessionFor("op-sin-forms@sutecba.local");
    expect(user.permissions.has("forms.view")).toBe(true);
    expect(can(user, "forms.view")).toBe(false);
    expect(can(user, "forms.create")).toBe(false);
    expect(can(user, "people.view")).toBe(true);
  });

  it("4) con el módulo pero sin el permiso, no accede", async () => {
    const { user } = await sessionFor("reuniones-con-forms@sutecba.local");
    expect(user.enabledModules.has("formularios")).toBe(true);
    expect(user.permissions.has("forms.view")).toBe(false);
    expect(can(user, "forms.view")).toBe(false);
  });
});

describe("Sidebar", () => {
  it("5) oculta el módulo deshabilitado aunque el rol conserve el permiso", async () => {
    const { user } = await sessionFor("op-sin-forms@sutecba.local");
    const html = renderToStaticMarkup(Sidebar({ user }));
    expect(html).toContain("Personas");
    expect(html).not.toContain("Formularios");
  });

  it("5b) muestra el módulo cuando está habilitado, y todo para MASTER_GLOBAL", async () => {
    const { user } = await sessionFor("op-forms@sutecba.local");
    expect(renderToStaticMarkup(Sidebar({ user }))).toContain("Formularios");

    const masterHtml = renderToStaticMarkup(Sidebar({ user: master }));
    for (const label of ["Dashboard", "Personas", "Asociaciones", "Reuniones", "Formularios", "Visualización", "Usuarios", "Organismos"]) {
      expect(masterHtml, label).toContain(label);
    }
    // Módulos retirados del producto: ni siquiera MASTER_GLOBAL los ve en el menú.
    for (const label of ["Roles", "Campos personalizados", "Auditor"]) expect(masterHtml, label).not.toContain(label);
  });

  it("5c) Administración sigue el permiso de cada pantalla y exige el módulo administracion", async () => {
    const con = (await sessionFor("admin-con-personas@sutecba.local")).user;
    const conHtml = renderToStaticMarkup(Sidebar({ user: con }));
    expect(conHtml).toContain("Usuarios");
    expect(conHtml).not.toContain("Campos personalizados");
    expect(conHtml).not.toContain("Organismos");
    expect(conHtml).not.toContain("Roles");

    const sin = (await sessionFor("admin-sin-admin@sutecba.local")).user;
    const sinHtml = renderToStaticMarkup(Sidebar({ user: sin }));
    expect(sinHtml).not.toContain("Usuarios");
    expect(sinHtml).not.toContain("Campos personalizados");
  });
});

describe("el servidor también bloquea (no depende del Sidebar)", () => {
  it("6) pegar la URL de un módulo deshabilitado redirige a /sin-permiso", async () => {
    currentToken = (await sessionFor("op-sin-forms@sutecba.local")).token;
    expect(await redirectTarget(() => FormulariosPage())).toContain("/sin-permiso");
    expect(await redirectTarget(() => requirePermission("forms.view"))).toContain("/sin-permiso");

    currentToken = (await sessionFor("admin-sin-personas@sutecba.local")).token;
    expect(await redirectTarget(() => PersonasPage({ searchParams: Promise.resolve({}) } as any))).toContain("/sin-permiso");

    currentToken = (await sessionFor("admin-sin-admin@sutecba.local")).token;
    expect(await redirectTarget(() => UsuariosPage())).toContain("/sin-permiso");
  });

  it("6b) con el módulo habilitado la misma comprobación pasa", async () => {
    currentToken = (await sessionFor("op-forms@sutecba.local")).token;
    await expect(requirePermission("forms.view")).resolves.toBeTruthy();
  });

  it("7) una server action de un módulo deshabilitado es rechazada y no crea nada", async () => {
    currentToken = (await sessionFor("op-sin-forms@sutecba.local")).token;
    const fd = new FormData();
    fd.set("name", "Formulario colado");
    fd.set("slug", "formulario-colado");
    fd.set("ownerOrganizationId", o("A"));

    const result = await createFormAction({ ok: false }, fd);
    expect(result.ok).toBe(false);

    const db = await getDb();
    const row = await db.selectFrom("forms").select("id").where("slug", "=", "formulario-colado").executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it("7b) el comando con el módulo habilitado sí crea el formulario", async () => {
    const { user } = await sessionFor("op-forms@sutecba.local");
    await expect(createForm(user, { name: "Formulario legítimo", slug: "formulario-legitimo", ownerOrganizationId: o("A") })).resolves.toHaveProperty("id");
  });

  it("7c) un endpoint protegido responde 403 si falta el módulo, aunque el rol tenga el permiso", async () => {
    const request = () => new NextRequest("http://localhost/api/personas/export");

    currentToken = (await sessionFor("admin-sin-personas@sutecba.local")).token;
    const denied = await exportPeople(request());
    expect(denied.status).toBe(403);

    currentToken = (await sessionFor("admin-con-personas@sutecba.local")).token;
    const allowed = await exportPeople(request());
    expect(allowed.status).toBe(200);

    currentToken = undefined;
    expect((await exportPeople(request())).status).toBe(401);
  });

  it("8) el módulo habilitado no permite saltarse el alcance organizativo", async () => {
    const { user } = await sessionFor("op-asoc@sutecba.local");
    expect(can(user, "associations.create")).toBe(true);

    const db = await getDb();
    const type = await db.selectFrom("association_types").select("id").executeTakeFirstOrThrow();

    await expect(createAssociation(user, { name: "Fuera de alcance", typeId: type.id, ownerOrganizationId: o("B") })).rejects.toThrow(AssociationCommandError);
    await expect(createAssociation(user, { name: "Dentro de alcance", typeId: type.id, ownerOrganizationId: o("A") })).resolves.toHaveProperty("id");
  });
});

describe("cambios de módulos y sesiones", () => {
  it("9) habilitar y quitar un módulo incrementa permissions_version", async () => {
    const target = id("op-sin-forms@sutecba.local");

    const before = await permissionsVersion(target);
    await grantUserModule(master, target, "visualizacion");
    const afterGrant = await permissionsVersion(target);
    expect(afterGrant).toBeGreaterThan(before);

    const moduleRow = (await getUserAccess(target)).modules.find((m) => m.moduleKey === "visualizacion")!;
    await revokeUserModule(master, target, moduleRow.id);
    expect(await permissionsVersion(target)).toBeGreaterThan(afterGrant);
  });

  it("10) la sesión anterior queda inválida cuando cambia permissions_version, y la nueva ve el cambio", async () => {
    const email = "op-sin-forms@sutecba.local";
    const old = await sessionFor(email);
    expect(await loadSessionUser(old.token)).not.toBeNull();
    expect(can(old.user, "forms.view")).toBe(false);

    await grantUserModule(master, id(email), "formularios");

    expect(await loadSessionUser(old.token)).toBeNull();

    const fresh = await sessionFor(email);
    expect(can(fresh.user, "forms.view")).toBe(true);
  });
});
