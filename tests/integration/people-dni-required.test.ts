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
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { createPerson, updatePerson, PersonCommandError } = await import("../../lib/people/commands.js");
const { createForm, updateFormMeta, upsertField, publishForm } = await import("../../lib/forms/commands.js");
const { submitForm } = await import("../../lib/forms/submit.js");
const { createNewFromCandidate } = await import("../../lib/forms/duplicates.js");
const { listPendingDuplicateCandidates } = await import("../../lib/forms/queries.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL_PERMISSIONS = new Set(PERMISSIONS.map((p) => p.key));

let actor: any;
let ownerOrgId: string;
let ipCounter = 0;
const nextIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  ownerOrgId = await createTestOrganization();
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({ email: "dni-actor@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  actor = {
    id: user.id,
    email: "dni-actor@sutecba.local",
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

const peopleCount = async () => {
  const db = await getDb();
  return Number((await db.selectFrom("people").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);
};

const insertPerson = async (values: Record<string, unknown>) => {
  const db = await getDb();
  return db.insertInto("people").values({ first_name: "P", last_name: "Q", ...values } as never).returning("id").executeTakeFirstOrThrow();
};

const input = (over: Record<string, unknown> = {}) =>
  ({ firstName: "Nueva", lastName: "Persona", dni: "", email: "", phone: "", organizationId: "", birthDate: "", declaredAge: "", ...over }) as any;

describe("PostgreSQL: el DNI es obligatorio y canónico para TODA persona", () => {
  it.each(["manual", "form", "import"])("origin=%s sin DNI (omitido o NULL) se rechaza", async (origin) => {
    const db = await getDb();
    await expect(db.insertInto("people").values({ first_name: "A", last_name: "B", origin } as never).execute()).rejects.toThrow();
    await expect(db.insertInto("people").values({ first_name: "A", last_name: "B", dni: null, origin } as never).execute()).rejects.toThrow();
  });

  it.each(["", " ", "12.345.678", "12 345 678", "12-345-678", " 12345678", "12345678 ", "123456", "123456789", "1234567a", "abcdefgh", "０１２３４５６７"])(
    "un DNI no canónico (%j) se rechaza",
    async (dni) => {
      await expect(insertPerson({ dni })).rejects.toThrow();
    }
  );

  it("acepta solo 7 u 8 dígitos", async () => {
    await insertPerson({ dni: "1234567" });
    await insertPerson({ dni: "12345678" });
  });

  it("UPDATE tampoco puede dejar a una persona sin DNI ni con DNI no canónico", async () => {
    const db = await getDb();
    const p = await insertPerson({ dni: "20000001" });
    await expect(db.updateTable("people").set({ dni: null } as never).where("id", "=", p.id).execute()).rejects.toThrow();
    await expect(db.updateTable("people").set({ dni: "20.000.001" }).where("id", "=", p.id).execute()).rejects.toThrow();
  });
});

describe("PostgreSQL: una sola persona vigente por DNI", () => {
  it("dos inserciones con el mismo DNI: la segunda falla (activa, inactiva o cualquier estado no fusionado)", async () => {
    const db = await getDb();
    await insertPerson({ dni: "21000001" });
    await expect(insertPerson({ dni: "21000001" })).rejects.toThrow();
    const inactive = await insertPerson({ dni: "21000002", status: "inactive" });
    await expect(insertPerson({ dni: "21000002" })).rejects.toThrow();
    // Reactivar/desactivar no abre un hueco.
    await db.updateTable("people").set({ status: "active" }).where("id", "=", inactive.id).execute();
    await expect(insertPerson({ dni: "21000002", status: "inactive" })).rejects.toThrow();
  });

  it("concurrencia: N altas simultáneas con el mismo DNI producen EXACTAMENTE una persona vigente", async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => insertPerson({ dni: "21000010", first_name: `Carrera${i}` })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(9);
    const db = await getDb();
    const rows = await db.selectFrom("people").select("id").where("dni", "=", "21000010").where("status", "!=", "merged").execute();
    expect(rows).toHaveLength(1);
  });

  it("concurrencia por el dominio: createPerson simultáneos con el mismo DNI → una persona y el resto recibe el conflicto genérico", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => createPerson(actor, input({ dni: "21.000.020" }))));
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(5);
    for (const f of failed) {
      expect(f.reason).toBeInstanceOf(PersonCommandError);
      expect((f.reason as any).code).toBe("IDENTITY_CONFLICT");
    }
    const db = await getDb();
    const stored = await db.selectFrom("people").select("dni").where("dni", "like", "2100002%").execute();
    expect(stored).toEqual([{ dni: "21000020" }]); // guardado sin puntos
  });

  it("una persona fusionada conserva su DNI histórico y su merged_into_id, y libera el DNI vigente", async () => {
    const db = await getDb();
    const old = await insertPerson({ dni: "22000001" });
    const target = await insertPerson({ dni: "22000002" });
    await db.updateTable("people").set({ status: "merged", merged_into_id: target.id }).where("id", "=", old.id).execute();

    const merged = await db.selectFrom("people").select(["dni", "status", "merged_into_id"]).where("id", "=", old.id).executeTakeFirstOrThrow();
    expect(merged).toEqual({ dni: "22000001", status: "merged", merged_into_id: target.id });

    // El DNI histórico puede volver a usarse por UNA persona vigente…
    await insertPerson({ dni: "22000001" });
    // …y no por dos, ni "des-fusionando" a la vieja mientras haya otra vigente.
    await expect(insertPerson({ dni: "22000001" })).rejects.toThrow();
    await expect(db.updateTable("people").set({ status: "active" }).where("id", "=", old.id).execute()).rejects.toThrow();
    // El historial admite varias fusionadas con el mismo DNI.
    const another = await insertPerson({ dni: "22000003" });
    await db.updateTable("people").set({ dni: "22000001", status: "merged", merged_into_id: target.id }).where("id", "=", another.id).execute();
  });

  it("'merged' exige apuntar a otra persona (nunca a sí misma ni a nadie)", async () => {
    const db = await getDb();
    const p = await insertPerson({ dni: "22000010" });
    await expect(db.updateTable("people").set({ status: "merged" }).where("id", "=", p.id).execute()).rejects.toThrow();
    await expect(db.updateTable("people").set({ status: "merged", merged_into_id: p.id }).where("id", "=", p.id).execute()).rejects.toThrow();
  });

  it("el índice de unicidad es parcial sobre status <> 'merged' y no hay UNIQUE sobre cuil_cuit", async () => {
    const db = await getDb();
    const idx = await sql<{ indexdef: string }>`select indexdef from pg_indexes where tablename = 'people' and indexname = 'people_dni_unique_idx'`.execute(db);
    expect(idx.rows[0]!.indexdef).toMatch(/CREATE UNIQUE INDEX .*\(dni\).*status/i);
    const uniques = await sql<{ n: number }>`
      select count(*)::int as n from pg_indexes where tablename = 'people' and indexdef ilike '%unique%' and indexdef ilike '%cuil_cuit%'`.execute(db);
    expect(uniques.rows[0]!.n).toBe(0);
  });
});

describe("dominio: alta manual y edición sin DNI", () => {
  it("createPerson sin DNI → error de validación y no se inserta nada", async () => {
    const before = await peopleCount();
    for (const dni of ["", "   ", undefined]) {
      const err = await createPerson(actor, input({ dni })).catch((e) => e);
      expect(err).toBeInstanceOf(PersonCommandError);
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toMatch(/DNI es obligatorio/);
    }
    const bad = await createPerson(actor, input({ dni: "123" })).catch((e) => e);
    expect(bad.code).toBe("VALIDATION");
    expect(await peopleCount()).toBe(before);
  });

  it("con DNI con puntos se guarda normalizado (solo dígitos)", async () => {
    const created = (await createPerson(actor, input({ dni: "23.000.001" }))) as { id: string };
    const db = await getDb();
    const row = await db.selectFrom("people").select(["dni", "dni_source", "origin"]).where("id", "=", created.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ dni: "23000001", dni_source: "explicit", origin: "manual" });
  });

  it("updatePerson no puede borrar el DNI; sin people.view_sensitive se conserva el guardado", async () => {
    const created = (await createPerson(actor, input({ dni: "23000002", firstName: "Edit" }))) as { id: string };
    const db = await getDb();
    const v1 = (await db.selectFrom("people").select("version").where("id", "=", created.id).executeTakeFirstOrThrow()).version;

    const err = await updatePerson(actor, created.id, v1, input({ dni: "", firstName: "Edit" })).catch((e) => e);
    expect(err).toBeInstanceOf(PersonCommandError);
    expect(err.message).toMatch(/DNI es obligatorio/);

    // Usuario sin ver datos sensibles: el campo DNI viaja vacío (deshabilitado) y NO borra ni cambia el DNI.
    const masked = { ...actor, permissions: new Set([...ALL_PERMISSIONS].filter((p) => p !== "people.view_sensitive")) };
    await updatePerson(masked, created.id, v1, input({ dni: "", firstName: "Editado" }));
    const row = await db.selectFrom("people").select(["dni", "first_name"]).where("id", "=", created.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ dni: "23000002", first_name: "Editado" });
  });
});

describe("formularios: un envío sin DNI no crea personas", () => {
  /**
   * Con la regla de publicación un formulario sin DNI obligatorio ya no se puede publicar. Para probar la defensa en
   * profundidad se simula un formulario LEGACY: se publica bien y después se degrada su snapshot (versión ya publicada),
   * como pasaría con datos anteriores a la regla o con manipulación directa.
   */
  async function makeForm(slug: string, legacy: "none" | "dni-optional" | "no-dni-field" = "none") {
    const { id } = await createForm(actor, { ownerOrganizationId: ownerOrgId, name: slug, slug });
    await updateFormMeta(actor, id, {
      name: slug,
      slug,
      consentText: "",
      successMessage: "",
      opensAt: "",
      closesAt: "",
      matchFields: ["dni", "email"],
      updatePolicy: "fill_empty_only",
    });
    await upsertField(actor, id, null, { key: "first_name", label: "Nombre", fieldType: "text", required: true, visible: true, personFieldMapping: "first_name" });
    await upsertField(actor, id, null, { key: "last_name", label: "Apellido", fieldType: "text", required: true, visible: true, personFieldMapping: "last_name" });
    await upsertField(actor, id, null, { key: "dni", label: "DNI", fieldType: "dni", required: true, visible: true, personFieldMapping: "dni" });
    await upsertField(actor, id, null, { key: "email", label: "Email", fieldType: "email", required: false, visible: true, personFieldMapping: "email" });
    await publishForm(actor, id);
    if (legacy !== "none") {
      const db = await getDb();
      const version = await db.selectFrom("form_versions").select(["id", "schema"]).where("form_id", "=", id).executeTakeFirstOrThrow();
      const schema = version.schema as any;
      schema.fields = schema.fields.flatMap((f: any) => (f.key !== "dni" ? [f] : legacy === "dni-optional" ? [{ ...f, required: false }] : []));
      await db.updateTable("form_versions").set({ schema: JSON.stringify(schema) as never }).where("id", "=", version.id).execute();
    }
    return id;
  }

  it("sin DNI: se conserva el form_submission en revisión, queda un candidato sin persona y NO se crea people", async () => {
    await makeForm("form-sin-dni", "dni-optional");
    const before = await peopleCount();
    const result = await submitForm("form-sin-dni", { first_name: "Sin", last_name: "Documento", dni: "", email: "sin@example.com" }, randomUUID(), nextIp(), "agent");
    expect(result.kind).toBe("ok");
    expect(await peopleCount()).toBe(before);

    const db = await getDb();
    const submission = await db.selectFrom("form_submissions").select(["match_result", "person_id", "raw_payload"]).orderBy("created_at", "desc").executeTakeFirstOrThrow();
    expect(submission.match_result).toBe("needs_review");
    expect(submission.person_id).toBeNull();
    expect(submission.raw_payload).toBeTruthy();

    const queue = await listPendingDuplicateCandidates(actor, true);
    const candidate = queue.find((c) => c.matchReason.includes("DNI"));
    expect(candidate).toBeTruthy();
    expect(candidate!.personId).toBeNull();
  });

  it("un formulario que ni siquiera tiene campo DNI tampoco crea personas", async () => {
    await makeForm("form-sin-campo-dni", "no-dni-field");
    const before = await peopleCount();
    await submitForm("form-sin-campo-dni", { first_name: "Otra", last_name: "Persona", email: "otra@example.com" }, randomUUID(), nextIp(), "agent");
    expect(await peopleCount()).toBe(before);
  });

  it("DNI inválido en el envío: no se crea persona", async () => {
    await makeForm("form-dni-invalido", "dni-optional");
    const before = await peopleCount();
    await submitForm("form-dni-invalido", { first_name: "Mal", last_name: "Dni", dni: "12", email: "" }, randomUUID(), nextIp(), "agent");
    expect(await peopleCount()).toBe(before);
  });

  it("desde la bandeja, 'es una persona nueva' sin DNI también se rechaza (la revisión no puede saltearse la regla)", async () => {
    const db = await getDb();
    const queue = await listPendingDuplicateCandidates(actor, true);
    const candidate = queue.find((c) => c.personId === null)!;
    const before = await peopleCount();
    await expect(createNewFromCandidate(actor, candidate.id)).rejects.toThrow(/DNI/);
    expect(await peopleCount()).toBe(before);
    const still = await db.selectFrom("person_duplicate_candidates").select("status").where("id", "=", candidate.id).executeTakeFirstOrThrow();
    expect(still.status).toBe("pending");
  });

  it("con DNI válido sí crea la persona (origin=form, dni_source=explicit)", async () => {
    await makeForm("form-con-dni");
    await submitForm("form-con-dni", { first_name: "Con", last_name: "Documento", dni: "24.000.001", email: "" }, randomUUID(), nextIp(), "agent");
    const db = await getDb();
    const row = await db.selectFrom("people").select(["dni", "origin", "dni_source"]).where("dni", "=", "24000001").executeTakeFirstOrThrow();
    expect(row).toEqual({ dni: "24000001", origin: "form", dni_source: "explicit" });
  });
});
