import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

/**
 * Actividades unificadas, paso 1f — registro de asistencia: quiénes fueron y quiénes no (por fecha y por persona), con trazabilidad y CSV.
 * Comportamiento real sobre PGlite, de punta a punta: formulario → inscripción → escaneo → informe.
 */

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.SUTECBA_QR_SECRET = "test-secret-not-for-prod-0123456789";

let currentToken: string | undefined;
vi.mock("../../lib/auth/cookies.js", () => ({ getSessionCookie: async () => currentToken }));

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createSession } = await import("../../lib/auth/session.js");
const { PERMISSIONS, ROLE_PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { createActivity } = await import("../../lib/activities/create.js");
const { getAttendanceReport, getPersonActivityTimeline } = await import("../../lib/activities/attendance-report.js");
const { exportAttendanceCsv } = await import("../../lib/activities/attendance-export.js");
const { submitForm } = await import("../../lib/forms/submit.js");
const { identifyForCheckin, confirmCheckin } = await import("../../lib/attendance/checkin.js");
const att = await import("../../lib/attendance/manual.js");
const reg = await import("../../lib/meetings/registrations.js");
const { GET: exportRoute } = await import("../../app/api/reuniones/actividad/[kind]/[id]/asistencia/route.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));
let master: any;
let areaA: any;
let areaB: any;
let lectura: any;
let areaAUserId: string;
let lecturaUserId: string;
let orgA: string;
let orgB: string;
let ipCounter = 0;
let seq = 0;
const nextIp = () => `10.80.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

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
  orgA = await createTestOrganization();
  orgB = await createTestOrganization();
  const db = await getDb();
  master = actorOf(await makeUser("rep-master@sutecba.local", "MASTER_GLOBAL"), "MASTER_GLOBAL", ALL);
  areaAUserId = await makeUser("rep-area-a@sutecba.local", "ADMIN");
  const b = await makeUser("rep-area-b@sutecba.local", "ADMIN");
  lecturaUserId = await makeUser("rep-lectura@sutecba.local", "LECTURA");
  for (const [u, o] of [[areaAUserId, orgA], [b, orgB], [lecturaUserId, orgA]] as const) {
    await db.insertInto("user_scopes").values({ user_id: u, organization_id: o, include_descendants: true, granted_by: master.id } as never).execute();
  }
  for (const u of [areaAUserId, lecturaUserId]) {
    for (const moduleKey of ["reuniones", "dashboard", "personas"]) await db.insertInto("user_modules").values({ user_id: u, module_key: moduleKey, granted_by: master.id } as never).execute();
  }
  areaA = actorOf(areaAUserId, "ADMIN", new Set<string>(ROLE_PERMISSIONS.ADMIN));
  areaB = actorOf(b, "ADMIN", new Set<string>(ROLE_PERMISSIONS.ADMIN));
  lectura = actorOf(lecturaUserId, "LECTURA", new Set<string>(ROLE_PERMISSIONS.LECTURA));
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

async function person(extra: Record<string, unknown> = {}, org = orgA) {
  const db = await getDb();
  seq += 1;
  const dni = `5${String(seq).padStart(7, "0")}`;
  const row = await db.insertInto("people").values({ first_name: `Nombre${seq}`, last_name: `Apellido${String(seq).padStart(3, "0")}`, dni, organization_id: org, origin: "manual", ...extra } as never).returning("id").executeTakeFirstOrThrow();
  return { id: row.id, dni, lastName: `Apellido${String(seq).padStart(3, "0")}` };
}
/** La persona responde el formulario (queda inscripta) ... */
async function respond(slug: string, p: { dni: string }) {
  const r = await submitForm(slug, { first_name: "X", last_name: "Y", dni: p.dni, email: "", phone: "" }, randomUUID(), nextIp(), "agent");
  expect(r.kind).toBe("ok");
}
/** ... y la fecha pasa a «en curso» para poder escanear. */
async function startMeeting(meetingId: string, allowUninvited = false) {
  const db = await getDb();
  await db.updateTable("meetings").set({ status: "in_progress", starts_at: new Date(Date.now() - 600_000), ends_at: new Date(Date.now() + 3_600_000), allow_uninvited_checkin: allowUninvited } as never).where("id", "=", meetingId).execute();
}
async function scan(meetingId: string, p: { dni: string; lastName: string }) {
  const idf = await identifyForCheckin(meetingId, p.dni, p.lastName, nextIp());
  if (idf.kind !== "need_confirmation") throw new Error(`identificación: ${idf.kind}`);
  expect((await confirmCheckin(idf.confirmToken, nextIp(), "ua")).kind).toBe("ok");
}

describe("1f · reunión de un día: esperados, asistieron y ausentes", () => {
  it("cuenta cada grupo y el %, con los inscriptos por formulario y el que asistió sin inscripción", async () => {
    const act = await createActivity(areaA, { kind: "single", name: "Informe de un día", ownerOrganizationId: orgA, dates: [date(3)] });
    const m = act.meetings[0]!.id;
    const [fue1, fue2, falto1, falto2, sinInscripcion] = [await person(), await person(), await person(), await person(), await person()];
    for (const p of [fue1, fue2, falto1, falto2]) await respond(act.form.slug, p);
    await startMeeting(m, true);
    await scan(m, fue1);
    await scan(m, fue2);
    await scan(m, sinInscripcion); // no estaba inscripta: el check-in sin invitación lo permite

    const r = (await getAttendanceReport(areaA, "reunion", act.meetings[0]!.id))!;
    expect(r.dates).toHaveLength(1);
    expect(r.dates[0]).toMatchObject({ number: 1, expected: 4, attended: 3, absent: 2, walkIns: 1, attendanceRate: 50 });
    expect(r.totals).toMatchObject({ expectedPeople: 4, expectedAttendedAny: 2, expectedNeverAttended: 2, walkInPeople: 1, unlinkedResponses: 0 });

    const byId = new Map(r.rows.map((row) => [row.personId, row]));
    expect(r.totalRows).toBe(5);
    expect(byId.get(fue1.id)!.cells[m]).toBe("attended");
    expect(byId.get(falto1.id)!.cells[m]).toBe("absent");
    expect(byId.get(sinInscripcion.id)!.cells[m]).toBe("walk_in");
  });

  it("las respuestas sin vincular se informan aparte y nunca cuentan como esperadas", async () => {
    const act = await createActivity(areaA, { kind: "single", name: "Sin vincular", ownerOrganizationId: orgA, dates: [date(3)] });
    await respond(act.form.slug, { dni: "99999991" }); // nadie con ese DNI: queda sin vincular
    const r = (await getAttendanceReport(areaA, "reunion", act.meetings[0]!.id))!;
    expect(r.totals.unlinkedResponses).toBe(1);
    expect(r.dates[0]!.expected).toBe(0);
    expect(r.dates[0]!.attendanceRate).toBeNull();
  });

  it("revocar una asistencia la vuelve ausente; restaurarla la devuelve", async () => {
    const act = await createActivity(areaA, { kind: "single", name: "Revocar informe", ownerOrganizationId: orgA, dates: [date(3)] });
    const m = act.meetings[0]!.id;
    const p = await person();
    await respond(act.form.slug, p);
    await startMeeting(m);
    await scan(m, p);
    const cell = async () => (await getAttendanceReport(areaA, "reunion", m))!.rows.find((x) => x.personId === p.id)!.cells[m];
    expect(await cell()).toBe("attended");
    await att.revokeAttendance(areaA, { meetingId: m, personId: p.id, reason: "error de escaneo" });
    expect(await cell()).toBe("absent");
    await att.restoreAttendance(areaA, { meetingId: m, personId: p.id, reason: "era correcta" });
    expect(await cell()).toBe("attended");
  });

  it("una inscripción anulada deja de ser esperada", async () => {
    const act = await createActivity(areaA, { kind: "single", name: "Anulada informe", ownerOrganizationId: orgA, dates: [date(3)] });
    const m = act.meetings[0]!.id;
    const p = await person();
    await respond(act.form.slug, p);
    const db = await getDb();
    const row = await db.selectFrom("meeting_participations").select("id").where("meeting_id", "=", m).where("person_id", "=", p.id).executeTakeFirstOrThrow();
    expect((await getAttendanceReport(areaA, "reunion", m))!.dates[0]!.expected).toBe(1);
    await reg.voidEnrollment(areaA, { participationId: row.id, reason: "se anotó por error" });
    expect((await getAttendanceReport(areaA, "reunion", m))!.dates[0]!.expected).toBe(0);
  });
});

describe("1f · campaña: matriz persona × fecha", () => {
  it("resumen por fecha, totales por persona distinta y «asistió a X de N»", async () => {
    const act = await createActivity(areaA, { kind: "campaign", name: "Informe campaña", ownerOrganizationId: orgA, dates: [date(2), date(4), date(6)] });
    const [d1, d2, d3] = act.meetings.map((m) => m.id) as [string, string, string];
    const [todas, algunas, ninguna] = [await person(), await person(), await person()];
    for (const p of [todas, algunas, ninguna]) await respond(act.form.slug, p);
    for (const m of [d1, d2, d3]) await startMeeting(m);
    for (const m of [d1, d2, d3]) await scan(m, todas);
    await scan(d1, algunas);
    await scan(d3, algunas);

    const r = (await getAttendanceReport(areaA, "campana", act.campaignId!))!;
    expect(r.dates.map((d) => [d.expected, d.expected - d.absent, d.absent])).toEqual([[3, 2, 1], [3, 1, 2], [3, 2, 1]]);
    expect(r.totals).toMatchObject({ expectedPeople: 3, expectedAttendedAny: 2, expectedNeverAttended: 1, attendedAllDates: 1, walkInPeople: 0 });
    const row = (p: { id: string }) => r.rows.find((x) => x.personId === p.id)!;
    expect(row(todas)).toMatchObject({ attendedCount: 3, expectedCount: 3 });
    expect(row(algunas)).toMatchObject({ attendedCount: 2, expectedCount: 3 });
    expect(row(algunas).cells).toEqual({ [d1]: "attended", [d2]: "absent", [d3]: "attended" });
    expect(row(ninguna)).toMatchObject({ attendedCount: 0, expectedCount: 3 });
  });

  it("filtros (ausentes / asistieron), búsqueda y paginación", async () => {
    const act = await createActivity(areaA, { kind: "campaign", name: "Filtros informe", ownerOrganizationId: orgA, dates: [date(2), date(3)] });
    const [d1] = act.meetings.map((m) => m.id) as [string, string];
    const people = [await person(), await person(), await person()];
    for (const p of people) await respond(act.form.slug, p);
    await startMeeting(d1);
    await scan(d1, people[0]!);
    const r = (opts: object) => getAttendanceReport(areaA, "campana", act.campaignId!, opts as never);
    expect((await r({ filter: "attended" }))!.rows.map((x) => x.personId)).toEqual([people[0]!.id]);
    expect((await r({ filter: "absent" }))!.totalRows).toBe(3); // todos faltaron a la fecha 2 (y dos a la 1)
    expect((await r({ search: people[1]!.dni }))!.rows.map((x) => x.personId)).toEqual([people[1]!.id]);
    expect((await r({ search: "Apellido" }))!.totalRows).toBeGreaterThanOrEqual(3);
    const page1 = (await r({ pageSize: 2, page: 1 }))!;
    const page2 = (await r({ pageSize: 2, page: 2 }))!;
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(1);
    expect(new Set([...page1.rows, ...page2.rows].map((x) => x.personId)).size).toBe(3);
  });
});

describe("1f · alcance y datos sensibles", () => {
  it("otra área no ve la actividad (null); quien la ve solo cuenta a su gente; el DNI sale enmascarado sin people.view_sensitive", async () => {
    const act = await createActivity(areaA, { kind: "single", name: "Alcance informe", ownerOrganizationId: orgA, dates: [date(3)] });
    const m = act.meetings[0]!.id;
    const mine = await person();
    const other = await person({}, orgB); // persona de OTRA unidad inscripta por un operador con alcance global
    await respond(act.form.slug, mine);
    await reg.enrollPerson(master, { meetingId: m, personId: other.id, channel: "email", when: { kind: "now" } } as never);

    const asArea = (await getAttendanceReport(areaA, "reunion", m))!;
    const asMaster = (await getAttendanceReport(master, "reunion", m))!;
    // otra área: mientras no tenga participantes propios, la actividad ni existe para ella; con uno propio la ve, pero solo cuenta a los suyos
    const outsider = await createActivity(areaA, { kind: "single", name: "Solo del área A", ownerOrganizationId: orgA, dates: [date(4)] });
    expect(await getAttendanceReport(areaB, "reunion", outsider.meetings[0]!.id)).toBeNull();
    const asOtherArea = (await getAttendanceReport(areaB, "reunion", m))!;
    expect(asOtherArea.rows.map((r) => r.personId)).toEqual([other.id]);
    expect(asOtherArea.dates[0]!.expected).toBe(1);
    expect(asMaster.dates[0]!.expected).toBe(2);
    expect(asArea.dates[0]!.expected).toBe(1);
    expect(asArea.rows.map((r) => r.personId)).toEqual([mine.id]);
    // areaA es ADMIN (con view_sensitive); LECTURA no
    expect(asArea.rows[0]!.dni).toBe(mine.dni);
    const asReader = (await getAttendanceReport(lectura, "reunion", m))!;
    expect(asReader.rows[0]!.dni).not.toBe(mine.dni);
    expect(asReader.rows[0]!.dni).toMatch(/\*/);
  });
});

describe("1f · trazabilidad por persona", () => {
  it("cuenta la historia completa en orden: respuesta, inscripción, asistencia, interacción, y las correcciones con su motivo", async () => {
    const act = await createActivity(areaA, { kind: "single", name: "Historial informe", ownerOrganizationId: orgA, dates: [date(3)] });
    const m = act.meetings[0]!.id;
    const p = await person();
    await respond(act.form.slug, p);
    await startMeeting(m);
    await scan(m, p);
    await att.revokeAttendance(areaA, { meetingId: m, personId: p.id, reason: "se escaneó por error" });
    // mientras está revocada, la interacción figura como anulada
    const whileRevoked = (await getPersonActivityTimeline(areaA, "reunion", m, p.id))!;
    expect(whileRevoked.entries.map((e) => e.label)).toContain("La interacción «Asistió a…» se anuló");
    await att.restoreAttendance(areaA, { meetingId: m, personId: p.id, reason: "era correcta" });

    const t = (await getPersonActivityTimeline(areaA, "reunion", m, p.id))!;
    const labels = t.entries.map((e) => e.label);
    expect(labels).toEqual(expect.arrayContaining([
      "La respuesta al formulario se vinculó con la persona",
      "Quedó inscripta automáticamente al responder el formulario",
      "Inscripción registrada (desde el formulario)",
      "Asistencia registrada por QR",
      "Se registró «Asistió a…» en la ficha de la persona",
      "Asistencia revocada",
      "Asistencia restaurada",
    ]));
    // orden cronológico y actor correcto
    const times = t.entries.map((e) => e.at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(t.entries.find((e) => e.label === "Asistencia registrada por QR")!.actor).toBe("La propia persona");
    expect(t.entries.find((e) => e.label === "Quedó inscripta automáticamente al responder el formulario")!.actor).toBe("El sistema (formulario)");
    expect(t.entries.find((e) => e.label === "Asistencia revocada")).toMatchObject({ reason: "se escaneó por error", source: "asistencia" });
    // restaurada: la interacción volvió a estar activa, así que ya no figura como anulada
    expect(labels).not.toContain("La interacción «Asistió a…» se anuló");
  });

  it("una persona o actividad fuera del alcance devuelve null", async () => {
    const act = await createActivity(areaA, { kind: "single", name: "Historial alcance", ownerOrganizationId: orgA, dates: [date(3)] });
    const m = act.meetings[0]!.id;
    const p = await person();
    expect(await getPersonActivityTimeline(areaB, "reunion", m, p.id)).toBeNull();
    const otherUnit = await person({}, orgB);
    expect(await getPersonActivityTimeline(areaA, "reunion", m, otherUnit.id)).toBeNull();
    expect(await getPersonActivityTimeline(areaA, "reunion", m, "no-es-uuid")).toBeNull();
  });
});

describe("1f · exportación CSV", () => {
  it("una fila por persona y una columna por fecha, con BOM, sin inyección de fórmulas y con el alcance", async () => {
    const act = await createActivity(areaA, { kind: "campaign", name: "CSV informe", ownerOrganizationId: orgA, dates: [date(2), date(3)] });
    const [d1] = act.meetings.map((m) => m.id) as [string, string];
    const peligrosa = await person({ first_name: "=HYPERLINK(\"http://x\")", last_name: "Peligrosa" });
    const normal = await person();
    for (const p of [peligrosa, normal]) await respond(act.form.slug, p);
    await startMeeting(d1);
    await scan(d1, normal);

    const csv = await exportAttendanceCsv(areaA, "campana", act.campaignId!);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    // sanitizeCsvCell entrecomilla cada celda (y neutraliza las fórmulas)
    expect(lines[0]).toBe('"Apellido","Nombre","DNI","Unidad","Fecha 1","Fecha 2","Asistió a","Esperada en"');
    expect(lines).toHaveLength(3);
    const normalLine = lines.find((l) => l.includes(normal.lastName))!;
    expect(normalLine).toContain("Asistió");
    expect(normalLine).toContain("1 de 2");
    expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/);
    await expect(exportAttendanceCsv(lectura, "campana", act.campaignId!)).rejects.toThrow(/permiso/i);
    await expect(exportAttendanceCsv(areaB, "campana", act.campaignId!)).rejects.toThrow(/no existe/);
  });

  it("la ruta: 401 sin sesión, 403 sin permiso, 404 fuera de alcance, 200 con el CSV", async () => {
    const act = await createActivity(areaA, { kind: "single", name: "Ruta CSV", ownerOrganizationId: orgA, dates: [date(3)] });
    const m = act.meetings[0]!.id;
    const call = (kind: string, id: string) => exportRoute(new NextRequest("https://crm.test/x"), { params: Promise.resolve({ kind, id }) });
    currentToken = undefined;
    expect((await call("reunion", m)).status).toBe(401);
    currentToken = (await createSession(lecturaUserId)).token;
    expect((await call("reunion", m)).status).toBe(403);
    currentToken = (await createSession(areaAUserId)).token;
    expect((await call("otra-cosa", m)).status).toBe(404);
    expect((await call("reunion", randomUUID())).status).toBe(404);
    const ok = await call("reunion", m);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/csv");
    expect(ok.headers.get("content-disposition")).toContain("attachment");
    currentToken = undefined;
  });
});
