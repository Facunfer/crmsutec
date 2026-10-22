import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

/**
 * Actividades unificadas, paso 1c — la respuesta al formulario INSCRIBE (según forms.enrollment_mode) cuando la persona queda vinculada sin
 * ambigüedad. Comportamiento real sobre PGlite. La inscripción es la canónica de B4 (`meeting_participations` + `meeting_registration_events`),
 * atribuida al usuario de sistema «Sistema (formularios)», con provenance `auto_enrolled` en la respuesta.
 */

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

// Permite simular que la inscripción FALLA: la respuesta pública igual debe registrarse y responder «ok».
const control = vi.hoisted(() => ({ failEnroll: false }));
vi.mock("../../lib/meetings/registrations.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/meetings/registrations.js")>();
  return {
    ...original,
    enrollFromFormAsSystem: (...args: Parameters<typeof original.enrollFromFormAsSystem>) => {
      if (control.failEnroll) throw new Error("fallo forzado al inscribir");
      return original.enrollFromFormAsSystem(...args);
    },
  };
});

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS, ROLE_PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { createActivity } = await import("../../lib/activities/create.js");
const { submitForm } = await import("../../lib/forms/submit.js");
const { FORM_SYSTEM_USER_EMAIL } = await import("../../lib/auth/system-users.js");
const subs = await import("../../lib/forms/submissions.js");
const reg = await import("../../lib/meetings/registrations.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));
let master: any;
let areaA: any;
let orgA: string;
let orgOther: string;
let ipCounter = 0;
let seq = 0;
let dniCounter = 0;
const nextIp = () => `10.60.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
const nextDni = () => String(35000000 + ++dniCounter);

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
  orgOther = await createTestOrganization();
  const db = await getDb();
  master = actorOf(await makeUser("enr-master@sutecba.local", "MASTER_GLOBAL"), "MASTER_GLOBAL", ALL);
  const a = await makeUser("enr-area-a@sutecba.local", "ADMIN");
  await db.insertInto("user_scopes").values({ user_id: a, organization_id: orgA, include_descendants: true, granted_by: master.id } as never).execute();
  areaA = actorOf(a, "ADMIN", new Set<string>(ROLE_PERMISSIONS.ADMIN));
});

afterAll(async () => {
  control.failEnroll = false;
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

async function single(form: Record<string, unknown> = {}) {
  seq += 1;
  return createActivity(areaA, { kind: "single", name: `Reunión enr ${seq}`, ownerOrganizationId: orgA, dates: [date(3)], form });
}
async function campaign(n = 3, form: Record<string, unknown> = {}) {
  seq += 1;
  return createActivity(areaA, { kind: "campaign", name: `Campaña enr ${seq}`, ownerOrganizationId: orgA, dates: Array.from({ length: n }, (_, i) => date(2 + i)), form });
}
async function person(dni = nextDni(), org = orgA, extra: Record<string, unknown> = {}) {
  const db = await getDb();
  seq += 1;
  return (await db.insertInto("people").values({ first_name: "Pers", last_name: `E${seq}`, dni, organization_id: org, origin: "manual", ...extra } as never).returning("id").executeTakeFirstOrThrow()).id;
}
const entries = (o: Record<string, string> = {}) => ({ first_name: "Ana", last_name: "Gomez", dni: nextDni(), email: "", phone: "", ...o });
async function submit(slug: string, e: Record<string, string>, key = randomUUID()) {
  const r = await submitForm(slug, e, key, nextIp(), "agent");
  expect(r.kind).toBe("ok");
  const db = await getDb();
  return db.selectFrom("form_submissions").selectAll().where("idempotency_key", "=", key).executeTakeFirstOrThrow();
}
const events = async (submissionId: string) => (await (await getDb()).selectFrom("form_submission_events").selectAll().where("submission_id", "=", submissionId).orderBy("seq").execute());
const participations = async (meetingId: string, personId?: string) => {
  const db = await getDb();
  let q = db.selectFrom("meeting_participations").selectAll().where("meeting_id", "=", meetingId).where("participation_kind", "=", "registration");
  if (personId) q = q.where("person_id", "=", personId);
  return q.execute();
};
const count = async (table: string) => (await sql<{ n: number }>`select count(*)::int n from ${sql.table(table)}`.execute(await getDb())).rows[0]!.n;
const systemUserId = async () => (await (await getDb()).selectFrom("users").select("id").where("email", "=", FORM_SYSTEM_USER_EMAIL).executeTakeFirstOrThrow()).id;

describe("1c · reunión de un día: la respuesta inscribe", () => {
  it("una persona existente de la unidad queda inscripta (canónica B4), a nombre del sistema, con provenance auto_enrolled y sin interacción ni asistencia", async () => {
    const act = await single();
    const m = act.meetings[0]!.id;
    const dni = nextDni();
    const pid = await person(dni);
    const interactionsBefore = await count("person_interactions");
    const s = await submit(act.form.slug, entries({ dni }));
    const db = await getDb();

    expect(s).toMatchObject({ match_result: "matched", person_id: pid });
    const rows = await participations(m, pid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ participation_kind: "registration", participation_basis: "standard", origin_channel: "form", recorded_by: await systemUserId(), origin_invitation_id: null, voided_at: null, registered_at_precision: "exact_datetime" });
    expect(rows[0]!.registered_at!.getTime()).toBe(s.created_at.getTime()); // la fecha de la inscripción es la del envío

    const regEv = await db.selectFrom("meeting_registration_events").select(["event_type", "origin_channel", "recorded_by"]).where("participation_id", "=", rows[0]!.id).execute();
    expect(regEv).toEqual([{ event_type: "registered", origin_channel: "form", recorded_by: await systemUserId() }]);

    const ev = await events(s.id);
    expect(ev.map((e) => e.event_type)).toEqual(["auto_linked", "auto_enrolled"]);
    expect(ev[1]).toMatchObject({ person_id: pid, meeting_id: m, participation_id: rows[0]!.id, recorded_by: null });
    // inscribir NO es asistir ni contactar (invariante de B4)
    expect(await count("meeting_attendance")).toBe(0);
    expect(await count("person_interactions")).toBe(interactionsBefore);
  });

  it("idempotente: reintentar el MISMO envío y enviar de nuevo la misma persona no duplican la inscripción ni su historial", async () => {
    const act = await single();
    const m = act.meetings[0]!.id;
    const dni = nextDni();
    const pid = await person(dni);
    const key = randomUUID();
    const first = await submit(act.form.slug, entries({ dni }), key);
    await submit(act.form.slug, entries({ dni }), key); // reintento del mismo envío
    const second = await submit(act.form.slug, entries({ dni })); // otra respuesta de la misma persona
    expect(await participations(m, pid)).toHaveLength(1);
    const db = await getDb();
    expect((await db.selectFrom("meeting_registration_events").select("id").where("person_id", "=", pid).execute()).length).toBe(1);
    expect((await events(first.id)).filter((e) => e.event_type === "auto_enrolled")).toHaveLength(1);
    // la segunda respuesta no originó la inscripción (ya existía): no se le atribuye
    expect((await events(second.id)).filter((e) => e.event_type === "auto_enrolled")).toHaveLength(0);
  });

  it("sin coincidencia (política «never»): queda sin vincular y NO inscribe", async () => {
    const act = await single();
    const s = await submit(act.form.slug, entries());
    expect(s.match_result).toBe("unlinked");
    expect(s.person_id).toBeNull();
    expect(await participations(act.meetings[0]!.id)).toHaveLength(0);
  });

  it("con when_valid_dni se crea la ficha en la unidad del formulario y se inscribe", async () => {
    const act = await single({ personCreation: "when_valid_dni" });
    const dni = nextDni();
    const s = await submit(act.form.slug, entries({ dni, first_name: "Nueva", last_name: "Persona" }));
    expect(s.match_result).toBe("created");
    const db = await getDb();
    const p = await db.selectFrom("people").select(["id", "organization_id", "status"]).where("id", "=", s.person_id!).executeTakeFirstOrThrow();
    expect(p).toMatchObject({ organization_id: orgA, status: "active" });
    const rows = await participations(act.meetings[0]!.id, p.id);
    expect(rows).toHaveLength(1);
    expect((await events(s.id)).map((e) => e.event_type)).toEqual(["auto_person_created", "auto_enrolled"]);
  });

  it("no inscribe cuando el envío queda en revisión: persona de otra unidad, DNI que no coincide con el email, o ambigüedad", async () => {
    const act = await single();
    const m = act.meetings[0]!.id;
    // 1. persona de OTRA unidad
    const outsideDni = nextDni();
    await person(outsideDni, orgOther);
    const s1 = await submit(act.form.slug, entries({ dni: outsideDni }));
    expect(s1.match_result).toBe("needs_review");
    // 2. mismo email, DNI distinto (puede ser otra persona)
    const owner = await person(nextDni(), orgA, { email: "compartido@example.com" });
    const s2 = await submit(act.form.slug, entries({ email: "compartido@example.com" }));
    expect(s2.match_result).toBe("needs_review");
    // 3. ambigüedad real: dos personas de la unidad con el mismo email y un DNI que no es de ninguna
    await person(nextDni(), orgA, { email: "dos@example.com" });
    await person(nextDni(), orgA, { email: "dos@example.com" });
    const s3 = await submit(act.form.slug, entries({ email: "dos@example.com" }));
    expect(s3.match_result).toBe("needs_review");
    expect(await participations(m)).toHaveLength(0);
    expect(owner).toBeTruthy();
  });

  it("enrollment=never: el formulario solo recibe respuestas, como hasta ahora", async () => {
    const act = await single({ enrollment: "never" });
    const dni = nextDni();
    const pid = await person(dni);
    const s = await submit(act.form.slug, entries({ dni }));
    expect(s.match_result).toBe("matched");
    expect(await participations(act.meetings[0]!.id, pid)).toHaveLength(0);
    expect((await events(s.id)).map((e) => e.event_type)).toEqual(["auto_linked"]);
  });

  it("una reunión cancelada o finalizada no inscribe, pero la respuesta igual se registra y vincula", async () => {
    const db = await getDb();
    for (const status of ["cancelled", "finished"] as const) {
      const act = await single();
      await db.updateTable("meetings").set({ status }).where("id", "=", act.meetings[0]!.id).execute();
      const dni = nextDni();
      const pid = await person(dni);
      const s = await submit(act.form.slug, entries({ dni }));
      expect(s).toMatchObject({ match_result: "matched", person_id: pid });
      expect(await participations(act.meetings[0]!.id, pid)).toHaveLength(0);
    }
  });

  it("una inscripción anulada por un operador NO se reactiva sola", async () => {
    const act = await single();
    const m = act.meetings[0]!.id;
    const dni = nextDni();
    const pid = await person(dni);
    await submit(act.form.slug, entries({ dni }));
    const row = (await participations(m, pid))[0]!;
    await reg.voidEnrollment(areaA, { participationId: row.id, reason: "Se anotó por error" });
    await submit(act.form.slug, entries({ dni }));
    const after = await participations(m, pid);
    expect(after).toHaveLength(1);
    expect(after[0]!.voided_at).not.toBeNull();
  });

  it("si la inscripción falla, la respuesta igual se guarda, queda vinculada y el visitante ve el mismo «ok»", async () => {
    const act = await single();
    const dni = nextDni();
    const pid = await person(dni);
    control.failEnroll = true;
    let s;
    try {
      s = await submit(act.form.slug, entries({ dni }));
    } finally {
      control.failEnroll = false;
    }
    expect(s).toMatchObject({ match_result: "matched", person_id: pid });
    expect(await participations(act.meetings[0]!.id, pid)).toHaveLength(0);
    // el operador la puede inscribir después («Inscribir respuestas seleccionadas») y queda con su provenance manual
    const [r] = await subs.enrollSubmissions(areaA, { submissionIds: [s.id] });
    expect(r!.status).toBe("enrolled");
  });

  it("después de una inscripción automática, «Inscribir respuestas» del operador la reconoce y no duplica", async () => {
    const act = await single();
    const dni = nextDni();
    await person(dni);
    const s = await submit(act.form.slug, entries({ dni }));
    const [r] = await subs.enrollSubmissions(areaA, { submissionIds: [s.id] });
    expect(r!.status).toBe("already_enrolled_from_submission");
    expect((await events(s.id)).filter((e) => e.event_type === "enrolled" || e.event_type === "auto_enrolled")).toHaveLength(1);
  });
});

describe("1c · campaña: la respuesta inscribe en todas las jornadas vigentes", () => {
  it("campaign_all: una inscripción por jornada programada, cada una con su provenance", async () => {
    const act = await campaign(3);
    const dni = nextDni();
    const pid = await person(dni);
    const s = await submit(act.form.slug, entries({ dni }));
    for (const m of act.meetings) expect(await participations(m.id, pid)).toHaveLength(1);
    const ev = (await events(s.id)).filter((e) => e.event_type === "auto_enrolled");
    expect(ev.map((e) => e.meeting_id).sort()).toEqual(act.meetings.map((m) => m.id).sort());
    // reenviar no duplica nada
    await submit(act.form.slug, entries({ dni }));
    for (const m of act.meetings) expect(await participations(m.id, pid)).toHaveLength(1);
  });

  it("las jornadas canceladas o finalizadas se saltean; la campaña inscribe solo en las vigentes", async () => {
    const act = await campaign(3);
    const db = await getDb();
    await db.updateTable("meetings").set({ status: "cancelled" }).where("id", "=", act.meetings[0]!.id).execute();
    await db.updateTable("meetings").set({ status: "finished" }).where("id", "=", act.meetings[1]!.id).execute();
    const dni = nextDni();
    const pid = await person(dni);
    await submit(act.form.slug, entries({ dni }));
    expect(await participations(act.meetings[0]!.id, pid)).toHaveLength(0);
    expect(await participations(act.meetings[1]!.id, pid)).toHaveLength(0);
    expect(await participations(act.meetings[2]!.id, pid)).toHaveLength(1);
  });

  it("campaign_selected todavía no inscribe (necesita una pregunta de opción múltiple): la respuesta se vincula y queda para el operador", async () => {
    const act = await campaign(2);
    const db = await getDb();
    await db.updateTable("forms").set({ enrollment_mode: "campaign_selected" } as never).where("id", "=", act.form.id).execute();
    const dni = nextDni();
    const pid = await person(dni);
    const s = await submit(act.form.slug, entries({ dni }));
    expect(s.match_result).toBe("matched");
    for (const m of act.meetings) expect(await participations(m.id, pid)).toHaveLength(0);
  });

  it("la respuesta pública es idéntica con o sin inscripción (no filtra si la persona existe)", async () => {
    const act = await single();
    const known = nextDni();
    await person(known);
    const a = await submitForm(act.form.slug, entries({ dni: known }), randomUUID(), nextIp(), "agent");
    const b = await submitForm(act.form.slug, entries(), randomUUID(), nextIp(), "agent");
    expect(a).toEqual(b);
  });
});
