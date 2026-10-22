import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

/**
 * Actividades unificadas, paso 1b — createActivity: reunión de un día o campaña con varias fechas + formulario + una reunión (y QR) por fecha,
 * todo en UNA transacción. Comportamiento real sobre PGlite.
 */

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

// Permite forzar un fallo A MITAD de la transacción (después de insertar campaña, reuniones, formulario y campos) para probar la atomicidad.
const control = vi.hoisted(() => ({ failSnapshot: false }));
vi.mock("../../lib/forms/snapshot.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/forms/snapshot.js")>();
  return {
    ...original,
    buildFormSnapshot: (...args: Parameters<typeof original.buildFormSnapshot>) => {
      if (control.failSnapshot) throw new Error("fallo forzado al publicar");
      return original.buildFormSnapshot(...args);
    },
  };
});

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS, ROLE_PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { createActivity, ActivityCommandError } = await import("../../lib/activities/create.js");
const { getPublicForm, submitForm } = await import("../../lib/forms/submit.js");
const { getMeetingById } = await import("../../lib/meetings/queries.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));
let master: any;
let areaA: any;
let areaB: any;
let reunionesRoot: any;
let reunionesNoStatus: any;
let lectura: any;
let rootOrg: string;
let orgA: string;
let orgA1: string;
let orgB: string;
let seq = 0;

function actorOf(id: string, roleKey: string, permissions: Set<string>): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions };
}
async function makeUser(email: string, roleKey: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id }).returning("id").executeTakeFirstOrThrow()).id;
}
async function grantScope(userId: string, orgId: string) {
  const db = await getDb();
  await db.insertInto("user_scopes").values({ user_id: userId, organization_id: orgId, include_descendants: true, granted_by: master.id } as never).execute();
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  rootOrg = await createTestOrganization();
  const db = await getDb();
  const orgType = await db.selectFrom("organization_types").select("id").where("key", "=", "reparticion").executeTakeFirstOrThrow();
  const child = async (parent: string) => (await db.insertInto("organizations").values({ name: `Hija ${++seq}`, type_id: orgType.id, parent_id: parent }).returning("id").executeTakeFirstOrThrow()).id;
  orgA = await child(rootOrg);
  orgA1 = await child(orgA);
  orgB = await child(rootOrg);

  master = actorOf(await makeUser("act-master@sutecba.local", "MASTER_GLOBAL"), "MASTER_GLOBAL", ALL);
  const a = await makeUser("act-area-a@sutecba.local", "ADMIN");
  const b = await makeUser("act-area-b@sutecba.local", "ADMIN");
  const r = await makeUser("act-reuniones@sutecba.local", "REUNIONES");
  const n = await makeUser("act-sin-estado@sutecba.local", "OPERADOR");
  const l = await makeUser("act-lectura@sutecba.local", "LECTURA");
  await grantScope(a, orgA);
  await grantScope(b, orgB);
  await grantScope(r, rootOrg); // «solo reuniones» para todas las áreas: alcance en la raíz con descendientes
  await grantScope(n, orgA);
  await grantScope(l, orgA);
  areaA = actorOf(a, "ADMIN", new Set<string>(ROLE_PERMISSIONS.ADMIN));
  areaB = actorOf(b, "ADMIN", new Set<string>(ROLE_PERMISSIONS.ADMIN));
  reunionesRoot = actorOf(r, "REUNIONES", new Set<string>(ROLE_PERMISSIONS.REUNIONES));
  reunionesNoStatus = actorOf(n, "OPERADOR", new Set<string>(ROLE_PERMISSIONS.OPERADOR.filter((p) => p !== "meetings.change_status")));
  lectura = actorOf(l, "LECTURA", new Set<string>(ROLE_PERMISSIONS.LECTURA));
});

afterAll(async () => {
  control.failSnapshot = false;
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
const base = (extra: Record<string, unknown> = {}) => ({ kind: "single" as const, name: "Charla de seguridad", ownerOrganizationId: orgA, dates: [date(3)], ...extra });

const count = async (table: string) => {
  const db = await getDb();
  return (await sql<{ n: number }>`select count(*)::int n from ${sql.table(table)}`.execute(db)).rows[0]!.n;
};
const rejects = (promise: Promise<unknown>, pattern: RegExp) => expect(promise).rejects.toThrow(pattern);

describe("createActivity · reunión de un día", () => {
  it("crea la reunión programada, su formulario publicado (v1) y los vincula, con la plantilla de campos", async () => {
    const r = await createActivity(areaA, base({ qrMode: "static", capacity: 40, form: { enrollment: "auto" } }));
    const db = await getDb();
    expect(r).toMatchObject({ kind: "single", campaignId: null, status: "scheduled" });
    expect(r.meetings).toHaveLength(1);
    expect(r.form).toMatchObject({ published: true, enrollmentMode: "single_meeting" });
    expect(r.form.publicPath).toBe(`/f/${r.form.slug}`);

    const m = await db.selectFrom("meetings").selectAll().where("id", "=", r.meetings[0]!.id).executeTakeFirstOrThrow();
    expect(m).toMatchObject({ name: "Charla de seguridad", status: "scheduled", qr_mode: "static", capacity: 40, campaign_id: null, owner_organization_id: orgA, organizer_user_id: areaA.id, created_by: areaA.id, meeting_type: "reunion" });

    const f = await db.selectFrom("forms").selectAll().where("id", "=", r.form.id).executeTakeFirstOrThrow();
    expect(f).toMatchObject({ status: "published", published_version: 1, meeting_id: m.id, campaign_id: null, default_meeting_id: null, enrollment_mode: "single_meeting", person_creation_policy: "never", apply_data_policy: "never", owner_organization_id: orgA });
    const fields = await db.selectFrom("form_fields").select(["key", "person_field_mapping", "required"]).where("form_id", "=", r.form.id).orderBy("sort_order").execute();
    expect(fields.map((x) => x.key)).toEqual(["first_name", "last_name", "dni", "email", "phone"]);
    expect(fields.map((x) => x.required)).toEqual([true, true, true, false, false]);
    const versions = await db.selectFrom("form_versions").select(["version"]).where("form_id", "=", r.form.id).execute();
    expect(versions).toEqual([{ version: 1 }]);
  });

  it("la reunión es visible con su QR operativo y el formulario público se carga y recibe respuestas", async () => {
    const r = await createActivity(areaA, base({ name: "Reunión con formulario" }));
    expect(await getMeetingById(areaA, r.meetings[0]!.id)).not.toBeNull();
    const pub = await getPublicForm(r.form.slug);
    expect(pub).toBeTruthy();
    const res = await submitForm(r.form.slug, { first_name: "Ana", last_name: "Gomez", dni: "30111222", email: "", phone: "" }, randomUUID(), "10.50.0.1", "agent");
    expect(res.kind).toBe("ok");
  });

  it("el tipo de reunión (reunión / capacitación) se respeta", async () => {
    const r = await createActivity(areaA, base({ name: "Capacitación de ingreso", meetingType: "capacitacion" }));
    const db = await getDb();
    expect((await db.selectFrom("meetings").select("meeting_type").where("id", "=", r.meetings[0]!.id).executeTakeFirstOrThrow()).meeting_type).toBe("capacitacion");
  });
});

describe("createActivity · campaña con varias fechas", () => {
  it("crea la campaña, una jornada por fecha (cronológica, con su QR), y el formulario vinculado a la campaña", async () => {
    // Se cargan desordenadas: la numeración es la del calendario.
    const r = await createActivity(areaA, base({ kind: "campaign", name: "Campaña de vacunación", campaignType: "vaccination", dates: [date(9), date(2), date(5, { locationName: "Sede" })] }));
    const db = await getDb();
    expect(r).toMatchObject({ kind: "campaign", status: "scheduled" });
    expect(r.campaignId).toBeTruthy();
    expect(r.meetings.map((m) => m.number)).toEqual([1, 2, 3]);
    expect(r.meetings[0]!.startsAt.getTime()).toBeLessThan(r.meetings[1]!.startsAt.getTime());
    expect(r.meetings[1]!.startsAt.getTime()).toBeLessThan(r.meetings[2]!.startsAt.getTime());
    expect(r.meetings[0]!.name).toMatch(/^Campaña de vacunación · Jornada 1 \(\d\d\/\d\d\)$/);

    const c = await db.selectFrom("campaigns").selectAll().where("id", "=", r.campaignId!).executeTakeFirstOrThrow();
    expect(c).toMatchObject({ name: "Campaña de vacunación", campaign_type: "vaccination", status: "scheduled", origin: "manual", historical_condition: null, owner_organization_id: orgA, created_by: areaA.id });
    expect(c.campaign_key).toMatch(/^act:campana-de-vacunacion-[0-9a-f]{6}$/);
    expect(String(c.start_date) <= String(c.end_date)).toBe(true);

    const ms = await db.selectFrom("meetings").select(["id", "campaign_id", "meeting_type", "status", "location_name"]).where("campaign_id", "=", r.campaignId!).orderBy("starts_at").execute();
    expect(ms).toHaveLength(3);
    expect(ms.every((m) => m.meeting_type === "jornada" && m.status === "scheduled")).toBe(true);
    expect(ms[1]!.location_name).toBe("Sede");

    const f = await db.selectFrom("forms").selectAll().where("id", "=", r.form.id).executeTakeFirstOrThrow();
    expect(f).toMatchObject({ campaign_id: r.campaignId, meeting_id: null, default_meeting_id: null, enrollment_mode: "campaign_all", status: "published" });
  });

  it("una campaña pide al menos dos fechas y una reunión de un día exactamente una", async () => {
    await rejects(createActivity(areaA, base({ kind: "campaign", dates: [date(1)] })), /al menos dos fechas/);
    await rejects(createActivity(areaA, base({ kind: "single", dates: [date(1), date(2)] })), /exactamente una fecha/);
    await rejects(createActivity(areaA, base({ dates: [] })), /al menos una fecha/);
  });
});

describe("createActivity · borrador, inscripción y preguntas propias", () => {
  it("publish=false deja todo en borrador y sin exponer nada (sin versión publicada)", async () => {
    const r = await createActivity(areaA, base({ kind: "campaign", name: "Borrador", dates: [date(4), date(6)], publish: false }));
    const db = await getDb();
    expect(r.status).toBe("draft");
    expect(r.form.published).toBe(false);
    expect((await db.selectFrom("campaigns").select("status").where("id", "=", r.campaignId!).executeTakeFirstOrThrow()).status).toBe("draft");
    expect((await db.selectFrom("meetings").select("status").where("campaign_id", "=", r.campaignId!).execute()).map((m) => m.status)).toEqual(["draft", "draft"]);
    const f = await db.selectFrom("forms").select(["status", "published_version"]).where("id", "=", r.form.id).executeTakeFirstOrThrow();
    expect(f).toEqual({ status: "draft", published_version: null });
    expect(await db.selectFrom("form_versions").select("id").where("form_id", "=", r.form.id).execute()).toHaveLength(0);
    expect(await getPublicForm(r.form.slug)).toEqual({ kind: "not_available" }); // un borrador no es público
  });

  it("enrollment=never deja el formulario como hasta ahora (no inscribe)", async () => {
    const one = await createActivity(areaA, base({ name: "Sin inscripción", form: { enrollment: "never" } }));
    const camp = await createActivity(areaA, base({ kind: "campaign", name: "Campaña sin inscripción", dates: [date(2), date(3)], form: { enrollment: "never" } }));
    expect(one.form.enrollmentMode).toBe("never");
    expect(camp.form.enrollmentMode).toBe("never");
  });

  it("personCreation se respeta; por defecto «never» (R7)", async () => {
    const db = await getDb();
    const a = await createActivity(areaA, base({ name: "Crea fichas", form: { personCreation: "when_valid_dni" } }));
    const b = await createActivity(areaA, base({ name: "No crea fichas" }));
    const policy = async (id: string) => (await db.selectFrom("forms").select("person_creation_policy").where("id", "=", id).executeTakeFirstOrThrow()).person_creation_policy;
    expect(await policy(a.form.id)).toBe("when_valid_dni");
    expect(await policy(b.form.id)).toBe("never");
  });

  it("agrega preguntas propias con claves únicas y opciones; una pregunta de opciones sin opciones se rechaza", async () => {
    const db = await getDb();
    const r = await createActivity(
      areaA,
      base({
        name: "Con preguntas",
        form: {
          extraFields: [
            { label: "Turno preferido", fieldType: "select", required: true, optionsText: "Mañana\nTarde" },
            { label: "Turno preferido", fieldType: "text" }, // misma etiqueta: otra clave
            { label: "Email", fieldType: "text" }, // choca con la plantilla: otra clave
            { label: "Observaciones", fieldType: "textarea" },
          ],
        },
      })
    );
    const fields = await db.selectFrom("form_fields").select(["key", "field_type", "options", "person_field_mapping", "required"]).where("form_id", "=", r.form.id).orderBy("sort_order").execute();
    expect(fields.map((f) => f.key)).toEqual(["first_name", "last_name", "dni", "email", "phone", "turno_preferido", "turno_preferido_2", "email_2", "observaciones"]);
    expect(fields.slice(5).every((f) => f.person_field_mapping === null)).toBe(true);
    expect(fields[5]).toMatchObject({ field_type: "select", required: true });
    expect((fields[5]!.options as any).choices.map((c: any) => c.label)).toEqual(["Mañana", "Tarde"]);
    expect(fields[8]!.options).toBeNull();

    const snap = (await db.selectFrom("form_versions").select("schema").where("form_id", "=", r.form.id).executeTakeFirstOrThrow()).schema as any;
    expect(snap.fields.map((f: any) => f.key)).toEqual(fields.map((f) => f.key));

    await rejects(createActivity(areaA, base({ form: { extraFields: [{ label: "Elegí", fieldType: "select" }] } })), /al menos una opción/);
  });
});

describe("createActivity · atomicidad", () => {
  it("si falla a mitad de la transacción no queda NADA (ni campaña, ni reuniones, ni formulario, ni campos)", async () => {
    const before = { campaigns: await count("campaigns"), meetings: await count("meetings"), forms: await count("forms"), fields: await count("form_fields"), versions: await count("form_versions") };
    control.failSnapshot = true;
    try {
      await rejects(createActivity(areaA, base({ kind: "campaign", name: "Se cae", dates: [date(2), date(3), date(4)] })), /fallo forzado/);
    } finally {
      control.failSnapshot = false;
    }
    expect({ campaigns: await count("campaigns"), meetings: await count("meetings"), forms: await count("forms"), fields: await count("form_fields"), versions: await count("form_versions") }).toEqual(before);
  });
});

describe("createActivity · permisos y alcance", () => {
  it("sin meetings.create (LECTURA) no se puede crear nada", async () => {
    const before = await count("meetings");
    await rejects(createActivity(lectura, base()), /permiso/i);
    expect(await count("meetings")).toBe(before);
  });

  it("publicar exige además meetings.change_status; como borrador no", async () => {
    await rejects(createActivity(reunionesNoStatus, base({ name: "Sin permiso de estado" })), /permiso/i);
    const draft = await createActivity(reunionesNoStatus, base({ name: "Borrador sin permiso de estado", publish: false }));
    expect(draft.status).toBe("draft");
  });

  it("un área solo crea en su órbita (incluidos descendientes), nunca en otra", async () => {
    const ok = await createActivity(areaA, base({ name: "En mi área", ownerOrganizationId: orgA }));
    const okChild = await createActivity(areaA, base({ name: "En un descendiente", ownerOrganizationId: orgA1 }));
    expect(ok.meetings).toHaveLength(1);
    expect(okChild.meetings).toHaveLength(1);
    const before = { m: await count("meetings"), f: await count("forms"), c: await count("campaigns") };
    await rejects(createActivity(areaA, base({ name: "En otra área", ownerOrganizationId: orgB })), /fuera de tu alcance/);
    await rejects(createActivity(areaA, base({ kind: "campaign", dates: [date(1), date(2)], ownerOrganizationId: orgB })), /fuera de tu alcance/);
    await rejects(createActivity(areaB, base({ ownerOrganizationId: orgA })), /fuera de tu alcance/);
    expect({ m: await count("meetings"), f: await count("forms"), c: await count("campaigns") }).toEqual(before);
  });

  it("el MASTER_GLOBAL crea para cualquier área; el usuario «solo reuniones» con alcance en la raíz crea para todas las áreas", async () => {
    for (const owner of [orgA, orgA1, orgB]) {
      expect((await createActivity(master, base({ name: `Master ${owner.slice(0, 4)}`, ownerOrganizationId: owner }))).meetings).toHaveLength(1);
      expect((await createActivity(reunionesRoot, base({ name: `Reuniones ${owner.slice(0, 4)}`, ownerOrganizationId: owner }))).meetings).toHaveLength(1);
    }
    const camp = await createActivity(reunionesRoot, base({ kind: "campaign", name: "Campaña de reuniones", dates: [date(2), date(3)], ownerOrganizationId: orgB }));
    expect(camp.meetings).toHaveLength(2);
  });

  it("una unidad inexistente o mal formada se rechaza sin crear nada", async () => {
    const before = await count("meetings");
    await rejects(createActivity(master, base({ ownerOrganizationId: randomUUID() })), /fuera de tu alcance|no existe/);
    await rejects(createActivity(master, base({ ownerOrganizationId: "no-es-un-uuid" })), /unidad responsable/);
    expect(await count("meetings")).toBe(before);
  });

  it("validaciones: fin anterior al inicio, nombre vacío", async () => {
    await rejects(createActivity(master, base({ dates: [{ startsAt: day(2, 12), endsAt: day(2, 9) }] })), /posterior/);
    await rejects(createActivity(master, base({ name: "   " })), /nombre/i);
  });
});
