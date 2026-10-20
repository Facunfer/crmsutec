import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Endpoints PÚBLICOS de punta a punta (S4/S3/S1): los pedidos entran por las Server Actions y rutas reales, con encabezados armados como
 * los arma nginx, y se verifica qué IP quedó registrada y qué se guardó. Es el camino que usa un atacante, no una función aislada.
 */

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.SUTECBA_QR_SECRET = "test-qr-secret-".padEnd(48, "x");
process.env.MAIL_UNSUBSCRIBE_SECRET = "unit-test-unsubscribe-secret-0123456789abcdef";
process.env.PUBLIC_BASE_URL = "https://crm.test";

const h = vi.hoisted(() => ({ xff: "" as string, ua: "vitest" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": h.xff, "user-agent": h.ua }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("../../lib/auth/cookies.js", () => ({ getSessionCookie: async () => undefined, setSessionCookie: async () => undefined, clearSessionCookie: async () => undefined }));

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { createSession, loadSessionUser } = await import("../../lib/auth/session.js");
const formCommands = await import("../../lib/forms/commands.js");
const invitationsLib = await import("../../lib/meetings/invitations.js");
const { submitFormAction } = await import("../../app/f/[slug]/actions.js");
const { respondAction } = await import("../../app/reunion/invitacion/[token]/actions.js");
const { login } = await import("../../app/login/actions.js");
const unsubRoute = await import("../../app/api/unsubscribe/[token]/route.js");
const tokens = await import("../../lib/mailing/tokens.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const REAL_PEER = "203.0.113.77";
let master: any;
let orgA: string;
let dniSeq = 41000000;

const rows = async <T extends object>(q: ReturnType<typeof sql<T>>) => (await q.execute(await getDb())).rows;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  const db = await getDb();
  const type = await db.selectFrom("organization_types").select("id").where("key", "=", "reparticion").executeTakeFirstOrThrow();
  orgA = (await db.insertInto("organizations").values({ name: "A", type_id: type.id }).returning("id").executeTakeFirstOrThrow()).id;
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  const u = await db.insertInto("users").values({ email: "master@sutecba.local", password_hash: await hashPassword("bootstrap-password-123"), full_name: "M", role_id: role.id }).returning("id").executeTakeFirstOrThrow();
  master = (await loadSessionUser((await createSession(u.id)).token))!;
});

afterAll(async () => {
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

describe("formulario público: la IP registrada es la del proxy propio y las señales anti-bot funcionan", () => {
  const slug = "f0-publico";
  const idle = { status: "idle" as const };

  beforeAll(async () => {
    const { id } = await formCommands.createForm(master, { name: slug, slug, ownerOrganizationId: orgA });
    await formCommands.updateFormMeta(master, id, { name: slug, slug, consentText: "", successMessage: "", opensAt: "", closesAt: "", matchFields: ["dni"], personCreationPolicy: "when_valid_dni", applyDataPolicy: "fill_empty_only" } as any);
    for (const [key, label, type] of [["first_name", "Nombre", "text"], ["last_name", "Apellido", "text"], ["dni", "DNI", "dni"]] as const) {
      await formCommands.upsertField(master, id, null, { key, label, fieldType: type, required: true, visible: true, personFieldMapping: key } as any);
    }
    await formCommands.publishForm(master, id);
  });

  const send = (extra: Record<string, string> = {}, key = randomUUID()) =>
    submitFormAction(slug, key, idle, fd({ first_name: "Ana", last_name: "Prueba", dni: String(++dniSeq), ...extra }));
  const stored = async () => (await rows(sql<{ n: number }>`select count(*)::int n from form_submissions`))[0]!.n;

  it("un cliente que falsifica X-Forwarded-For no cambia la IP registrada: manda la que agregó nginx", async () => {
    for (let i = 1; i <= 25; i += 1) {
      h.xff = `9.9.9.${i}, ${REAL_PEER}`; // el cliente rota su encabezado; nginx agrega al final su IP real
      expect((await send({ __rt: String(Date.now() - 5000) })).status).toBe("ok");
    }
    const ips = await rows(sql<{ ip: string }>`select distinct host(ip_address) as ip from form_submissions`);
    expect(ips.map((r) => r.ip)).toEqual([REAL_PEER]);
    // y el límite por IP se aplicó sobre esa única IP, no sobre 25 falsas
    const attempts = await rows(sql<{ ip: string; n: number }>`select host(ip_address) as ip, count(*)::int n from public_link_attempts where scope = 'form_submit' group by 1`);
    expect(attempts).toEqual([{ ip: REAL_PEER, n: 25 }]);
  });

  it("campo trampa completado: agradece pero no guarda; enviado demasiado rápido: pide reintentar; un envío normal se guarda", async () => {
    h.xff = REAL_PEER;
    const before = await stored();
    expect((await send({ __website_url: "http://spam.example", __rt: String(Date.now() - 9000) })).status).toBe("ok");
    expect(await stored()).toBe(before);

    const fast = await send({ __rt: String(Date.now() - 50) });
    expect(fast.status).toBe("error");
    expect(fast.message).toMatch(/segundos/);
    expect(await stored()).toBe(before);

    expect((await send({ __rt: String(Date.now() - 4000) })).status).toBe("ok");
    expect(await stored()).toBe(before + 1);
  });

  it("páginas abiertas antes del cambio (sin __rt ni trampa) se siguen enviando", async () => {
    h.xff = REAL_PEER;
    const before = await stored();
    expect((await send()).status).toBe("ok");
    expect(await stored()).toBe(before + 1);
  });

  it("entradas basura (NUL, valores enormes, campos inesperados) no producen un error de servidor", async () => {
    h.xff = REAL_PEER;
    const huge = "x".repeat(200_000);
    const out = await send({ first_name: huge, __website_url: "", campo_inventado: "1" }).catch((e) => ({ status: "throw", message: String(e) }));
    expect(["ok", "validation_error", "error"]).toContain(out.status);
  });
});

describe("invitaciones, baja y login: la IP también sale del proxy propio", () => {
  it("responder una invitación registra la IP del proxy y el token hasheado, también con encabezado falsificado", async () => {
    const db = await getDb();
    const person = await db.insertInto("people").values({ first_name: "Inés", last_name: "Inv", dni: String(++dniSeq), organization_id: orgA, created_by: master.id }).returning("id").executeTakeFirstOrThrow();
    const meeting = await db.insertInto("meetings").values({ name: "Reunión", owner_organization_id: orgA, status: "scheduled", allow_uninvited_checkin: false, starts_at: new Date(Date.now() + 3_600_000), ends_at: new Date(Date.now() + 7_200_000) }).returning("id").executeTakeFirstOrThrow();
    const batch = await invitationsLib.createInvitationBatch(master, meeting.id, { personIds: [person.id] });
    const token = batch.links[0]!.token;

    h.xff = `1.2.3.4, ${REAL_PEER}`;
    expect((await respondAction(token, { status: "idle" }, "confirmed")).status).toBe("ok");
    const attempts = await rows(sql<{ identifier: string; ip: string }>`select identifier, host(ip_address) as ip from public_link_attempts where scope = 'invitation_respond'`);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.ip).toBe(REAL_PEER);
    expect(attempts[0]!.identifier).toMatch(/^h1:[0-9a-f]{32}$/);
    expect(JSON.stringify(attempts)).not.toContain(token);
  });

  it("la baja pública registra la IP del proxy (no la del encabezado del cliente)", async () => {
    const token = tokens.createUnsubscribeToken(randomUUID(), process.env.MAIL_UNSUBSCRIBE_SECRET!);
    const res = await unsubRoute.POST(
      new NextRequest(`https://crm.test/api/unsubscribe/${token}`, { method: "POST", headers: { "x-forwarded-for": `7.7.7.7, ${REAL_PEER}`, "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }),
      { params: Promise.resolve({ token }) }
    );
    expect(res.status).toBeLessThan(500);
    const ips = await rows(sql<{ ip: string }>`select distinct host(ip_address) as ip from public_link_attempts where scope = 'unsubscribe'`);
    expect(ips.map((r) => r.ip)).toEqual([REAL_PEER]);
  });

  it("el login registra los intentos con la IP del proxy, y un encabezado roto no rompe la base", async () => {
    h.xff = `8.8.8.8, ${REAL_PEER}`;
    expect((await login({}, fd({ email: "nadie@sutecba.local", password: "mala-clave-123" }))).error).toMatch(/incorrectos/);
    h.xff = "no-es-una-ip";
    expect((await login({}, fd({ email: "nadie@sutecba.local", password: "mala-clave-123" }))).error).toMatch(/incorrectos/);
    const ips = await rows(sql<{ ip: string }>`select distinct host(ip_address) as ip from login_attempts order by 1`);
    expect(ips.map((r) => r.ip)).toEqual(["127.0.0.1", REAL_PEER]);
  });
});

describe("entradas con byte nulo por las Server Actions públicas reales: respuesta controlada, nunca un 500", () => {
  const NUL = "\u0000";
  const idle = { status: "idle" as const };
  const valid = () => ({ first_name: "María", last_name: "Núñez", dni: String(++dniSeq), __rt: String(Date.now() - 5000) });

  it("formulario: un campo con byte nulo da error de validación en ese campo; un envío válido inmediatamente después se guarda", async () => {
    h.xff = REAL_PEER;
    const before = (await rows(sql<{ n: number }>`select count(*)::int n from form_submissions`))[0]!.n;
    const bad = await submitFormAction("f0-publico", randomUUID(), idle, fd({ ...valid(), first_name: `Ma${NUL}ría` }));
    expect(bad.status).toBe("validation_error");
    expect(bad.fieldErrors).toEqual({ first_name: "Contiene caracteres no válidos." });
    expect((await rows(sql<{ n: number }>`select count(*)::int n from form_submissions`))[0]!.n).toBe(before);
    const good = await submitFormAction("f0-publico", randomUUID(), idle, fd(valid()));
    expect(good.status).toBe("ok");
    expect((await rows(sql<{ n: number }>`select count(*)::int n from form_submissions`))[0]!.n).toBe(before + 1);
  });

  it("formulario: clave de idempotencia y slug con byte nulo dan mensajes controlados", async () => {
    h.xff = REAL_PEER;
    const key = await submitFormAction("f0-publico", `k${NUL}k`, idle, fd(valid()));
    expect(key).toEqual({ status: "error", message: "Recargá la página e intentá de nuevo." });
    const slug = await submitFormAction(`f0-publico${NUL}`, randomUUID(), idle, fd(valid()));
    expect(slug.status).toBe("error");
    expect(slug.message).toMatch(/no está disponible/);
  });

  it("login: un email con byte nulo recibe el mismo mensaje genérico que un email inexistente, sin consultar ni registrar el intento", async () => {
    h.xff = REAL_PEER;
    const before = (await rows(sql<{ n: number }>`select count(*)::int n from login_attempts`))[0]!.n;
    const nul = await login({}, fd({ email: `nadie${NUL}@sutecba.local`, password: "mala-clave-123" }));
    const unknown = await login({}, fd({ email: "nadie@sutecba.local", password: "mala-clave-123" }));
    expect(nul).toEqual(unknown);
    expect(nul.error).toMatch(/incorrectos/);
    expect((await rows(sql<{ n: number }>`select count(*)::int n from login_attempts`))[0]!.n).toBe(before + 1); // solo el inexistente se registra
  });
});
