import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.SUTECBA_QR_SECRET = "test-qr-secret-".padEnd(48, "x");

// Páginas, acciones y rutas leen la cookie de sesión: el test sirve un token real.
let currentToken: string | undefined;
vi.mock("../../lib/auth/cookies.js", () => ({
  getSessionCookie: async () => currentToken,
}));

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createSession, loadSessionUser } = await import("../../lib/auth/session.js");
const { MODULES, PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { createUser } = await import("../../lib/users/commands.js");
const { toJsonb } = await import("../../lib/db/json.js");

const people = await import("../../lib/people/queries.js");
const peopleCommands = await import("../../lib/people/commands.js");
const { exportPeopleCsv } = await import("../../lib/people/export.js");
const { bulkSetActive } = await import("../../lib/people/bulk.js");
const { transferPerson, listTransferReceipts } = await import("../../lib/people/transfers.js");
const assoc = await import("../../lib/associations/queries.js");
const assocCommands = await import("../../lib/associations/commands.js");
const assocMembers = await import("../../lib/associations/members.js");
const meetings = await import("../../lib/meetings/queries.js");
const meetingCommands = await import("../../lib/meetings/commands.js");
const invitations = await import("../../lib/meetings/invitations.js");
const { countAudience } = await import("../../lib/meetings/audience.js");
const { getLivePanelData, quickSearchForAccreditation } = await import("../../lib/attendance/live.js");
const { setAttendanceManually } = await import("../../lib/attendance/manual.js");
const forms = await import("../../lib/forms/queries.js");
const formCommands = await import("../../lib/forms/commands.js");
const { exportSubmissionsCsv } = await import("../../lib/forms/export.js");
const { submitForm, getPublicForm } = await import("../../lib/forms/submit.js");
const analytics = await import("../../lib/analytics/queries.js");
const tagsQueries = await import("../../lib/tags/queries.js");
const { listPersonInteractions } = await import("../../lib/interactions/queries.js");
const { listImportBatches, listImportRows } = await import("../../lib/imports/queries.js");
const scope = await import("../../lib/scope/organizations.js");

const { default: PersonaFichaPage } = await import("../../app/(protegido)/personas/[id]/page.js");
const { default: AsociacionFichaPage } = await import("../../app/(protegido)/asociaciones/[id]/page.js");
const { default: ReunionFichaPage } = await import("../../app/(protegido)/reuniones/[id]/page.js");
const { default: FormularioFichaPage } = await import("../../app/(protegido)/formularios/[id]/page.js");
const { setPersonActiveAction, bulkSetActiveAction, transferPersonAction } = await import("../../app/(protegido)/personas/acciones.js");
const { GET: qrRoute } = await import("../../app/api/reuniones/[id]/qr/route.js");
const { GET: liveRoute } = await import("../../app/api/reuniones/[id]/live/route.js");
const { GET: exportPeopleRoute } = await import("../../app/api/personas/export/route.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;

/*
 * Organigrama:   Área A ─┬─ A1        Área B ── B1
 *                        └─ A2
 * Usuarios: masterU (MASTER_GLOBAL), adminA (ADMIN, A + dependientes), adminB (ADMIN, B + dependientes),
 *           userA1 (OPERADOR, solo A1), userANoDesc (OPERADOR, A sin dependientes).
 */
const orgs = new Map<string, string>();
const o = (name: string) => orgs.get(name)!;
const ids = new Map<string, string>();
const id = (key: string) => ids.get(key)!;

let masterId: string;
let master: any;

async function makeOrg(name: string, parentId: string | null) {
  const db = await getDb();
  const type = await db.selectFrom("organization_types").select("id").where("key", "=", "reparticion").executeTakeFirstOrThrow();
  const row = await db.insertInto("organizations").values({ name, type_id: type.id, parent_id: parentId }).returning("id").executeTakeFirstOrThrow();
  orgs.set(name, row.id);
}

const ALL_MODULES = MODULES.map((m) => m.key);

async function makeUser(email: string, roleKey: string, scopes: Array<[string, boolean]>) {
  const { userId } = await createUser(master, {
    email,
    fullName: email,
    roleKey: roleKey as any,
    scopes: scopes.map(([name, include]) => ({ organizationId: o(name), includeDescendants: include })),
    moduleKeys: ALL_MODULES,
  });
  ids.set(email, userId);
}

async function sessionFor(email: string) {
  const { token } = await createSession(id(email));
  const user = await loadSessionUser(token);
  return { token, user: user! };
}

async function makePerson(key: string, firstName: string, orgName: string | null, dni: string) {
  const db = await getDb();
  const row = await db
    .insertInto("people")
    .values({ first_name: firstName, last_name: "Prueba", dni, organization_id: orgName ? o(orgName) : null, created_by: masterId })
    .returning("id")
    .executeTakeFirstOrThrow();
  ids.set(key, row.id);
}

async function isNotFound(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (err) {
    const digest = String((err as { digest?: string }).digest ?? "");
    return digest.includes("NEXT_HTTP_ERROR_FALLBACK;404") || digest.includes("NEXT_NOT_FOUND");
  }
}

const names = (rows: Array<{ firstName: string }>) => rows.map((r) => r.firstName).sort();
const ALL_FILTER = { status: "all" as const };

let adminA: any;
let adminB: any;
let userA1: any;
let userANoDesc: any;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  await makeOrg("A", null);
  await makeOrg("A1", o("A"));
  await makeOrg("A2", o("A"));
  await makeOrg("B", null);
  await makeOrg("B1", o("B"));

  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const m = await db
    .insertInto("users")
    .values({ email: "master@sutecba.local", password_hash: await hashPassword("bootstrap-password-123"), full_name: "Master", role_id: role.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  masterId = m.id;
  ids.set("master@sutecba.local", masterId);
  master = (await sessionFor("master@sutecba.local")).user;

  await makeUser("admin-a@sutecba.local", "ADMIN", [["A", true]]);
  await makeUser("admin-b@sutecba.local", "ADMIN", [["B", true]]);
  await makeUser("user-a1@sutecba.local", "OPERADOR", [["A1", false]]);
  await makeUser("user-a-nodesc@sutecba.local", "OPERADOR", [["A", false]]);
  adminA = (await sessionFor("admin-a@sutecba.local")).user;
  adminB = (await sessionFor("admin-b@sutecba.local")).user;
  userA1 = (await sessionFor("user-a1@sutecba.local")).user;
  userANoDesc = (await sessionFor("user-a-nodesc@sutecba.local")).user;

  // Personas: una por unidad y una sin unidad.
  await makePerson("pA", "PersonaA", "A", "40000001");
  await makePerson("pA1", "PersonaA1", "A1", "40000002");
  await makePerson("pA2", "PersonaA2", "A2", "40000003");
  await makePerson("pB", "PersonaB", "B", "40000004");
  await makePerson("pB1", "PersonaB1", "B1", "40000005");
  await makePerson("pNull", "PersonaSinUnidad", null, "40000006");

  // Asociaciones, reuniones y formularios propios de cada unidad.
  const type = await db.selectFrom("association_types").select("id").executeTakeFirstOrThrow();
  for (const [key, orgName] of [["aA", "A"], ["aA1", "A1"], ["aB1", "B1"]] as const) {
    const row = await db.insertInto("associations").values({ name: `Asoc ${key}`, type_id: type.id, owner_organization_id: o(orgName) }).returning("id").executeTakeFirstOrThrow();
    ids.set(key, row.id);
  }
  const start = new Date(Date.now() + 86_400_000);
  const end = new Date(start.getTime() + 3_600_000);
  for (const [key, orgName] of [["mA", "A"], ["mA1", "A1"], ["mB1", "B1"]] as const) {
    const row = await db.insertInto("meetings").values({ name: `Reunión ${key}`, starts_at: start, ends_at: end, owner_organization_id: o(orgName) }).returning("id").executeTakeFirstOrThrow();
    ids.set(key, row.id);
  }
  for (const [key, orgName] of [["fA", "A"], ["fB", "B"]] as const) {
    const row = await db.insertInto("forms").values({ name: `Form ${key}`, slug: `form-${key.toLowerCase()}`, owner_organization_id: o(orgName) }).returning("id").executeTakeFirstOrThrow();
    ids.set(key, row.id);
  }
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("personas: alcance por organización", () => {
  it("1) MASTER_GLOBAL ve todo, incluida la persona sin unidad", async () => {
    const { rows, total } = await people.listPeoplePage(master, ALL_FILTER, { field: "name", direction: "asc" }, 1, 50);
    expect(total).toBe(6);
    expect(names(rows)).toContain("PersonaSinUnidad");
    expect(await people.getPersonById(master, id("pNull"))).not.toBeNull();
  });

  it("2) adminA (con dependientes) ve A, A1 y A2", async () => {
    const { rows } = await people.listPeoplePage(adminA, ALL_FILTER, { field: "name", direction: "asc" }, 1, 50);
    expect(names(rows)).toEqual(["PersonaA", "PersonaA1", "PersonaA2"]);
  });

  it("3) adminA no ve a las personas de B ni de B1", async () => {
    const { rows } = await people.listPeoplePage(adminA, ALL_FILTER, { field: "name", direction: "asc" }, 1, 50);
    expect(names(rows)).not.toContain("PersonaB");
    expect(names(rows)).not.toContain("PersonaB1");
    const b = (await people.listPeoplePage(adminB, ALL_FILTER, { field: "name", direction: "asc" }, 1, 50)).rows;
    expect(names(b)).toEqual(["PersonaB", "PersonaB1"]);
  });

  it("4) userA1 (solo A1) ve únicamente a la persona de A1", async () => {
    const { rows } = await people.listPeoplePage(userA1, ALL_FILTER, { field: "name", direction: "asc" }, 1, 50);
    expect(names(rows)).toEqual(["PersonaA1"]);
  });

  it("5) userA1 no ve a la persona del área A", async () => {
    expect(await people.getPersonById(userA1, id("pA"))).toBeNull();
  });

  it("6) include_descendants=false no hereda a los hijos", async () => {
    const { rows } = await people.listPeoplePage(userANoDesc, ALL_FILTER, { field: "name", direction: "asc" }, 1, 50);
    expect(names(rows)).toEqual(["PersonaA"]);
  });

  it("7) la persona sin unidad solo la ve MASTER_GLOBAL", async () => {
    for (const user of [adminA, adminB, userA1, userANoDesc]) {
      const { rows } = await people.listPeoplePage(user, ALL_FILTER, { field: "name", direction: "asc" }, 1, 50);
      expect(names(rows)).not.toContain("PersonaSinUnidad");
      expect(await people.getPersonById(user, id("pNull"))).toBeNull();
    }
  });

  it("8) la búsqueda respeta el alcance (por nombre y por DNI)", async () => {
    const byName = await people.listPeoplePage(adminA, { status: "all", search: "Prueba" }, { field: "name", direction: "asc" }, 1, 50);
    expect(names(byName.rows)).toEqual(["PersonaA", "PersonaA1", "PersonaA2"]);

    const byDniOfB = await people.listPeoplePage(adminA, { status: "all", search: "40000004" }, { field: "name", direction: "asc" }, 1, 50);
    expect(byDniOfB.total).toBe(0);
    expect(await people.countPeople(adminA, { status: "all", search: "40000005" })).toBe(0);
    expect(await people.listAllMatchingIds(adminA, { status: "all", search: "40000004" })).toEqual([]);

    // El filtro por unidad no amplía el alcance: pedir la unidad B no devuelve nada.
    expect(await people.countPeople(adminA, { status: "all", organizationIds: [o("B")] })).toBe(0);
  });

  it("9) la ficha directa de una persona ajena falla, y también editar o desactivar", async () => {
    expect(await people.getPersonById(adminA, id("pB"))).toBeNull();
    expect(await people.getPersonMeetingActivity(adminA, id("pB"))).toEqual([]);

    await expect(
      peopleCommands.updatePerson(adminA, id("pB"), 1, { firstName: "X", lastName: "Y", dni: "", email: "", phone: "", organizationId: o("B"), birthDate: "", declaredAge: "" } as any)
    ).rejects.toThrow(/no existe/);
    await expect(peopleCommands.setPersonActive(adminA, id("pB"), false)).rejects.toThrow(/no existe/);
    expect(await bulkSetActive(adminA, [id("pB"), id("pB1")], false)).toBe(0);

    const db = await getDb();
    const row = await db.selectFrom("people").select("status").where("id", "=", id("pB")).executeTakeFirstOrThrow();
    expect(row.status).toBe("active");
  });

  it("10) el export CSV respeta el alcance", async () => {
    const csv = await exportPeopleCsv(adminA, { status: "all" }, { field: "name", direction: "asc" });
    expect(csv).toContain("PersonaA1");
    expect(csv).not.toContain("PersonaB");
    expect(csv).not.toContain("PersonaSinUnidad");

    currentToken = (await sessionFor("admin-a@sutecba.local")).token;
    const response = await exportPeopleRoute(new NextRequest("http://localhost/api/personas/export?status=all"));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("PersonaA2");
    expect(body).not.toContain("PersonaB1");
  });

  it("crear una persona exige quedar dentro del alcance propio", async () => {
    const input = (organizationId: string) =>
      ({ firstName: "Nueva", lastName: "Persona", dni: "40777001", email: "", phone: "", organizationId, birthDate: "", declaredAge: "" }) as any;
    await expect(peopleCommands.createPerson(adminA, input(o("B")))).rejects.toThrow(/alcance/);
    await expect(peopleCommands.createPerson(adminA, input(""))).rejects.toThrow(/alcance/);
    await expect(peopleCommands.createPerson(adminA, input(o("A2")))).resolves.toHaveProperty("id");
  });

  it("un DNI repetido en otra unidad bloquea sin revelar quién es", async () => {
    const dup = { firstName: "Otra", lastName: "Persona", dni: "40000004", email: "", phone: "", organizationId: o("A"), birthDate: "", declaredAge: "" } as any;
    const error = await peopleCommands.createPerson(adminA, dup).catch((e) => e);
    expect(error).toBeInstanceOf(peopleCommands.PersonCommandError);
    expect(error.code).toBe("IDENTITY_CONFLICT");
    expect(error.blockedByPersonId).toBeUndefined();
    expect(error.message).not.toContain("PersonaB");
  });

  it("la unidad no se cambia editando la ficha", async () => {
    const version = (await people.getPersonById(adminA, id("pA")))!.version;
    await expect(
      peopleCommands.updatePerson(adminA, id("pA"), version, { firstName: "PersonaA", lastName: "Prueba", dni: "40000001", email: "", phone: "", organizationId: o("A2"), birthDate: "", declaredAge: "" } as any)
    ).rejects.toThrow(/traslado/);
  });
});

describe("asociaciones: alcance por unidad propietaria", () => {
  it("11) cada usuario ve solo las asociaciones de su alcance", async () => {
    const list = async (u: any) => (await assoc.listAssociations(u)).map((a) => a.name).sort();
    expect(await list(master)).toEqual(["Asoc aA", "Asoc aA1", "Asoc aB1"]);
    expect(await list(adminA)).toEqual(["Asoc aA", "Asoc aA1"]);
    expect(await list(userA1)).toEqual(["Asoc aA1"]);
    expect(await list(adminB)).toEqual(["Asoc aB1"]);
  });

  it("11b) no se abre, edita, desactiva ni se administran miembros de una asociación ajena", async () => {
    expect(await assoc.getAssociationById(adminA, id("aB1"))).toBeNull();
    expect(await assoc.getAssociationById(adminA, id("aA1"))).not.toBeNull();
    expect(await assoc.listActiveMembers(adminA, id("aB1"))).toEqual([]);
    expect(await assoc.getAssociationMetrics(adminA, id("aB1"))).toMatchObject({ activeMembers: 0 });
    expect(await assoc.searchPeopleToAdd(adminA, id("aB1"), "Persona", true)).toEqual([]);

    await expect(assocCommands.updateAssociation(adminA, id("aB1"), { name: "Hack" })).rejects.toThrow(/no existe/);
    await expect(assocCommands.setAssociationActive(adminA, id("aB1"), false)).rejects.toThrow(/no existe/);
    await expect(assocMembers.addMember(adminA, id("aB1"), id("pA"))).rejects.toThrow(/no existe/);
    await expect(assocMembers.bulkAddMembers(adminA, id("aB1"), [id("pA")])).rejects.toThrow(/no existe/);
    await expect(assocMembers.addMember(adminA, id("aA"), id("pB"))).rejects.toThrow(/no existe/);
  });

  it("los selectores de personas para asociaciones respetan el alcance", async () => {
    const found = (await assoc.searchAnyActivePeople(adminA, "Persona")).map((p) => p.firstName);
    expect(found).toEqual(expect.arrayContaining(["PersonaA", "PersonaA1", "PersonaA2"]));
    expect(found).not.toContain("PersonaB");
    expect(found).not.toContain("PersonaB1");
    expect(found).not.toContain("PersonaSinUnidad");
    expect((await assoc.searchPeopleToAdd(adminA, id("aA"), "Persona", true)).map((p) => p.firstName)).not.toContain("PersonaB");
    // Alta masiva: la persona ajena se ignora en silencio.
    expect(await assocMembers.bulkAddMembers(adminA, id("aA"), [id("pA"), id("pB")])).toBe(1);
  });
});

describe("reuniones: alcance por unidad propietaria", () => {
  it("12) cada usuario ve solo las reuniones de su alcance", async () => {
    const list = async (u: any) => (await meetings.listMeetings(u)).map((m) => m.name).sort();
    expect(await list(master)).toEqual(["Reunión mA", "Reunión mA1", "Reunión mB1"]);
    expect(await list(adminA)).toEqual(["Reunión mA", "Reunión mA1"]);
    expect(await list(userA1)).toEqual(["Reunión mA1"]);
  });

  it("12b) detalle, edición, estado, invitaciones y asistencia de una reunión ajena fallan", async () => {
    expect(await meetings.getMeetingById(adminA, id("mB1"))).toBeNull();
    expect(await meetings.getMeetingAssociationIds(adminA, id("mB1"))).toEqual([]);
    expect(await invitations.listInvitations(adminA, id("mB1"))).toEqual([]);
    expect(await getLivePanelData(adminA, id("mB1"))).toBeNull();
    expect(await quickSearchForAccreditation(adminA, id("mB1"), "Persona")).toEqual([]);

    await expect(meetingCommands.changeMeetingStatus(adminA, id("mB1"), "scheduled")).rejects.toThrow(/no existe/);
    await expect(meetingCommands.regenerateQrSecret(adminA, id("mB1"))).rejects.toThrow(/no existe/);
    await expect(meetingCommands.setMeetingAssociations(adminA, id("mB1"), [])).rejects.toThrow(/no existe/);
    await expect(invitations.createInvitationBatch(adminA, id("mB1"), { personIds: [id("pA")] })).rejects.toThrow(/no existe/);
    await expect(setAttendanceManually(adminA, id("mB1"), id("pA"), "attended", "motivo")).rejects.toThrow(/no existe/);
    await expect(
      meetingCommands.updateMeeting(adminA, id("mB1"), { name: "x", startsAt: "2030-01-01T10:00", endsAt: "2030-01-01T11:00" } as any)
    ).rejects.toThrow(/no existe/);
  });

  it("12c) asociar una asociación ajena a una reunión propia falla", async () => {
    await expect(meetingCommands.setMeetingAssociations(adminA, id("mA"), [id("aB1")])).rejects.toThrow(/no existe/);
  });

  it("12d) la audiencia de una invitación solo incluye personas del alcance", async () => {
    expect(await countAudience(adminA, { personIds: [id("pA"), id("pB"), id("pNull")] })).toBe(1);
    expect(await countAudience(master, { personIds: [id("pA"), id("pB"), id("pNull")] })).toBe(3);
  });

  it("12e) las rutas del QR y del panel en vivo responden 404 para una reunión ajena", async () => {
    currentToken = (await sessionFor("admin-a@sutecba.local")).token;
    const params = (meetingId: string) => ({ params: Promise.resolve({ id: meetingId }) });

    const foreignQr = await qrRoute(new NextRequest("http://localhost/api/reuniones/x/qr"), params(id("mB1")));
    expect(foreignQr.status).toBe(404);
    const ownQr = await qrRoute(new NextRequest("http://localhost/api/reuniones/x/qr"), params(id("mA")));
    expect(ownQr.status).toBe(200);

    expect((await liveRoute(new NextRequest("http://localhost/api/reuniones/x/live"), params(id("mB1")))).status).toBe(404);
    expect((await liveRoute(new NextRequest("http://localhost/api/reuniones/x/live"), params(id("mA")))).status).toBe(200);
  });
});

describe("formularios: alcance por unidad propietaria", () => {
  it("13) cada usuario ve solo los formularios de su alcance", async () => {
    const list = async (u: any) => (await forms.listForms(u)).map((f) => f.name).sort();
    expect(await list(master)).toEqual(["Form fA", "Form fB"]);
    expect(await list(adminA)).toEqual(["Form fA"]);
    expect(await list(adminB)).toEqual(["Form fB"]);
    expect(await list(userA1)).toEqual([]);
  });

  it("13b) ver, editar, publicar, exportar y responder un formulario ajeno falla", async () => {
    expect(await forms.getFormById(adminA, id("fB"))).toBeNull();
    expect(await forms.listFormFields(adminA, id("fB"))).toEqual([]);
    expect(await forms.listSubmissions(adminA, id("fB"))).toEqual([]);

    await expect(formCommands.publishForm(adminA, id("fB"))).rejects.toThrow(/no existe/);
    await expect(formCommands.changeFormStatus(adminA, id("fB"), "archived")).rejects.toThrow(/no existe/);
    await expect(
      formCommands.upsertField(adminA, id("fB"), null, { key: "x", label: "X", fieldType: "text", required: false, visible: true, personFieldMapping: "" } as any)
    ).rejects.toThrow(/no existe/);
    await expect(formCommands.addAssociationAction(adminA, id("fA"), id("aB1"))).rejects.toThrow(/no existe/);
    await expect(exportSubmissionsCsv(adminA, id("fB"))).rejects.toThrow(/no existe/);
  });

  it("13c) la revisión de duplicados solo trae candidatos de formularios del alcance", async () => {
    const db = await getDb();
    for (const [formKey, personKey] of [["fA", "pA"], ["fB", "pB"]] as const) {
      const submission = await db
        .insertInto("form_submissions")
        .values({ form_id: id(formKey), form_version: 1, raw_payload: toJsonb({ dni: "1" }), normalized_values: toJsonb({}), idempotency_key: randomUUID(), match_result: "needs_review" } as any)
        .returning("id")
        .executeTakeFirstOrThrow();
      await db.insertInto("person_duplicate_candidates").values({ person_id: id(personKey), submission_id: submission.id, match_reason: "test" }).execute();
    }
    const forA = await forms.listPendingDuplicateCandidates(adminA, true);
    expect(forA.map((c) => c.formName)).toEqual(["Form fA"]);
    const forMaster = await forms.listPendingDuplicateCandidates(master, true);
    expect(forMaster.map((c) => c.formName).sort()).toEqual(["Form fA", "Form fB"]);
  });
});

describe("analytics: solo lo accesible", () => {
  it("14) los indicadores de personas se calculan solo sobre el alcance", async () => {
    const forMaster = await analytics.getPeopleAnalytics(master);
    const forA = await analytics.getPeopleAnalytics(adminA);
    const forA1 = await analytics.getPeopleAnalytics(userA1);
    expect(forMaster.total).toBeGreaterThanOrEqual(6);
    expect(forMaster.missingOrganization).toBe(1);
    expect(forA.total).toBe(4); // A, A1, A2 + la persona creada en A2 por el test de alta
    expect(forA.missingOrganization).toBe(0);
    expect(forA.byOrganization.map((r) => r.nombre)).not.toContain("Sin organismo");
    expect(forA1.total).toBe(1);
  });

  it("14b) asociaciones, reuniones y formularios también", async () => {
    expect((await analytics.getAssociationsAnalytics(master)).total).toBe(3);
    expect((await analytics.getAssociationsAnalytics(adminA)).total).toBe(2);
    expect((await analytics.getAssociationsAnalytics(userA1)).total).toBe(1);

    expect((await analytics.getMeetingsAnalytics(master)).total).toBe(3);
    expect((await analytics.getMeetingsAnalytics(adminA)).total).toBe(2);
    expect((await analytics.getMeetingsAnalytics(adminB)).total).toBe(1);

    expect((await analytics.getFormsAnalytics(master)).totalForms).toBe(2);
    expect((await analytics.getFormsAnalytics(adminA)).totalForms).toBe(1);
    expect((await analytics.getFormsAnalytics(userA1)).totalForms).toBe(0);
    expect((await analytics.getFormsAnalytics(adminA)).pendingDuplicates).toBe(1);
    expect((await analytics.getFormsAnalytics(master)).pendingDuplicates).toBe(2);
  });

  it("14c) los totales del dashboard también respetan el alcance", async () => {
    const forMaster = await analytics.getDashboardCounts(master);
    const forA = await analytics.getDashboardCounts(adminA);
    expect(forA.associations).toBe(2);
    expect(forA.meetings).toBe(2);
    expect(forA.people).toBe(4);
    expect(forA.people).toBeLessThan(forMaster.people);
    expect(forA.users).toBeLessThan(forMaster.users);
  });
});

describe("IDOR: id conocido de otra unidad", () => {
  it("15) las páginas de detalle responden no encontrado", async () => {
    currentToken = (await sessionFor("admin-a@sutecba.local")).token;
    const params = (paramId: string) => ({ params: Promise.resolve({ id: paramId }) });

    expect(await isNotFound(() => PersonaFichaPage(params(id("pB")) as any))).toBe(true);
    expect(await isNotFound(() => AsociacionFichaPage(params(id("aB1")) as any))).toBe(true);
    expect(await isNotFound(() => ReunionFichaPage(params(id("mB1")) as any))).toBe(true);
    expect(await isNotFound(() => FormularioFichaPage(params(id("fB")) as any))).toBe(true);

    // Control: los propios sí se abren.
    expect(await isNotFound(() => PersonaFichaPage(params(id("pA1")) as any))).toBe(false);
    expect(await isNotFound(() => AsociacionFichaPage(params(id("aA1")) as any))).toBe(false);
    expect(await isNotFound(() => ReunionFichaPage(params(id("mA1")) as any))).toBe(false);
    expect(await isNotFound(() => FormularioFichaPage(params(id("fA")) as any))).toBe(false);
  });

  it("15b) una Server Action con un UUID ajeno falla y no modifica nada", async () => {
    currentToken = (await sessionFor("admin-a@sutecba.local")).token;
    const db = await getDb();

    const single = await setPersonActiveAction(id("pB"), false);
    expect(single.ok).toBe(false);

    const bulk = await bulkSetActiveAction({ mode: "ids", ids: [id("pB"), id("pB1"), id("pNull")] }, false);
    expect(bulk.count ?? 0).toBe(0);

    const transfer = await transferPersonAction(id("pB"), { ok: false }, (() => {
      const fd = new FormData();
      fd.set("organizationId", o("A"));
      fd.set("reason", "intento");
      return fd;
    })());
    expect(transfer.ok).toBe(false);

    const rows = await db.selectFrom("people").select(["status", "organization_id"]).where("id", "in", [id("pB"), id("pB1"), id("pNull")]).execute();
    expect(rows.every((r) => r.status === "active")).toBe(true);
    expect((await db.selectFrom("people").select("organization_id").where("id", "=", id("pB")).executeTakeFirstOrThrow()).organization_id).toBe(o("B"));
  });

  it("un id malformado no rompe: se trata como inexistente", async () => {
    expect(await scope.canAccessPerson(adminA, "no-es-un-uuid")).toBe(false);
    expect(await people.getPersonById(adminA, "no-es-un-uuid")).toBeNull();
    expect(await assoc.getAssociationById(adminA, "no-es-un-uuid")).toBeNull();
  });
});

describe("etiquetas, interacciones e importaciones", () => {
  let localA: string;
  let localB: string;
  let globalTag: string;
  let sensitiveGlobal: string;
  let sensitiveA: string;

  beforeAll(async () => {
    const db = await getDb();
    const make = async (name: string, ownerName: string | null, sensitive: boolean) => {
      const row = await db
        .insertInto("tags")
        .values({ name, normalized_name: name.toLowerCase(), owner_organization_id: ownerName ? o(ownerName) : null, is_sensitive: sensitive, created_by: masterId })
        .returning("id")
        .executeTakeFirstOrThrow();
      return row.id;
    };
    localA = await make("Local A", "A", false);
    localB = await make("Local B", "B", false);
    globalTag = await make("Global", null, false);
    sensitiveGlobal = await make("Sensible global", null, true);
    sensitiveA = await make("Sensible A", "A", true);
    for (const [personKey, tagId] of [["pA", localA], ["pA", sensitiveGlobal], ["pA1", globalTag], ["pB", localB]] as const) {
      await db.insertInto("person_tags").values({ person_id: id(personKey), tag_id: tagId, assigned_by: masterId }).execute();
    }
  });

  it("19) las etiquetas locales respetan el alcance; las globales se ven según permisos", async () => {
    const visible = async (u: any) => (await tagsQueries.listVisibleTags(u)).map((t) => t.name).sort();
    expect(await visible(adminA)).toEqual(["Global", "Local A", "Sensible A", "Sensible global"]);
    expect(await visible(adminB)).toEqual(["Global", "Local B", "Sensible global"]);
    // userA1 solo llega a A1: la etiqueta local de A (su área superior) no le corresponde.
    expect(await visible(userA1)).toEqual(["Global"]);
    expect(await visible(userANoDesc)).toEqual(["Global", "Local A"]);
    expect(await visible(master)).toHaveLength(5);
  });

  it("19b) las etiquetas de una persona ajena no se listan", async () => {
    expect((await tagsQueries.listPersonTags(adminA, id("pA"))).map((t) => t.name).sort()).toEqual(["Local A", "Sensible global"]);
    expect(await tagsQueries.listPersonTags(adminA, id("pB"))).toEqual([]);
  });

  it("20) las etiquetas sensibles requieren people.view_sensitive (listados, filtros y estadísticas)", async () => {
    expect(userA1.permissions.has("people.view_sensitive")).toBe(false);
    expect(adminA.permissions.has("people.view_sensitive")).toBe(true);

    const sensitiveNames = (await tagsQueries.listVisibleTags(userA1)).filter((t) => t.isSensitive);
    expect(sensitiveNames).toEqual([]);

    // Filtrar personas por una etiqueta sensible sin el permiso no matchea nada (ni revela que existe).
    const withPermission = await people.countPeople(adminA, { status: "all", tagIds: [sensitiveGlobal] });
    expect(withPermission).toBe(1);
    const withoutPermission = await people.countPeople(userANoDesc, { status: "all", tagIds: [sensitiveGlobal] });
    expect(withoutPermission).toBe(0);

    const stats = await tagsQueries.countPeopleByVisibleTag(userANoDesc);
    expect(stats.map((s) => s.name)).not.toContain("Sensible global");
    expect((await tagsQueries.countPeopleByVisibleTag(adminA)).map((s) => s.name)).toContain("Sensible global");
  });

  it("filtrar personas por una etiqueta local ajena no matchea nada", async () => {
    expect(await people.countPeople(adminA, { status: "all", tagIds: [localB] })).toBe(0);
    expect(await people.countPeople(adminB, { status: "all", tagIds: [localB] })).toBe(1);
    expect(sensitiveA).toBeTruthy();
  });

  it("importaciones: el lote define el alcance y raw_data es sensible", async () => {
    const db = await getDb();
    const batchIds = new Map<string, string>();
    for (const orgName of ["A", "B"]) {
      const file = await db
        .insertInto("import_files")
        .values({ original_name: `${orgName}.xlsx`, content_hash: (orgName === "A" ? "a" : "b").repeat(64), created_by: masterId })
        .returning("id")
        .executeTakeFirstOrThrow();
      const batch = await db
        .insertInto("import_batches")
        .values({ owner_organization_id: o(orgName), responsible_user_id: masterId, created_by: masterId })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db.insertInto("import_batch_files").values({ batch_id: batch.id, file_id: file.id, linked_by: masterId }).execute();
      await db
        .insertInto("import_rows")
        .values({ file_id: file.id, sheet: "Hoja1", row_number: 1, raw_data: JSON.stringify({ dni: "30111222" }), row_hash: (orgName === "A" ? "c" : "d").repeat(64) })
        .execute();
      batchIds.set(orgName, batch.id);
    }

    expect((await listImportBatches(adminA)).map((b) => b.ownerOrganizationId)).toEqual([o("A")]);
    expect(await listImportBatches(adminB).then((b) => b.map((x) => x.ownerOrganizationId))).toEqual([o("B")]);
    expect(await listImportBatches(master)).toHaveLength(2);

    expect(await listImportRows(adminA, batchIds.get("B")!)).toEqual([]);
    const own = await listImportRows(adminA, batchIds.get("A")!);
    expect(own).toHaveLength(1);
    expect(own[0]!.rawData).not.toBeNull(); // adminA tiene people.view_sensitive

    const sensitive = await listImportRows(userANoDesc, batchIds.get("A")!);
    expect(sensitive).toHaveLength(1);
    expect(sensitive[0]!.rawData).toBeNull(); // sin people.view_sensitive, raw_data no se entrega
  });
});

describe("formularios públicos y traslados", () => {
  it("un formulario público sigue funcionando sin sesión y la persona hereda la unidad del formulario", async () => {
    currentToken = undefined;
    const form = await formCommands.createForm(master, { name: "Público A1", slug: "publico-a1", ownerOrganizationId: o("A1") });
    await formCommands.updateFormMeta(master, form.id, {
      name: "Público A1",
      slug: "publico-a1",
      consentText: "",
      successMessage: "",
      opensAt: "",
      closesAt: "",
      matchFields: ["dni"],
      updatePolicy: "fill_empty_only",
    } as any);
    for (const [key, label, type, mapping] of [
      ["first_name", "Nombre", "text", "first_name"],
      ["last_name", "Apellido", "text", "last_name"],
      ["dni", "DNI", "dni", "dni"],
    ] as const) {
      await formCommands.upsertField(master, form.id, null, { key, label, fieldType: type, required: true, visible: true, personFieldMapping: mapping } as any);
    }
    await formCommands.publishForm(master, form.id);

    const publicForm = await getPublicForm("publico-a1");
    expect(publicForm.kind).toBe("ok");

    const result = await submitForm("publico-a1", { first_name: "Visitante", last_name: "Publico", dni: "40999001" }, randomUUID(), "10.0.0.1", "test");
    expect(result.kind).toBe("ok");

    const db = await getDb();
    const created = await db.selectFrom("people").select(["id", "organization_id"]).where("dni", "=", "40999001").executeTakeFirstOrThrow();
    expect(created.organization_id).toBe(o("A1"));
    expect(await people.getPersonById(adminA, created.id)).not.toBeNull();
    expect(await people.getPersonById(adminB, created.id)).toBeNull();

    // El selector público de asociaciones lo fija la unidad del formulario, no el visitante.
    const options = (await forms.listAssociationsForPublicForm(o("A1"))).map((a) => a.name);
    expect(options).toEqual(["Asoc aA1"]);
  });

  it("un envío que coincide con una persona de otra unidad va a revisión y no la modifica", async () => {
    const db = await getDb();
    const before = await db.selectFrom("people").select(["email", "phone"]).where("id", "=", id("pB")).executeTakeFirstOrThrow();

    const result = await submitForm("publico-a1", { first_name: "Otro", last_name: "Intento", dni: "40000004" }, randomUUID(), "10.0.0.2", "test");
    expect(result.kind).toBe("ok");

    const submission = await db.selectFrom("form_submissions").select(["match_result", "person_id"]).orderBy("created_at", "desc").executeTakeFirstOrThrow();
    expect(submission.match_result).toBe("needs_review");
    expect(submission.person_id).toBeNull();
    const after = await db.selectFrom("people").select(["email", "phone"]).where("id", "=", id("pB")).executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });

  it("16) al trasladar A→B, B ve la ficha actual y A deja de verla", async () => {
    const db = await getDb();
    const interactionType = await db.selectFrom("interaction_types").select("id").where("key", "=", "consulta").executeTakeFirstOrThrow();
    await db
      .insertInto("person_interactions")
      .values({ person_id: id("pA1"), owner_organization_id: o("A"), occurred_at: new Date(), interaction_type_id: interactionType.id, subject: "Consulta previa al traslado", created_by: masterId })
      .execute();

    expect(await people.getPersonById(adminA, id("pA1"))).not.toBeNull();
    expect(await people.getPersonById(adminB, id("pA1"))).toBeNull();

    await transferPerson(adminA, id("pA1"), o("B"), "Cambio de destino");

    expect(await people.getPersonById(adminB, id("pA1"))).not.toBeNull();
    expect(await people.getPersonById(adminA, id("pA1"))).toBeNull();
    expect(await people.getPersonById(userA1, id("pA1"))).toBeNull();
    expect(names((await people.listPeoplePage(adminA, ALL_FILTER, { field: "name", direction: "asc" }, 1, 50)).rows)).not.toContain("PersonaA1");
  });

  it("17) B no ve las interacciones históricas de A; A conserva las suyas", async () => {
    expect((await listPersonInteractions(adminB, id("pA1"))).map((i) => i.subject)).toEqual([]);
    expect((await listPersonInteractions(adminA, id("pA1"))).map((i) => i.subject)).toEqual(["Consulta previa al traslado"]);
  });

  it("18) A conserva la constancia del traslado, sin acceso a la ficha; B ve la llegada", async () => {
    const forA = (await listTransferReceipts(adminA)).find((r) => r.personName.startsWith("PersonaA1"))!;
    expect(forA.direction).toBe("salida");
    expect(forA.toOrganizationName).toBe("B");
    expect(forA.personId).toBeNull();
    expect(forA.reason).toBe("Cambio de destino");

    const forB = (await listTransferReceipts(adminB)).find((r) => r.personName.startsWith("PersonaA1"))!;
    expect(forB.direction).toBe("entrada");
    expect(forB.personId).toBe(id("pA1"));
    expect(forB.reason).toBe("");

    // Nadie ajeno a los dos lados ve la constancia.
    expect((await listTransferReceipts(userANoDesc)).find((r) => r.personName.startsWith("PersonaA1"))).toBeUndefined();
  });

  it("solo MASTER_GLOBAL o quien tiene el permiso y el alcance puede trasladar", async () => {
    await expect(transferPerson(userA1, id("pA2"), o("B"), "sin permiso")).rejects.toThrow();
    await expect(transferPerson(adminB, id("pA2"), o("B1"), "fuera de alcance")).rejects.toThrow(/no existe/);
    await expect(transferPerson(adminA, id("pA2"), o("B"), "")).rejects.toThrow(/motivo/i);
  });
});
