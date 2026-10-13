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
const pq = await import("../../lib/people/queries.js");
const { exportPeopleCsv } = await import("../../lib/people/export.js");
const { trafficLightOf } = await import("../../lib/people/traffic.js");
const tl = await import("../../lib/people/timeline.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const BA = "America/Argentina/Buenos_Aires";
let master: any;
let org: string;
let userId: string;
let seq = 0;
let dni = 61000000;
const P: Record<string, string> = {};
const typeId: Record<string, string> = {};
const channelId: Record<string, string> = {};

async function person(label: string) {
  const db = await getDb();
  seq += 1;
  dni += 1;
  const id = (
    await db
      .insertInto("people")
      .values({ first_name: label, last_name: "SemaforoZ", dni: String(dni), organization_id: org, origin: "manual" } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  P[label] = id;
  return id;
}

/** Interacción en el día de Buenos Aires `today - daysAgo`, a la hora local indicada ('HH:MI'). */
async function interaction(personId: string, daysAgo: number, localTime: string, o: { type?: string; channel?: string | null; sourceKey?: string | null; dateBasis?: string; status?: string } = {}) {
  const db = await getDb();
  await sql`
    insert into person_interactions (person_id, owner_organization_id, occurred_at, occurred_precision, interaction_type_id, channel_id, subject, status, created_by, source_key, date_basis)
    values (${personId}::uuid, ${org}::uuid,
            ((((now() at time zone ${BA})::date - ${daysAgo}::int)::text || ' ' || ${localTime})::timestamp at time zone ${BA}),
            'exact_datetime', ${typeId[o.type ?? "llamada"]}::uuid, ${o.channel === null ? null : channelId[o.channel ?? "telefono"]}::uuid,
            'Contacto de prueba', ${o.status ?? "completed"}, ${userId}::uuid, ${o.sourceKey ?? null}, ${o.dateBasis ?? "actual"})`.execute(db);
}

const rowsOf = async (filter: any = {}) => {
  const out = await pq.listPeoplePage(master, { search: "SemaforoZ", status: "all", ...filter }, { field: "name", direction: "asc" }, 1, 200);
  return new Map(out.rows.map((r) => [r.firstName, r]));
};
const light = async (label: string) => (await rowsOf()).get(label)!.trafficLight;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  org = await createTestOrganization("Semáforo");
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  userId = (await db.insertInto("users").values({ email: "sem-master@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "Sem Master", role_id: role.id }).returning("id").executeTakeFirstOrThrow()).id;
  master = { id: userId, email: "sem-master@sutecba.local", fullName: "Sem", roleId: "n/a", roleKey: "MASTER_GLOBAL", mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions: new Set(PERMISSIONS.map((p) => p.key)) };
  for (const r of await db.selectFrom("interaction_types").select(["id", "key"]).execute()) typeId[r.key] = r.id;
  for (const r of await db.selectFrom("interaction_channels").select(["id", "key"]).execute()) channelId[r.key] = r.id;

  // contacto real
  await interaction(await person("Gris"), 0, "10:00", { status: "open" }); // abierta/planificada: no es un contacto efectivo → gris
  await interaction(await person("Verde10"), 10, "11:00");
  await interaction(await person("Amarillo45"), 45, "11:00");
  await interaction(await person("Rojo90"), 90, "11:00");
  // límites (día calendario de Buenos Aires)
  await interaction(await person("L30"), 30, "23:30"); // 23:30 BA = 02:30 UTC del día siguiente: sigue siendo el día -30
  await interaction(await person("L31"), 31, "00:30");
  await interaction(await person("L60"), 60, "23:59");
  await interaction(await person("L61"), 61, "00:00");
  // varias: toma la más reciente
  const multi = await person("Multiple");
  await interaction(multi, 100, "10:00");
  await interaction(multi, 20, "10:00");
  await interaction(multi, 70, "10:00");

  // NO son contacto
  const sinContactoParticipa = await person("Participa");
  const meeting = (
    await db
      .insertInto("meetings")
      .values({ name: "Actividad reciente", owner_organization_id: org, organizer_user_id: userId, created_by: userId, origin: "manual", status: "finished", meeting_type: "reunion", schedule_precision: "exact_datetime", starts_at: new Date(Date.now() - 5 * 86400_000), ends_at: new Date(Date.now() - 5 * 86400_000 + 3600_000) } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  const mp = (await db.insertInto("meeting_participations").values({ meeting_id: meeting, person_id: sinContactoParticipa, participation_kind: "participated", participation_basis: "legacy_initial_import" } as never).returning("id").executeTakeFirstOrThrow()).id;
  // espejo técnico de la participación (tipo participation, sin canal, hace 5 días)
  await interaction(sinContactoParticipa, 5, "10:00", { type: "participation", channel: null, sourceKey: `meeting_participation:${mp}` });

  const asiste = await person("Asiste");
  await db.insertInto("meeting_attendance").values({ meeting_id: meeting, person_id: await asiste, method: "manual", checked_in_at: new Date(Date.now() - 4 * 86400_000), registered_by: userId, correction_reason: "carga de prueba", occurred_precision: "exact_datetime" } as never).execute().catch(() => undefined);
  await db.insertInto("meeting_participations").values({ meeting_id: meeting, person_id: asiste, participation_kind: "registration", participation_basis: "standard" } as never).execute();

  const formu = await person("Formulario");
  await interaction(formu, 3, "10:00", { channel: "formulario" }); // «formulario» no prueba una comunicación
  const referencia = await person("LegacyRef");
  await interaction(referencia, 0, "10:00", { type: "participation", channel: null, sourceKey: `meeting_participation:${randomUUID()}`, dateBasis: "legacy_reference" }).catch(() => undefined);

  // mailing delivered / opened / clicked recientes
  const mailPerson = await person("Mailing");
  const campaign = (await sql<{ id: string }>`insert into mailing_campaigns (name, created_by, status) values ('Sem', ${userId}::uuid, 'cancelled') returning id`.execute(db)).rows[0]!.id;
  const rec = (
    await sql<{ id: string }>`
      insert into mailing_campaign_recipients (campaign_id, primary_person_id, normalized_email, email_snapshot, status, sent_at, delivered_at, opened_at, clicked_at, open_count, click_count)
      values (${campaign}::uuid, ${mailPerson}::uuid, 'sem-mail@example.test', 'sem-mail@example.test', 'delivered', now(), now(), now(), now(), 1, 1) returning id`.execute(db)
  ).rows[0]!.id;
  await sql`insert into mailing_campaign_recipient_people (recipient_id, person_id, campaign_id) values (${rec}::uuid, ${mailPerson}::uuid, ${campaign}::uuid)`.execute(db);

  // participación + llamada real: toma la fecha de la llamada
  const mixto = await person("Mixto");
  await db.insertInto("meeting_participations").values({ meeting_id: meeting, person_id: mixto, participation_kind: "participated", participation_basis: "legacy_initial_import" } as never).execute();
  await interaction(mixto, 40, "09:00");
});

afterAll(async () => {
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("semáforo desde el último contacto REAL", () => {
  it("sin interacciones (o solo anuladas) → gris; verde/amarillo/rojo según los días", async () => {
    expect(await light("Gris")).toBe("gray");
    expect(await light("Verde10")).toBe("green");
    expect(await light("Amarillo45")).toBe("yellow");
    expect(await light("Rojo90")).toBe("red");
    const g = (await rowsOf()).get("Gris")!;
    expect(g.lastInteractionDate).toBeNull();
    expect(g.daysSinceInteraction).toBeNull();
  });

  it("límites 30/31 y 60/61 en día calendario de Buenos Aires (sin off-by-one por UTC)", async () => {
    const rows = await rowsOf();
    expect(rows.get("L30")!.daysSinceInteraction).toBe(30);
    expect(rows.get("L30")!.trafficLight).toBe("green"); // 23:30 BA = 02:30 UTC del día siguiente
    expect(rows.get("L31")!.daysSinceInteraction).toBe(31);
    expect(rows.get("L31")!.trafficLight).toBe("yellow");
    expect(rows.get("L60")!.daysSinceInteraction).toBe(60);
    expect(rows.get("L60")!.trafficLight).toBe("yellow");
    expect(rows.get("L61")!.daysSinceInteraction).toBe(61);
    expect(rows.get("L61")!.trafficLight).toBe("red");
    // el espejo puro (sin base) coincide
    expect([30, 31, 60, 61].map(trafficLightOf)).toEqual(["green", "yellow", "yellow", "red"]);
  });

  it("varios contactos reales: toma el más reciente; participación + llamada: toma la fecha de la llamada", async () => {
    const rows = await rowsOf();
    expect(rows.get("Multiple")!.daysSinceInteraction).toBe(20);
    expect(rows.get("Multiple")!.trafficLight).toBe("green");
    expect(rows.get("Mixto")!.daysSinceInteraction).toBe(40);
    expect(rows.get("Mixto")!.trafficLight).toBe("yellow");
  });

  it("participación, asistencia, inscripción, formulario, referencia legacy y mailing recientes NO mueven el semáforo", async () => {
    for (const label of ["Participa", "Asiste", "Formulario", "LegacyRef", "Mailing"]) {
      expect(await light(label), label).toBe("gray");
      const rel = await tl.getPersonRelationship(master, P[label]!);
      expect(rel!.lastContact, label).toBeNull();
    }
  });
});

describe("KPIs, filtros y exportación usan el mismo criterio", () => {
  it("los KPIs suman lo mismo que las filas; el filtro por semáforo devuelve exactamente cada grupo", async () => {
    const filter = { search: "SemaforoZ", status: "all" as const };
    const rows = [...(await rowsOf()).values()];
    const expected = { green: 0, yellow: 0, red: 0, gray: 0 } as Record<string, number>;
    for (const r of rows) expected[r.trafficLight] = (expected[r.trafficLight] ?? 0) + 1;
    const kpis = await pq.getTrafficKpis(master, filter);
    expect(kpis).toMatchObject({ green: expected.green, yellow: expected.yellow, red: expected.red, gray: expected.gray });
    for (const color of ["green", "yellow", "red", "gray"] as const) {
      const ids = (await pq.listAllMatchingIds(master, { ...filter, trafficLight: color })).sort();
      expect(ids, color).toEqual(rows.filter((r) => r.trafficLight === color).map((r) => r.id).sort());
    }
  });

  it("filtro «último contacto desde/hasta» (día de Buenos Aires) y exportación = grilla", async () => {
    const rows = await rowsOf();
    const day = (label: string) => rows.get(label)!.lastInteractionDate!;
    const only = await rowsOf({ lastInteractionFrom: day("Multiple"), lastInteractionTo: day("Multiple") });
    expect([...only.keys()]).toEqual(["Multiple"]);

    const csv = await exportPeopleCsv(master, { search: "SemaforoZ", status: "all" }, { field: "name", direction: "asc" });
    const lines = csv.replace(/^﻿/, "").split("\r\n").slice(1).map((l) => l.split('","').map((c) => c.replace(/^"|"$/g, "")));
    expect(lines).toHaveLength(rows.size);
    const LABEL: Record<string, string> = { green: "Verde", yellow: "Amarillo", red: "Rojo", gray: "Gris" };
    for (const cols of lines) {
      const r = rows.get(cols[0] as string)!;
      expect(cols[7], cols[0] as string).toBe(r.lastInteractionDate ?? "");
      expect(cols[8], cols[0] as string).toBe(LABEL[r.trafficLight]);
    }
  });
});
