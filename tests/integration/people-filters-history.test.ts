import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.MAIL_UNSUBSCRIBE_SECRET = "unit-test-unsubscribe-secret-0123456789abcdef";
process.env.PUBLIC_BASE_URL = "https://crm.test";
process.env.AWS_REGION = "us-east-1";

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { createTestOrganization } = await import("../helpers/organization.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS, ROLE_PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const pq = await import("../../lib/people/queries.js");
const fp = await import("../../lib/people/filter-params.js");
const tl = await import("../../lib/people/timeline.js");
const analytics = await import("../../lib/analytics/queries.js");
const campaigns = await import("../../lib/mailing/campaigns.js");
const { audienceSpecSchema } = await import("../../lib/mailing/audience.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));
let master: any;
let areaA: any;
let areaB: any;
let orgA: string;
let orgB: string;
let seq = 0;
let dni = 52000000;
let tagAbogado: string;
let tagJuventud: string;
let tagLocalB: string;

function actorOf(id: string, roleKey: string, permissions: Set<string>): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions };
}
async function makeUser(email: string, roleKey: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id }).returning("id").executeTakeFirstOrThrow()).id;
}
async function person(o: { email?: string | null; phone?: string | null; org?: string; first?: string } = {}) {
  const db = await getDb();
  seq += 1;
  dni += 1;
  return (
    await db
      .insertInto("people")
      .values({ first_name: o.first ?? `Fil${seq}`, last_name: `Tro${seq}`, dni: String(dni), email: o.email ?? null, phone: o.phone ?? null, organization_id: o.org ?? orgA, origin: "manual" } as never)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}
async function tag(ids: string[], tagId: string) {
  const db = await getDb();
  for (const id of ids) await db.insertInto("person_tags").values({ person_id: id, tag_id: tagId, assigned_by: master.id }).execute();
}
const ids = async (actor: any, filter: any) => (await pq.listAllMatchingIds(actor, filter)).sort();

// población de prueba (todas en orgA): se identifica por el prefijo de apellido `Tro`
const P: Record<string, string> = {};

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  orgA = await createTestOrganization("Filtros A");
  orgB = await createTestOrganization("Filtros B");
  const db = await getDb();
  master = actorOf(await makeUser("flt-master@sutecba.local", "MASTER_GLOBAL"), "MASTER_GLOBAL", ALL);
  const admin = new Set<string>(ROLE_PERMISSIONS.ADMIN);
  const a = await makeUser("flt-a@sutecba.local", "ADMIN");
  const b = await makeUser("flt-b@sutecba.local", "ADMIN");
  for (const [u, o] of [[a, orgA], [b, orgB]] as const) {
    await db.insertInto("user_scopes").values({ user_id: u, organization_id: o, include_descendants: true, granted_by: master.id } as never).execute();
  }
  areaA = actorOf(a, "ADMIN", admin);
  areaB = actorOf(b, "ADMIN", admin);
  const mk = async (name: string, owner: string | null) =>
    (await db.insertInto("tags").values({ name, owner_organization_id: owner, created_by: master.id } as never).returning("id").executeTakeFirstOrThrow()).id;
  tagAbogado = await mk("abogado-flt", null);
  tagJuventud = await mk("juventud-flt", null);
  tagLocalB = await mk("local-b-flt", orgB);

  P.abogadoFull = await person({ email: "a1@x.test", phone: "1155550001" });
  P.abogadoEmail = await person({ email: "a2@x.test" });
  P.abogadoPhone = await person({ phone: "1155550003" });
  P.abogadoNone = await person({});
  P.abogadoBlank = await person({ email: "   ", phone: "" });
  P.juventudFull = await person({ email: "j1@x.test", phone: "1155550006" });
  P.ambos = await person({ email: "m1@x.test", phone: "1155550007" });
  P.sinTag = await person({ email: "s1@x.test", phone: "1155550008" });
  P.otraUnidad = await person({ email: "b1@x.test", phone: "1155550009", org: orgB });
  await tag([P.abogadoFull!, P.abogadoEmail!, P.abogadoPhone!, P.abogadoNone!, P.abogadoBlank!, P.ambos!], tagAbogado);
  await tag([P.juventudFull!, P.ambos!], tagJuventud);
  await tag([P.otraUnidad!], tagLocalB);
});

afterAll(async () => {
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const names = (list: string[]) => Object.entries(P).filter(([, v]) => list.includes(v)).map(([k]) => k).sort();

describe("filtros de /personas: etiquetas, email y teléfono", () => {
  it("etiqueta: una, varias (cualquiera / todas) y una etiqueta no visible no filtra ni revela", async () => {
    expect(names(await ids(master, { tagIds: [tagAbogado] }))).toEqual(["abogadoBlank", "abogadoEmail", "abogadoFull", "abogadoNone", "abogadoPhone", "ambos"]);
    expect(names(await ids(master, { tagIds: [tagJuventud] }))).toEqual(["ambos", "juventudFull"]);
    expect(names(await ids(master, { tagIds: [tagAbogado, tagJuventud] }))).toHaveLength(7); // cualquiera
    expect(names(await ids(master, { tagIds: [tagAbogado, tagJuventud], tagMatch: "all" }))).toEqual(["ambos"]);
    // la etiqueta local de B no es visible para el área A: no matchea (no revela que existe)
    expect(await ids(areaA, { tagIds: [tagLocalB] })).toEqual([]);
    expect(names(await ids(areaB, { tagIds: [tagLocalB] }))).toEqual(["otraUnidad"]);
  });

  it("email: con (no nulo ni vacío tras trim) / sin", async () => {
    const withEmail = names(await ids(master, { tagIds: [tagAbogado], hasEmail: true }));
    expect(withEmail).toEqual(["abogadoEmail", "abogadoFull", "ambos"]);
    const without = names(await ids(master, { tagIds: [tagAbogado], hasEmail: false }));
    expect(without).toEqual(["abogadoBlank", "abogadoNone", "abogadoPhone"]); // «   » y NULL cuentan como sin email
  });

  it("teléfono: con / sin (campo canónico people.phone)", async () => {
    expect(names(await ids(master, { tagIds: [tagAbogado], hasPhone: true }))).toEqual(["abogadoFull", "abogadoPhone", "ambos"]);
    expect(names(await ids(master, { tagIds: [tagAbogado], hasPhone: false }))).toEqual(["abogadoBlank", "abogadoEmail", "abogadoNone"]);
  });

  it("combinación tag + con email + con teléfono = intersección; con paginación consistente", async () => {
    const filter = { tagIds: [tagAbogado], hasEmail: true, hasPhone: true };
    expect(names(await ids(master, filter))).toEqual(["abogadoFull", "ambos"]);
    expect(await pq.countPeople(master, filter)).toBe(2);
    const page1 = await pq.listPeoplePage(master, filter, { field: "name", direction: "asc" }, 1, 1);
    const page2 = await pq.listPeoplePage(master, filter, { field: "name", direction: "asc" }, 2, 1);
    expect(page1.total).toBe(2);
    expect([...page1.rows, ...page2.rows].map((r) => r.id).sort()).toEqual(await ids(master, filter));
    // tag + sin email + con teléfono
    expect(names(await ids(master, { tagIds: [tagAbogado], hasEmail: false, hasPhone: true }))).toEqual(["abogadoPhone"]);
  });

  it("alcance: el área A nunca ve personas de B aunque el filtro las matchee", async () => {
    expect(names(await ids(areaA, { hasEmail: true, hasPhone: true }))).not.toContain("otraUnidad");
    expect(names(await ids(areaB, { hasEmail: true, hasPhone: true }))).toEqual(["otraUnidad"]);
  });

  it("el parser único (página, CSV y Mailing) valida y es reversible", () => {
    const p = new URLSearchParams(`tag=${tagAbogado}&tag=${tagJuventud}&tag=no-uuid&tagMatch=all&email=with&phone=without&status=hack`);
    const f = fp.parsePeopleFilter(fp.paramReaderFromSearchParams(p));
    expect(f).toMatchObject({ tagIds: [tagAbogado, tagJuventud], tagMatch: "all", hasEmail: true, hasPhone: false, status: "active" });
    // una sola etiqueta no lleva tagMatch; los vacíos son «todos»
    const g = fp.parsePeopleFilter(fp.paramReaderFromSearchParams(new URLSearchParams(`tag=${tagAbogado}&tagMatch=all&email=&phone=`)));
    expect(g.tagMatch).toBeUndefined();
    expect(g.hasEmail).toBeUndefined();
    expect(g.hasPhone).toBeUndefined();
    const back = fp.peopleFilterToParams(f);
    expect(back.getAll("tag")).toEqual([tagAbogado, tagJuventud]);
    expect(back.get("email")).toBe("with");
    expect(back.get("phone")).toBe("without");
    // acotado a las visibles
    const h = fp.parsePeopleFilter(fp.paramReaderFromSearchParams(p), { visibleTagIds: new Set([tagJuventud]) });
    expect(h.tagIds).toEqual([tagJuventud]);
  });
});

describe("Mailing recibe exactamente el universo filtrado", () => {
  it("«todos los resultados» (people_filter) = misma población que la grilla; el esquema acepta los filtros nuevos", async () => {
    const filter = { tagIds: [tagAbogado], hasEmail: true as const, hasPhone: true as const, status: "active" as const };
    expect(audienceSpecSchema.safeParse({ kind: "people_filter", filter }).success).toBe(true);
    expect(audienceSpecSchema.safeParse({ kind: "people_filter", filter: { hasEmail: "yes" } }).success).toBe(false);
    const grid = await ids(master, filter);
    const preview = await campaigns.previewAudience(master, { kind: "people_filter", filter });
    expect(preview.stats.selected).toBe(grid.length);
    expect(preview.stats.withEmail).toBe(grid.length); // «con email» ya excluye a los sin email
    expect(preview.stats.finalRecipients).toBe(2);
    // y respeta el alcance: el área B con el mismo filtro no obtiene personas de A
    const b = await campaigns.previewAudience(areaB, { kind: "people_filter", filter });
    expect(b.stats.selected).toBe(0);
    // «sin email» como filtro de personas deja la audiencia vacía de destinatarios (no hay a quién escribir)
    const none = await campaigns.previewAudience(master, { kind: "people_filter", filter: { tagIds: [tagAbogado], hasEmail: false } });
    expect(none.stats.withEmail).toBe(0);
  });
});

describe("texto «¿Qué cuenta como contacto real?» eliminado de la interfaz", () => {
  it("no aparece en ninguna pantalla (app/ y components/); la definición B5 sigue en lib/", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (name === "node_modules" || name === ".next") continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && /Qué cuenta como contacto real|RealContactNotice/.test(readFileSync(full, "utf8"))) hits.push(full.replace(/\\/g, "/"));
      }
    };
    walk("app");
    walk("components");
    expect(hits).toEqual([]);
    expect(readFileSync("lib/contacts/real-contact.ts", "utf8")).toContain("countsAsRealContactSql");
  });
});

describe("historial: la participación aparece como «Participó en …» sin ser contacto", () => {
  it("una vez, con la fecha real de la actividad, sin mover semáforo ni crear interacciones; sin fecha → «Fecha no registrada»", async () => {
    const db = await getDb();
    const p = await person({ email: "hist@x.test", first: "Histórica" });
    const dated = (
      await db
        .insertInto("meetings")
        .values({ name: "Jornada de Vacunación", owner_organization_id: orgA, organizer_user_id: master.id, created_by: master.id, origin: "import", source_event_key: "operativo:flt-jornada", status: "finished", meeting_type: "operativo_salud", schedule_precision: "date_only", event_date: "2026-03-10" } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await db.insertInto("meeting_participations").values({ meeting_id: dated, person_id: p, participation_kind: "participated", participation_basis: "source_business_rule", evidence: "regla" } as never).execute();
    await db.insertInto("meeting_participations").values({ meeting_id: null, campaign_key: "ophthalmology:flt-campana", person_id: p, participation_kind: "participated", participation_basis: "source_business_rule", evidence: "regla de la fuente" } as never).execute();
    const before = (await sql<{ n: number }>`select count(*)::int n from person_interactions where person_id = ${p}::uuid`.execute(db)).rows[0]!.n;

    const page = await tl.getPersonTimeline(master, p, { limit: 50 });
    const parts = page!.events.filter((e) => e.category === "participation");
    expect(parts).toHaveLength(2); // una por hecho, sin duplicados
    const withDate = parts.find((e) => e.title.includes("Jornada de Vacunación"))!;
    expect(withDate.title).toBe("Participó en Jornada de Vacunación");
    expect(withDate.at).not.toBeNull();
    expect(new Date(withDate.at!).toISOString().slice(0, 10)).toBe("2026-03-10");
    expect(withDate.countsAsContact).toBe(false);
    const camp = parts.find((e) => e !== withDate)!;
    expect(camp.title).toMatch(/^Participó en/);
    expect(camp.at).toBeNull(); // sin jornada/fecha: nunca se inventa
    expect(camp.countsAsContact).toBe(false);

    // semáforo / último contacto intactos y sin interacciones nuevas
    const rel = await tl.getPersonRelationship(master, p);
    expect(rel!.lastContact).toBeNull();
    expect((await sql<{ n: number }>`select count(*)::int n from person_interactions where person_id = ${p}::uuid`.execute(db)).rows[0]!.n).toBe(before);
    expect(await pq.countPeople(master, { search: "Histórica", trafficLight: "gray" })).toBe(1);
  });
});

describe("Visualización: reuniones por estado", () => {
  it("agrupa por estado, traduce y no omite categorías (incluidas las de valor 0)", () => {
    const past = new Date(Date.now() - 86_400_000);
    const series = analytics.buildMeetingStatusSeries([
      { status: "draft", ends_at: null },
      { status: "draft", ends_at: null },
      { status: "finished", ends_at: past },
      { status: "scheduled", ends_at: past }, // vencida sin cerrar (derivado)
      { status: "scheduled", ends_at: new Date(Date.now() + 86_400_000) },
    ]);
    const by = Object.fromEntries(series.map((s) => [s.nombre, s.valor]));
    expect(by).toEqual({ Borrador: 2, Programado: 1, "En curso": 0, Finalizado: 1, Cancelado: 0, "Vencido sin cerrar": 1 });
    expect(series.map((s) => s.nombre).slice(0, 5)).toEqual(["Borrador", "Programado", "En curso", "Finalizado", "Cancelado"]);
    // sin reuniones: igual están los cinco estados en 0 (no se oculta nada)
    expect(analytics.buildMeetingStatusSeries([]).map((s) => s.valor)).toEqual([0, 0, 0, 0, 0]);
  });
});
