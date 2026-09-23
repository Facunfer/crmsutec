import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
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
const { createForm, updateFormMeta, upsertField, removeField, publishForm, changeFormStatus, FormCommandError } = await import("../../lib/forms/commands.js");
const { submitForm } = await import("../../lib/forms/submit.js");
const { dniPublishError, DNI_REQUIRED_TO_PUBLISH_MESSAGE } = await import("../../lib/forms/publish-rules.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL_PERMISSIONS = new Set(PERMISSIONS.map((p) => p.key));
const MESSAGE = "Para publicar este formulario necesitás incluir un campo DNI obligatorio.";

let actor: any;
let ownerOrgId: string;
let ipCounter = 0;
let slugCounter = 0;
const nextIp = () => `10.7.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  ownerOrgId = await createTestOrganization();
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({ email: "publish-actor@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  actor = { id: user.id, email: "publish-actor@sutecba.local", fullName: "Actor", roleId: role.id, roleKey: "MASTER_GLOBAL", mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions: ALL_PERMISSIONS };
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

type FieldSpec = { key: string; label: string; fieldType: string; required: boolean; visible: boolean; personFieldMapping: string | null };
const nameFields: FieldSpec[] = [
  { key: "first_name", label: "Nombre", fieldType: "text", required: true, visible: true, personFieldMapping: "first_name" },
  { key: "last_name", label: "Apellido", fieldType: "text", required: true, visible: true, personFieldMapping: "last_name" },
];
const goodDni: FieldSpec = { key: "dni", label: "DNI", fieldType: "dni", required: true, visible: true, personFieldMapping: "dni" };

async function makeDraft(extra: FieldSpec[]) {
  const slug = `pub-dni-${++slugCounter}`;
  const { id } = await createForm(actor, { ownerOrganizationId: ownerOrgId, name: slug, slug });
  await updateFormMeta(actor, id, { name: slug, slug, consentText: "", successMessage: "", opensAt: "", closesAt: "", matchFields: ["dni"], updatePolicy: "fill_empty_only" });
  for (const f of [...nameFields, ...extra]) await upsertField(actor, id, null, f as any);
  return { id, slug };
}

const publishError = (id: string) => publishForm(actor, id).then(() => null, (e) => e);

describe("publicar formularios: exige exactamente un campo DNI utilizable", () => {
  it("un borrador SIN DNI se puede diseñar y guardar (y editar)", async () => {
    const { id } = await makeDraft([]);
    const db = await getDb();
    const form = await db.selectFrom("forms").select("status").where("id", "=", id).executeTakeFirstOrThrow();
    expect(form.status).toBe("draft");
    await upsertField(actor, id, null, { key: "email", label: "Email", fieldType: "email", required: false, visible: true, personFieldMapping: "email" } as any);
  });

  it("publicar sin DNI: rechazado con el mensaje claro", async () => {
    const { id } = await makeDraft([]);
    const err = await publishError(id);
    expect(err).toBeInstanceOf(FormCommandError);
    expect(err.message).toBe(MESSAGE);
    const db = await getDb();
    expect((await db.selectFrom("forms").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status).toBe("draft");
    expect(await db.selectFrom("form_versions").select("id").where("form_id", "=", id).execute()).toHaveLength(0);
  });

  it("un campo cuya etiqueta dice 'DNI' pero NO está mapeado a people.dni no alcanza", async () => {
    const { id } = await makeDraft([{ ...goodDni, key: "documento", personFieldMapping: null }]);
    expect((await publishError(id)).message).toBe(MESSAGE);
    const { id: id2 } = await makeDraft([{ ...goodDni, key: "documento", personFieldMapping: "email" }]);
    expect((await publishError(id2)).message).toBe(MESSAGE);
  });

  it("DNI mapeado pero NO obligatorio: rechazado", async () => {
    const { id } = await makeDraft([{ ...goodDni, required: false }]);
    expect((await publishError(id)).message).toBe(MESSAGE);
  });

  it("DNI mapeado pero oculto: rechazado", async () => {
    const { id } = await makeDraft([{ ...goodDni, visible: false }]);
    expect((await publishError(id)).message).toBe(MESSAGE);
  });

  it("DNI mapeado con un tipo incompatible (texto libre): rechazado", async () => {
    const { id } = await makeDraft([{ ...goodDni, fieldType: "text" }]);
    expect((await publishError(id)).message).toBe(MESSAGE);
  });

  it("dos campos distintos mapeados a DNI: rechazado por ambiguo (aunque uno sea válido)", async () => {
    const { id } = await makeDraft([goodDni, { ...goodDni, key: "dni_2", label: "DNI (otra vez)" }]);
    const err = await publishError(id);
    expect(err).toBeInstanceOf(FormCommandError);
    expect(err.message).toMatch(/más de un campo mapeado a DNI/);
    const { id: id2 } = await makeDraft([goodDni, { ...goodDni, key: "dni_oculto", visible: false, required: false }]);
    expect((await publishError(id2)).message).toMatch(/más de un campo mapeado a DNI/);
  });

  it("DNI visible + obligatorio + tipo dni + mapeo correcto: se publica y crea personas", async () => {
    const { id, slug } = await makeDraft([goodDni]);
    await expect(publishForm(actor, id)).resolves.toEqual({ version: 1 });
    const result = await submitForm(slug, { first_name: "Ana", last_name: "Gomez", dni: "32.100.001" }, randomUUID(), nextIp(), "agent");
    expect(result.kind).toBe("ok");
    const db = await getDb();
    expect(await db.selectFrom("people").select("id").where("dni", "=", "32100001").execute()).toHaveLength(1);
  });

  it("un formulario ya publicado con configuración válida sigue funcionando aunque el borrador se edite después", async () => {
    const { id, slug } = await makeDraft([goodDni]);
    await publishForm(actor, id);
    const db = await getDb();
    // Se edita el borrador quitando el DNI: la versión publicada (snapshot) no cambia y sigue recibiendo envíos.
    const dniField = await db.selectFrom("form_fields").select("id").where("form_id", "=", id).where("key", "=", "dni").executeTakeFirstOrThrow();
    await removeField(actor, id, dniField.id);
    const result = await submitForm(slug, { first_name: "Beto", last_name: "Paz", dni: "32100002" }, randomUUID(), nextIp(), "agent");
    expect(result.kind).toBe("ok");
    expect(await db.selectFrom("people").select("id").where("dni", "=", "32100002").execute()).toHaveLength(1);
    // Pero publicar una versión NUEVA con ese borrador roto sí se rechaza.
    expect((await publishError(id)).message).toBe(MESSAGE);
  });

  it("despublicar y volver a publicar una versión válida funciona; una versión legacy sin DNI válido no se reactiva", async () => {
    const good = await makeDraft([goodDni]);
    await publishForm(actor, good.id);
    await changeFormStatus(actor, good.id, "unpublished");
    await expect(changeFormStatus(actor, good.id, "published")).resolves.toBeUndefined();

    const legacy = await makeDraft([goodDni]);
    await publishForm(actor, legacy.id);
    const db = await getDb();
    const version = await db.selectFrom("form_versions").select(["id", "schema"]).where("form_id", "=", legacy.id).executeTakeFirstOrThrow();
    const schema = version.schema as any;
    schema.fields = schema.fields.filter((f: any) => f.key !== "dni");
    await db.updateTable("form_versions").set({ schema: JSON.stringify(schema) as never }).where("id", "=", version.id).execute();
    await changeFormStatus(actor, legacy.id, "unpublished");
    await expect(changeFormStatus(actor, legacy.id, "published")).rejects.toThrow(MESSAGE);
  });
});

describe("regla pura de publicación", () => {
  const f = (over: Record<string, unknown> = {}) => ({ fieldType: "dni", required: true, visible: true, personFieldMapping: "dni", ...over }) as any;
  it("solo pasa con exactamente un campo dni visible, obligatorio y de tipo dni", () => {
    expect(dniPublishError([f()])).toBeNull();
    expect(dniPublishError([])).toBe(DNI_REQUIRED_TO_PUBLISH_MESSAGE);
    expect(dniPublishError([f({ required: false })])).toBe(MESSAGE);
    expect(dniPublishError([f({ visible: false })])).toBe(MESSAGE);
    expect(dniPublishError([f({ fieldType: "number" })])).toBe(MESSAGE);
    expect(dniPublishError([f({ personFieldMapping: null })])).toBe(MESSAGE);
    expect(dniPublishError([f(), f()])).toMatch(/más de un campo/);
  });
});
