import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createAssociation, setAssociationActive, AssociationCommandError } = await import(
  "../../lib/associations/commands.js"
);
const { addMember, addManager, bulkAddMembers, removeMember } = await import("../../lib/associations/members.js");
const { listActiveMembers, listManagers, searchPeopleToAdd } = await import("../../lib/associations/queries.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL_PERMISSIONS = new Set(PERMISSIONS.map((p) => p.key));

let actor: any;
let typeId: string;

beforeAll(async () => {
  await applyMigrations(parseFlags([]));
  await runSeed();

  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const user = await db
    .insertInto("users")
    .values({
      email: "assoc-actor@sutecba.local",
      password_hash: await hashPassword("x-password-123"),
      full_name: "Actor",
      role_id: role.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  actor = {
    id: user.id,
    email: "assoc-actor@sutecba.local",
    fullName: "Actor",
    roleId: role.id,
    roleKey: "MASTER_GLOBAL",
    mustChangePassword: false,
    permissions: ALL_PERMISSIONS,
  };

  const type = await db.selectFrom("association_types").select("id").where("key", "=", "comision").executeTakeFirstOrThrow();
  typeId = type.id;
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function makePerson(db: any, firstName: string, dni: string) {
  const row = await db
    .insertInto("people")
    .values({ first_name: firstName, last_name: "Test", dni })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id as string;
}

describe("ABM de asociaciones", () => {
  it("crea una asociación y la desactiva sin borrarla (R8)", async () => {
    const { id } = await createAssociation(actor, { name: "Comisión de Prueba", typeId });
    await setAssociationActive(actor, id, false);

    const db = await getDb();
    const row = await db.selectFrom("associations").select(["id", "status"]).where("id", "=", id).executeTakeFirst();
    expect(row?.status).toBe("inactive");
  });

  it("rechaza un tipo de asociación inexistente", async () => {
    await expect(createAssociation(actor, { name: "X", typeId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(
      AssociationCommandError
    );
  });
});

describe("miembros: alta idempotente y baja lógica", () => {
  it("agregar dos veces a la misma persona no crea una fila duplicada activa", async () => {
    const db = await getDb();
    const { id: associationId } = await createAssociation(actor, { name: "Delegados Test", typeId });
    const personId = await makePerson(db, "Mario", "32000001");

    await addMember(actor, associationId, personId);
    await addMember(actor, associationId, personId); // idempotente

    const rows = await db
      .selectFrom("people_associations")
      .selectAll()
      .where("association_id", "=", associationId)
      .where("person_id", "=", personId)
      .where("status", "=", "active")
      .execute();
    expect(rows.length).toBe(1);
  });

  it("quitar un miembro lo marca inactivo, no borra la fila", async () => {
    const db = await getDb();
    const { id: associationId } = await createAssociation(actor, { name: "Delegados Test 2", typeId });
    const personId = await makePerson(db, "Nora", "32000002");

    await addMember(actor, associationId, personId);
    const [membership] = await listActiveMembers(associationId);
    if (!membership) throw new Error("expected a membership");
    await removeMember(actor, membership.membershipId);

    const row = await db
      .selectFrom("people_associations")
      .selectAll()
      .where("id", "=", membership.membershipId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("inactive");
    expect(row.removed_at).not.toBeNull();

    const active = await listActiveMembers(associationId);
    expect(active.length).toBe(0);
  });

  it("se puede volver a agregar a alguien después de haber sido quitado", async () => {
    const db = await getDb();
    const { id: associationId } = await createAssociation(actor, { name: "Delegados Test 3", typeId });
    const personId = await makePerson(db, "Otto", "32000003");

    await addMember(actor, associationId, personId);
    const [membership] = await listActiveMembers(associationId);
    if (!membership) throw new Error("expected a membership");
    await removeMember(actor, membership.membershipId);
    await addMember(actor, associationId, personId);

    const active = await listActiveMembers(associationId);
    expect(active.length).toBe(1);
  });
});

describe("alta masiva desde una selección/filtro de Personas (sección 10)", () => {
  it("bulkAddMembers agrega solo activas y no duplica a quien ya es miembro", async () => {
    const db = await getDb();
    const { id: associationId } = await createAssociation(actor, { name: "Comisión Masiva", typeId });

    const p1 = await makePerson(db, "Ana", "32000010");
    const p2 = await makePerson(db, "Beto", "32000011");
    const p3 = await makePerson(db, "Ciro", "32000012");
    await db.updateTable("people").set({ status: "inactive" }).where("id", "=", p3).execute();
    await addMember(actor, associationId, p1); // ya es miembro de antes

    const count = await bulkAddMembers(actor, associationId, [p1, p2, p3]);

    expect(count).toBe(1); // solo p2 se agrega: p1 ya era miembro, p3 está inactiva
    const active = await listActiveMembers(associationId);
    expect(active.map((m) => m.personId).sort()).toEqual([p1, p2].sort());
  });

  it("searchPeopleToAdd excluye a quienes ya son miembros activos", async () => {
    const db = await getDb();
    const { id: associationId } = await createAssociation(actor, { name: "Comisión Búsqueda", typeId });
    const p1 = await makePerson(db, "Zulema", "32000020");

    const before = await searchPeopleToAdd(associationId, "Zulema", true);
    expect(before.map((r) => r.id)).toContain(p1);

    await addMember(actor, associationId, p1);
    const after = await searchPeopleToAdd(associationId, "Zulema", true);
    expect(after.map((r) => r.id)).not.toContain(p1);
  });

  it("searchPeopleToAdd exige al menos 2 caracteres", async () => {
    const { id: associationId } = await createAssociation(actor, { name: "Comisión Mínimo", typeId });
    const results = await searchPeopleToAdd(associationId, "a", true);
    expect(results).toEqual([]);
  });

  it("searchPeopleToAdd enmascara el DNI sin people.view_sensitive (hallazgo real de la Etapa 10)", async () => {
    const db = await getDb();
    const { id: associationId } = await createAssociation(actor, { name: "Comisión Enmascarado", typeId });
    await makePerson(db, "Wanda", "32000099");

    const withPermission = await searchPeopleToAdd(associationId, "Wanda", true);
    expect(withPermission[0]?.dni).toBe("32000099");

    const withoutPermission = await searchPeopleToAdd(associationId, "Wanda", false);
    expect(withoutPermission[0]?.dni).not.toBe("32000099");
    expect(withoutPermission[0]?.dni).toContain("*");
  });
});

describe("responsables", () => {
  it("agrega un usuario y una persona como responsables", async () => {
    const db = await getDb();
    const { id: associationId } = await createAssociation(actor, { name: "Consejo Test", typeId });
    const personId = await makePerson(db, "Delegado", "32000030");

    await addManager(actor, associationId, { userId: actor.id });
    await addManager(actor, associationId, { personId });

    const managers = await listManagers(associationId);
    expect(managers.length).toBe(2);
    expect(managers.some((m) => m.userId === actor.id)).toBe(true);
    expect(managers.some((m) => m.personId === personId)).toBe(true);
  });
});
