import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.SUTECBA_QR_SECRET = "test-qr-secret-".padEnd(48, "x");

let currentToken: string | undefined;
vi.mock("../../lib/auth/cookies.js", () => ({
  getSessionCookie: async () => currentToken,
}));

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createSession, loadSessionUser } = await import("../../lib/auth/session.js");
const { createUser } = await import("../../lib/users/commands.js");
const peopleCommands = await import("../../lib/people/commands.js");
const people = await import("../../lib/people/queries.js");
const { transferPerson } = await import("../../lib/people/transfers.js");
const formCommands = await import("../../lib/forms/commands.js");
const forms = await import("../../lib/forms/queries.js");
const { exportSubmissionsCsv } = await import("../../lib/forms/export.js");
const { submitForm } = await import("../../lib/forms/submit.js");
const { maskSubmissionPayload } = await import("../../lib/forms/sensitive.js");
const { identifyForCheckin, confirmCheckin, resolveQrToken } = await import("../../lib/attendance/checkin.js");
const { signPendingCheckin } = await import("../../lib/attendance/session-tokens.js");
const { signRotatingQrToken } = await import("../../lib/attendance/qr.js");
const invitationsLib = await import("../../lib/meetings/invitations.js");
const { getInvitationByToken, respondToInvitation, checkInByInvitationToken } = await import("../../lib/meetings/public.js");
const { getLivePanelData, quickSearchForAccreditation } = await import("../../lib/attendance/live.js");

const { default: FormSubmissionsPage } = await import("../../app/(protegido)/formularios/[id]/respuestas/page.js");
const { default: PersonaFichaPage } = await import("../../app/(protegido)/personas/[id]/page.js");
const { GET: exportFormRoute } = await import("../../app/api/formularios/[id]/export/route.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;

const orgs = new Map<string, string>();
const o = (name: string) => orgs.get(name)!;
const ids = new Map<string, string>();
const id = (key: string) => ids.get(key)!;
let masterId: string;
let master: any;
let adminA: any;
let exporter: any;
let ipCounter = 0;
const nextIp = () => `10.20.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function makeOrg(name: string, parentId: string | null) {
  const db = await getDb();
  const type = await db.selectFrom("organization_types").select("id").where("key", "=", "reparticion").executeTakeFirstOrThrow();
  const row = await db.insertInto("organizations").values({ name, type_id: type.id, parent_id: parentId }).returning("id").executeTakeFirstOrThrow();
  orgs.set(name, row.id);
}

async function sessionFor(email: string) {
  const { token } = await createSession(id(email));
  return { token, user: (await loadSessionUser(token))! };
}

async function makePerson(key: string, values: { first: string; last: string; dni: string; org: string | null; email?: string; phone?: string }) {
  const db = await getDb();
  const row = await db
    .insertInto("people")
    .values({
      first_name: values.first,
      last_name: values.last,
      dni: values.dni,
      email: values.email ?? null,
      phone: values.phone ?? null,
      organization_id: values.org ? o(values.org) : null,
      created_by: masterId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  ids.set(key, row.id);
}

async function makeMeeting(key: string, orgName: string, status: "scheduled" | "in_progress", allowUninvited: boolean) {
  const db = await getDb();
  const row = await db
    .insertInto("meetings")
    .values({
      name: `Reunión ${key}`,
      owner_organization_id: o(orgName),
      status,
      allow_uninvited_checkin: allowUninvited,
      starts_at: new Date(Date.now() - 10 * 60_000),
      ends_at: new Date(Date.now() + 80 * 60_000),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  ids.set(key, row.id);
}

async function attendanceCount(meetingKey: string, personKey?: string): Promise<number> {
  const db = await getDb();
  let query = db.selectFrom("meeting_attendance").select("id").where("meeting_id", "=", id(meetingKey));
  if (personKey) query = query.where("person_id", "=", id(personKey));
  return (await query.execute()).length;
}

async function makeForm(slug: string, matchFields: string[], fields: Array<[string, string, string, string]>) {
  const { id: formId } = await formCommands.createForm(master, { name: slug, slug, ownerOrganizationId: o("A") });
  await formCommands.updateFormMeta(master, formId, {
    name: slug,
    slug,
    consentText: "",
    successMessage: "",
    opensAt: "",
    closesAt: "",
    matchFields,
    updatePolicy: "fill_empty_only",
  } as any);
  for (const [key, label, type, mapping] of fields) {
    await formCommands.upsertField(master, formId, null, { key, label, fieldType: type, required: key === "first_name" || key === "last_name" || key === "dni", visible: true, personFieldMapping: mapping } as any);
  }
  await formCommands.publishForm(master, formId);
  return formId;
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  await makeOrg("A", null);
  await makeOrg("A1", o("A"));
  await makeOrg("B", null);

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

  // Rol con permiso de exportar respuestas pero SIN people.view_sensitive.
  const exporterRole = await db.insertInto("roles").values({ key: "EXPORTER_TEST", name: "Exportador de prueba" }).returning("id").executeTakeFirstOrThrow();
  const perms = await db.selectFrom("permissions").select(["id"]).where("key", "in", ["forms.view", "forms.export_submissions"]).execute();
  await db.insertInto("role_permissions").values(perms.map((p) => ({ role_id: exporterRole.id, permission_id: p.id }))).execute();

  const create = async (email: string, roleKey: string, modules: string[]) => {
    const { userId } = await createUser(master, {
      email,
      fullName: email,
      roleKey: roleKey as any,
      scopes: [{ organizationId: o("A"), includeDescendants: true }],
      moduleKeys: modules,
    });
    ids.set(email, userId);
  };
  await create("admin-a@sutecba.local", "ADMIN", ["personas", "reuniones", "formularios", "dashboard"]);
  await create("exporter@sutecba.local", "EXPORTER_TEST", ["formularios"]);
  adminA = (await sessionFor("admin-a@sutecba.local")).user;
  exporter = (await sessionFor("exporter@sutecba.local")).user;

  await makePerson("pB", { first: "Beto", last: "Beta", dni: "50000001", org: "B", email: "beto@example.com", phone: "1144440001" });
  await makePerson("pA", { first: "Alma", last: "Alfa", dni: "50000002", org: "A", email: "alma@example.com", phone: "1144440002" });
  await makePerson("pA1", { first: "Aldo", last: "Alfauno", dni: "50000003", org: "A1" });
  await makePerson("pNull", { first: "Nula", last: "Sinunidad", dni: "50000004", org: null });
  await makePerson("pInvB", { first: "Invitada", last: "Deb", dni: "50000005", org: "B" });

  await makeMeeting("mOpen", "A", "in_progress", true);
  await makeMeeting("mClosed", "A", "in_progress", false);
  await makeMeeting("mSched", "A", "scheduled", false);
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("formularios: las respuestas respetan people.view_sensitive", () => {
  let formId: string;
  const RAW = { dni: "41888777", email: "maria.sensible@example.com", phone: "1155556666", dato: "secreto-123" };

  beforeAll(async () => {
    const db = await getDb();
    await db.insertInto("person_field_definitions").values({ key: "dato_reservado", label: "Dato reservado", field_type: "text", sensitive: true }).execute();
    formId = await makeForm("form-sensible", ["dni"], [
      ["first_name", "Nombre", "text", "first_name"],
      ["last_name", "Apellido", "text", "last_name"],
      ["dni", "DNI", "dni", "dni"],
      ["email", "Email", "email", "email"],
      ["phone", "Teléfono", "phone", "phone"],
      ["dato", "Dato reservado", "text", "dato_reservado"],
    ]);
    const result = await submitForm("form-sensible", { first_name: "Maria", last_name: "Sensible", ...RAW }, randomUUID(), nextIp(), "test");
    expect(result.kind).toBe("ok");
  });

  it("consulta: sin people.view_sensitive, el payload sale enmascarado desde el servidor", async () => {
    expect(exporter.permissions.has("people.view_sensitive")).toBe(false);
    const rows = await forms.listSubmissions(exporter, formId);
    expect(rows).toHaveLength(1);

    const blob = JSON.stringify(rows);
    for (const value of Object.values(RAW)) expect(blob).not.toContain(value);
    expect(rows[0]!.rawPayload.dni).toBe("41****77");
    expect(String(rows[0]!.rawPayload.email)).toMatch(/^m\*+e@example\.com$/);
    expect(rows[0]!.rawPayload.phone).toBe("******6666");
    expect(rows[0]!.rawPayload.dato).toBe("••••");
    // Lo no sensible se conserva.
    expect(rows[0]!.rawPayload.first_name).toBe("Maria");
  });

  it("consulta: con people.view_sensitive (o MASTER_GLOBAL) los valores reales se ven", async () => {
    for (const viewer of [master, adminA]) {
      const rows = await forms.listSubmissions(viewer, formId);
      expect(rows[0]!.rawPayload.dni).toBe(RAW.dni);
      expect(rows[0]!.rawPayload.dato).toBe(RAW.dato);
    }
  });

  it("export CSV: enmascarado sin el permiso, real con el permiso", async () => {
    const masked = await exportSubmissionsCsv(exporter, formId);
    for (const value of Object.values(RAW)) expect(masked).not.toContain(value);
    expect(masked).toContain("41****77");

    const real = await exportSubmissionsCsv(master, formId);
    expect(real).toContain(RAW.dni);
    expect(real).toContain(RAW.email);
  });

  it("API: el endpoint de exportación no devuelve el valor real sin el permiso", async () => {
    const request = () => new NextRequest(`http://localhost/api/formularios/${formId}/export`);
    const params = { params: Promise.resolve({ id: formId }) };

    currentToken = (await sessionFor("exporter@sutecba.local")).token;
    const maskedResponse = await exportFormRoute(request(), params);
    const maskedBody = await maskedResponse.text();
    expect(maskedResponse.status).toBe(200);
    for (const value of Object.values(RAW)) expect(maskedBody).not.toContain(value);

    currentToken = (await sessionFor("master@sutecba.local")).token;
    const realBody = await (await exportFormRoute(request(), params)).text();
    expect(realBody).toContain(RAW.dni);
  });

  it("UI: la página de respuestas no expone valores reales sin el permiso", async () => {
    currentToken = (await sessionFor("exporter@sutecba.local")).token;
    const html = renderToStaticMarkup(await FormSubmissionsPage({ params: Promise.resolve({ id: formId }) } as any));
    for (const value of Object.values(RAW)) expect(html).not.toContain(value);
  });

  it("el enmascarado trata como sensible una clave que no figura en el esquema", () => {
    const masked = maskSubmissionPayload({ dni: "12345678", extra: "valor-suelto", nombre: "Ana" }, null, new Set());
    expect(JSON.stringify(masked)).not.toContain("valor-suelto");
    expect(JSON.stringify(masked)).not.toContain("12345678");
  });
});

describe("DNI fuera del scope: sin enumeración", () => {
  const newPerson = (dni: string) =>
    ({ firstName: "Nueva", lastName: "Alta", dni, email: "", phone: "", organizationId: o("A"), birthDate: "", declaredAge: "" }) as any;

  it("un usuario con alcance limitado recibe siempre el mismo mensaje, exista el DNI donde exista", async () => {
    const outOfScope = await peopleCommands.createPerson(adminA, newPerson("50000001")).catch((e) => e); // persona de B
    const inScope = await peopleCommands.createPerson(adminA, newPerson("50000002")).catch((e) => e); // persona de A
    const unitless = await peopleCommands.createPerson(adminA, newPerson("50000004")).catch((e) => e); // sin unidad

    for (const error of [outOfScope, inScope, unitless]) {
      expect(error).toBeInstanceOf(peopleCommands.PersonCommandError);
      expect(error.message).toBe(peopleCommands.IDENTITY_CONFLICT_MESSAGE);
      expect(error.code).toBe("IDENTITY_CONFLICT");
      expect(error.blockedByPersonId).toBeUndefined();
    }
    expect(outOfScope.message).toBe(inScope.message);
    expect(outOfScope.message).toBe(unitless.message);
  });

  it("el mensaje no trae nombre, unidad, id ni datos de contacto ni afirma que exista en otra unidad", async () => {
    const error = await peopleCommands.createPerson(adminA, newPerson("50000001")).catch((e) => e);
    const text = JSON.stringify({ message: error.message, code: error.code, blocked: error.blockedByPersonId });
    for (const leaked of ["Beto", "Beta", id("pB"), "beto@example.com", "1144440001", "otra unidad", "ya existe", "Ya existe"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("editar una persona propia con el DNI de otra da el mismo mensaje genérico", async () => {
    const version = (await people.getPersonById(adminA, id("pA1")))!.version;
    const error = await peopleCommands
      .updatePerson(adminA, id("pA1"), version, { firstName: "Aldo", lastName: "Alfauno", dni: "50000001", email: "", phone: "", organizationId: o("A1"), birthDate: "", declaredAge: "" } as any)
      .catch((e) => e);
    expect(error.message).toBe(peopleCommands.IDENTITY_CONFLICT_MESSAGE);
    expect(error.blockedByPersonId).toBeUndefined();
  });

  it("MASTER_GLOBAL conserva el detalle necesario para resolver el conflicto", async () => {
    const error = await peopleCommands
      .createPerson(master, { firstName: "Nueva", lastName: "Alta", dni: "50000001", email: "", phone: "", organizationId: o("A"), birthDate: "", declaredAge: "" } as any)
      .catch((e) => e);
    expect(error.code).toBe("DNI_DUPLICATE");
    expect(error.blockedByPersonId).toBe(id("pB"));
    expect(error.message).toContain("Beto");
  });

  it("un envío público que choca por DNI queda con un mensaje genérico, sin revelar a quién pertenece el DNI", async () => {
    const formId = await makeForm("form-conflicto", ["email"], [
      ["first_name", "Nombre", "text", "first_name"],
      ["last_name", "Apellido", "text", "last_name"],
      ["dni", "DNI", "dni", "dni"],
      ["email", "Email", "email", "email"],
    ]);
    await submitForm("form-conflicto", { first_name: "Intruso", last_name: "Publico", dni: "50000001", email: "intruso@example.com" }, randomUUID(), nextIp(), "test");

    const rows = await forms.listSubmissions(adminA, formId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.matchResult).toBe("error");
    expect(rows[0]!.errorMessage).toBe(peopleCommands.IDENTITY_CONFLICT_MESSAGE);
    expect(rows[0]!.errorMessage).not.toContain("Beto");
    expect(rows[0]!.errorMessage).not.toContain("50000001");

  });
});

describe("check-in público: la identificación queda acotada a la reunión", () => {
  it("una persona de B no puede identificarse en una reunión de A, y la respuesta no confirma que exista", async () => {
    const existsInB = await identifyForCheckin(id("mOpen"), "50000001", "Beta", nextIp());
    const doesNotExist = await identifyForCheckin(id("mOpen"), "99999999", "Nadie", nextIp());
    const wrongLastName = await identifyForCheckin(id("mOpen"), "50000002", "Equivocado", nextIp());

    expect(existsInB).toEqual({ kind: "not_found" });
    expect(existsInB).toEqual(doesNotExist);
    expect(existsInB).toEqual(wrongLastName);
    expect(await attendanceCount("mOpen", "pB")).toBe(0);
  });

  it("tampoco por email ni por teléfono", async () => {
    expect(await identifyForCheckin(id("mOpen"), "beto@example.com", "Beta", nextIp())).toEqual({ kind: "not_found" });
    expect(await identifyForCheckin(id("mOpen"), "1144440001", "Beta", nextIp())).toEqual({ kind: "not_found" });
  });

  it("una persona sin unidad tampoco es válida para una reunión abierta", async () => {
    expect(await identifyForCheckin(id("mOpen"), "50000004", "Sinunidad", nextIp())).toEqual({ kind: "not_found" });
  });

  it("en una reunión solo para invitados, una persona no invitada es indistinguible de una inexistente", async () => {
    expect(await identifyForCheckin(id("mClosed"), "50000002", "Alfa", nextIp())).toEqual({ kind: "not_found" });
    expect(await identifyForCheckin(id("mClosed"), "50000001", "Beta", nextIp())).toEqual({ kind: "not_found" });
  });

  it("en una reunión abierta, las personas de la unidad propietaria (y sus dependientes) sí pueden", async () => {
    for (const [dni, last] of [["50000002", "Alfa"], ["50000003", "Alfauno"]] as const) {
      const result = await identifyForCheckin(id("mOpen"), dni, last, nextIp());
      expect(result.kind).toBe("need_confirmation");
    }
  });

  it("una persona de B invitada explícitamente a esa reunión sí puede (la invitación la hace válida)", async () => {
    await invitationsLib.createInvitationBatch(master, id("mClosed"), { personIds: [id("pInvB")] });
    const result = await identifyForCheckin(id("mClosed"), "50000005", "Deb", nextIp());
    expect(result.kind).toBe("need_confirmation");
  });

  it("un token de confirmación armado para una persona no válida no registra nada", async () => {
    const forged = signPendingCheckin(id("mOpen"), id("pB"));
    expect(await confirmCheckin(forged, nextIp(), "test")).toEqual({ kind: "invalid" });
    expect(await attendanceCount("mOpen", "pB")).toBe(0);
  });

  it("no se rompe el flujo legítimo: identificar, confirmar y la unicidad (meeting, persona)", async () => {
    const identified = await identifyForCheckin(id("mOpen"), "50000002", "Alfa", nextIp());
    if (identified.kind !== "need_confirmation") throw new Error("debía pedir confirmación");

    const first = await confirmCheckin(identified.confirmToken, nextIp(), "test");
    expect(first.kind).toBe("ok");
    const second = await confirmCheckin(identified.confirmToken, nextIp(), "test");
    expect(second.kind).toBe("already_checked_in");
    expect(await attendanceCount("mOpen", "pA")).toBe(1);

    const again = await identifyForCheckin(id("mOpen"), "50000002", "Alfa", nextIp());
    expect(again.kind).toBe("already_checked_in");
  });

  it("el QR sigue validándose: uno firmado es válido y uno alterado no", async () => {
    const db = await getDb();
    const meeting = await db.selectFrom("meetings").select("qr_secret_version").where("id", "=", id("mOpen")).executeTakeFirstOrThrow();
    const { token } = signRotatingQrToken(id("mOpen"), meeting.qr_secret_version);

    expect((await resolveQrToken(token, nextIp())).kind).toBe("ok");
    expect((await resolveQrToken(`${token}x`, nextIp())).kind).toBe("invalid");
  });

  it("el límite de intentos sigue vigente", async () => {
    const ip = nextIp();
    let last: { kind: string } = { kind: "" };
    for (let i = 0; i < 50; i += 1) {
      last = await identifyForCheckin(id("mSched"), `6000${String(i).padStart(4, "0")}`, "Nadie", ip);
    }
    expect(last.kind).toBe("rate_limited");
  });
});

describe("invitaciones públicas: no se puede explorar personas ni unidades", () => {
  let validToken: string;
  let withdrawnToken: string;

  beforeAll(async () => {
    const result = await invitationsLib.createInvitationBatch(master, id("mSched"), { personIds: [id("pA"), id("pA1")] });
    validToken = result.links.find((l) => l.personId === id("pA"))!.token;
    withdrawnToken = result.links.find((l) => l.personId === id("pA1"))!.token;
    const db = await getDb();
    const invitation = await db.selectFrom("meeting_invitations").select("id").where("person_id", "=", id("pA1")).where("meeting_id", "=", id("mSched")).executeTakeFirstOrThrow();
    await invitationsLib.withdrawInvitation(master, invitation.id);
  });

  it("un token válido muestra solo lo de esa invitación (nombre de pila y datos de la reunión)", async () => {
    const view = await getInvitationByToken(validToken, nextIp());
    expect(view.kind).toBe("ok");
    const text = JSON.stringify(view);
    expect(text).toContain("Alma");
    for (const leaked of ["Alfa", "50000002", "alma@example.com", "1144440002", o("A"), id("pA")]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("token inexistente, retirado o malformado dan exactamente el mismo resultado", async () => {
    const unknown = await getInvitationByToken("x".repeat(43), nextIp());
    const withdrawn = await getInvitationByToken(withdrawnToken, nextIp());
    const malformed = await getInvitationByToken("no-es-un-token", nextIp());
    expect(unknown).toEqual({ kind: "invalid" });
    expect(withdrawn).toEqual({ kind: "invalid" });
    expect(malformed).toEqual({ kind: "invalid" });
  });

  it("responder o acreditarse con un token retirado o inexistente no revela ni registra nada", async () => {
    expect(await respondToInvitation(withdrawnToken, "confirmed", nextIp())).toEqual({ ok: false, reason: "invalid" });
    expect(await respondToInvitation("x".repeat(43), "confirmed", nextIp())).toEqual({ ok: false, reason: "invalid" });
    expect(await checkInByInvitationToken(withdrawnToken, nextIp(), "test")).toEqual({ ok: false, reason: "invalid" });
    expect(await attendanceCount("mSched")).toBe(0);
  });
});

describe("historial de reuniones de una persona trasladada", () => {
  it("A conserva el nombre en el historial de su reunión, pero no accede a la ficha actual ni a sus datos de contacto", async () => {
    await makePerson("pHist", { first: "Historica", last: "Pasado", dni: "50000009", org: "A", email: "historica@example.com", phone: "1144449999" });

    // Participa mientras pertenece a A: invitada y acreditada.
    await invitationsLib.createInvitationBatch(master, id("mOpen"), { personIds: [id("pHist")] });
    const identified = await identifyForCheckin(id("mOpen"), "50000009", "Pasado", nextIp());
    if (identified.kind !== "need_confirmation") throw new Error("debía pedir confirmación");
    expect((await confirmCheckin(identified.confirmToken, nextIp(), "test")).kind).toBe("ok");

    // Después se la traslada a B.
    await transferPerson(adminA, id("pHist"), o("B"), "Cambio de destino");

    // El historial de la reunión de A conserva el nombre...
    const invitations = await invitationsLib.listInvitations(adminA, id("mOpen"));
    const row = invitations.find((i) => i.personId === id("pHist"));
    expect(row?.firstName).toBe("Historica");
    const panel = await getLivePanelData(adminA, id("mOpen"));
    expect(panel!.arrived.map((p) => p.firstName)).toContain("Historica");

    // ...pero no se filtran datos actuales de la persona.
    const exposed = JSON.stringify({ invitations, panel });
    for (const secret of ["50000009", "historica@example.com", "1144449999"]) {
      expect(exposed).not.toContain(secret);
    }

    // Y no se llega a la ficha actual (ahora de B) por ninguna vía.
    expect(await people.getPersonById(adminA, id("pHist"))).toBeNull();
    currentToken = (await sessionFor("admin-a@sutecba.local")).token;
    const digest = await PersonaFichaPage({ params: Promise.resolve({ id: id("pHist") }) } as any).catch((e: any) => String(e.digest ?? ""));
    expect(String(digest)).toMatch(/404|NOT_FOUND/);
    expect((await quickSearchForAccreditation(adminA, id("mOpen"), "Historica")).map((r) => r.firstName)).not.toContain("Historica");
  });
});
