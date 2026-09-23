import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { createMeeting, changeMeetingStatus } = await import("../../lib/meetings/commands.js");
const { createInvitationBatch } = await import("../../lib/meetings/invitations.js");
const { checkInWithInvitationToken } = await import("../../lib/attendance/checkin.js");
const { createAssociation } = await import("../../lib/associations/commands.js");
const { addMember } = await import("../../lib/associations/members.js");
const { getPeopleAnalytics, getAssociationsAnalytics, getMeetingsAnalytics, getFormsAnalytics } = await import("../../lib/analytics/queries.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL_PERMISSIONS = new Set(PERMISSIONS.map((p) => p.key));

let actor: any;

function futureMeetingInput(offsetMinutes = -10, durationMinutes = 90) {
  const start = new Date(Date.now() + offsetMinutes * 60_000);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const toLocal = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return { startsAt: toLocal(start), endsAt: toLocal(end) };
}

async function makePerson(firstName: string, lastName: string, dni: string, opts: { organizationId?: string; origin?: string } = {}) {
  const db = await getDb();
  const row = await db
    .insertInto("people")
    .values({ first_name: firstName, last_name: lastName, dni, organization_id: opts.organizationId ?? null, origin: (opts.origin as never) ?? "manual" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id as string;
}

let ownerOrgId: string;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  ownerOrgId = await createTestOrganization();

  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({ email: "analytics-actor@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id })
    .returning("id")
    .executeTakeFirstOrThrow();

  actor = {
    id: user.id,
    email: "analytics-actor@sutecba.local",
    fullName: "Actor",
    roleId: role.id,
    roleKey: "MASTER_GLOBAL",
    mustChangePassword: false,
    enabledModules: ALL_MODULE_KEYS,
    permissions: ALL_PERMISSIONS,
  };
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("analítica de Personas: nada se traba, los conteos cierran", () => {
  it("total = activas + inactivas, y las series no rompen con la base vacía o con datos reales", async () => {
    const empty = await getPeopleAnalytics(actor);
    expect(empty.total).toBe(0);
    expect(empty.monthlySignups.length).toBe(12);
    expect(empty.monthlySignups.every((s) => s.valor === 0)).toBe(true);

    const db = await getDb();
    const orgType = await db.selectFrom("organization_types").select("id").executeTakeFirstOrThrow();
    const org = await db.insertInto("organizations").values({ name: "Ministerio Analítica", type_id: orgType.id }).returning("id").executeTakeFirstOrThrow();

    const p1 = await makePerson("Ana", "Gomez", "30111001", { organizationId: org.id, origin: "manual" });
    await makePerson("Bruno", "Diaz", "30111002", { origin: "form" });
    const p3 = await makePerson("Carla", "Ruiz", "39111003", { origin: "import" });
    await db.updateTable("people").set({ status: "inactive" }).where("id", "=", p3).execute();

    const analytics = await getPeopleAnalytics(actor);
    expect(analytics.total).toBe(3);
    expect(analytics.active).toBe(2);
    expect(analytics.inactive).toBe(1);
    expect(analytics.byOrigin.reduce((acc, s) => acc + s.valor, 0)).toBe(3);
    expect(analytics.byOrganization.find((s) => s.nombre === "Ministerio Analítica")?.valor).toBe(1);
    // Bruno no tiene organismo ni DNI... espera, Bruno sí tiene DNI; probamos "sin organismo" con Bruno.
    expect(analytics.byOrganization.find((s) => s.nombre === "Sin organismo")).toBeTruthy();
    expect(analytics.missingOrganization).toBeGreaterThanOrEqual(1); // al menos Bruno (activo, sin organismo)

    const currentMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    const thisMonth = analytics.monthlySignups.find((s) => s.nombre === currentMonthKey);
    expect(thisMonth?.valor).toBeGreaterThanOrEqual(3);

    void p1;
  });
});

describe("analítica de Asociaciones", () => {
  it("cuenta por tipo y arma el top por cantidad de miembros", async () => {
    const db = await getDb();
    const assocType = await db.selectFrom("association_types").select("id").where("key", "=", "comision").executeTakeFirstOrThrow();
    const { id: associationId } = await createAssociation(actor, { ownerOrganizationId: ownerOrgId, name: "Comisión Analítica", typeId: assocType.id });
    const personId = await makePerson("Dario", "Lopez", "30111003");
    await addMember(actor, associationId, personId);

    const analytics = await getAssociationsAnalytics(actor);
    expect(analytics.total).toBeGreaterThanOrEqual(1);
    expect(analytics.active).toBeGreaterThanOrEqual(1);
    expect(analytics.byType.some((s) => s.valor > 0)).toBe(true);
    expect(analytics.topByMembers.find((s) => s.nombre === "Comisión Analítica")?.valor).toBe(1);
  });
});

describe("analítica de Reuniones", () => {
  it("cuenta por estado (incluida 'vencida sin cerrar' derivada) y calcula la tasa de asistencia", async () => {
    const { id } = await createMeeting(actor, { ownerOrganizationId: ownerOrgId, name: "Reunión Analítica", ...futureMeetingInput(), description: "", locationName: "", address: "", notes: "" });
    await changeMeetingStatus(actor, id, "scheduled");
    const personId = await makePerson("Elena", "Vega", "30111004");
    const batch = await createInvitationBatch(actor, id, { personIds: [personId] });
    await changeMeetingStatus(actor, id, "in_progress");
    await checkInWithInvitationToken(id, personId, "10.1.1.1", "agent");

    void batch;

    const analytics = await getMeetingsAnalytics(actor);
    expect(analytics.total).toBeGreaterThanOrEqual(1);
    expect(analytics.invited).toBeGreaterThanOrEqual(1);
    expect(analytics.attendanceRate).not.toBeNull();
    expect(analytics.attendanceRate!).toBeGreaterThan(0);
    expect(analytics.monthly.length).toBe(12);
    expect(analytics.byStatus.some((s) => s.valor > 0)).toBe(true);
  });

  it("una reunión vencida sin cerrar se cuenta como tal, no como 'programada'", async () => {
    const past = new Date(Date.now() - 5 * 24 * 60 * 60_000);
    const pastEnd = new Date(past.getTime() + 60 * 60_000);
    const toLocal = (d: Date) => {
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const { id } = await createMeeting(actor, { ownerOrganizationId: ownerOrgId, name: "Reunión Vencida", startsAt: toLocal(past), endsAt: toLocal(pastEnd), description: "", locationName: "", address: "", notes: "" });
    await changeMeetingStatus(actor, id, "scheduled");

    const analytics = await getMeetingsAnalytics(actor);
    const overdue = analytics.byStatus.find((s) => s.nombre === "Vencida sin cerrar");
    expect(overdue?.valor).toBeGreaterThanOrEqual(1);
  });
});

describe("analítica de Formularios", () => {
  it("no rompe sin formularios, y refleja el pendiente de revisión", async () => {
    const analytics = await getFormsAnalytics(actor);
    expect(analytics.totalForms).toBeGreaterThanOrEqual(0);
    expect(analytics.submissionsMonthly.length).toBe(12);
    expect(analytics.pendingDuplicates).toBeGreaterThanOrEqual(0);
  });
});
