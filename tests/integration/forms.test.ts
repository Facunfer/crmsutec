import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const {
  createForm,
  updateFormMeta,
  upsertField,
  publishForm,
  addAssociationAction,
  changeFormStatus,
  FormCommandError,
} = await import("../../lib/forms/commands.js");
const { getPublicForm, submitForm } = await import("../../lib/forms/submit.js");
const { linkDuplicateCandidate, createNewFromCandidate, discardDuplicateCandidate } = await import("../../lib/forms/duplicates.js");
const { createAssociation } = await import("../../lib/associations/commands.js");
const { createFieldDefinition } = await import("../../lib/people/field-definitions.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL_PERMISSIONS = new Set(PERMISSIONS.map((p) => p.key));

let actor: any;
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.8.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

beforeAll(async () => {
  await applyMigrations(parseFlags([]));
  await runSeed();

  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({ email: "forms-actor@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Actor", role_id: role.id })
    .returning("id")
    .executeTakeFirstOrThrow();

  actor = {
    id: user.id,
    email: "forms-actor@sutecba.local",
    fullName: "Actor",
    roleId: role.id,
    roleKey: "MASTER_GLOBAL",
    mustChangePassword: false,
    permissions: ALL_PERMISSIONS,
  };
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function makeBasicForm(name: string, slug: string, opts: { updatePolicy?: "fill_empty_only" | "always_flag_for_review" } = {}) {
  const { id } = await createForm(actor, { name, slug });
  await updateFormMeta(actor, id, {
    name,
    slug,
    consentText: "",
    successMessage: "¡Gracias por sumarte!",
    opensAt: "",
    closesAt: "",
    matchFields: ["dni", "email", "phone"],
    updatePolicy: opts.updatePolicy ?? "fill_empty_only",
  });
  await upsertField(actor, id, null, { key: "first_name", label: "Nombre", fieldType: "text", required: true, visible: true, personFieldMapping: "first_name" });
  await upsertField(actor, id, null, { key: "last_name", label: "Apellido", fieldType: "text", required: true, visible: true, personFieldMapping: "last_name" });
  await upsertField(actor, id, null, { key: "dni", label: "DNI", fieldType: "dni", required: false, visible: true, personFieldMapping: "dni" });
  await upsertField(actor, id, null, { key: "email", label: "Email", fieldType: "email", required: false, visible: true, personFieldMapping: "email" });
  await upsertField(actor, id, null, { key: "phone", label: "Teléfono", fieldType: "phone", required: false, visible: true, personFieldMapping: "phone" });
  return id;
}

function baseEntries(overrides: Record<string, string> = {}): Record<string, string> {
  return { first_name: "Ana", last_name: "Gomez", dni: "", email: "", phone: "", ...overrides };
}

describe("ciclo de vida del constructor: publicar exige nombre y apellido mapeados", () => {
  it("rechaza publicar sin campos, y sin mapeo a nombre/apellido", async () => {
    const { id } = await createForm(actor, { name: "Formulario Vacío", slug: "form-vacio" });
    await expect(publishForm(actor, id)).rejects.toThrow(FormCommandError);

    await upsertField(actor, id, null, { key: "algo", label: "Algo", fieldType: "text", required: false, visible: true, personFieldMapping: "" });
    await expect(publishForm(actor, id)).rejects.toThrow(FormCommandError);
  });

  it("un formulario archivado no se puede editar ni publicar", async () => {
    const id = await makeBasicForm("Formulario Archivable", "form-archivable");
    await changeFormStatus(actor, id, "archived");
    await expect(publishForm(actor, id)).rejects.toThrow(FormCommandError);
    await expect(updateFormMeta(actor, id, { name: "x", slug: "form-archivable", matchFields: [], updatePolicy: "fill_empty_only" } as any)).rejects.toThrow(FormCommandError);
  });
});

describe("versionado: editar después de publicar no reinterpreta la versión ya publicada", () => {
  it("getPublicForm siempre refleja la última versión publicada, no los campos en edición", async () => {
    const id = await makeBasicForm("Formulario Versionado", "form-versionado");
    await publishForm(actor, id);

    const v1 = await getPublicForm("form-versionado");
    expect(v1.kind).toBe("ok");
    if (v1.kind !== "ok") return;
    expect(v1.schema.fields.map((f) => f.key)).toContain("dni");

    // Se agrega un campo nuevo pero NO se vuelve a publicar: la pública sigue viendo la v1.
    await upsertField(actor, id, null, { key: "nota", label: "Nota", fieldType: "text", required: false, visible: true, personFieldMapping: "" });
    const stillV1 = await getPublicForm("form-versionado");
    expect(stillV1.kind).toBe("ok");
    if (stillV1.kind !== "ok") return;
    expect(stillV1.schema.fields.map((f) => f.key)).not.toContain("nota");

    await publishForm(actor, id);
    const v2 = await getPublicForm("form-versionado");
    expect(v2.kind).toBe("ok");
    if (v2.kind !== "ok") return;
    expect(v2.schema.fields.map((f) => f.key)).toContain("nota");
  });
});

describe("envío público: crea, matchea (fill_empty_only) y nunca pisa un dato ya cargado", () => {
  it("primer envío crea una persona nueva; un segundo envío con el mismo DNI actualiza solo lo vacío", async () => {
    const id = await makeBasicForm("Formulario Alta", "form-alta");
    await publishForm(actor, id);

    const first = await submitForm("form-alta", baseEntries({ dni: "30222111", email: "ana@example.com" }), randomUUID(), nextIp(), "agent");
    expect(first.kind).toBe("ok");

    const db = await getDb();
    const [person] = await db.selectFrom("people").selectAll().where("dni", "=", "30222111").execute();
    expect(person?.first_name).toBe("Ana");
    expect(person?.email).toBe("ana@example.com");
    expect(person?.origin).toBe("form");

    const [submission] = await db.selectFrom("form_submissions").selectAll().where("form_id", "=", id).where("person_id", "=", person!.id).execute();
    expect(submission?.match_result).toBe("created");

    // Segundo envío: mismo DNI, distinto teléfono, y un email DISTINTO (que no debería pisar el que ya tiene).
    const second = await submitForm(
      "form-alta",
      baseEntries({ dni: "30222111", email: "otro@example.com", phone: "+541122223333" }),
      randomUUID(),
      nextIp(),
      "agent"
    );
    expect(second.kind).toBe("ok");

    const updated = await db.selectFrom("people").selectAll().where("id", "=", person!.id).executeTakeFirstOrThrow();
    expect(updated.email).toBe("ana@example.com"); // no se pisó
    expect(updated.phone).not.toBeNull(); // se completó porque estaba vacío

    const rows = await db.selectFrom("people").selectAll().where("dni", "=", "30222111").execute();
    expect(rows.length).toBe(1); // nunca se duplicó la persona
  });

  it("un campo mapeado a un campo personalizado se guarda en people.custom_fields", async () => {
    await createFieldDefinition(actor, { key: "talle", label: "Talle de ropa", fieldType: "text" });

    const { id } = await createForm(actor, { name: "Formulario Custom", slug: "form-custom" });
    await updateFormMeta(actor, id, { name: "Formulario Custom", slug: "form-custom", consentText: "", successMessage: "", opensAt: "", closesAt: "", matchFields: ["dni"], updatePolicy: "fill_empty_only" });
    await upsertField(actor, id, null, { key: "first_name", label: "Nombre", fieldType: "text", required: true, visible: true, personFieldMapping: "first_name" });
    await upsertField(actor, id, null, { key: "last_name", label: "Apellido", fieldType: "text", required: true, visible: true, personFieldMapping: "last_name" });
    await upsertField(actor, id, null, { key: "talle_campo", label: "Talle", fieldType: "text", required: false, visible: true, personFieldMapping: "talle" });
    await publishForm(actor, id);

    const result = await submitForm("form-custom", { first_name: "Bruno", last_name: "Diaz", talle_campo: "L" }, randomUUID(), nextIp(), "agent");
    expect(result.kind).toBe("ok");

    const db = await getDb();
    const person = await db.selectFrom("people").selectAll().where("first_name", "=", "Bruno").where("last_name", "=", "Diaz").executeTakeFirstOrThrow();
    expect((person.custom_fields as Record<string, unknown>).talle).toBe("L");
  });

  it("una acción 'sumar a asociación' se aplica a la persona creada", async () => {
    const db0 = await getDb();
    const assocType = await db0.selectFrom("association_types").select("id").where("key", "=", "comision").executeTakeFirstOrThrow();
    const { id: associationId } = await createAssociation(actor, { name: "Asociación De Formulario", typeId: assocType.id });

    const { id } = await createForm(actor, { name: "Formulario Con Accion", slug: "form-con-accion" });
    await updateFormMeta(actor, id, { name: "Formulario Con Accion", slug: "form-con-accion", consentText: "", successMessage: "", opensAt: "", closesAt: "", matchFields: ["dni"], updatePolicy: "fill_empty_only" });
    await upsertField(actor, id, null, { key: "first_name", label: "Nombre", fieldType: "text", required: true, visible: true, personFieldMapping: "first_name" });
    await upsertField(actor, id, null, { key: "last_name", label: "Apellido", fieldType: "text", required: true, visible: true, personFieldMapping: "last_name" });
    await addAssociationAction(actor, id, associationId);
    await publishForm(actor, id);

    await submitForm("form-con-accion", { first_name: "Carla", last_name: "Ruiz" }, randomUUID(), nextIp(), "agent");

    const db = await getDb();
    const person = await db.selectFrom("people").selectAll().where("first_name", "=", "Carla").where("last_name", "=", "Ruiz").executeTakeFirstOrThrow();
    const membership = await db.selectFrom("people_associations").select("id").where("person_id", "=", person.id).where("association_id", "=", associationId).where("status", "=", "active").executeTakeFirst();
    expect(membership).toBeTruthy();
  });
});

describe("update_policy=always_flag_for_review: nunca actualiza sola, siempre a revisión", () => {
  it("un match no toca a la persona hasta que alguien lo confirma desde la bandeja", async () => {
    const id = await makeBasicForm("Formulario Revision", "form-revision", { updatePolicy: "always_flag_for_review" });
    await publishForm(actor, id);

    const first = await submitForm("form-revision", baseEntries({ dni: "30333222" }), randomUUID(), nextIp(), "agent");
    expect(first.kind).toBe("ok");

    const db = await getDb();
    const person = await db.selectFrom("people").selectAll().where("dni", "=", "30333222").executeTakeFirstOrThrow();

    const second = await submitForm("form-revision", baseEntries({ dni: "30333222", email: "nuevo@example.com" }), randomUUID(), nextIp(), "agent");
    expect(second.kind).toBe("ok");

    const stillEmpty = await db.selectFrom("people").select("email").where("id", "=", person.id).executeTakeFirstOrThrow();
    expect(stillEmpty.email).toBeNull(); // no se aplicó solo, quedó pendiente de revisión

    const candidate = await db.selectFrom("person_duplicate_candidates").selectAll().where("person_id", "=", person.id).where("status", "=", "pending").executeTakeFirstOrThrow();

    await linkDuplicateCandidate(actor, candidate.id);

    const afterLink = await db.selectFrom("people").select("email").where("id", "=", person.id).executeTakeFirstOrThrow();
    expect(afterLink.email).toBe("nuevo@example.com");

    const submissionRow = await db.selectFrom("form_submissions").select(["match_result", "person_id"]).where("id", "=", candidate.submission_id!).executeTakeFirstOrThrow();
    expect(submissionRow.match_result).toBe("matched");
    expect(submissionRow.person_id).toBe(person.id);
  });

  it("'es una persona nueva' crea otra persona en vez de tocar la que matcheaba (coincidencia por email, DNI distinto)", async () => {
    const id = await makeBasicForm("Formulario Revision Nueva", "form-revision-nueva", { updatePolicy: "always_flag_for_review" });
    await publishForm(actor, id);

    await submitForm("form-revision-nueva", baseEntries({ email: "compartido@example.com", first_name: "Original" }), randomUUID(), nextIp(), "agent");

    const db = await getDb();
    const original = await db.selectFrom("people").selectAll().where("email", "=", "compartido@example.com").executeTakeFirstOrThrow();

    // Mismo email (coincide), pero un DNI distinto: puede ser una persona homónima de verdad.
    await submitForm("form-revision-nueva", baseEntries({ email: "compartido@example.com", dni: "30333666", first_name: "Homonimo" }), randomUUID(), nextIp(), "agent");
    const candidate = await db.selectFrom("person_duplicate_candidates").selectAll().where("person_id", "=", original.id).where("status", "=", "pending").executeTakeFirstOrThrow();

    const { personId: newPersonId } = await createNewFromCandidate(actor, candidate.id);
    expect(newPersonId).not.toBe(original.id);

    const newPerson = await db.selectFrom("people").select("first_name").where("id", "=", newPersonId).executeTakeFirstOrThrow();
    expect(newPerson.first_name).toBe("Homonimo");

    const originalUnchanged = await db.selectFrom("people").select("first_name").where("id", "=", original.id).executeTakeFirstOrThrow();
    expect(originalUnchanged.first_name).toBe("Original");
  });

  it("'es una persona nueva' con el mismo DNI que ya causó el match da un error claro, no un crash", async () => {
    const id = await makeBasicForm("Formulario Revision DNI Choca", "form-revision-dni-choca", { updatePolicy: "always_flag_for_review" });
    await publishForm(actor, id);

    await submitForm("form-revision-dni-choca", baseEntries({ dni: "30333999", first_name: "Original" }), randomUUID(), nextIp(), "agent");
    const db = await getDb();
    const original = await db.selectFrom("people").selectAll().where("dni", "=", "30333999").executeTakeFirstOrThrow();

    await submitForm("form-revision-dni-choca", baseEntries({ dni: "30333999", first_name: "Otro" }), randomUUID(), nextIp(), "agent");
    const candidate = await db.selectFrom("person_duplicate_candidates").selectAll().where("person_id", "=", original.id).where("status", "=", "pending").executeTakeFirstOrThrow();

    await expect(createNewFromCandidate(actor, candidate.id)).rejects.toThrow(/ya existe una persona con el DNI/i);

    // El candidato sigue pendiente: el intento fallido no lo marcó como resuelto.
    const stillPending = await db.selectFrom("person_duplicate_candidates").select("status").where("id", "=", candidate.id).executeTakeFirstOrThrow();
    expect(stillPending.status).toBe("pending");
  });

  it("descartar no crea ni vincula nada", async () => {
    const id = await makeBasicForm("Formulario Revision Descartar", "form-revision-descartar", { updatePolicy: "always_flag_for_review" });
    await publishForm(actor, id);

    await submitForm("form-revision-descartar", baseEntries({ dni: "30333777" }), randomUUID(), nextIp(), "agent");
    const db = await getDb();
    const person = await db.selectFrom("people").selectAll().where("dni", "=", "30333777").executeTakeFirstOrThrow();

    await submitForm("form-revision-descartar", baseEntries({ dni: "30333777", email: "descartado@example.com" }), randomUUID(), nextIp(), "agent");
    const candidate = await db.selectFrom("person_duplicate_candidates").selectAll().where("person_id", "=", person.id).where("status", "=", "pending").executeTakeFirstOrThrow();

    await discardDuplicateCandidate(actor, candidate.id);

    const rows = await db.selectFrom("people").selectAll().where("dni", "=", "30333777").execute();
    expect(rows.length).toBe(1);
    expect(rows[0]?.email).toBeNull();

    const discarded = await db.selectFrom("person_duplicate_candidates").select("status").where("id", "=", candidate.id).executeTakeFirstOrThrow();
    expect(discarded.status).toBe("discarded");
  });
});

describe("ambigüedad real: distintos campos matchean a distintas personas", () => {
  it("nunca elige sola: crea un candidato por cada persona posible", async () => {
    const id = await makeBasicForm("Formulario Ambiguo", "form-ambiguo");
    await publishForm(actor, id);

    await submitForm("form-ambiguo", baseEntries({ dni: "30444111", email: "personaA@example.com" }), randomUUID(), nextIp(), "agent");
    await submitForm("form-ambiguo", baseEntries({ dni: "30444222", email: "personaB@example.com", first_name: "Otra" }), randomUUID(), nextIp(), "agent");

    // Un envío nuevo cuyo DNI matchea a la persona A pero cuyo email matchea a la persona B.
    const ambiguous = await submitForm(
      "form-ambiguo",
      baseEntries({ dni: "30444111", email: "personab@example.com", first_name: "Ambiguo" }),
      randomUUID(),
      nextIp(),
      "agent"
    );
    expect(ambiguous.kind).toBe("ok");

    const db = await getDb();
    const submission = await db.selectFrom("form_submissions").selectAll().where("form_id", "=", id).orderBy("created_at", "desc").executeTakeFirstOrThrow();
    expect(submission.match_result).toBe("needs_review");
    expect(submission.person_id).toBeNull();

    const candidates = await db.selectFrom("person_duplicate_candidates").selectAll().where("submission_id", "=", submission.id).execute();
    expect(candidates.length).toBe(2);
  });
});

describe("idempotencia: reintentar con la misma clave no procesa dos veces", () => {
  it("el mismo idempotencyKey enviado dos veces no crea dos personas", async () => {
    const id = await makeBasicForm("Formulario Idempotente", "form-idempotente");
    await publishForm(actor, id);

    const key = randomUUID();
    const entries = baseEntries({ dni: "30555111" });
    const first = await submitForm("form-idempotente", entries, key, nextIp(), "agent");
    const retry = await submitForm("form-idempotente", entries, key, nextIp(), "agent");
    expect(first.kind).toBe("ok");
    expect(retry.kind).toBe("ok");

    const db = await getDb();
    const rows = await db.selectFrom("people").selectAll().where("dni", "=", "30555111").execute();
    expect(rows.length).toBe(1);

    const submissions = await db.selectFrom("form_submissions").selectAll().where("form_id", "=", id).execute();
    expect(submissions.length).toBe(1);
  });
});

describe("validación pública: campo obligatorio vacío y consentimiento", () => {
  it("rechaza si falta un campo obligatorio, con el error en la clave correcta", async () => {
    const id = await makeBasicForm("Formulario Validacion", "form-validacion");
    await publishForm(actor, id);

    const result = await submitForm("form-validacion", { first_name: "", last_name: "Gomez", dni: "", email: "", phone: "" }, randomUUID(), nextIp(), "agent");
    expect(result.kind).toBe("validation_error");
    if (result.kind === "validation_error") {
      expect(result.fieldErrors.first_name).toBeTruthy();
    }
  });

  it("con texto de consentimiento configurado, rechaza si no viene aceptado", async () => {
    const { id } = await createForm(actor, { name: "Formulario Consentimiento", slug: "form-consentimiento" });
    await updateFormMeta(actor, id, {
      name: "Formulario Consentimiento",
      slug: "form-consentimiento",
      consentText: "Acepto que mis datos se usen para fines sindicales.",
      successMessage: "",
      opensAt: "",
      closesAt: "",
      matchFields: ["dni"],
      updatePolicy: "fill_empty_only",
    });
    await upsertField(actor, id, null, { key: "first_name", label: "Nombre", fieldType: "text", required: true, visible: true, personFieldMapping: "first_name" });
    await upsertField(actor, id, null, { key: "last_name", label: "Apellido", fieldType: "text", required: true, visible: true, personFieldMapping: "last_name" });
    await publishForm(actor, id);

    const withoutConsent = await submitForm("form-consentimiento", { first_name: "Dario", last_name: "Lopez" }, randomUUID(), nextIp(), "agent");
    expect(withoutConsent.kind).toBe("validation_error");

    const withConsent = await submitForm("form-consentimiento", { first_name: "Dario", last_name: "Lopez", __consent: "true" }, randomUUID(), nextIp(), "agent");
    expect(withConsent.kind).toBe("ok");
  });
});

describe("disponibilidad pública: borrador, despublicado y fuera de ventana", () => {
  it("un formulario en borrador no está disponible", async () => {
    const { id } = await createForm(actor, { name: "Formulario Borrador", slug: "form-borrador" });
    void id;
    const result = await getPublicForm("form-borrador");
    expect(result.kind).toBe("not_available");
  });

  it("despublicar lo saca de circulación, y volver a publicar lo resume sin pedir una versión nueva", async () => {
    const id = await makeBasicForm("Formulario Pausable", "form-pausable");
    await publishForm(actor, id);
    expect((await getPublicForm("form-pausable")).kind).toBe("ok");

    await changeFormStatus(actor, id, "unpublished");
    expect((await getPublicForm("form-pausable")).kind).toBe("not_available");

    await changeFormStatus(actor, id, "published");
    expect((await getPublicForm("form-pausable")).kind).toBe("ok");
  });

  it("un slug que no existe da 'not_found'", async () => {
    const result = await getPublicForm("no-existe-este-slug");
    expect(result.kind).toBe("not_found");
  });
});

describe("rate limiting en el envío público", () => {
  it("después de muchos intentos desde la misma IP, se corta con 'rate_limited'", async () => {
    const id = await makeBasicForm("Formulario Rate Limit", "form-rate-limit");
    await publishForm(actor, id);
    const ip = nextIp();

    let lastKind = "";
    for (let i = 0; i < 61; i += 1) {
      const result = await submitForm("form-rate-limit", baseEntries({ dni: `3099${String(i).padStart(4, "0")}` }), randomUUID(), ip, "agent");
      lastKind = result.kind;
      if (lastKind === "rate_limited") break;
    }
    expect(lastKind).toBe("rate_limited");
  }, 30_000);
});
