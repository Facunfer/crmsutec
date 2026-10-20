import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { sql } from "kysely";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Fase F0 — endurecimiento de seguridad. Comportamiento real sobre PGlite (nada de búsquedas de texto en el código):
 *   S1 tokens fuera de la tabla de límites · S2 alcance de asociaciones en formularios públicos · S3 anti-automatización ·
 *   S5 límite atómico y retención · S6 permiso de acreditación.
 * (S4 y S7 son funciones puras: tests/unit/client-ip.test.ts y tests/unit/qr-config.test.ts.)
 */

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.SUTECBA_QR_SECRET = "test-qr-secret-".padEnd(48, "x");

let currentToken: string | undefined;
vi.mock("../../lib/auth/cookies.js", () => ({ getSessionCookie: async () => currentToken }));

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb, execRawSql } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createSession, loadSessionUser } = await import("../../lib/auth/session.js");
const { createUser } = await import("../../lib/users/commands.js");
const formCommands = await import("../../lib/forms/commands.js");
const { submitForm, MIN_FILL_MS } = await import("../../lib/forms/submit.js");
const { resolveQrToken } = await import("../../lib/attendance/checkin.js");
const { signRotatingQrToken } = await import("../../lib/attendance/qr.js");
const invitationsLib = await import("../../lib/meetings/invitations.js");
const { getInvitationByToken, respondToInvitation, checkInByInvitationToken } = await import("../../lib/meetings/public.js");
const { getLivePanelData, quickSearchForAccreditation } = await import("../../lib/attendance/live.js");
const limiter = await import("../../lib/security/public-rate-limit.js");
const { ROLE_PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { GET: qrRoute } = await import("../../app/api/reuniones/[id]/qr/route.js");
const { GET: liveRoute } = await import("../../app/api/reuniones/[id]/live/route.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const orgs = new Map<string, string>();
const o = (name: string) => orgs.get(name)!;
const ids = new Map<string, string>();
const id = (key: string) => ids.get(key)!;
const tokens = new Map<string, string>();
let master: any;
let masterId: string;
let ipCounter = 0;
const nextIp = () => `10.30.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
let dniSeq = 30000000;
const nextDni = () => String(++dniSeq);

async function makeOrg(name: string, parentId: string | null) {
  const db = await getDb();
  const type = await db.selectFrom("organization_types").select("id").where("key", "=", "reparticion").executeTakeFirstOrThrow();
  const row = await db.insertInto("organizations").values({ name, type_id: type.id, parent_id: parentId }).returning("id").executeTakeFirstOrThrow();
  orgs.set(name, row.id);
}

async function makePerson(key: string, first: string, last: string, dni: string, org: string) {
  const db = await getDb();
  const row = await db.insertInto("people").values({ first_name: first, last_name: last, dni, organization_id: o(org), created_by: masterId }).returning("id").executeTakeFirstOrThrow();
  ids.set(key, row.id);
}

async function makeMeeting(key: string, org: string, status: "scheduled" | "in_progress" = "in_progress") {
  const db = await getDb();
  const row = await db
    .insertInto("meetings")
    .values({
      name: `Reunión ${key}`,
      owner_organization_id: o(org),
      status,
      allow_uninvited_checkin: false,
      starts_at: new Date(Date.now() + (status === "scheduled" ? 60 : -10) * 60_000),
      ends_at: new Date(Date.now() + (status === "scheduled" ? 150 : 80) * 60_000),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  ids.set(key, row.id);
}

async function makeAssociation(key: string, org: string, status: "active" | "inactive" = "active") {
  const db = await getDb();
  const type = await db.selectFrom("association_types").select("id").limit(1).executeTakeFirstOrThrow();
  const row = await db
    .insertInto("associations")
    .values({ name: `Asoc ${key}`, type_id: type.id, owner_organization_id: o(org), status } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  ids.set(key, row.id);
}

async function sessionFor(email: string) {
  const { token } = await createSession(id(email));
  return { token, user: (await loadSessionUser(token))! };
}

async function draftForm(slug: string, ownerOrg: string, extraFields: Array<[string, string, string, string]> = []) {
  const { id: formId } = await formCommands.createForm(master, { name: slug, slug, ownerOrganizationId: o(ownerOrg) });
  await formCommands.updateFormMeta(master, formId, {
    name: slug, slug, consentText: "", successMessage: "", opensAt: "", closesAt: "",
    matchFields: ["dni"], personCreationPolicy: "when_valid_dni", applyDataPolicy: "fill_empty_only",
  } as any);
  const fields: Array<[string, string, string, string]> = [
    ["first_name", "Nombre", "text", "first_name"],
    ["last_name", "Apellido", "text", "last_name"],
    ["dni", "DNI", "dni", "dni"],
    ...extraFields,
  ];
  for (const [key, label, type, mapping] of fields) {
    await formCommands.upsertField(master, formId, null, { key, label, fieldType: type, required: ["first_name", "last_name", "dni"].includes(key), visible: true, personFieldMapping: mapping } as any);
  }
  return formId;
}

async function makeForm(slug: string, ownerOrg: string, extraFields: Array<[string, string, string, string]> = []) {
  const formId = await draftForm(slug, ownerOrg, extraFields);
  await formCommands.publishForm(master, formId);
  return formId;
}

const sub = (slug: string, dni: string, extra: Record<string, string> = {}, signals = {}) =>
  submitForm(slug, { first_name: "Ana", last_name: "Prueba", dni, ...extra }, randomUUID(), nextIp(), "vitest", signals);

const attemptsFor = async (scope: string) =>
  (await sql<{ identifier: string; ip_address: string; succeeded: boolean }>`select identifier, ip_address::text as ip_address, succeeded from public_link_attempts where scope = ${scope}`.execute(await getDb())).rows;
const count = async (query: ReturnType<typeof sql<{ n: number }>>) => (await query.execute(await getDb())).rows[0]!.n;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  await makeOrg("A", null);
  await makeOrg("A1", o("A"));
  await makeOrg("B", null);

  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const m = await db.insertInto("users").values({ email: "master@sutecba.local", password_hash: await hashPassword("bootstrap-password-123"), full_name: "Master", role_id: role.id }).returning("id").executeTakeFirstOrThrow();
  masterId = m.id;
  ids.set("master@sutecba.local", masterId);
  master = (await sessionFor("master@sutecba.local")).user;

  const create = async (email: string, roleKey: string) => {
    const { userId } = await createUser(master, {
      email, fullName: email, roleKey: roleKey as any,
      scopes: [{ organizationId: o("A"), includeDescendants: true }],
      moduleKeys: ["personas", "reuniones", "formularios", "dashboard", "asociaciones"],
    });
    ids.set(email, userId);
  };
  for (const r of ["ADMIN", "OPERADOR", "REUNIONES", "LECTURA"]) await create(`${r.toLowerCase()}@sutecba.local`, r);

  await makePerson("pA", "Alma", "Alfa", "50000002", "A");
  await makePerson("pB", "Beto", "Beta", "50000001", "B");
  await makeMeeting("mA", "A");
  await makeMeeting("mB", "B");
  await makeMeeting("mSched", "A", "scheduled");
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S5 — límite atómico, trazabilidad y retención", () => {
  it("N pedidos SIMULTÁNEOS por el mismo identificador: pasan exactamente `límite`, ni uno más", async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => limiter.consumePublicLinkAttempt("t_atomic_id", "mismo", "10.99.0.1", { perIdentifierLimit: 10, perIpLimit: 1000 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(await attemptsFor("t_atomic_id")).toHaveLength(10); // lo rechazado no se registra: el bloqueo se levanta solo y la tabla no crece bajo ataque
  });

  it("N pedidos simultáneos desde la misma IP con identificadores distintos: pasan exactamente `límite por IP`", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => limiter.consumePublicLinkAttempt("t_atomic_ip", `id-${i}`, "10.99.0.2", { perIdentifierLimit: 1000, perIpLimit: 7 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(7);
  });

  it("IPs distintas no se pisan entre sí, y los scopes son independientes", async () => {
    for (let i = 0; i < 5; i += 1) expect((await limiter.consumePublicLinkAttempt("t_iso", `a${i}`, "10.99.0.3", { perIpLimit: 5 })).allowed).toBe(true);
    expect((await limiter.consumePublicLinkAttempt("t_iso", "a9", "10.99.0.3", { perIpLimit: 5 })).allowed).toBe(false);
    expect((await limiter.consumePublicLinkAttempt("t_iso", "a9", "10.99.0.4", { perIpLimit: 5 })).allowed).toBe(true);
    expect((await limiter.consumePublicLinkAttempt("t_iso_otro_scope", "a9", "10.99.0.3", { perIpLimit: 5 })).allowed).toBe(true);
  });

  it("tope de FALLIDOS: muchos aciertos desde la misma IP no bloquean, pero quien falla sí se frena", async () => {
    const opts = { perIdentifierLimit: 100, perIpLimit: 1000, perIdentifierFailureLimit: 5 };
    for (let i = 0; i < 30; i += 1) {
      const r = await limiter.consumePublicLinkAttempt("t_fail", "wifi", "10.99.0.8", opts);
      expect(r.allowed).toBe(true);
      await limiter.settlePublicLinkAttempt(r.attemptId, true); // acierto
    }
    let blockedAt = -1;
    for (let i = 0; i < 10; i += 1) {
      const r = await limiter.consumePublicLinkAttempt("t_fail", "wifi", "10.99.0.8", opts); // sin settle => cuenta como fallido
      if (!r.allowed) { blockedAt = i; break; }
    }
    expect(blockedAt).toBe(5);
  });

  it("lo que quedó fuera de la ventana no cuenta (no se bloquea a nadie para siempre)", async () => {
    const db = await getDb();
    await sql`insert into public_link_attempts (scope, identifier, ip_address, succeeded, created_at) select 't_window', 'viejo', '10.99.0.5', false, now() - interval '11 minutes' from generate_series(1, 20)`.execute(db);
    expect((await limiter.consumePublicLinkAttempt("t_window", "viejo", "10.99.0.5", { perIdentifierLimit: 3, perIpLimit: 3 })).allowed).toBe(true);
  });

  it("el intento reservado se completa con su resultado (trazabilidad) y un id nulo no hace nada", async () => {
    const ok = await limiter.consumePublicLinkAttempt("t_settle", "x", "10.99.0.6");
    const ok2 = await limiter.consumePublicLinkAttempt("t_settle", "y", "10.99.0.6");
    await limiter.settlePublicLinkAttempt(ok.attemptId, true);
    await limiter.settlePublicLinkAttempt(ok2.attemptId, false);
    await limiter.settlePublicLinkAttempt(null, true);
    const rows = await attemptsFor("t_settle");
    expect(rows.find((r) => r.identifier === "x")!.succeeded).toBe(true);
    expect(rows.find((r) => r.identifier === "y")!.succeeded).toBe(false);
  });

  it("la limpieza borra solo lo viejo (>retención), en lotes, y se niega a barrer la ventana reciente", async () => {
    const db = await getDb();
    await sql`insert into public_link_attempts (scope, identifier, ip_address, succeeded, created_at) select 't_purge', 'v', '10.99.0.7', true, now() - interval '40 days' from generate_series(1, 6)`.execute(db);
    await sql`insert into public_link_attempts (scope, identifier, ip_address, succeeded, created_at) select 't_purge', 'n', '10.99.0.7', true, now() - interval '5 days' from generate_series(1, 4)`.execute(db);
    expect(await limiter.purgePublicLinkAttempts(30)).toBeGreaterThanOrEqual(6);
    const left = await attemptsFor("t_purge");
    expect(left).toHaveLength(4);
    expect(left.every((r) => r.identifier === "n")).toBe(true);
    await expect(limiter.purgePublicLinkAttempts(0)).rejects.toThrow();
    expect((await attemptsFor("t_purge")).length).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S1 — ningún token queda en claro en el rastro del límite", () => {
  let tokenView: string; // reunión programada: se puede ver y responder
  let tokenCheckin: string; // reunión en curso: se puede acreditar
  let tokenOther: string;

  beforeAll(async () => {
    await makePerson("pInv1", "Inés", "Invitada", nextDni(), "A");
    await makePerson("pInv2", "Iván", "Invitado", nextDni(), "A");
    const sched = await invitationsLib.createInvitationBatch(master, id("mSched"), { personIds: [id("pInv1")] });
    tokenView = sched.links[0]!.token;
    const live = await invitationsLib.createInvitationBatch(master, id("mA"), { personIds: [id("pInv1"), id("pInv2")] });
    tokenCheckin = live.links.find((l) => l.personId === id("pInv1"))!.token;
    tokenOther = live.links.find((l) => l.personId === id("pInv2"))!.token;
  });

  it("ver, responder y acreditarse con el enlace personal funcionan y NO dejan el token (ni un pedazo) en la tabla", async () => {
    const view = await getInvitationByToken(tokenView, nextIp());
    expect(["ok", "checkin"]).toContain(view.kind);
    expect((await respondToInvitation(tokenView, "confirmed", nextIp())).ok).toBe(true);
    expect((await checkInByInvitationToken(tokenCheckin, nextIp(), "vitest")).ok).toBe(true);
    await getInvitationByToken("x".repeat(43), nextIp()); // token inexistente: tampoco queda en claro

    const db = await getDb();
    const all = JSON.stringify((await sql`select * from public_link_attempts where scope like 'invitation_%'`.execute(db)).rows);
    for (const secret of [tokenView, tokenView.slice(0, 24), tokenCheckin, tokenCheckin.slice(0, 24), "x".repeat(43)]) expect(all).not.toContain(secret);

    for (const [scope, token] of [["invitation_view", tokenView], ["invitation_respond", tokenView], ["invitation_checkin", tokenCheckin]] as const) {
      const rows = (await attemptsFor(scope)).filter((r) => r.identifier === limiter.hashRateLimitIdentifier(scope, token));
      expect(rows.length, scope).toBeGreaterThan(0);
      expect(rows.every((r) => r.identifier.startsWith("h1:") && !r.identifier.includes(token))).toBe(true);
    }
    // se completó el resultado de las operaciones que salieron bien
    expect((await attemptsFor("invitation_respond")).some((r) => r.succeeded)).toBe(true);
  });

  it("el escaneo del QR deja el identificador hasheado, no el prefijo del token", async () => {
    const meeting = await (await getDb()).selectFrom("meetings").select("qr_secret_version").where("id", "=", id("mA")).executeTakeFirstOrThrow();
    const { token } = signRotatingQrToken(id("mA"), meeting.qr_secret_version);
    expect((await resolveQrToken(token, nextIp())).kind).toBe("ok");
    const rows = await attemptsFor("checkin_qr");
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(token.slice(0, 24));
    expect(rows.every((r) => r.identifier.startsWith("h1:"))).toBe(true);
  });

  it("el límite por enlace sigue vigente con el identificador hasheado (el intento 31 se frena)", async () => {
    const ip = nextIp();
    let limited = 0;
    for (let i = 0; i < 40; i += 1) if ((await getInvitationByToken(tokenOther, ip)).kind === "rate_limited") limited += 1;
    expect(limited).toBe(10);
  });

  it("el hash separa dominios (mismo valor, distinto scope => distinto identificador) y es estable", () => {
    const a = limiter.hashRateLimitIdentifier("invitation_view", "abc");
    expect(a).toBe(limiter.hashRateLimitIdentifier("invitation_view", "abc"));
    expect(a).not.toBe(limiter.hashRateLimitIdentifier("invitation_respond", "abc"));
    expect(a).toMatch(/^h1:[0-9a-f]{32}$/);
  });

  it("la migración 0046 sanea lo histórico SIN borrar filas ni invalidar invitaciones, y es idempotente", async () => {
    const db = await getDb();
    const legacy = [
      ["invitation_view", tokenView], ["invitation_respond", tokenView], ["invitation_checkin", tokenOther], ["checkin_qr", "eyJtIjoiMDAwMDAwMDAtMDAw"],
    ] as const;
    for (const [scope, identifier] of legacy) {
      await sql`insert into public_link_attempts (scope, identifier, ip_address, succeeded, created_at) values (${scope}, ${identifier}, '10.77.0.1', true, now() - interval '2 days')`.execute(db);
    }
    await sql`insert into public_link_attempts (scope, identifier, ip_address, succeeded, created_at) values ('form_submit', 'mi-formulario', '10.77.0.1', true, now() - interval '2 days')`.execute(db);
    const before = await count(sql<{ n: number }>`select count(*)::int n from public_link_attempts`);

    const migration = readFileSync("db/migrations/0046_public_link_attempts_hardening.sql", "utf8");
    await execRawSql(migration);
    await execRawSql(migration); // idempotente

    expect(await count(sql<{ n: number }>`select count(*)::int n from public_link_attempts`)).toBe(before); // ninguna fila borrada
    const raw = JSON.stringify((await sql`select identifier from public_link_attempts where ip_address = '10.77.0.1'`.execute(db)).rows);
    expect(raw).not.toContain(tokenView);
    expect(raw).not.toContain(tokenOther);
    expect(raw).not.toContain("eyJtIjoiMDAwMDAwMDAtMDAw");
    expect(raw).toContain("mi-formulario"); // el slug público no es un secreto: no se toca
    const rows = (await sql<{ scope: string; identifier: string; succeeded: boolean }>`select scope, identifier, succeeded from public_link_attempts where ip_address = '10.77.0.1'`.execute(db)).rows;
    expect(rows.find((r) => r.scope === "invitation_view")!.identifier).toBe(limiter.hashRateLimitIdentifier("invitation_view", tokenView)); // misma fórmula que la app
    expect(rows.every((r) => r.succeeded)).toBe(true);

    // las invitaciones existentes siguen funcionando: el acceso depende de meeting_invitations.token_hash, no de esta tabla
    expect(["ok", "checkin"]).toContain((await getInvitationByToken(tokenView, nextIp())).kind);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S2 — un formulario público no suma personas a asociaciones fuera de su alcance", () => {
  const slug = "f0-asociaciones";
  let formId: string;
  let personDni: string;

  beforeAll(async () => {
    await makeAssociation("aA", "A");
    await makeAssociation("aA1", "A1");
    await makeAssociation("aB", "B");
    await makeAssociation("aInactiva", "A", "inactive");
    formId = await makeForm(slug, "A", [["asociacion", "Asociación", "association", ""]]);
    await makePerson("pForm", "Fabi", "Formulario", (personDni = nextDni()), "A");
  });

  // Cada envío usa una persona propia: reenviar el mismo DNI muchas veces lo frena el tope «misma persona» (S3), que no es lo que se prueba acá.
  const newPerson = async (key: string) => {
    const dni = nextDni();
    await makePerson(key, "Fabi", "Formulario", dni, "A");
    return dni;
  };
  const isMember = async (assoc: string, person = "pForm") =>
    (await count(sql<{ n: number }>`select count(*)::int n from people_associations where person_id = ${id(person)}::uuid and association_id = ${id(assoc)}::uuid`)) > 0;

  it("asociación de la unidad del formulario y de una dependiente: se suma", async () => {
    expect((await sub(slug, personDni, { asociacion: id("aA") })).kind).toBe("ok");
    expect(await isMember("aA")).toBe(true);
    expect((await sub(slug, personDni, { asociacion: id("aA1") })).kind).toBe("ok");
    expect(await isMember("aA1")).toBe(true);
  });

  it("asociación de OTRA unidad, inactiva, inexistente o con id manipulado: no se suma y el envío se procesa igual", async () => {
    const before = await count(sql<{ n: number }>`select count(*)::int n from people_associations`);
    const forgedValues = [id("aB"), id("aInactiva"), randomUUID(), "no-es-un-uuid", "' or 1=1 --", `${id("aB")} `];
    for (const [i, forged] of forgedValues.entries()) {
      const dni = await newPerson(`pForjada${i}`);
      const res = await sub(slug, dni, { asociacion: forged });
      expect(res.kind, forged).toBe("ok"); // misma respuesta: no revela qué asociaciones existen
      // el envío se procesó: quedó vinculado a la persona, solo que sin la asociación
      expect(await count(sql<{ n: number }>`select count(*)::int n from form_submissions where form_id = ${formId}::uuid and person_id = ${id(`pForjada${i}`)}::uuid`), forged).toBe(1);
      expect(await isMember("aB", `pForjada${i}`)).toBe(false);
      expect(await isMember("aInactiva", `pForjada${i}`)).toBe(false);
    }
    expect(await count(sql<{ n: number }>`select count(*)::int n from people_associations`)).toBe(before);
  });

  it("un formulario YA publicado con una acción fuera del alcance (versión anterior a F0) tampoco la aplica en el servidor", async () => {
    const db = await getDb();
    // Publicar esa configuración ya no es posible (ver el bloque siguiente); se simula una versión publicada antes de esta regla.
    const v = await db.selectFrom("forms").select("published_version").where("id", "=", formId).executeTakeFirstOrThrow();
    await sql`update form_versions set schema = jsonb_set(schema, '{actions}', ${JSON.stringify([{ actionType: "add_to_association", config: { associationId: id("aB") } }])}::jsonb) where form_id = ${formId}::uuid and version = ${v.published_version}`.execute(db);
    const dni = await newPerson("pAccionVieja");
    expect((await sub(slug, dni)).kind).toBe("ok");
    expect(await isMember("aB", "pAccionVieja")).toBe(false);
  });

  it("configurar la acción desde el panel exige que la asociación sea de la unidad del formulario", async () => {
    const draft = await formCommands.createForm(master, { name: "f0-borrador", slug: "f0-borrador", ownerOrganizationId: o("A") });
    await expect(formCommands.addAssociationAction(master, draft.id, id("aB"))).rejects.toThrow(/unidad del formulario/);
    await expect(formCommands.addAssociationAction(master, draft.id, id("aA1"))).resolves.toBeDefined();
  });

  it("la lista que ve el visitante y la regla del servidor son la misma", async () => {
    const forms = await import("../../lib/forms/queries.js");
    const offered = (await forms.listAssociationsForPublicForm(o("A"))).map((a) => a.id).sort();
    for (const key of ["aA", "aA1", "aB", "aInactiva"]) {
      expect(await forms.isAssociationAllowedForForm(id(key), o("A")), key).toBe(offered.includes(id(key)));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S3 — protección contra envíos automatizados sin estorbar a las personas", () => {
  const slug = "f0-antibot";

  beforeAll(async () => {
    await makeForm(slug, "A");
  });

  const submissions = async () => count(sql<{ n: number }>`select count(*)::int n from form_submissions fs join forms f on f.id = fs.form_id where f.slug = ${slug}`);

  it("un envío normal (sin señales, o con tiempo razonable) se guarda", async () => {
    expect((await sub(slug, nextDni())).kind).toBe("ok");
    expect((await sub(slug, nextDni(), {}, { honeypot: "", renderedAtMs: Date.now() - 8000 })).kind).toBe("ok");
    expect(await submissions()).toBe(2);
  });

  it("honeypot completado: responde «gracias» (no avisa) pero NO guarda nada ni crea personas", async () => {
    const dni = nextDni();
    const before = await submissions();
    const res = await sub(slug, dni, {}, { honeypot: "http://spam.example" });
    expect(res.kind).toBe("ok");
    expect(await submissions()).toBe(before);
    expect(await count(sql<{ n: number }>`select count(*)::int n from people where dni = ${dni}`)).toBe(0);
  });

  it("enviado en menos de MIN_FILL_MS: pide reintentar (no se pierde a una persona real) y no guarda", async () => {
    const before = await submissions();
    expect((await sub(slug, nextDni(), {}, { renderedAtMs: Date.now() - 100 })).kind).toBe("too_fast");
    expect(await submissions()).toBe(before);
    expect((await sub(slug, nextDni(), {}, { renderedAtMs: Date.now() - (MIN_FILL_MS + 500) })).kind).toBe("ok");
  });

  it("instante ausente o inverosímil (página abierta antes del cambio, reloj raro): no hay señal confiable y se deja pasar", async () => {
    expect((await sub(slug, nextDni(), {}, { renderedAtMs: undefined })).kind).toBe("ok");
    expect((await sub(slug, nextDni(), {}, { renderedAtMs: Date.now() + 3_600_000 })).kind).toBe("ok");
  });

  it("la misma persona (DNI) no puede reenviar sin fin: el 6.º envío distinto se frena, y el DNI no queda en claro", async () => {
    const dni = nextDni();
    const results: string[] = [];
    for (let i = 0; i < 7; i += 1) results.push((await sub(slug, dni)).kind);
    expect(results.filter((k) => k === "ok")).toHaveLength(5);
    expect(results.filter((k) => k === "rate_limited")).toHaveLength(2);
    const rows = JSON.stringify(await attemptsFor("form_submit_person"));
    expect(rows).not.toContain(dni);
  });

  it("reintentar EL MISMO envío (doble toque / red lenta) devuelve ok y no consume el tope de «misma persona»", async () => {
    const dni = nextDni();
    const key = randomUUID();
    for (let i = 0; i < 12; i += 1) {
      const res = await submitForm(slug, { first_name: "Ana", last_name: "Prueba", dni }, key, nextIp(), "vitest");
      expect(res.kind).toBe("ok");
    }
    expect(await count(sql<{ n: number }>`select count(*)::int n from form_submissions where idempotency_key = ${key}`)).toBe(1);
    expect((await sub(slug, dni)).kind).toBe("ok"); // y la persona todavía tiene cupo
  });

  it("muchas personas distintas al mismo formulario desde la misma IP (un acto con wifi compartido) no se bloquean antes del tope por IP", async () => {
    const ip = "10.55.9.9";
    let ok = 0;
    for (let i = 0; i < 60; i += 1) {
      const res = await submitForm(slug, { first_name: "Ana", last_name: "Prueba", dni: nextDni() }, randomUUID(), ip, "vitest");
      if (res.kind === "ok") ok += 1;
    }
    expect(ok).toBe(60);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S6 — acreditación: el QR operativo y la búsqueda exigen meetings.accredit", () => {
  const asUser = async (email: string | null) => {
    currentToken = email ? (await sessionFor(email)).token : undefined;
  };
  const callQr = (meeting: string) => qrRoute(new NextRequest(`https://crm.test/api/reuniones/${meeting}/qr`), { params: Promise.resolve({ id: meeting }) });
  const callLive = (meeting: string, q?: string) =>
    liveRoute(new NextRequest(`https://crm.test/api/reuniones/${meeting}/live${q ? `?q=${encodeURIComponent(q)}` : ""}`), { params: Promise.resolve({ id: meeting }) });

  it("matriz por rol (catálogo Y base): LECTURA no acredita; el resto de los roles operativos conserva su acceso", async () => {
    expect(ROLE_PERMISSIONS.LECTURA).toContain("meetings.view");
    expect(ROLE_PERMISSIONS.LECTURA).not.toContain("meetings.accredit");
    for (const role of ["MASTER_GLOBAL", "ADMIN", "OPERADOR", "REUNIONES"] as const) expect(ROLE_PERMISSIONS[role], role).toContain("meetings.accredit");

    const db = await getDb();
    const rows = (await sql<{ role: string }>`select r.key as role from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where p.key = 'meetings.accredit' order by 1`.execute(db)).rows.map((r) => r.role);
    expect(rows).toEqual(["ADMIN", "MASTER_GLOBAL", "OPERADOR", "REUNIONES"]);
  });

  it("sin sesión: 401 en ambas rutas", async () => {
    await asUser(null);
    expect((await callQr(id("mA"))).status).toBe(401);
    expect((await callLive(id("mA"))).status).toBe(401);
  });

  it("LECTURA (con meetings.view): 403 para el QR, el panel y la búsqueda", async () => {
    await asUser("lectura@sutecba.local");
    expect((await callQr(id("mA"))).status).toBe(403);
    expect((await callLive(id("mA"))).status).toBe(403);
    expect((await callLive(id("mA"), "Alma")).status).toBe(403);
  });

  it("REUNIONES / OPERADOR / ADMIN sobre una reunión de su unidad: 200 con QR firmado, panel y búsqueda", async () => {
    for (const email of ["reuniones@sutecba.local", "operador@sutecba.local", "admin@sutecba.local"]) {
      await asUser(email);
      const qr = await callQr(id("mA"));
      expect(qr.status, email).toBe(200);
      const body = (await qr.json()) as { token: string; mode: string };
      expect(body.token.split(".")).toHaveLength(2);
      expect((await callLive(id("mA"))).status, email).toBe(200);
      const search = (await (await callLive(id("mA"), "Alfa")).json()) as { results: Array<{ personId: string }> };
      expect(search.results.map((r) => r.personId)).toContain(id("pA"));
    }
  });

  it("alcance: una reunión de OTRA unidad devuelve 404 aunque el rol tenga el permiso, y la búsqueda no trae personas ajenas", async () => {
    await asUser("reuniones@sutecba.local");
    expect((await callQr(id("mB"))).status).toBe(404);
    expect((await callLive(id("mB"))).status).toBe(404);
    const search = (await (await callLive(id("mA"), "Beta")).json()) as { results: unknown[] };
    expect(search.results).toHaveLength(0); // pB es de la unidad B
    const byDni = (await (await callLive(id("mA"), "50000001")).json()) as { results: unknown[] };
    expect(byDni.results).toHaveLength(0);
  });

  it("UUID manipulado o inexistente: 404, sin error de servidor", async () => {
    await asUser("reuniones@sutecba.local");
    expect((await callQr("no-es-un-uuid")).status).toBe(404);
    expect((await callQr(randomUUID())).status).toBe(404);
  });

  it("las funciones de librería se defienden solas (no dependen de que la ruta haya chequeado)", async () => {
    const lectura = (await sessionFor("lectura@sutecba.local")).user;
    const reuniones = (await sessionFor("reuniones@sutecba.local")).user;
    expect(await getLivePanelData(lectura, id("mA"))).toBeNull();
    expect(await quickSearchForAccreditation(lectura, id("mA"), "Alfa")).toEqual([]);
    expect(await getLivePanelData(reuniones, id("mA"))).not.toBeNull();
    expect((await quickSearchForAccreditation(reuniones, id("mA"), "Alfa")).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("S2 — publicar una configuración de asociaciones fuera de alcance se rechaza con un error claro", () => {
  let n = 0;
  const addAction = async (formId: string, associationId: string) => {
    const db = await getDb();
    await db.insertInto("form_actions").values({ form_id: formId, action_type: "add_to_association", config: JSON.stringify({ associationId }) as never, sort_order: ++n }).execute();
  };
  const status = async (formId: string) =>
    (await sql<{ status: string; v: number | null }>`select status, published_version v from forms where id = ${formId}::uuid`.execute(await getDb())).rows[0]!;
  const versions = async (formId: string) => count(sql<{ n: number }>`select count(*)::int n from form_versions where form_id = ${formId}::uuid`);
  const message = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  beforeAll(async () => {
    await makeAssociation("pa_ok", "A");
    await makeAssociation("pa_ok1", "A1");
    await makeAssociation("pa_otra", "B");
    await makeAssociation("pa_inactiva", "A", "inactive");
  });

  it("asociación de otra unidad: no se publica, el mensaje es claro, nombra la acción y NO muestra ids; el formulario queda como estaba", async () => {
    const formId = await draftForm("pa-otra-unidad", "A");
    await addAction(formId, id("pa_ok"));
    await addAction(formId, id("pa_otra"));
    const msg = await message(formCommands.publishForm(master, formId));
    expect(msg).toMatch(/^No se puede publicar: la acción «Sumar a una asociación» n\.º 2 /);
    expect(msg).toMatch(/no pertenece a la unidad del formulario, está inactiva o ya no existe/);
    expect(msg).toMatch(/Quitá esa acción o reemplazala/);
    expect(msg).toContain("Asoc pa_otra"); // el master tiene alcance sobre esa asociación: puede ver cuál es
    for (const key of ["pa_ok", "pa_otra"]) expect(msg).not.toContain(id(key)); // nunca ids
    expect(await versions(formId)).toBe(0);
    expect((await status(formId)).status).toBe("draft");
  });

  it("quien publica SIN alcance sobre esa asociación no recibe su nombre (no se filtra información de otra unidad)", async () => {
    const formId = await draftForm("pa-sin-alcance", "A");
    await addAction(formId, id("pa_otra"));
    const admin = (await sessionFor("admin@sutecba.local")).user; // ADMIN con alcance solo sobre A
    const msg = await message(formCommands.publishForm(admin, formId));
    expect(msg).toMatch(/^No se puede publicar: la acción «Sumar a una asociación» n\.º 1 apunta/);
    expect(msg).not.toContain("Asoc pa_otra");
    expect(msg).not.toContain(id("pa_otra"));
  });

  it("inactiva, inexistente e id mal formado se rechazan igual, y con varias acciones inválidas se listan todas", async () => {
    const formId = await draftForm("pa-varias", "A");
    await addAction(formId, id("pa_inactiva"));
    await addAction(formId, randomUUID());
    await addAction(formId, "no-es-un-uuid");
    const msg = await message(formCommands.publishForm(master, formId));
    expect(msg).toMatch(/^No se puede publicar: las acciones «Sumar a una asociación» n\.º 1 \(«Asoc pa_inactiva»\), n\.º 2, n\.º 3 apuntan/);
    expect(msg).toMatch(/Quitá esas acciones o reemplazalas/);
    expect(msg).not.toContain("no-es-un-uuid");
    expect(await versions(formId)).toBe(0);
  });

  it("una configuración válida (unidad propia y dependiente) se publica, y las respuestas siguen sumando a esas asociaciones", async () => {
    const formId = await draftForm("pa-valida", "A");
    await addAction(formId, id("pa_ok"));
    await addAction(formId, id("pa_ok1"));
    await expect(formCommands.publishForm(master, formId)).resolves.toEqual({ version: 1 });
    await makePerson("pPaValida", "Vera", "Valida", nextDni(), "A");
    const dni = (await sql<{ dni: string }>`select dni from people where id = ${id("pPaValida")}::uuid`.execute(await getDb())).rows[0]!.dni;
    expect((await sub("pa-valida", dni)).kind).toBe("ok");
    const members = await count(sql<{ n: number }>`select count(*)::int n from people_associations where person_id = ${id("pPaValida")}::uuid`);
    expect(members).toBe(2);
  });

  it("corregir la configuración habilita la publicación (se quita la acción inválida)", async () => {
    const formId = await draftForm("pa-corregida", "A");
    await addAction(formId, id("pa_otra"));
    expect(await message(formCommands.publishForm(master, formId))).not.toBeNull();
    await (await getDb()).deleteFrom("form_actions").where("form_id", "=", formId).execute();
    await expect(formCommands.publishForm(master, formId)).resolves.toEqual({ version: 1 });
  });

  it("volver a publicar un formulario despublicado reactiva una versión guardada: también se valida contra el alcance actual", async () => {
    const formId = await draftForm("pa-reactivar", "A");
    await addAction(formId, id("pa_ok"));
    await formCommands.publishForm(master, formId);
    await formCommands.changeFormStatus(master, formId, "unpublished");
    const db = await getDb();
    // la versión guardada trae una acción fuera de alcance (p. ej. la asociación cambió de unidad después)
    await sql`update form_versions set schema = jsonb_set(schema, '{actions}', ${JSON.stringify([{ actionType: "add_to_association", config: { associationId: id("pa_otra") } }])}::jsonb) where form_id = ${formId}::uuid`.execute(db);
    const msg = await message(formCommands.changeFormStatus(master, formId, "published"));
    expect(msg).toMatch(/^No se puede publicar: la acción «Sumar a una asociación» n\.º 1/);
    expect((await status(formId)).status).toBe("unpublished");
    await sql`update form_versions set schema = jsonb_set(schema, '{actions}', ${JSON.stringify([{ actionType: "add_to_association", config: { associationId: id("pa_ok") } }])}::jsonb) where form_id = ${formId}::uuid`.execute(db);
    await expect(formCommands.changeFormStatus(master, formId, "published")).resolves.toBeUndefined();
    expect((await status(formId)).status).toBe("published");
  });

  it("un formulario sin acciones de asociación no se ve afectado", async () => {
    const formId = await draftForm("pa-sin-acciones", "A");
    await expect(formCommands.publishForm(master, formId)).resolves.toEqual({ version: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("0046 — la función de limpieza solo la ejecuta sutecba_app (también con los privilegios por defecto de Supabase)", () => {
  const FN = "public.purge_public_link_attempts(integer)";
  const MIGRATION = () => readFileSync("db/migrations/0046_public_link_attempts_hardening.sql", "utf8");
  const canExecute = async (role: string) => (await sql<{ x: boolean }>`select has_function_privilege(${role}, ${FN}, 'EXECUTE') as x`.execute(await getDb())).rows[0]!.x;
  const rollbackQuietly = async () => {
    try {
      await execRawSql("ROLLBACK");
    } catch {
      /* sin transacción abierta */
    }
  };

  it("con ALTER DEFAULT PRIVILEGES de Supabase (anon, authenticated, service_role reciben EXECUTE en funciones nuevas), la migración los deja sin acceso", async () => {
    const db = await getDb();
    await sql`do $$ begin if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end $$`.execute(db);
    await sql`alter default privileges in schema public grant execute on functions to anon, authenticated, service_role`.execute(db);
    try {
      // el entorno simulado se comporta como Supabase: una función nueva SÍ queda abierta a esos roles
      await sql`create function public.f0_probe() returns int language sql as 'select 1'`.execute(db);
      const probe = (await sql<{ a: boolean; b: boolean; c: boolean }>`select has_function_privilege('anon','public.f0_probe()','EXECUTE') a, has_function_privilege('authenticated','public.f0_probe()','EXECUTE') b, has_function_privilege('service_role','public.f0_probe()','EXECUTE') c`.execute(db)).rows[0];
      expect(probe).toEqual({ a: true, b: true, c: true });
      await sql`drop function public.f0_probe()`.execute(db);

      // la función de limpieza se vuelve a crear en ese entorno (como en un despliegue real) y la migración debe cerrarla
      await sql`drop function public.purge_public_link_attempts(integer)`.execute(db);
      await execRawSql(MIGRATION());
      for (const role of ["anon", "authenticated", "service_role"]) expect(await canExecute(role), role).toBe(false);
      expect(await canExecute("sutecba_app")).toBe(true);
      const acl = (
        await sql<{ grantee: string }>`select case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
          from pg_proc p, aclexplode(p.proacl) a where p.oid = ${FN}::regprocedure and a.privilege_type = 'EXECUTE' order by 1`.execute(db)
      ).rows.map((r) => r.grantee);
      expect(acl).toEqual(["postgres", "sutecba_app"]); // dueño + sutecba_app, nadie más (ni PUBLIC)
    } finally {
      await sql`alter default privileges in schema public revoke execute on functions from anon, authenticated, service_role`.execute(db);
    }
  });

  it("propietario y modo: SECURITY DEFINER, mismo dueño que la tabla, search_path fijo", async () => {
    const db = await getDb();
    const r = (
      await sql<{ definer: boolean; fnOwner: string; tableOwner: string; cfg: string }>`
        select p.prosecdef definer, pg_get_userbyid(p.proowner) "fnOwner", pg_get_userbyid(c.relowner) "tableOwner", array_to_string(p.proconfig, ',') cfg
        from pg_proc p, pg_class c where p.oid = ${FN}::regprocedure and c.oid = 'public.public_link_attempts'::regclass`.execute(db)
    ).rows[0]!;
    expect(r.definer).toBe(true);
    expect(r.fnOwner).toBe(r.tableOwner);
    expect(r.cfg).toBe("search_path=public, pg_temp");
  });

  it("si quedara otro rol con EXECUTE, la migración se ABORTA (no queda a medias) y nombra al rol", async () => {
    const db = await getDb();
    await sql`do $$ begin if not exists (select 1 from pg_roles where rolname = 'f0_intruso') then create role f0_intruso nologin; end if; end $$`.execute(db);
    await sql`grant execute on function public.purge_public_link_attempts(integer) to f0_intruso`.execute(db);
    let message = "";
    try {
      await execRawSql(MIGRATION());
    } catch (e) {
      message = (e as Error).message;
    }
    await rollbackQuietly();
    expect(message).toMatch(/EXECUTE para roles no previstos: f0_intruso/);
    await sql`revoke all on function public.purge_public_link_attempts(integer) from f0_intruso`.execute(db);
    await execRawSql(MIGRATION()); // y con el intruso fuera, pasa
  });

  it("si el dueño de la función no puede borrar de la tabla, la migración se ABORTA", async () => {
    const db = await getDb();
    await sql`do $$ begin if not exists (select 1 from pg_roles where rolname = 'f0_otro_dueno') then create role f0_otro_dueno nologin; end if; end $$`.execute(db);
    await sql`alter function public.purge_public_link_attempts(integer) owner to f0_otro_dueno`.execute(db);
    let message = "";
    try {
      await execRawSql(MIGRATION());
    } catch (e) {
      message = (e as Error).message;
    }
    await rollbackQuietly();
    expect(message).toMatch(/no puede borrar de public_link_attempts/);
    await sql`alter function public.purge_public_link_attempts(integer) owner to postgres`.execute(db);
    await execRawSql(MIGRATION());
    expect(await canExecute("sutecba_app")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("Caracteres que la base no guarda (NUL, sustitutos sueltos) en entradas públicas: validación, nunca error 500", () => {
  const slug = "f0-nul";
  const NUL = "\u0000";
  const LONE_SURROGATE = "\uD83D";
  let formId: string;

  const submissions = async () => count(sql<{ n: number }>`select count(*)::int n from form_submissions where form_id = ${formId}::uuid`);
  const people = async () => count(sql<{ n: number }>`select count(*)::int n from people`);

  beforeAll(async () => {
    formId = await makeForm(slug, "A", [["nota", "Nota", "textarea", ""]]);
  });

  it("cada campo con un byte nulo se rechaza con su mensaje, sin excepción, sin guardar nada ni crear personas", async () => {
    const before = [await submissions(), await people()];
    for (const [field, values] of [
      ["first_name", { first_name: `A${NUL}na` }],
      ["last_name", { last_name: `${NUL}` }],
      ["dni", { dni: `4011${NUL}1222` }],
      ["nota", { nota: `hola${NUL}mundo` }],
    ] as const) {
      const base: Record<string, string> = { first_name: "Ana", last_name: "Prueba", dni: nextDni(), nota: "ok" };
      const res = await submitForm(slug, { ...base, ...values }, randomUUID(), nextIp(), "vitest");
      expect(res.kind, field).toBe("validation_error");
      expect((res as { fieldErrors: Record<string, string> }).fieldErrors, field).toEqual({ [field]: "Contiene caracteres no válidos." });
    }
    expect([await submissions(), await people()]).toEqual(before);
  });

  it("varios campos inválidos se informan todos; los válidos no se marcan", async () => {
    const res = await submitForm(slug, { first_name: `A${NUL}`, last_name: "Prueba", dni: nextDni(), nota: `x${NUL}` }, randomUUID(), nextIp(), "vitest");
    expect((res as { fieldErrors: Record<string, string> }).fieldErrors).toEqual({ first_name: "Contiene caracteres no válidos.", nota: "Contiene caracteres no válidos." });
  });

  it("casillas (listas de valores) con un byte nulo también se rechazan", async () => {
    const res = await submitForm(slug, { first_name: "Ana", last_name: "Prueba", dni: nextDni(), nota: ["a", `b${NUL}`] as unknown as string }, randomUUID(), nextIp(), "vitest");
    expect(res.kind).toBe("validation_error");
  });

  it("un sustituto UTF-16 suelto (mitad de un emoji) se rechaza; un emoji completo se acepta", async () => {
    const bad = await submitForm(slug, { first_name: "Ana", last_name: "Prueba", dni: nextDni(), nota: `hola ${LONE_SURROGATE} fin` }, randomUUID(), nextIp(), "vitest");
    expect(bad.kind).toBe("validation_error");
    const good = await sub(slug, nextDni(), { nota: "hola 😀 fin" });
    expect(good.kind).toBe("ok");
  });

  it("clave de idempotencia con byte nulo o desmedida: pide recargar, sin excepción ni escritura", async () => {
    const before = await submissions();
    for (const key of [`k${NUL}k`, "k".repeat(500)]) {
      const res = await submitForm(slug, { first_name: "Ana", last_name: "Prueba", dni: nextDni(), nota: "ok" }, key, nextIp(), "vitest");
      expect(res.kind).toBe("validation_error");
      expect((res as { fieldErrors: Record<string, string> }).fieldErrors).toEqual({ __form: "Recargá la página e intentá de nuevo." });
    }
    expect(await submissions()).toBe(before);
  });

  it("slug con byte nulo: «no existe», igual que cualquier slug inexistente, tanto al enviar como al mostrar la página", async () => {
    const { getPublicForm } = await import("../../lib/forms/submit.js");
    expect((await submitForm(`${slug}${NUL}`, { first_name: "A", last_name: "B", dni: nextDni() }, randomUUID(), nextIp(), "vitest")).kind).toBe("not_found");
    expect((await getPublicForm(`${slug}${NUL}`)).kind).toBe("not_found");
    expect((await getPublicForm("slug-que-no-existe")).kind).toBe("not_found");
  });

  it("User-Agent con byte nulo (no ocurre por HTTP; defensa): el envío se guarda sin él", async () => {
    const dni = nextDni();
    const res = await submitForm(slug, { first_name: "Ana", last_name: "Prueba", dni, nota: "ok" }, randomUUID(), nextIp(), `Mozilla${NUL}`);
    expect(res.kind).toBe("ok");
    const row = (await sql<{ ua: string | null }>`select user_agent ua from form_submissions where raw_payload->>'dni' = ${dni}`.execute(await getDb())).rows[0]!;
    expect(row.ua).toBeNull();
  });

  it("identificación en el check-in: un email o apellido con byte nulo da «no encontrado», igual que cualquier dato inexistente", async () => {
    const { identifyForCheckin } = await import("../../lib/attendance/checkin.js");
    const known = await identifyForCheckin(id("mA"), "inexistente@example.test", "Nadie", nextIp());
    for (const [identifier, last] of [
      [`ana${NUL}@example.test`, "Perez"],
      ["ana@example.test", `Pe${NUL}rez`],
      [`4011${NUL}1222`, "Perez"],
    ] as const) {
      const res = await identifyForCheckin(id("mA"), identifier, last, nextIp());
      expect(res.kind).toBe("not_found");
      expect(res).toEqual(known);
    }
  });

  it("REGRESIÓN: las respuestas válidas no se alteran (acentos, ñ, emojis, saltos de línea, tabulaciones, comillas, símbolos)", async () => {
    const dni = nextDni();
    const nota = "Línea 1 — «con acentos»: áéíóú ÁÉÍÓÚ üÜ ñÑ ¿qué? ¡sí!\n\tLínea 2 con tab\r\nLínea 3 😀👍🏽 ✓ \"comillas\" 'simples' <b>no es html</b> \\ 100% $5 & más";
    const res = await submitForm(slug, { first_name: "María José", last_name: "Núñez-Ñandú", dni, nota }, randomUUID(), nextIp(), "Mozilla/5.0 (X11; Linux) Gecko");
    expect(res.kind).toBe("ok");
    const row = (await sql<{ raw: Record<string, string>; ua: string }>`select raw_payload raw, user_agent ua from form_submissions where raw_payload->>'dni' = ${dni}`.execute(await getDb())).rows[0]!;
    expect(row.raw.first_name).toBe("María José");
    expect(row.raw.last_name).toBe("Núñez-Ñandú");
    expect(row.raw.nota).toBe(nota);
    expect(row.ua).toBe("Mozilla/5.0 (X11; Linux) Gecko");
  });

  it("el helper distingue exactamente lo no guardable: NUL y mitades de par, y nada más", async () => {
    const { isUnsafeText, hasUnsafeText } = await import("../../lib/security/text-safety.js");
    for (const bad of [NUL, `a${NUL}`, "\uD800", "\uDC00", "x\uD83D", "\uDE00x"]) expect(isUnsafeText(bad), JSON.stringify(bad)).toBe(true);
    for (const good of ["", "abc", "ñandú", "😀", "a\tb\nc\r", "\u0001\u001F", "�", "日本語", "👨‍👩‍👧"]) expect(isUnsafeText(good), JSON.stringify(good)).toBe(false);
    expect(hasUnsafeText(["a", `b${NUL}`])).toBe(true);
    expect(hasUnsafeText(["a", "b"])).toBe(false);
    expect(hasUnsafeText(null)).toBe(false);
    expect(hasUnsafeText(undefined)).toBe(false);
  });
});
