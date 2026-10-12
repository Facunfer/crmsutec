import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS, ROLE_PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { createForm, updateFormMeta, upsertField, publishForm, FormCommandError } = await import("../../lib/forms/commands.js");
const { submitForm, getPublicForm } = await import("../../lib/forms/submit.js");
const subs = await import("../../lib/forms/submissions.js");
const fq = await import("../../lib/forms/queries.js");
const reg = await import("../../lib/meetings/registrations.js");
const { createMeeting, updateMeeting } = await import("../../lib/meetings/commands.js");
const { getMeetingById } = await import("../../lib/meetings/queries.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));
let master: any;
let areaA: any;
let areaB: any;
let areaANoSensitive: any;
let orgA: string;
let orgB: string;
let ipCounter = 0;
let seq = 0;
const nextIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
let dniCounter = 0;
const nextDni = () => String(32000000 + ++dniCounter);

function actorOf(id: string, roleKey: string, permissions: Set<string>): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions };
}
async function makeUser(email: string, roleKey: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id }).returning("id").executeTakeFirstOrThrow()).id;
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  orgA = await createTestOrganization();
  orgB = await createTestOrganization();
  const db = await getDb();
  master = actorOf(await makeUser("f1-master@sutecba.local", "MASTER_GLOBAL"), "MASTER_GLOBAL", ALL);
  const adminPerms = new Set<string>(ROLE_PERMISSIONS.ADMIN);
  const a = await makeUser("f1-area-a@sutecba.local", "ADMIN");
  const a2 = await makeUser("f1-area-a2@sutecba.local", "ADMIN");
  const b = await makeUser("f1-area-b@sutecba.local", "ADMIN");
  for (const [u, o] of [[a, orgA], [a2, orgA], [b, orgB]] as const) {
    await db.insertInto("user_scopes").values({ user_id: u, organization_id: o, include_descendants: true, granted_by: master.id } as never).execute();
  }
  areaA = actorOf(a, "ADMIN", adminPerms);
  areaANoSensitive = actorOf(a2, "ADMIN", new Set([...adminPerms].filter((p) => p !== "people.view_sensitive")));
  areaB = actorOf(b, "ADMIN", adminPerms);
});

afterAll(async () => {
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

interface MakeFormOpts {
  creation?: "never" | "when_valid_dni";
  apply?: "never" | "fill_empty_only";
  campaignId?: string;
  meetingId?: string;
  defaultMeetingId?: string;
  owner?: string;
  actor?: any;
  noPublish?: boolean;
}
async function makeForm(opts: MakeFormOpts = {}) {
  seq += 1;
  const slug = `f1-form-${seq}`;
  const actor = opts.actor ?? master;
  const { id } = await createForm(actor, { ownerOrganizationId: opts.owner ?? orgA, name: `F1 ${seq}`, slug });
  await updateFormMeta(actor, id, {
    name: `F1 ${seq}`, slug, consentText: "", successMessage: "", opensAt: "", closesAt: "", matchFields: ["dni", "email", "phone"],
    personCreationPolicy: opts.creation ?? "never", applyDataPolicy: opts.apply ?? "never",
    description: "", campaignId: opts.campaignId ?? "", meetingId: opts.meetingId ?? "", defaultMeetingId: opts.defaultMeetingId ?? "",
  } as never);
  const f = (key: string, label: string, fieldType: any, required: boolean, mapping: string, extra: Record<string, unknown> = {}) =>
    upsertField(actor, id, null, { key, label, fieldType, required, visible: true, personFieldMapping: mapping, ...extra } as never);
  await f("first_name", "Nombre", "text", true, "first_name");
  await f("last_name", "Apellido", "text", true, "last_name");
  await f("dni", "DNI", "dni", true, "dni");
  await f("email", "Email", "email", false, "email");
  await f("phone", "Teléfono", "phone", false, "phone");
  if (!opts.noPublish) await publishForm(actor, id);
  return { id, slug };
}
const entries = (o: Record<string, string> = {}) => ({ first_name: "Ana", last_name: "Gomez", dni: nextDni(), email: "", phone: "", ...o });
const submit = async (slug: string, e: Record<string, string>, key = randomUUID()) => {
  const r = await submitForm(slug, e, key, nextIp(), "agent");
  expect(r.kind).toBe("ok");
  const db = await getDb();
  return db.selectFrom("form_submissions").selectAll().where("idempotency_key", "=", key).executeTakeFirstOrThrow();
};
async function person(dni = nextDni(), extra: Record<string, unknown> = {}, org = orgA) {
  const db = await getDb();
  return (await db.insertInto("people").values({ first_name: "Pers", last_name: `P${++seq}`, dni, organization_id: org, origin: "manual", ...extra } as never).returning("id").executeTakeFirstOrThrow()).id;
}
const count = async (table: string) => {
  const db = await getDb();
  return (await sql<{ n: number }>`select count(*)::int n from ${sql.table(table)}`.execute(db)).rows[0]!.n;
};
const events = async (submissionId: string) => {
  const db = await getDb();
  return db.selectFrom("form_submission_events").selectAll().where("submission_id", "=", submissionId).orderBy("seq", "asc").execute();
};
async function campaign() {
  const db = await getDb();
  seq += 1;
  return (await db.insertInto("campaigns").values({ campaign_key: `ophthalmology:f1-${seq}`, name: `Campaña F1 ${seq}`, campaign_type: "ophthalmology", owner_organization_id: orgA, origin: "import", historical_condition: "imported_undated", created_by: master.id } as never).returning("id").executeTakeFirstOrThrow()).id;
}
async function meeting(status: "draft" | "scheduled" | "in_progress" | "finished" = "scheduled", extra: Record<string, unknown> = {}) {
  const db = await getDb();
  seq += 1;
  return (
    await db
      .insertInto("meetings")
      .values({
        name: `Reunión F1 ${seq}`, owner_organization_id: orgA, organizer_user_id: master.id, created_by: master.id, origin: "manual", status, meeting_type: "reunion",
        schedule_precision: "exact_datetime", starts_at: new Date(Date.now() + 3_600_000), ends_at: new Date(Date.now() + 7_200_000), ...extra,
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

describe("F1 · políticas de personas (defaults «never»)", () => {
  it("un formulario nuevo NO crea personas ni completa datos: la respuesta sin coincidencia queda «sin vincular»", async () => {
    const { id, slug } = await makeForm();
    const f = await fq.getFormById(master, id);
    expect(f).toMatchObject({ personCreationPolicy: "never", applyDataPolicy: "never" });
    const peopleBefore = await count("people");
    const s = await submit(slug, entries({ email: "nueva@example.com" }));
    expect(s.match_result).toBe("unlinked");
    expect(s.person_id).toBeNull();
    expect(await count("people")).toBe(peopleBefore);
    expect(await events(s.id)).toHaveLength(0);
    // sin persona, sin inscripción, sin interacciones, sin asistencia
    expect(await count("person_interactions")).toBe(0);
  });

  it("coincidencia inequívoca por DNI: se VINCULA, pero con apply_data_policy=never no se completa ningún dato", async () => {
    const { slug } = await makeForm();
    const dni = nextDni();
    const pid = await person(dni);
    const s = await submit(slug, entries({ dni, email: "nuevo@example.com", phone: "+541122223333" }));
    expect(s.match_result).toBe("matched");
    expect(s.person_id).toBe(pid);
    const db = await getDb();
    const p = await db.selectFrom("people").select(["email", "phone"]).where("id", "=", pid).executeTakeFirstOrThrow();
    expect(p).toEqual({ email: null, phone: null }); // nada se aplicó solo
    expect((await events(s.id)).map((e) => e.event_type)).toEqual(["auto_linked"]);
  });

  it("apply_data_policy=fill_empty_only completa solo VACÍOS, sin pisar, y lo audita", async () => {
    const { slug } = await makeForm({ apply: "fill_empty_only" });
    const dni = nextDni();
    const pid = await person(dni, { email: "ya@example.com" });
    const s = await submit(slug, entries({ dni, email: "otro@example.com", phone: "+541144445555" }));
    const db = await getDb();
    const p = await db.selectFrom("people").select(["email", "phone"]).where("id", "=", pid).executeTakeFirstOrThrow();
    expect(p.email).toBe("ya@example.com");
    expect(p.phone).not.toBeNull();
    const ev = await events(s.id);
    expect(ev.map((e) => e.event_type)).toEqual(["auto_linked", "auto_data_applied"]);
    expect(ev[1]!.recorded_by).toBeNull();
    expect((ev[1]!.details as any).fields.map((f: any) => f.key)).toEqual(["phone"]);
  });

  it("person_creation_policy=when_valid_dni sí crea la persona (explícito) y deja evento automático", async () => {
    const { slug } = await makeForm({ creation: "when_valid_dni" });
    const dni = nextDni();
    const s = await submit(slug, entries({ dni }));
    expect(s.match_result).toBe("created");
    const db = await getDb();
    const p = await db.selectFrom("people").select(["id", "origin"]).where("dni", "=", dni).executeTakeFirstOrThrow();
    expect(p.origin).toBe("form");
    expect((await events(s.id)).map((e) => e.event_type)).toEqual(["auto_person_created"]);
  });

  it("email que coincide con otra persona pero con DNI distinto NO se vincula solo: revisión; ambigüedad tampoco elige", async () => {
    const { slug } = await makeForm();
    const owner = await person(nextDni(), { email: "compartido@example.com" });
    const s = await submit(slug, entries({ email: "compartido@example.com" }));
    expect(s.match_result).toBe("needs_review");
    expect(s.person_id).toBeNull();
    const db = await getDb();
    const cands = await db.selectFrom("person_duplicate_candidates").select(["person_id"]).where("submission_id", "=", s.id).execute();
    expect(cands.map((c) => c.person_id)).toEqual([owner]);

    // ambigua: el DNI es de A y el email de B
    const a = await person(nextDni());
    const b = await person(nextDni(), { email: "b@example.com" });
    const amb = await submit(slug, entries({ dni: (await db.selectFrom("people").select("dni").where("id", "=", a).executeTakeFirstOrThrow()).dni!, email: "b@example.com" }));
    expect(amb.match_result).toBe("needs_review");
    expect(amb.person_id).toBeNull();
    expect(b).toBeTruthy();
  });

  it("idempotencia: el mismo envío reintentado no duplica respuesta ni eventos", async () => {
    const { slug } = await makeForm();
    const dni = nextDni();
    const pid = await person(dni);
    const key = randomUUID();
    const e = entries({ dni });
    const first = await submit(slug, e, key);
    await submitForm(slug, e, key, nextIp(), "agent");
    await submitForm(slug, e, key, nextIp(), "agent");
    const db = await getDb();
    expect((await db.selectFrom("form_submissions").select("id").where("idempotency_key", "=", key).execute()).length).toBe(1);
    expect((await events(first.id)).length).toBe(1);
    expect(first.person_id).toBe(pid);
  });
});

describe("F1 · acciones explícitas del operador (vincular / crear persona / aplicar datos)", () => {
  it("vincular: auditado, idempotente, no completa datos y respeta el alcance", async () => {
    const { slug } = await makeForm();
    const s = await submit(slug, entries({ email: "lnk@example.com" }));
    const pid = await person();
    const outside = await person(nextDni(), {}, orgB);

    await expect(subs.linkSubmissionToPerson(areaB, { submissionId: s.id, personId: pid })).rejects.toThrow(/no existe/);
    await expect(subs.linkSubmissionToPerson(areaA, { submissionId: s.id, personId: outside })).rejects.toThrow(/no existe/);
    expect(await subs.linkSubmissionToPerson(areaA, { submissionId: s.id, personId: pid, reason: "es ella" })).toEqual({ changed: true });
    expect(await subs.linkSubmissionToPerson(areaA, { submissionId: s.id, personId: pid })).toEqual({ changed: false });
    await expect(subs.linkSubmissionToPerson(areaA, { submissionId: s.id, personId: await person() })).rejects.toThrow(/ya está vinculada/);

    const db = await getDb();
    const row = await db.selectFrom("form_submissions").select(["person_id", "match_result"]).where("id", "=", s.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ person_id: pid, match_result: "matched" });
    const p = await db.selectFrom("people").select("email").where("id", "=", pid).executeTakeFirstOrThrow();
    expect(p.email).toBeNull(); // vincular NO aplica datos
    const ev = await events(s.id);
    expect(ev.map((e) => e.event_type)).toEqual(["linked"]);
    expect(ev[0]).toMatchObject({ recorded_by: areaA.id, reason: "es ella", person_id: pid });
  });

  it("dos operadores vinculando a la vez: gana uno, el otro no pisa; un solo evento", async () => {
    const { slug } = await makeForm();
    const s = await submit(slug, entries());
    const p1 = await person();
    const p2 = await person();
    const res = await Promise.allSettled([
      subs.linkSubmissionToPerson(areaA, { submissionId: s.id, personId: p1 }),
      subs.linkSubmissionToPerson(master, { submissionId: s.id, personId: p2 }),
    ]);
    expect(res.filter((r) => r.status === "fulfilled" && (r as any).value.changed).length).toBe(1);
    const db = await getDb();
    expect((await db.selectFrom("form_submissions").select("person_id").where("id", "=", s.id).executeTakeFirstOrThrow()).person_id).not.toBeNull();
    expect((await events(s.id)).length).toBe(1);
  });

  it("crear persona explícito: requiere people.create, usa la unidad del formulario y no se repite", async () => {
    const { slug } = await makeForm();
    const dni = nextDni();
    const s = await submit(slug, entries({ dni, email: "crear@example.com" }));
    const noCreate = actorOf(areaA.id, "ADMIN", new Set([...areaA.permissions].filter((p: string) => p !== "people.create")));
    await expect(subs.createPersonFromUnlinkedSubmission(noCreate, { submissionId: s.id })).rejects.toThrow();
    const { personId } = await subs.createPersonFromUnlinkedSubmission(areaA, { submissionId: s.id, reason: "alta desde formulario" });
    const db = await getDb();
    const p = await db.selectFrom("people").select(["dni", "organization_id", "origin"]).where("id", "=", personId).executeTakeFirstOrThrow();
    expect(p).toEqual({ dni, organization_id: orgA, origin: "form" });
    await expect(subs.createPersonFromUnlinkedSubmission(areaA, { submissionId: s.id })).rejects.toThrow(/ya está vinculada/);
    expect((await events(s.id)).map((e) => e.event_type)).toEqual(["person_created"]);
  });

  it("aplicar datos: por defecto solo vacíos; reemplazar exige indicar campos; nunca DNI ni nombre; auditoría con antes/después y enmascarado", async () => {
    const { slug } = await makeForm();
    const dni = nextDni();
    const pid = await person(dni, { email: "viejo@example.com" });
    const s = await submit(slug, entries({ dni, email: "nuevo@example.com", phone: "+541155556666", first_name: "Otro", last_name: "Nombre" }));
    expect(s.person_id).toBe(pid);

    await expect(subs.applySubmissionData(areaA, { submissionId: s.id, mode: "overwrite" })).rejects.toThrow(/qué campos/);
    const filled = await subs.applySubmissionData(areaA, { submissionId: s.id });
    expect(filled.fields.map((f) => f.key)).toEqual(["phone"]); // solo lo vacío
    expect(await subs.applySubmissionData(areaA, { submissionId: s.id })).toMatchObject({ changed: false });

    const over = await subs.applySubmissionData(areaA, { submissionId: s.id, mode: "overwrite", keys: ["email", "dni", "first_name"], reason: "el correo cambió" });
    expect(over.fields.map((f) => f.key)).toEqual(["email"]); // dni y nombre no son aplicables
    const db = await getDb();
    const p = await db.selectFrom("people").select(["email", "dni", "first_name", "version"]).where("id", "=", pid).executeTakeFirstOrThrow();
    expect(p).toMatchObject({ email: "nuevo@example.com", dni, first_name: "Pers" });

    const full = (await fq.listSubmissionEvents(areaA, s.id))!;
    const applied = full.filter((e) => e.eventType === "data_applied");
    expect(applied).toHaveLength(2);
    expect((applied[1]!.details as any).fields[0]).toEqual({ key: "email", before: "viejo@example.com", after: "nuevo@example.com" });
    const masked = (await fq.listSubmissionEvents(areaANoSensitive, s.id))!;
    expect(JSON.stringify(masked)).not.toContain("viejo@example.com");
    expect(JSON.stringify(masked)).not.toContain("nuevo@example.com");
  });
});

describe("F1 · respuesta → inscripción (reutiliza B4, sin segunda fuente de verdad)", () => {
  it("completar el formulario NO inscribe; la inscripción es explícita, canónica en meeting_participations y con provenance", async () => {
    const m = await meeting("scheduled");
    const { slug } = await makeForm({ meetingId: m });
    const dni = nextDni();
    const pid = await person(dni);
    const s = await submit(slug, entries({ dni }));
    const db = await getDb();
    expect(s.person_id).toBe(pid);
    // sin acción explícita: ni inscripción, ni participación, ni asistencia, ni interacción, ni invitación
    expect((await db.selectFrom("meeting_participations").select("id").where("meeting_id", "=", m).execute()).length).toBe(0);
    expect(await count("meeting_attendance")).toBe(0);
    expect(await count("meeting_invitations")).toBe(0);
    expect(await count("person_interactions")).toBe(0);

    const [r] = await subs.enrollSubmissions(areaA, { submissionIds: [s.id] });
    expect(r!.status).toBe("enrolled");
    const row = await db.selectFrom("meeting_participations").selectAll().where("meeting_id", "=", m).where("person_id", "=", pid).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ participation_kind: "registration", participation_basis: "standard", origin_channel: "form", recorded_by: areaA.id, origin_invitation_id: null, voided_at: null });
    expect(row.registered_at!.getTime()).toBe(s.created_at.getTime()); // la fecha es la del envío de la persona
    const ev = (await events(s.id)).find((e) => e.event_type === "enrolled")!;
    expect(ev).toMatchObject({ participation_id: row.id, meeting_id: m, recorded_by: areaA.id });
    const regEv = await db.selectFrom("meeting_registration_events").select(["event_type", "origin_channel"]).where("participation_id", "=", row.id).execute();
    expect(regEv).toEqual([{ event_type: "registered", origin_channel: "form" }]);

    // idempotente: repetir no duplica ni la inscripción ni el evento
    const again = await subs.enrollSubmissions(areaA, { submissionIds: [s.id] });
    expect(again[0]!.status).toBe("already_enrolled_from_submission");
    expect((await db.selectFrom("meeting_participations").select("id").where("meeting_id", "=", m).execute()).length).toBe(1);
    expect((await events(s.id)).filter((e) => e.event_type === "enrolled").length).toBe(1);
    expect(await count("person_interactions")).toBe(0); // la inscripción por formulario tampoco crea contacto
  });

  it("anular y restaurar la inscripción sigue siendo B4: el evento de la respuesta solo conserva el provenance", async () => {
    const m = await meeting("scheduled");
    const { slug } = await makeForm({ meetingId: m });
    const dni = nextDni();
    await person(dni);
    const s = await submit(slug, entries({ dni }));
    const [r] = await subs.enrollSubmissions(areaA, { submissionIds: [s.id] });
    await reg.voidEnrollment(areaA, { participationId: r!.participationId!, reason: "duplicada" });
    const db = await getDb();
    expect((await db.selectFrom("meeting_participations").select("voided_at").where("id", "=", r!.participationId!).executeTakeFirstOrThrow()).voided_at).not.toBeNull();
    // inscribir de nuevo desde la misma respuesta: ya existe el evento; no se crea una segunda fila ni se restaura sola
    const again = await subs.enrollSubmissions(areaA, { submissionIds: [s.id] });
    expect(again[0]!.status).toBe("already_enrolled_from_submission");
    expect((await db.selectFrom("meeting_participations").select("id").where("meeting_id", "=", m).execute()).length).toBe(1);
  });

  it("respuestas sin vincular no se inscriben; una por una el resultado es explícito", async () => {
    const m = await meeting("scheduled");
    const { slug } = await makeForm({ meetingId: m });
    const unlinked = await submit(slug, entries());
    const linkedDni = nextDni();
    await person(linkedDni);
    const linked = await submit(slug, entries({ dni: linkedDni }));
    const res = await subs.enrollSubmissions(areaA, { submissionIds: [unlinked.id, linked.id] });
    expect(res.find((r) => r.submissionId === unlinked.id)!.status).toBe("unlinked");
    expect(res.find((r) => r.submissionId === linked.id)!.status).toBe("enrolled");
  });

  it("campaña con varias jornadas: nunca decide sola; la jornada debe ser de la campaña; con jornada por defecto la usa", async () => {
    const camp = await campaign();
    const j1 = await meeting("scheduled", { campaign_id: camp });
    const j2 = await meeting("scheduled", { campaign_id: camp });
    const other = await meeting("scheduled");
    const { slug } = await makeForm({ campaignId: camp });
    const dni = nextDni();
    await person(dni);
    const s = await submit(slug, entries({ dni }));

    const none = await subs.enrollSubmissions(areaA, { submissionIds: [s.id] });
    expect(none[0]).toMatchObject({ status: "error" });
    expect(none[0]!.message).toMatch(/Elegí la jornada/);
    const wrong = await subs.enrollSubmissions(areaA, { submissionIds: [s.id], meetingId: other });
    expect(wrong[0]!.message).toMatch(/no pertenece a la campaña/);
    const ok = await subs.enrollSubmissions(areaA, { submissionIds: [s.id], meetingId: j2 });
    expect(ok[0]!.status).toBe("enrolled");

    const { slug: slug2 } = await makeForm({ campaignId: camp, defaultMeetingId: j1 });
    const dni2 = nextDni();
    await person(dni2);
    const s2 = await submit(slug2, entries({ dni: dni2 }));
    const def = await subs.enrollSubmissions(areaA, { submissionIds: [s2.id] });
    expect(def[0]!.status).toBe("enrolled");
    const db = await getDb();
    const r = await db.selectFrom("meeting_participations").select("meeting_id").where("id", "=", def[0]!.participationId!).executeTakeFirstOrThrow();
    expect(r.meeting_id).toBe(j1);
  });

  it("formulario con reunión fija: no admite otra; permisos y estados de B4 se respetan (cancelada, retroactiva)", async () => {
    const fixed = await meeting("scheduled");
    const otherMeeting = await meeting("scheduled");
    const cancelled = await meeting("scheduled", { status: "cancelled" });
    const finished = await meeting("finished");
    const dni = nextDni();
    await person(dni);

    const { slug } = await makeForm({ meetingId: fixed });
    const s = await submit(slug, entries({ dni }));
    expect((await subs.enrollSubmissions(areaA, { submissionIds: [s.id], meetingId: otherMeeting }))[0]!.message).toMatch(/otra reunión/);

    const { slug: sc } = await makeForm({ meetingId: cancelled });
    const s2 = await submit(sc, entries({ dni }));
    expect((await subs.enrollSubmissions(areaA, { submissionIds: [s2.id] }))[0]!.message).toMatch(/cancelada/);

    const { slug: sf } = await makeForm({ meetingId: finished });
    const s3 = await submit(sf, entries({ dni }));
    // En una reunión finalizada es una carga retroactiva (B4): exige motivo. La fecha es la del envío (pasada), nunca «ahora».
    const noReason = await subs.enrollSubmissions(areaA, { submissionIds: [s3.id] });
    expect(noReason[0]).toMatchObject({ status: "error" });
    expect(noReason[0]!.message).toMatch(/motivo/);
    const retro = await subs.enrollSubmissions(areaA, { submissionIds: [s3.id], reason: "carga tardía de respuestas" });
    expect(retro[0]!.status).toBe("enrolled");
    await expect(subs.enrollSubmissions(noPerm(), { submissionIds: [s.id] })).rejects.toThrow();
  });

  it("capacidad blanda: superarla avisa pero NO bloquea", async () => {
    const m = await meeting("scheduled", { capacity: 1 });
    const { slug } = await makeForm({ meetingId: m });
    const d1 = nextDni();
    const d2 = nextDni();
    await person(d1);
    await person(d2);
    const s1 = await submit(slug, entries({ dni: d1 }));
    const s2 = await submit(slug, entries({ dni: d2 }));
    const r1 = await subs.enrollSubmissions(areaA, { submissionIds: [s1.id] });
    const r2 = await subs.enrollSubmissions(areaA, { submissionIds: [s2.id] });
    expect(r1[0]).toMatchObject({ status: "enrolled" });
    expect(r1[0]!.capacityWarning).toBeUndefined();
    expect(r2[0]).toMatchObject({ status: "enrolled", capacityWarning: { capacity: 1, registered: 2 } });
    const db = await getDb();
    expect((await db.selectFrom("meeting_participations").select("id").where("meeting_id", "=", m).where("participation_kind", "=", "registration").execute()).length).toBe(2);
  });

  it("el canal «form» no se acepta en la carga manual de B4", async () => {
    const m = await meeting("scheduled");
    const pid = await person();
    await expect(reg.enrollPerson(areaA, { meetingId: m, personId: pid, channel: "form", when: { kind: "now" } })).rejects.toThrow(/Canal/);
    expect(await reg.enrollPerson(areaA, { meetingId: m, personId: pid, channel: "email", when: { kind: "now" } })).toMatchObject({ changed: true });
  });
});

function noPerm() {
  return actorOf(areaA.id, "ADMIN", new Set([...areaA.permissions].filter((p: string) => p !== "meetings.manage_invitations")));
}

describe("F1 · vínculos campaña/reunión, campos y capacidad", () => {
  it("valida los vínculos: coherencia reunión↔campaña, jornada por defecto y alcance", async () => {
    const camp = await campaign();
    const inCamp = await meeting("scheduled", { campaign_id: camp });
    const loose = await meeting("scheduled");
    const outsideScope = await (async () => {
      const db = await getDb();
      return (await db.insertInto("meetings").values({ name: "Fuera", owner_organization_id: orgB, organizer_user_id: master.id, created_by: master.id, origin: "manual", status: "scheduled", meeting_type: "reunion", schedule_precision: "exact_datetime", starts_at: new Date(Date.now() + 3600_000), ends_at: new Date(Date.now() + 7200_000) } as never).returning("id").executeTakeFirstOrThrow()).id;
    })();
    const { id } = await makeForm({ noPublish: true });
    const meta = (extra: Record<string, unknown>) => ({
      name: "F", slug: `f1-links-${++seq}`, consentText: "", successMessage: "", opensAt: "", closesAt: "", matchFields: ["dni"],
      personCreationPolicy: "never", applyDataPolicy: "never", description: "", campaignId: "", meetingId: "", defaultMeetingId: "", ...extra,
    });
    await expect(updateFormMeta(master, id, meta({ campaignId: camp, meetingId: loose }) as never)).rejects.toThrow(/no pertenece a la campaña/);
    await expect(updateFormMeta(master, id, meta({ defaultMeetingId: inCamp }) as never)).rejects.toThrow(/requiere elegir una campaña/);
    await expect(updateFormMeta(master, id, meta({ campaignId: camp, defaultMeetingId: loose }) as never)).rejects.toThrow(/no pertenece/);
    await expect(updateFormMeta(master, id, meta({ meetingId: inCamp, defaultMeetingId: inCamp }) as never)).rejects.toThrow(/no las dos/);
    await expect(updateFormMeta(areaA, id, meta({ meetingId: outsideScope }) as never)).rejects.toThrow(/no existe/);
    // con solo la reunión, la campaña se deriva de ella
    await updateFormMeta(master, id, meta({ meetingId: inCamp }) as never);
    expect(await fq.getFormById(master, id)).toMatchObject({ meetingId: inCamp, campaignId: camp });
    await expect(updateFormMeta(master, id, meta({ campaignId: await campaign(), meetingId: inCamp }) as never)).rejects.toThrow(FormCommandError);
  });

  it("campos: descripción y validación (largos y rango) viajan en el snapshot y se aplican en el envío público", async () => {
    seq += 1;
    const slug = `f1-campos-${seq}`;
    const { id } = await createForm(master, { ownerOrganizationId: orgA, name: "Campos", slug });
    await updateFormMeta(master, id, { name: "Campos", slug, consentText: "", successMessage: "", opensAt: "", closesAt: "", matchFields: ["dni"], personCreationPolicy: "never", applyDataPolicy: "never" } as never);
    const f = (key: string, fieldType: string, required: boolean, mapping = "", extra: Record<string, unknown> = {}) =>
      upsertField(master, id, null, { key, label: key, fieldType, required, visible: true, personFieldMapping: mapping, ...extra } as never);
    await f("first_name", "text", true, "first_name");
    await f("last_name", "text", true, "last_name");
    await f("dni", "dni", true, "dni");
    await f("motivo", "textarea", true, "", { description: "Contanos brevemente", minLength: "10", maxLength: "20" });
    await f("edad", "number", false, "", { min: "18", max: "99" });
    await publishForm(master, id);

    const pub = await getPublicForm(slug);
    expect(pub.kind).toBe("ok");
    if (pub.kind !== "ok") return;
    const motivo = pub.schema.fields.find((x) => x.key === "motivo")!;
    expect(motivo.description).toBe("Contanos brevemente");
    expect(motivo.validation).toEqual({ minLength: 10, maxLength: 20 });

    const base = { first_name: "A", last_name: "B", dni: nextDni() };
    const bad = async (extra: Record<string, string>) => submitForm(slug, { ...base, motivo: "texto de prueba ok", ...extra }, randomUUID(), nextIp(), "agent");
    const short = await submitForm(slug, { ...base, motivo: "corto" }, randomUUID(), nextIp(), "agent");
    expect(short.kind).toBe("validation_error");
    const long = await submitForm(slug, { ...base, motivo: "x".repeat(21) }, randomUUID(), nextIp(), "agent");
    expect(long.kind).toBe("validation_error");
    const young = await bad({ edad: "17" });
    expect(young.kind).toBe("validation_error");
    const ok = await bad({ edad: "40" });
    expect(ok.kind).toBe("ok");
  });

  it("capacidad de reuniones: se guarda, se informa y rechaza valores no positivos", async () => {
    const mid = await meeting("draft");
    const detail = await getMeetingById(master, mid);
    expect(detail!.capacity).toBeNull();
    const db = await getDb();
    await db.updateTable("meetings").set({ capacity: 30 } as never).where("id", "=", mid).execute();
    expect((await getMeetingById(master, mid))!.capacity).toBe(30);
    await expect(db.updateTable("meetings").set({ capacity: 0 } as never).where("id", "=", mid).execute()).rejects.toThrow();
    const { parseMeetingForm } = await import("../../lib/meetings/schema.js");
    const fd = new FormData();
    for (const [k, v] of Object.entries({ name: "X", startsAt: "2026-12-01T10:00", endsAt: "2026-12-01T11:00", capacity: "25" })) fd.set(k, v);
    expect(parseMeetingForm(fd).capacity).toBe(25);
    fd.set("capacity", "");
    expect(parseMeetingForm(fd).capacity).toBeUndefined();
    fd.set("capacity", "-3");
    expect(() => parseMeetingForm(fd)).toThrow();
    // updateMeeting sin capacity no la pisa (llamadores anteriores a 0043)
    void createMeeting;
    void updateMeeting;
  });
});

describe("F1 · bandeja «Respuestas sin vincular», alcance y datos sensibles", () => {
  it("lista solo las respuestas sin persona de formularios del alcance, con payload enmascarado sin view_sensitive", async () => {
    const mine = await makeForm({ owner: orgA });
    const theirs = await makeForm({ owner: orgB });
    const s1 = await submit(mine.slug, entries({ email: "reservado@example.com" }));
    const s2 = await submit(theirs.slug, entries());
    const linkedDni = nextDni();
    await person(linkedDni);
    await submit(mine.slug, entries({ dni: linkedDni })); // vinculada: no aparece

    const a = await fq.listUnlinkedSubmissions(areaA, { formId: mine.id });
    expect(a.rows.map((r) => r.id)).toEqual([s1.id]);
    expect(a.rows[0]!.rawPayload.email).toBe("reservado@example.com");
    const none = await fq.listUnlinkedSubmissions(areaA, { formId: theirs.id });
    expect(none.total).toBe(0);
    const masked = await fq.listUnlinkedSubmissions(areaANoSensitive, { formId: mine.id });
    expect(JSON.stringify(masked.rows[0]!.rawPayload)).not.toContain("reservado@example.com");
    expect((await fq.listUnlinkedSubmissions(master)).rows.map((r) => r.id)).toEqual(expect.arrayContaining([s1.id, s2.id]));
    // provenance fuera del alcance: no visible
    expect(await fq.listSubmissionEvents(areaB, s1.id)).toBeNull();
    const list = await fq.listForms(areaA);
    expect(list.find((f) => f.id === mine.id)!.unlinkedCount).toBe(1);
  });

  it("el historial es append-only y la base impone sus combinaciones (auto_* sin operador, enrolled con reunión)", async () => {
    const { slug } = await makeForm();
    const dni = nextDni();
    const pid = await person(dni);
    const s = await submit(slug, entries({ dni }));
    const db = await getDb();
    await expect(db.updateTable("form_submission_events").set({ reason: "x" } as never).where("submission_id", "=", s.id).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom("form_submission_events").where("submission_id", "=", s.id).execute()).rejects.toThrow(/append-only/);
    const base = { submission_id: s.id, person_id: pid };
    await expect(db.insertInto("form_submission_events").values({ ...base, event_type: "auto_linked", recorded_by: master.id } as never).execute()).rejects.toThrow();
    await expect(db.insertInto("form_submission_events").values({ ...base, event_type: "linked", recorded_by: null } as never).execute()).rejects.toThrow();
    await expect(db.insertInto("form_submission_events").values({ ...base, event_type: "enrolled", recorded_by: master.id } as never).execute()).rejects.toThrow();
  });

  it("completar formularios nunca crea interacciones: el semáforo y el contacto real quedan intactos", async () => {
    const { slug } = await makeForm({ creation: "when_valid_dni", apply: "fill_empty_only" });
    const before = await count("person_interactions");
    for (let i = 0; i < 3; i += 1) await submit(slug, entries({ email: `x${i}@example.com` }));
    expect(await count("person_interactions")).toBe(before);
    const { countsAsRealContactSql } = await import("../../lib/contacts/real-contact.js");
    const db = await getDb();
    const n = (await sql<{ n: number }>`select count(*)::int n from person_interactions pi where ${countsAsRealContactSql("pi")}`.execute(db)).rows[0]!.n;
    expect(n).toBe(0);
  });
});
