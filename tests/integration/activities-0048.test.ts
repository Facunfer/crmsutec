import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Actividades unificadas, paso 1a — migración 0048 (comportamiento real sobre PGlite):
 *   forms.enrollment_mode · form_submission_events.auto_enrolled · REUNIONES crea/edita reuniones · usuario de sistema «Sistema (formularios)».
 */

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb, execRawSql } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { ROLE_PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { ensureFormSystemUser, FORM_SYSTEM_USER_EMAIL } = await import("../../lib/auth/system-users.js");
const { verifyPassword } = await import("../../lib/auth/passwords.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const MIGRATION = () => readFileSync("db/migrations/0048_activities_enrollment.sql", "utf8");
let orgId: string;
let seq = 0;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  orgId = await createTestOrganization();
});

afterAll(async () => {
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function userId(email: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "ADMIN").executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: "x", full_name: email, role_id: role.id }).returning("id").executeTakeFirstOrThrow()).id;
}
async function makeForm(extra: Record<string, unknown> = {}) {
  const db = await getDb();
  seq += 1;
  return (await db.insertInto("forms").values({ owner_organization_id: orgId, slug: `a48-${seq}`, name: `Form ${seq}`, ...extra } as never).returning("id").executeTakeFirstOrThrow()).id;
}
async function makeMeeting(by: string) {
  const db = await getDb();
  seq += 1;
  return (
    await db
      .insertInto("meetings")
      .values({
        name: `Reunión ${seq}`, owner_organization_id: orgId, organizer_user_id: by, created_by: by, origin: "manual", status: "scheduled", meeting_type: "reunion",
        schedule_precision: "exact_datetime", starts_at: new Date(Date.now() + 3_600_000), ends_at: new Date(Date.now() + 7_200_000),
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}
async function makeCampaign() {
  const db = await getDb();
  seq += 1;
  return (
    await db
      .insertInto("campaigns")
      .values({ campaign_key: `other:a48-${seq}`, name: `Campaña ${seq}`, campaign_type: "other", owner_organization_id: orgId, origin: "manual", status: "draft" } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}
async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await expect(promise).rejects.toThrow(pattern);
}

describe("0048 · forms.enrollment_mode", () => {
  it("nace en «never»: completar un formulario sigue sin inscribir", async () => {
    const db = await getDb();
    const id = await makeForm();
    expect((await db.selectFrom("forms").select("enrollment_mode").where("id", "=", id).executeTakeFirstOrThrow()).enrollment_mode).toBe("never");
  });

  it("el modo debe ser coherente con el destino del formulario", async () => {
    const db = await getDb();
    const by = await userId(`a48-m-${++seq}@x.local`);
    const meeting = await makeMeeting(by);
    const campaign = await makeCampaign();
    const set = (id: string, values: Record<string, unknown>) => db.updateTable("forms").set(values as never).where("id", "=", id).execute();

    const noTarget = await makeForm();
    await rejects(set(noTarget, { enrollment_mode: "single_meeting" }), /forms_enrollment_target_check/);
    await rejects(set(noTarget, { enrollment_mode: "campaign_all" }), /forms_enrollment_target_check/);
    await rejects(set(noTarget, { enrollment_mode: "campaign_selected" }), /forms_enrollment_target_check/);
    await rejects(set(noTarget, { enrollment_mode: "siempre" }), /forms_enrollment_mode_check/);

    const withMeeting = await makeForm({ meeting_id: meeting });
    await set(withMeeting, { enrollment_mode: "single_meeting" }); // reunión fija: válido
    await rejects(set(withMeeting, { enrollment_mode: "campaign_all" }), /forms_enrollment_target_check/);

    const withCampaign = await makeForm({ campaign_id: campaign });
    await set(withCampaign, { enrollment_mode: "campaign_all" });
    await set(withCampaign, { enrollment_mode: "campaign_selected" });
    await rejects(set(withCampaign, { enrollment_mode: "single_meeting" }), /forms_enrollment_target_check/);
  });
});

describe("0048 · form_submission_events.auto_enrolled", () => {
  async function fixture() {
    const db = await getDb();
    const by = await userId(`a48-e-${++seq}@x.local`);
    const meeting = await makeMeeting(by);
    const formId = await makeForm({ meeting_id: meeting });
    const person = (
      await db
        .insertInto("people")
        .values({ first_name: "Ana", last_name: `P${seq}`, dni: String(40000000 + seq), organization_id: orgId, origin: "manual" } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const submission = (
      await db
        .insertInto("form_submissions")
        .values({ form_id: formId, form_version: 1, raw_payload: sql`'{}'::jsonb`, idempotency_key: randomUUID(), person_id: person } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const system = await ensureFormSystemUser(db);
    const participation = (
      await db
        .insertInto("meeting_participations")
        .values({
          meeting_id: meeting, person_id: person, participation_kind: "registration", participation_basis: "standard",
          recorded_by: system, origin_channel: "form", registered_at: new Date(), registered_at_precision: "exact_datetime",
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    return { db, by, meeting, person, submission, participation };
  }

  it("acepta el evento automático (actor NULL) con reunión y participación", async () => {
    const f = await fixture();
    const row = await f.db
      .insertInto("form_submission_events")
      .values({ submission_id: f.submission, event_type: "auto_enrolled", person_id: f.person, meeting_id: f.meeting, participation_id: f.participation, recorded_by: null } as never)
      .returning("event_type")
      .executeTakeFirstOrThrow();
    expect(row.event_type).toBe("auto_enrolled");
  });

  it("exige reunión y participación, y NO admite actor humano en un evento automático", async () => {
    const f = await fixture();
    const base = { submission_id: f.submission, event_type: "auto_enrolled", person_id: f.person };
    await rejects(f.db.insertInto("form_submission_events").values({ ...base, meeting_id: f.meeting, participation_id: null, recorded_by: null } as never).execute(), /form_submission_events_enrolled_check/);
    await rejects(f.db.insertInto("form_submission_events").values({ ...base, meeting_id: null, participation_id: null, recorded_by: null } as never).execute(), /form_submission_events_enrolled_check/);
    await rejects(f.db.insertInto("form_submission_events").values({ ...base, meeting_id: f.meeting, participation_id: f.participation, recorded_by: f.by } as never).execute(), /form_submission_events_actor_check/);
  });

  it("una respuesta origina como máximo UNA inscripción por reunión, sea automática o manual", async () => {
    const f = await fixture();
    const ev = (type: string, recordedBy: string | null) =>
      f.db.insertInto("form_submission_events").values({ submission_id: f.submission, event_type: type, person_id: f.person, meeting_id: f.meeting, participation_id: f.participation, recorded_by: recordedBy } as never).execute();
    await ev("auto_enrolled", null);
    await rejects(ev("auto_enrolled", null), /duplicate key|unique/i);
    await rejects(ev("enrolled", f.by), /duplicate key|unique/i); // ya la inscribió el sistema: el operador no la duplica
  });
});

describe("0048 · REUNIONES crea y edita reuniones", () => {
  it("el catálogo y la base coinciden (la migración y el seed convergen)", async () => {
    expect(ROLE_PERMISSIONS.REUNIONES).toEqual(expect.arrayContaining(["meetings.create", "meetings.edit", "meetings.view", "meetings.accredit"]));
    const db = await getDb();
    const rows = await sql<{ key: string }>`select p.key from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where r.key = 'REUNIONES' order by 1`.execute(db);
    expect(rows.rows.map((r) => r.key)).toEqual([...ROLE_PERMISSIONS.REUNIONES].sort());
  });

  it("no se amplía nada más: REUNIONES sigue sin personas, asociaciones ni formularios propios", () => {
    for (const key of ROLE_PERMISSIONS.REUNIONES) expect(key).toMatch(/^(dashboard|meetings)\./);
  });

  it("la migración, aplicada sola sobre una base con roles, deja a REUNIONES con ambos permisos (producción)", async () => {
    const db = await getDb();
    await sql`delete from role_permissions where role_id = (select id from roles where key = 'REUNIONES') and permission_id in (select id from permissions where key in ('meetings.create', 'meetings.edit'))`.execute(db);
    await execRawSql(MIGRATION());
    const rows = await sql<{ key: string }>`select p.key from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where r.key = 'REUNIONES' and p.key in ('meetings.create', 'meetings.edit') order by 1`.execute(db);
    expect(rows.rows.map((r) => r.key)).toEqual(["meetings.create", "meetings.edit"]);
  });
});

describe("0048 · usuario de sistema «Sistema (formularios)»", () => {
  it("existe, está inactivo, sin acceso y sin alcances; ensureFormSystemUser es idempotente", async () => {
    const db = await getDb();
    const id = await ensureFormSystemUser(db);
    expect(await ensureFormSystemUser(db)).toBe(id);
    const u = await db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(u).toMatchObject({ email: FORM_SYSTEM_USER_EMAIL, status: "inactive", full_name: "Sistema (formularios)" });
    expect(await verifyPassword("cualquier-clave-123", u.password_hash)).toBe(false);
    expect(await verifyPassword("!sin-acceso", u.password_hash)).toBe(false);
    expect((await db.selectFrom("user_scopes").select("id").where("user_id", "=", id).execute()).length).toBe(0);
    expect((await db.selectFrom("sessions").select("id").where("user_id", "=", id).execute()).length).toBe(0);
    const count = await sql<{ n: number }>`select count(*)::int n from users where lower(email) = ${FORM_SYSTEM_USER_EMAIL}`.execute(db);
    expect(count.rows[0]!.n).toBe(1);
  });

  it("la migración, aplicada con el usuario ya creado, no lo duplica", async () => {
    const db = await getDb();
    await execRawSql(MIGRATION());
    const count = await sql<{ n: number }>`select count(*)::int n from users where lower(email) = ${FORM_SYSTEM_USER_EMAIL}`.execute(db);
    expect(count.rows[0]!.n).toBe(1);
  });
});

describe("0048 · idempotencia y compatibilidad", () => {
  it("reaplicar la migración completa no falla ni cambia el esquema", async () => {
    const db = await getDb();
    const fingerprint = async () =>
      (await sql<{ h: string }>`select md5(string_agg(conname || ':' || pg_get_constraintdef(oid), ',' order by conname)) h from pg_constraint where conrelid in ('public.forms'::regclass, 'public.form_submission_events'::regclass)`.execute(db)).rows[0]!.h;
    const before = await fingerprint();
    await execRawSql(MIGRATION());
    await execRawSql(MIGRATION());
    expect(await fingerprint()).toBe(before);
  });

  it("es aditiva: no hay DROP de tablas ni columnas, ni TRUNCATE, ni DELETE de datos de negocio", () => {
    const text = MIGRATION().replace(/--.*$/gm, "");
    expect(text).not.toMatch(/drop\s+(table|column|schema)|truncate|delete\s+from/i);
  });
});
