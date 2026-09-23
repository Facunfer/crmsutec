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
const { createMeeting, updateMeeting, changeMeetingStatus, setMeetingAssociations, MeetingCommandError } = await import(
  "../../lib/meetings/commands.js"
);
const { countAudience, resolveAudienceIds } = await import("../../lib/meetings/audience.js");
const { createInvitationBatch, withdrawInvitation, listInvitations } = await import("../../lib/meetings/invitations.js");
const { getInvitationByToken, respondToInvitation } = await import("../../lib/meetings/public.js");
const { createAssociation } = await import("../../lib/associations/commands.js");
const { addMember } = await import("../../lib/associations/members.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL_PERMISSIONS = new Set(PERMISSIONS.map((p) => p.key));

let actor: any;
let associationTypeId: string;
let orgTypeId: string;

function futureMeetingInput(offsetMinutes = 60, durationMinutes = 90) {
  const start = new Date(Date.now() + offsetMinutes * 60_000);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const toLocal = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return { startsAt: toLocal(start), endsAt: toLocal(end) };
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
    .values({
      email: "meetings-actor@sutecba.local",
      password_hash: await hashPassword("x-password-123"),
      full_name: "Actor",
      role_id: role.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  actor = {
    id: user.id,
    email: "meetings-actor@sutecba.local",
    fullName: "Actor",
    roleId: role.id,
    roleKey: "MASTER_GLOBAL",
    mustChangePassword: false,
    enabledModules: ALL_MODULE_KEYS,
    permissions: ALL_PERMISSIONS,
  };

  const assocType = await db.selectFrom("association_types").select("id").where("key", "=", "comision").executeTakeFirstOrThrow();
  associationTypeId = assocType.id;
  const orgType = await db.selectFrom("organization_types").select("id").where("key", "=", "ministerio").executeTakeFirstOrThrow();
  orgTypeId = orgType.id;
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function makePerson(firstName: string, dni: string, organizationId?: string) {
  const db = await getDb();
  const row = await db
    .insertInto("people")
    .values({ first_name: firstName, last_name: "Test", dni, organization_id: organizationId ?? null })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id as string;
}

describe("ABM y máquina de estados (integración)", () => {
  it("crea en borrador, permite editar, y bloquea saltar a finalizada", async () => {
    const { id } = await createMeeting(actor, { ownerOrganizationId: ownerOrgId, name: "Reunión Test", ...futureMeetingInput(), description: "", locationName: "", address: "", notes: "" });

    await updateMeeting(actor, id, { name: "Reunión Editada", ...futureMeetingInput(), description: "", locationName: "", address: "", notes: "" });

    await expect(changeMeetingStatus(actor, id, "finished")).rejects.toThrow(MeetingCommandError);

    await changeMeetingStatus(actor, id, "scheduled");
    await expect(updateMeeting(actor, id, { name: "otra vez", ...futureMeetingInput(), description: "", locationName: "", address: "", notes: "" })).resolves.not.toThrow();

    await changeMeetingStatus(actor, id, "in_progress");
    await expect(
      updateMeeting(actor, id, { name: "no debería poder", ...futureMeetingInput(), description: "", locationName: "", address: "", notes: "" })
    ).rejects.toThrow(MeetingCommandError);
  });

  it("al finalizar, las invitaciones sin respuesta de asistencia quedan 'absent' (se congela el resultado)", async () => {
    const { id } = await createMeeting(actor, { ownerOrganizationId: ownerOrgId, name: "Reunión Finaliza", ...futureMeetingInput(), description: "", locationName: "", address: "", notes: "" });
    await changeMeetingStatus(actor, id, "scheduled");

    const personId = await makePerson("Finaliza", "33000001");
    await createInvitationBatch(actor, id, { personIds: [personId] });

    await changeMeetingStatus(actor, id, "in_progress");
    await changeMeetingStatus(actor, id, "finished");

    const [invitation] = await listInvitations(actor, id);
    expect(invitation?.attendanceStatus).toBe("absent");
  });

  it("una reunión finalizada no deja tocar sus asociaciones relacionadas (server-side, no solo la UI)", async () => {
    const { id } = await createMeeting(actor, { ownerOrganizationId: ownerOrgId, name: "Reunión Sin Editar Asoc", ...futureMeetingInput(), description: "", locationName: "", address: "", notes: "" });
    await changeMeetingStatus(actor, id, "scheduled");
    await changeMeetingStatus(actor, id, "in_progress");
    await changeMeetingStatus(actor, id, "finished");

    const { id: associationId } = await createAssociation(actor, { ownerOrganizationId: ownerOrgId, name: "Asociación Tardía", typeId: associationTypeId });
    await expect(setMeetingAssociations(actor, id, [associationId])).rejects.toThrow(MeetingCommandError);
  });
});

describe("resolvedor de audiencia (personas + asociaciones + organismos con jerarquía)", () => {
  it("un organismo seleccionado incluye a sus dependencias", async () => {
    const db = await getDb();
    const parentOrg = await db.insertInto("organizations").values({ name: "Ministerio Test", type_id: orgTypeId }).returning("id").executeTakeFirstOrThrow();
    const childOrg = await db
      .insertInto("organizations")
      .values({ name: "Dependencia Test", type_id: orgTypeId, parent_id: parentOrg.id })
      .returning("id")
      .executeTakeFirstOrThrow();

    const inParent = await makePerson("EnMinisterio", "33000010", parentOrg.id);
    const inChild = await makePerson("EnDependencia", "33000011", childOrg.id);
    const unrelated = await makePerson("SinOrganismo", "33000012");

    const ids = await resolveAudienceIds(actor, { organizationIds: [parentOrg.id] });
    expect(ids).toContain(inParent);
    expect(ids).toContain(inChild);
    expect(ids).not.toContain(unrelated);
  });

  it("combina fuentes con OR y excluye personas inactivas", async () => {
    const { id: associationId } = await createAssociation(actor, { ownerOrganizationId: ownerOrgId, name: "Asociación Audiencia", typeId: associationTypeId });
    const memberPerson = await makePerson("MiembroAsoc", "33000020");
    await addMember(actor, associationId, memberPerson);

    const explicitPerson = await makePerson("Explicito", "33000021");
    const inactivePerson = await makePerson("Inactivo", "33000022");
    const db = await getDb();
    await db.updateTable("people").set({ status: "inactive" }).where("id", "=", inactivePerson).execute();

    const count = await countAudience(actor, { associationIds: [associationId], personIds: [explicitPerson, inactivePerson] });
    expect(count).toBe(2); // memberPerson + explicitPerson, nunca el inactivo

    const ids = await resolveAudienceIds(actor, { associationIds: [associationId], personIds: [explicitPerson, inactivePerson] });
    expect(ids.sort()).toEqual([memberPerson, explicitPerson].sort());
  });

  it("sin ninguna fuente elegida, la audiencia es vacía (no 'todas')", async () => {
    const count = await countAudience(actor, {});
    expect(count).toBe(0);
  });
});

describe("invitaciones: idempotencia, revivir tras retirar, token en claro solo una vez", () => {
  it("re-generar la misma tanda no duplica invitaciones", async () => {
    const { id } = await createMeeting(actor, { ownerOrganizationId: ownerOrgId, name: "Reunión Invita", ...futureMeetingInput(), description: "", locationName: "", address: "", notes: "" });
    await changeMeetingStatus(actor, id, "scheduled");
    const personId = await makePerson("Invitado", "33000030");

    const first = await createInvitationBatch(actor, id, { personIds: [personId] });
    expect(first.createdCount).toBe(1);
    expect(first.links).toHaveLength(1);

    const second = await createInvitationBatch(actor, id, { personIds: [personId] });
    expect(second.createdCount).toBe(0);
    expect(second.alreadyInvitedCount).toBe(1);
    expect(second.links).toHaveLength(0);

    const db = await getDb();
    const rows = await db.selectFrom("meeting_invitations").selectAll().where("meeting_id", "=", id).where("person_id", "=", personId).execute();
    expect(rows.length).toBe(1);
  });

  it("retirar a alguien y volver a invitarlo revive la misma fila con un token nuevo", async () => {
    const { id } = await createMeeting(actor, { ownerOrganizationId: ownerOrgId, name: "Reunión Revive", ...futureMeetingInput(), description: "", locationName: "", address: "", notes: "" });
    await changeMeetingStatus(actor, id, "scheduled");
    const personId = await makePerson("RevivoYo", "33000031");

    const first = await createInvitationBatch(actor, id, { personIds: [personId] });
    const firstToken = first.links[0]!.token;

    const db = await getDb();
    const [row] = await db.selectFrom("meeting_invitations").select("id").where("meeting_id", "=", id).where("person_id", "=", personId).execute();
    await withdrawInvitation(actor, row!.id);

    const invalidView = await getInvitationByToken(firstToken, "10.0.0.1");
    expect(invalidView.kind).toBe("invalid");

    const revived = await createInvitationBatch(actor, id, { personIds: [personId] });
    expect(revived.revivedCount).toBe(1);
    expect(revived.createdCount).toBe(0);
    const newToken = revived.links[0]!.token;
    expect(newToken).not.toBe(firstToken);

    const rows = await db.selectFrom("meeting_invitations").selectAll().where("meeting_id", "=", id).where("person_id", "=", personId).execute();
    expect(rows.length).toBe(1); // misma fila, no una nueva
  });
});

describe("respuesta pública a la invitación", () => {
  it("confirma y rechaza, y ya no deja cambiar una vez que la reunión arrancó", async () => {
    const { id } = await createMeeting(actor, { ownerOrganizationId: ownerOrgId, name: "Reunión Pública", ...futureMeetingInput(), description: "", locationName: "", address: "", notes: "" });
    await changeMeetingStatus(actor, id, "scheduled");
    const personId = await makePerson("Publico", "33000040");
    const batch = await createInvitationBatch(actor, id, { personIds: [personId] });
    const token = batch.links[0]!.token;

    const view = await getInvitationByToken(token, "10.0.0.2");
    expect(view.kind).toBe("ok");

    const response = await respondToInvitation(token, "confirmed", "10.0.0.2");
    expect(response.ok).toBe(true);

    const viewAfter = await getInvitationByToken(token, "10.0.0.2");
    expect(viewAfter.kind === "ok" && viewAfter.responseStatus).toBe("confirmed");

    await changeMeetingStatus(actor, id, "in_progress");
    const lockedResponse = await respondToInvitation(token, "declined", "10.0.0.2");
    expect(lockedResponse).toEqual({ ok: false, reason: "locked" });
  });

  it("un token inexistente da 'invalid', sin distinguir de un token con formato roto", async () => {
    const view = await getInvitationByToken("token-que-no-existe", "10.0.0.3");
    expect(view.kind).toBe("invalid");
  });
});
