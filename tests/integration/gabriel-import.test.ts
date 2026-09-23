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
const { loadEnv } = await import("../../lib/db/env.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { listMeetings, getMeetingById } = await import("../../lib/meetings/queries.js");
const { createMeeting, updateMeeting } = await import("../../lib/meetings/commands.js");
const { runImport } = await import("../../lib/imports/gabriel/apply.js");
const { planFromSources } = await import("../../lib/imports/gabriel/plan-hash.js");
const fx = await import("../helpers/gabriel-fixtures.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL_PERMISSIONS = new Set(PERMISSIONS.map((p) => p.key));

let ownerOrgId: string;
let userId: string;
let actor: any;

async function makeUser(email: string, roleKey: string, status: "active" | "inactive" = "active") {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({ email, password_hash: await hashPassword("x-password-123"), full_name: "Usuario", role_id: role.id, status } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: user.id, roleId: role.id };
}

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  ownerOrgId = await createTestOrganization();
  const master = await makeUser("import-actor@sutecba.local", "MASTER_GLOBAL");
  userId = master.id;
  actor = {
    id: master.id,
    email: "import-actor@sutecba.local",
    fullName: "Importador",
    roleId: master.roleId,
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

async function rejects(promise: Promise<unknown>, message?: RegExp) {
  await expect(promise).rejects.toThrow(message);
}

const count = async (table: string) => {
  const db = await getDb();
  const r = await (db as any).selectFrom(table).select((eb: any) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow();
  return Number(r.n);
};

const snapshot = async () => ({
  people: await count("people"),
  meetings: await count("meetings"),
  participations: await count("meeting_participations"),
  rows: await count("import_rows"),
  issues: await count("import_issues"),
  files: await count("import_files"),
  batches: await count("import_batches"),
  attendance: await count("meeting_attendance"),
});

/** Ejecuta `run` con el rol runtime real (`sutecba_app`): sin superusuario, con RLS y solo los GRANT de 0019/0021. */
async function asRuntimeRole<T>(run: () => Promise<T>): Promise<T> {
  const db = await getDb();
  await sql`set role sutecba_app`.execute(db);
  try {
    return await run();
  } finally {
    await sql`reset role`.execute(db);
  }
}

/** sutecba_meta/sutecba_migrations no son legibles con sutecba_app: se lee con la conexión de verificación. */
async function readLedger() {
  const db = await getDb();
  const database = await sql<{ database: string }>`select current_database() as database`.execute(db);
  const meta = await sql<{ system: string }>`select system from sutecba_meta where id = true`.execute(db);
  const migs = await sql<{ filename: string }>`select filename from sutecba_migrations`.execute(db);
  return { database: database.rows[0]!.database, system: meta.rows[0]?.system ?? null, migrations: migs.rows.map((r) => r.filename) };
}

const apply = async (files: any[], overrides: Record<string, unknown> = {}) => {
  const db = await getDb();
  return runImport(db, files, {
    ownerOrganizationId: ownerOrgId,
    createdBy: userId,
    confirmedPlanHash: planFromSources(files).planHash,
    ...overrides,
  } as never);
};

describe("migración 0021: garantías de esquema", () => {
  it("CUIL/CUIT: 11 dígitos con checksum válido; dni_source solo explicit/derived_from_cuil y el derivado coincide con su CUIL", async () => {
    const db = await getDb();
    const insert = (v: Record<string, unknown>) => db.insertInto("people").values({ first_name: "A", last_name: "B", ...v } as never).execute();
    await rejects(insert({ dni: "40000001", cuil_cuit: "123" }));
    const valid = fx.cuilFor("40000004");
    await rejects(insert({ dni: "40000004", cuil_cuit: `${valid.slice(0, 10)}${(Number(valid[10]) + 1) % 10}` })); // checksum inválido
    await rejects(insert({ dni: "40000002", dni_source: "adivinado" }));
    await rejects(insert({ dni: "40000002", dni_source: "manual" })); // el origen vive en people.origin
    await rejects(insert({ dni: "40000005", dni_source: "derived_from_cuil" })); // derivado sin CUIL
    await rejects(insert({ dni: "40000006", dni_source: "derived_from_cuil", cuil_cuit: fx.cuilFor("40000007") })); // derivado que no coincide
    await insert({ dni: "40000003", cuil_cuit: fx.cuilFor("40000003"), dni_source: "derived_from_cuil" });
    // 7 dígitos: el DNI se guarda SIN el cero de relleno del CUIL.
    await insert({ dni: "4000008", cuil_cuit: fx.cuilFor("4000008"), dni_source: "derived_from_cuil" });
    await rejects(insert({ dni: "04000008", cuil_cuit: fx.cuilFor("4000008"), dni_source: "derived_from_cuil" }));
    // El mismo CUIL para DNI distintos NO lo impide la base (no es identificador): se resuelve como incidencia.
    await insert({ dni: "40000009", cuil_cuit: fx.cuilFor("40000009") });
    await insert({ dni: "40000011", cuil_cuit: fx.cuilFor("40000009") });
  });

  it("meetings: precisión de horario coherente con lo guardado (exact_datetime / date_only / unknown)", async () => {
    const db = await getDb();
    const base = { owner_organization_id: ownerOrgId, name: "X", created_by: userId };
    const imported = { ...base, origin: "import" };
    const insert = (values: Record<string, unknown>) => db.insertInto("meetings").values(values as never).execute();

    // Manual: siempre exact_datetime con horas reales.
    await rejects(insert({ ...base, starts_at: null, ends_at: null }));
    await rejects(insert({ ...base, starts_at: null, ends_at: null, schedule_precision: "date_only", event_date: "2026-03-10" }));
    // Importada: exige clave estable.
    await rejects(insert({ ...imported, starts_at: null, ends_at: null, schedule_precision: "unknown" }));
    // date_only: día sin ninguna hora (ni siquiera una sintética).
    await insert({ ...imported, source_event_key: "t:date-only", starts_at: null, ends_at: null, schedule_precision: "date_only", event_date: "2026-03-10" });
    await rejects(insert({ ...imported, source_event_key: "t:date-only-no-day", starts_at: null, ends_at: null, schedule_precision: "date_only" }));
    await rejects(
      insert({ ...imported, source_event_key: "t:date-only-with-time", starts_at: new Date("2026-03-10T12:00:00Z"), ends_at: new Date("2026-03-10T13:00:00Z"), schedule_precision: "date_only", event_date: "2026-03-10" })
    );
    // exact_datetime exige inicio y fin reales; unknown no admite nada.
    await rejects(insert({ ...imported, source_event_key: "t:exact-empty", starts_at: null, ends_at: null, schedule_precision: "exact_datetime" }));
    await insert({ ...imported, source_event_key: "t:unknown", starts_at: null, ends_at: null, schedule_precision: "unknown" });
    await rejects(insert({ ...imported, source_event_key: "t:unknown-with-day", starts_at: null, ends_at: null, schedule_precision: "unknown", event_date: "2026-03-10" }));
    // Los nombres viejos ya no existen y la clave de evento es única.
    await rejects(insert({ ...imported, source_event_key: "t:legacy", starts_at: null, ends_at: null, schedule_precision: "known" }));
    await rejects(insert({ ...imported, source_event_key: "t:unknown", starts_at: null, ends_at: null, schedule_precision: "unknown" }));
  });

  it("participaciones: 'attended' exige evidencia, hay un destino obligatorio y no se duplican", async () => {
    const db = await getDb();
    const person = await db.insertInto("people").values({ first_name: "P", last_name: "Q", dni: "40000010" }).returning("id").executeTakeFirstOrThrow();
    const values = { person_id: person.id, campaign_key: "camp:test", participation_kind: "registration" };
    await db.insertInto("meeting_participations").values(values as never).execute();
    await rejects(db.insertInto("meeting_participations").values(values as never).execute());
    await rejects(db.insertInto("meeting_participations").values({ ...values, participation_kind: "attended" } as never).execute());
    await db.insertInto("meeting_participations").values({ ...values, participation_kind: "attended", evidence: "planilla firmada" } as never).execute();
    await rejects(db.insertInto("meeting_participations").values({ person_id: person.id, participation_kind: "registration" } as never).execute());
  });

  it("las participaciones no se pueden borrar (trigger) y no se pierde historia", async () => {
    const db = await getDb();
    await rejects(db.deleteFrom("meeting_participations").execute());
  });

  it("un lote 'applied' exige trazabilidad completa (modo apply, plan_hash, applied_at, summary)", async () => {
    const db = await getDb();
    const base = { owner_organization_id: ownerOrgId, responsible_user_id: userId, created_by: userId };
    await rejects(db.insertInto("import_batches").values({ ...base, status: "applied" } as never).execute());
    await rejects(db.insertInto("import_batches").values({ ...base, plan_hash: "no-es-un-hash" } as never).execute());
    await db
      .insertInto("import_batches")
      .values({ ...base, status: "applied", execution_mode: "apply", plan_hash: "a".repeat(64), applied_at: new Date(), summary: sql`'{}'::jsonb` } as never)
      .execute();
  });
});

describe("reuniones normales y edición con date_only (dominio)", () => {
  it("una reunión manual sigue naciendo exact_datetime con fecha y hora", async () => {
    const start = new Date(Date.now() + 3_600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const { id } = await createMeeting(actor, {
      ownerOrganizationId: ownerOrgId,
      name: "Reunión normal",
      startsAt: local(start),
      endsAt: local(new Date(start.getTime() + 3_600_000)),
      description: "",
      locationName: "",
      address: "",
      notes: "",
    });
    const db = await getDb();
    const row = await db.selectFrom("meetings").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.schedule_precision).toBe("exact_datetime");
    expect(row.origin).toBe("manual");
    expect(row.starts_at).toBeInstanceOf(Date);
    expect(row.ends_at).toBeInstanceOf(Date);
    expect(row.event_date).toBeNull();
  });

  it("editar una actividad importada sin horario y cargarle fecha y hora reales la vuelve exact_datetime", async () => {
    const db = await getDb();
    const inserted = await db
      .insertInto("meetings")
      .values({ owner_organization_id: ownerOrgId, name: "Jornada", created_by: userId, origin: "import", source_event_key: "t:edit-me", starts_at: null, ends_at: null, schedule_precision: "date_only", event_date: "2026-03-10", status: "draft" } as never)
      .returning("id")
      .executeTakeFirstOrThrow();
    await updateMeeting(actor, inserted.id, {
      name: "Jornada",
      startsAt: "2026-03-10T09:30",
      endsAt: "2026-03-10T12:30",
      description: "",
      locationName: "",
      address: "",
      notes: "",
    });
    const row = await db.selectFrom("meetings").selectAll().where("id", "=", inserted.id).executeTakeFirstOrThrow();
    expect(row.schedule_precision).toBe("exact_datetime");
    expect(row.event_date).toBeNull();
    expect(row.starts_at?.toISOString()).toBe("2026-03-10T12:30:00.000Z"); // 09:30 hora de Buenos Aires
  });

  it("listados y detalle no se rompen con date_only/unknown y ordenan por su día (los sin fecha, al final)", async () => {
    const db = await getDb();
    const insert = (key: string, precision: string, day: string | null) =>
      db
        .insertInto("meetings")
        .values({ owner_organization_id: ownerOrgId, name: `Lista ${key}`, created_by: userId, origin: "import", source_event_key: `t:list-${key}`, starts_at: null, ends_at: null, schedule_precision: precision, event_date: day } as never)
        .returning("id")
        .executeTakeFirstOrThrow();
    const dateOnly = await insert("d", "date_only", "2099-01-01");
    await insert("u", "unknown", null);
    const list = await listMeetings(actor);
    const names = list.map((m: any) => m.name);
    expect(names.indexOf("Lista d")).toBeLessThan(names.indexOf("Lista u"));
    expect(names.indexOf("Lista d")).toBe(0); // 2099 es la más futura
    const item = list.find((m: any) => m.name === "Lista d") as any;
    expect(item.startsAt).toBeNull();
    expect(item.schedulePrecision).toBe("date_only");
    const detail = await getMeetingById(actor, dateOnly.id);
    expect(detail).toBeTruthy();
    expect((detail as any).schedulePrecision).toBe("date_only");
  });
});

describe("apply protegido sobre PGlite (datos sintéticos)", () => {
  const dniA = "41000001";
  const dniB = "41000002";
  const dniC = "41000003";

  // Mismos archivos (mismo SHA-256) en cada corrida: así se prueba la idempotencia real.
  const fixed = [
    fx.f09File([{ last: "Alfa", first: "Ana", dni: dniA, email: "ana@example.com" }], { residual: true }),
    fx.f07File([{ last: "Alfa", first: "Ana", cuil: fx.cuilFor(dniA), organism: "Cultura" }]),
    fx.f10File([{ last: "Beta", first: "Bruno", cuil: fx.cuilFor(dniB) }], [{ last: "Ref", first: "Sin Cuil", phone: "1155550000" }]),
    fx.courseListFile("F02", "52010-RCP CRUZ MALTA.xlsx", { code: "52010", when: "09/09/2026 10 a 13 hs" }, [{ cuil: fx.cuilFor(dniC), last: "Gamma", first: "Carla" }]),
    fx.pdfResponsesFile("F01", "R.C.P -Cruz Malta (Respuestas).pdf", [{ cuil: fx.cuilFor(dniC), fullName: "GAMMA CARLA" }]),
    fx.agendaFile([["martes", "2026-03-10", "educacion 1"], ["martes", "2026-03-10", "educación 2"], ["miercoles", "2026-03-11", "canale"], ["martes", null, null]]),
    fx.pdfResponsesFile("F03", "AGC-CAPACITACION 2026 (Respuestas).pdf", [{ cuil: fx.cuilFor("41000004"), fullName: "DELTA DIEGO" }]),
  ];

  it("escribe con el rol runtime sutecba_app (sin GRANT nuevos), simulando el chequeo de production", async () => {
    const ledger = await readLedger();
    const env = { ...loadEnv(), SUTECBA_ENV: "production" as const };
    const before = await count("meeting_attendance");
    const result = await asRuntimeRole(() => apply(fixed, { env, ledger: async () => ledger }));

    expect(result.runtimeRole).toBe("sutecba_app");
    expect(result.outcome).toBe("applied");
    expect(result.peopleCreated).toBe(4); // A, B, C, D (D: F03, solo identidad)
    expect(result.meetingsCreated).toBe(3); // training:52010 + educación 10/03 (1 y 2 = una) + canale 11/03
    expect(await count("meeting_attendance")).toBe(before);
  });

  it("crea personas por DNI canónico con procedencia, sin unidad (no hay organismos cargados) y sin asistencia", async () => {
    const db = await getDb();
    const people = await db.selectFrom("people").selectAll().where("origin", "=", "import" as never).where("dni", "in", [dniA, dniB, dniC, "41000004"]).orderBy("dni").execute();
    expect(people.map((p) => p.dni)).toEqual([dniA, dniB, dniC, "41000004"]);
    expect(people.every((p) => p.organization_id === null)).toBe(true);
    const byDni = new Map(people.map((p) => [p.dni, p as any]));
    expect(byDni.get(dniA).dni_source).toBe("explicit");
    expect(byDni.get(dniA).cuil_cuit).toBe(fx.cuilFor(dniA));
    expect(byDni.get(dniB).dni_source).toBe("derived_from_cuil");
    // Ninguna organización fue creada por el importador.
    const orgs = await db.selectFrom("organizations").select("name").execute();
    expect(orgs.map((o) => o.name)).toEqual(["Unidad de prueba"]);
  });

  it("los eventos con día pero sin hora quedan date_only SIN ninguna hora inventada; con franja real, exact_datetime", async () => {
    const db = await getDb();
    const meetings = await db.selectFrom("meetings").selectAll().where("origin", "=", "import" as never).where("source_event_key", "not like", "t:%").execute();
    const byKey = new Map(meetings.map((m) => [m.source_event_key, m as any]));

    const oftalmo = byKey.get("ophthalmology:2026-03-10:educacion");
    expect(oftalmo).toMatchObject({ schedule_precision: "date_only", starts_at: null, ends_at: null, meeting_type: "operativo_salud" });
    expect((oftalmo.event_date as Date).toISOString().slice(0, 10)).toBe("2026-03-10");
    expect(meetings.filter((m) => m.source_event_key?.startsWith("ophthalmology:2026-03-10"))).toHaveLength(1);

    const rcp = byKey.get("training:52010");
    expect(rcp.schedule_precision).toBe("exact_datetime");
    expect(rcp.starts_at.toISOString()).toBe("2026-09-09T13:00:00.000Z"); // 10:00 en Buenos Aires
    expect(rcp.ends_at.toISOString()).toBe("2026-09-09T16:00:00.000Z");

    // Ninguna reunión importada sin precisión exacta guarda una hora "técnica".
    expect(meetings.filter((m: any) => m.schedule_precision !== "exact_datetime").every((m: any) => m.starts_at === null && m.ends_at === null)).toBe(true);
    expect(meetings.some((m) => m.source_event_key?.includes("null"))).toBe(false);
  });

  it("las inscripciones existen, una por (destino, persona), y ninguna es 'attended'", async () => {
    const db = await getDb();
    const rows = (await db.selectFrom("meeting_participations").selectAll().execute()).filter((r) => r.import_row_id !== null);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.participation_kind === "registration")).toBe(true);
    const keys = rows.map((r) => `${r.meeting_id ?? r.campaign_key}:${r.person_id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("conserva el crudo de cada fila, incluidas las que no crean persona, con incidencias", async () => {
    const db = await getDb();
    const issues = await db.selectFrom("import_issues").select("code" as never).execute();
    const codes = new Set(issues.map((i: any) => i.code));
    expect(codes.has("MISSING_CANONICAL_DNI")).toBe(true);
    expect(codes.has("MISSING_EVENT_DATE")).toBe(true);
    expect(codes.has("ORGANISM_UNMAPPED")).toBe(true);
    const raws = await db.selectFrom("import_rows").select("raw_data" as never).execute();
    expect(raws.every((r: any) => r.raw_data && typeof r.raw_data === "object")).toBe(true);
    expect(await db.selectFrom("people").select("id").where("last_name", "=", "Ref").execute()).toHaveLength(0);
  });

  it("deja el lote distinguible de un dry-run: modo apply, plan_hash, actor, momento, conteos y estado final; sin datos personales", async () => {
    const db = await getDb();
    const batch = (await db.selectFrom("import_batches").selectAll().where("plan_hash", "=", planFromSources(fixed).planHash).orderBy("created_at").executeTakeFirstOrThrow()) as any;
    expect(batch).toMatchObject({ execution_mode: "apply", status: "applied", source_system: "gabriel-historical", sutecba_env: "production", created_by: userId, responsible_user_id: userId, owner_organization_id: ownerOrgId });
    expect(batch.applied_at).toBeInstanceOf(Date);
    expect(batch.completed_at).toBeInstanceOf(Date);
    expect(batch.summary.outcome).toBe("applied");
    expect(batch.summary.people.created).toBe(4);
    expect(batch.summary.attendance_created).toBe(0);
    expect(batch.summary.files).toHaveLength(7);

    const text = JSON.stringify(batch.summary);
    for (const pii of [dniA, dniB, "ana@example.com", "Alfa", "Ana", fx.cuilFor(dniA)]) expect(text).not.toContain(pii);


    const linkedFiles = await db.selectFrom("import_batch_files").select("file_id").where("batch_id", "=", batch.id).execute();
    expect(linkedFiles).toHaveLength(7);
  });

  it("segunda ejecución idéntica: no-op explícito, 0 personas / reuniones / participaciones / filas nuevas", async () => {
    const before = await snapshot();
    const second = await apply(fixed);
    expect(second.outcome).toBe("noop_idempotent");
    expect(second.peopleCreated).toBe(0);
    expect(second.meetingsCreated).toBe(0);
    expect(second.participationsCreated).toBe(0);
    expect(second.rowsInserted).toBe(0);
    expect(second.issuesInserted).toBe(0);
    const after = await snapshot();
    // Solo se agrega la traza del lote no-op; nada de negocio.
    expect({ ...after, batches: before.batches }).toEqual(before);
    expect(after.batches).toBe(before.batches + 1);
    const db = await getDb();
    const noopBatch = (await db.selectFrom("import_batches").select("summary").where("id", "=", second.batchId).executeTakeFirstOrThrow()) as any;
    expect(noopBatch.summary.outcome).toBe("noop_idempotent");
  });

  it("una persona ya existente no se transfiere ni se pisa: solo se completan vacíos inequívocos", async () => {
    const db = await getDb();
    const otherOrg = await createTestOrganization("Otra unidad");
    const dni = "42000001";
    const existing = await db
      .insertInto("people")
      .values({ first_name: "Existente", last_name: "Persona", dni, organization_id: otherOrg, email: "propio@example.com", origin: "manual" as never })
      .returning("id")
      .executeTakeFirstOrThrow();
    const files = [fx.f09File([{ last: "Persona", first: "Existente", dni, email: "distinto@example.com", phone: "1155557777", organism: "Cultura" }])];
    const result = await apply(files);
    expect(result.peopleCreated).toBe(0);
    expect(result.peopleFilled).toBe(1); // solo el teléfono estaba vacío
    const row = await db.selectFrom("people").selectAll().where("id", "=", existing.id).executeTakeFirstOrThrow();
    expect(row.organization_id).toBe(otherOrg);
    expect(row.email).toBe("propio@example.com");
    expect(row.phone).toBeTruthy();
    expect(row.origin).toBe("manual");
  });

  it("organismo: se asigna SOLO por alias aprobado hacia una unidad activa; el nombre de la unidad o un alias pendiente no alcanzan", async () => {
    const db = await getDb();
    const cultura = await createTestOrganization("Cultura");
    await createTestOrganization("Salud"); // existe y se llama igual que el texto, pero sin alias aprobado
    const pendienteOrg = await createTestOrganization("Unidad Pendiente");
    const inactiva = await createTestOrganization("Unidad Inactiva Alias");
    await db.updateTable("organizations").set({ active: false }).where("id", "=", inactiva).execute();
    const alias = (org: string, text: string, status: "approved" | "pending") =>
      db
        .insertInto("organization_aliases")
        .values({ organization_id: org, alias: text, status, ...(status === "approved" ? { approved_by: userId, approved_at: new Date() } : {}) } as never)
        .execute();
    await alias(cultura, "CULTURA", "approved");
    await alias(pendienteOrg, "Texto Pendiente", "pending");
    await alias(inactiva, "Texto De Unidad Inactiva", "approved");

    const files = [
      fx.f09File([
        { last: "Con", first: "Alias", dni: "42000010", email: "cu@example.com", organism: "cultura" },
        { last: "Sin", first: "Alias", dni: "42000011", email: "su@example.com", organism: "Ministerio inexistente" },
        { last: "Por", first: "Nombre", dni: "42000012", email: "pn@example.com", organism: "Salud" },
        { last: "Alias", first: "Pendiente", dni: "42000013", email: "ap@example.com", organism: "Texto Pendiente" },
        { last: "Unidad", first: "Inactiva", dni: "42000014", email: "ui@example.com", organism: "Texto De Unidad Inactiva" },
      ]),
    ];
    await apply(files);
    const rows = await db.selectFrom("people").select(["dni", "organization_id"]).where("dni", "in", ["42000010", "42000011", "42000012", "42000013", "42000014"]).orderBy("dni").execute();
    expect(rows).toEqual([
      { dni: "42000010", organization_id: cultura },
      { dni: "42000011", organization_id: null },
      { dni: "42000012", organization_id: null },
      { dni: "42000013", organization_id: null },
      { dni: "42000014", organization_id: null },
    ]);
    // Sigue sin crearse ninguna unidad nueva desde texto libre.
    expect(await db.selectFrom("organizations").select("name").where("name", "in", ["Ministerio inexistente", "Texto Pendiente"]).execute()).toHaveLength(0);
  });

  it("un conflicto material de identidad bloquea a la persona: no se crea, ni se vincula, y queda la incidencia", async () => {
    const db = await getDb();
    const dni = "42000020";
    const files = [
      fx.f09File([{ last: "Vega", first: "Elena", dni, email: "elena@example.com" }]),
      fx.f07File([{ last: "Otro", first: "Nombre", cuil: fx.cuilFor(dni), organism: "Cultura" }]),
    ];
    const result = await apply(files);
    expect(result.peopleCreated).toBe(0);
    expect(await db.selectFrom("people").select("id").where("dni", "=", dni).execute()).toHaveLength(0);
    const blocked = await db.selectFrom("import_issues").select("id").where("code", "=", "BLOCKED_IDENTITY_CONFLICT").execute();
    expect(blocked.length).toBeGreaterThan(0);
    expect(result.summary).toMatchObject({ people: { blocked_identity: 1 } });
  });

  it("un campo opcional contradictorio se crea vacío y con incidencia (no elige uno)", async () => {
    const db = await getDb();
    const dni = "42000030";
    await apply([
      fx.f09File([{ last: "Paz", first: "Ana", dni, email: "uno@example.com" }]),
      fx.f07File([{ last: "Paz", first: "Ana", cuil: fx.cuilFor(dni), email: "dos@example.com", organism: "Cultura" }]),
    ]);
    const person = await db.selectFrom("people").select(["email", "first_name"]).where("dni", "=", dni).executeTakeFirstOrThrow();
    expect(person.first_name).toBe("Ana");
    expect(person.email).toBeNull();
  });
});

describe("apply: abortos y rollback total", () => {
  const fixedFiles = [
    fx.f09File([{ last: "Rollback", first: "Uno", dni: "43000001", email: "rb1@example.com" }]),
    fx.courseListFile("F02", "52099-RCP.xlsx", { code: "52099", when: "10/10/2026 10 a 13 hs" }, [{ cuil: fx.cuilFor("43000002"), last: "Rollback", first: "Dos" }]),
    fx.agendaFile([["martes", "2026-04-07", "rollback"]]),
  ];

  it("hash del plan distinto al aprobado: aborta sin escribir nada", async () => {
    const before = await snapshot();
    await rejects(apply(fixedFiles, { confirmedPlanHash: "0".repeat(64) }), /hash del plan/);
    expect(await snapshot()).toEqual(before);
  });

  it("si un archivo cambió respecto del aprobado, el hash ya no coincide y aborta", async () => {
    const approved = planFromSources(fixedFiles).planHash;
    const tampered = fixedFiles.map((f, i) => (i === 0 ? { ...f, sha256: "b".repeat(64) } : f));
    const before = await snapshot();
    await rejects(apply(tampered, { confirmedPlanHash: approved }), /hash del plan/);
    expect(await snapshot()).toEqual(before);
  });

  it("production con la conexión administrativa (postgres/superusuario) aborta: el negocio no escribe con esa conexión", async () => {
    const before = await snapshot();
    await rejects(apply(fixedFiles, { env: { ...loadEnv(), SUTECBA_ENV: "production" } }), /rol runtime sutecba_app/);
    expect(await snapshot()).toEqual(before);
  });

  it("migraciones pendientes, 0021 sin aplicar o base ajena: aborta", async () => {
    const ledger = await readLedger();
    const before = await snapshot();
    await rejects(apply(fixedFiles, { ledger: async () => ({ ...ledger, migrations: ledger.migrations.filter((m) => !m.startsWith("0020")) }) }), /pendiente/);
    await rejects(apply(fixedFiles, { ledger: async () => ({ ...ledger, migrations: ledger.migrations.filter((m) => !m.startsWith("0021")) }) }), /0021/);
    await rejects(apply(fixedFiles, { ledger: async () => ({ ...ledger, system: "otro-sistema" }) }), /sutecba-crm/);
    await rejects(apply(fixedFiles, { ledger: async () => ({ ...ledger, database: "otra_base" }) }), /bases distintas/);
    expect(await snapshot()).toEqual(before);
  });

  it("actor inexistente, inactivo o sin autoridad; unidad inexistente o inactiva: aborta", async () => {
    const inactive = await makeUser("inactivo@sutecba.local", "MASTER_GLOBAL", "inactive");
    const db = await getDb();
    const lowRole = (await db.selectFrom("roles").select("key").where("key", "!=", "MASTER_GLOBAL").executeTakeFirstOrThrow()).key;
    const low = await makeUser("bajo@sutecba.local", lowRole);
    const inactiveOrg = await createTestOrganization("Unidad inactiva");
    await db.updateTable("organizations").set({ active: false }).where("id", "=", inactiveOrg).execute();
    const before = await snapshot();

    await rejects(apply(fixedFiles, { createdBy: randomUUID() }), /no existe/);
    await rejects(apply(fixedFiles, { createdBy: inactive.id }), /no está activo/);
    await rejects(apply(fixedFiles, { createdBy: low.id }), /autoridad suficiente/);
    await rejects(apply(fixedFiles, { ownerOrganizationId: randomUUID() }), /no existe/);
    await rejects(apply(fixedFiles, { ownerOrganizationId: inactiveOrg }), /no está activa/);
    expect(await snapshot()).toEqual(before);
  });

  it("el apply toma el lock transaccional (un solo apply a la vez) antes de escribir", async () => {
    const db = await getDb();
    await sql`
      create or replace function test_require_import_lock() returns trigger language plpgsql as $$
      begin
        if not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted) then
          raise exception 'apply sin lock advisory';
        end if;
        return new;
      end $$
    `.execute(db);
    await sql`create trigger test_require_import_lock before insert on people for each row execute function test_require_import_lock()`.execute(db);
    try {
      const result = await apply(fixedFiles);
      expect(result.peopleCreated).toBe(2);
    } finally {
      await sql`drop trigger test_require_import_lock on people`.execute(db);
    }
    // Fuera de la transacción el lock ya no está tomado (es transaccional).
    const held = await sql<{ n: number }>`select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`.execute(db);
    expect(held.rows[0]!.n).toBe(0);
  });

  it("una falla en una etapa tardía revierte TODO: sin personas, reuniones, participaciones, filas ni lote", async () => {
    const db = await getDb();
    const rollbackFiles = [
      fx.f09File([{ last: "Tardia", first: "Falla", dni: "44000001", email: "tf@example.com" }]),
      fx.courseListFile("F02", "52098-RCP.xlsx", { code: "52098", when: "11/11/2026 10 a 13 hs" }, [{ cuil: fx.cuilFor("44000002"), last: "Tardia", first: "Falla2" }]),
      fx.agendaFile([["martes", "2026-05-05", "tardia"]]),
    ];
    const before = await snapshot();
    await sql`create or replace function test_fail_participation() returns trigger language plpgsql as $$ begin raise exception 'falla inyectada'; end $$`.execute(db);
    await sql`create trigger test_fail_participation before insert on meeting_participations for each row execute function test_fail_participation()`.execute(db);
    try {
      await rejects(apply(rollbackFiles), /falla inyectada/);
    } finally {
      await sql`drop trigger test_fail_participation on meeting_participations`.execute(db);
    }
    expect(await snapshot()).toEqual(before);
    expect(await db.selectFrom("people").select("id").where("dni", "in", ["44000001", "44000002"]).execute()).toHaveLength(0);
    expect(await db.selectFrom("meetings").select("id").where("source_event_key", "in", ["training:52098", "ophthalmology:2026-05-05:tardia"]).execute()).toHaveLength(0);

    // Y sin el fallo el mismo plan se aplica completo: no quedó nada a medias.
    const ok = await apply(rollbackFiles);
    expect(ok.outcome).toBe("applied");
    expect(ok.peopleCreated).toBe(2);
    expect(ok.meetingsCreated).toBe(2);
  });
});
