import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

const h = vi.hoisted(() => ({ actor: null as unknown, revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth/guard")>()), requireUser: async () => h.actor }));

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;
process.env.MAIL_UNSUBSCRIBE_SECRET = "unit-test-unsubscribe-secret-0123456789abcdef";
process.env.PUBLIC_BASE_URL = "https://crm.test";
process.env.AWS_REGION = "us-east-2";

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS, ROLE_PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const providers = await import("../../lib/mailing/providers/index.js");
const { SesProvider, classifyIdentityError } = await import("../../lib/mailing/providers/ses.js");
const senders = await import("../../lib/mailing/senders.js");
const actions = await import("../../app/(protegido)/mailing/acciones.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const ALL = new Set(PERMISSIONS.map((p) => p.key));

type Outcome = "verified" | "pending" | "failed" | "error";
/** Proveedor falso: responde por identidad y registra qué identidades se consultaron. */
class FakeProvider {
  readonly name = "ses" as const;
  asked: string[] = [];
  answers = new Map<string, { outcome: Outcome; code?: string; message?: string }>();
  async checkIdentity(identity: string) {
    this.asked.push(identity);
    const a = this.answers.get(identity) ?? { outcome: "pending" as Outcome, code: "NotFoundException", message: `SES no tiene la identidad «${identity}»` };
    return { identity, region: "us-east-2", outcome: a.outcome, code: a.code, message: a.message ?? `${identity}: ${a.outcome}` };
  }
  async getIdentityStatus() {
    return "unknown" as const;
  }
  async getAccountStatus() {
    return { sandbox: false, sendingEnabled: true, max24HourSend: 0, maxSendRate: 0, sentLast24Hours: 0 };
  }
  async send() {
    return { kind: "accepted" as const, messageId: "x" };
  }
}
let provider: FakeProvider;
let master: any;
let operador: any;
let seq = 0;

function actorOf(id: string, roleKey: string, permissions: Set<string>): any {
  return { id, email: `${id}@x.local`, fullName: "U", roleId: "n/a", roleKey, mustChangePassword: false, enabledModules: ALL_MODULE_KEYS, permissions };
}
async function makeUser(email: string, roleKey: string) {
  const db = await getDb();
  const role = await db.selectFrom("roles").select("id").where("key", "=", roleKey).executeTakeFirstOrThrow();
  return (await db.insertInto("users").values({ email, password_hash: await hashPassword("x-password-123"), full_name: email, role_id: role.id }).returning("id").executeTakeFirstOrThrow()).id;
}
async function newSender(o: { email?: string; identity?: string | null } = {}) {
  seq += 1;
  const { id } = await senders.createSender(master, {
    name: "Contacto SUTECBA", fromName: "SUTECBA", fromEmail: o.email ?? `contacto${seq}@sutecba.com`, providerIdentity: o.identity === undefined ? "sutecba.com" : o.identity,
  });
  return id;
}
const row = async (id: string) => {
  const db = await getDb();
  return (await sql<{ verified_status: string; verified_at: Date | null; verified_checked_at: Date | null }>`
    select verified_status, verified_at, verified_checked_at from mailing_senders where id = ${id}::uuid`.execute(db)).rows[0]!;
};

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  master = actorOf(await makeUser("sv-master@sutecba.local", "MASTER_GLOBAL"), "MASTER_GLOBAL", ALL);
  operador = actorOf(await makeUser("sv-op@sutecba.local", "OPERADOR"), "OPERADOR", new Set<string>(ROLE_PERMISSIONS.OPERADOR));
});
beforeEach(() => {
  provider = new FakeProvider();
  providers.setMailProviderForTests(provider as never);
  h.actor = master;
  h.revalidate.mockClear();
});
afterAll(async () => {
  providers.setMailProviderForTests(null);
  await closeDb();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("verificar remitente en SES (servicio)", () => {
  it("dominio verificado: consulta EXACTAMENTE provider_identity, persiste verified + verified_at", async () => {
    const id = await newSender({ email: "contacto@sutecba.com", identity: "sutecba.com" });
    expect((await row(id)).verified_status).toBe("pending");
    provider.answers.set("sutecba.com", { outcome: "verified" });
    const { sender, check } = await senders.verifySenderIdentity(master, id);
    expect(provider.asked).toEqual(["sutecba.com"]); // no el email, no otra identidad
    expect(check.outcome).toBe("verified");
    expect(sender.verifiedStatus).toBe("verified");
    const r = await row(id);
    expect(r.verified_status).toBe("verified");
    expect(r.verified_at).not.toBeNull();
    expect(r.verified_checked_at).not.toBeNull();
    // un remitente verificado ya se puede usar para enviar
    expect((await senders.requireUsableSender(master, id)).id).toBe(id);
  });

  it("sin provider_identity: prueba el email y después su dominio", async () => {
    const id = await newSender({ email: "info@sutecba.com", identity: null });
    provider.answers.set("sutecba.com", { outcome: "verified" });
    const { check } = await senders.verifySenderIdentity(master, id);
    expect(provider.asked).toEqual(["info@sutecba.com", "sutecba.com"]);
    expect(check.outcome).toBe("verified");
    expect((await row(id)).verified_status).toBe("verified");
  });

  it("identidad pendiente: queda pending, sin verified_at, y el motivo vuelve en el resultado", async () => {
    const id = await newSender();
    provider.answers.set("sutecba.com", { outcome: "pending", code: "PENDING", message: "«sutecba.com» existe pero todavía no está verificada (estado PENDING)." });
    const { check } = await senders.verifySenderIdentity(master, id);
    expect(check).toMatchObject({ outcome: "pending", code: "PENDING" });
    const r = await row(id);
    expect(r.verified_status).toBe("pending");
    expect(r.verified_at).toBeNull();
    expect(r.verified_checked_at).not.toBeNull();
  });

  it("identidad inexistente (región/cuenta equivocada): pending con código NotFoundException y explicación", async () => {
    const id = await newSender();
    const { check } = await senders.verifySenderIdentity(master, id); // el falso responde NotFound por defecto
    expect(check).toMatchObject({ outcome: "pending", code: "NotFoundException" });
    expect(check.message).toMatch(/sutecba\.com/);
  });

  it("error de AWS: no cambia el estado guardado (no des-verifica), registra la consulta y devuelve el error", async () => {
    const id = await newSender();
    provider.answers.set("sutecba.com", { outcome: "verified" });
    await senders.verifySenderIdentity(master, id);
    const before = await row(id);
    provider.answers.set("sutecba.com", { outcome: "error", code: "AccessDeniedException", message: "Amazon SES rechazó la consulta (AccessDeniedException)" });
    await new Promise((r) => setTimeout(r, 15));
    const { sender, check } = await senders.verifySenderIdentity(master, id);
    expect(check.outcome).toBe("error");
    expect(sender.verifiedStatus).toBe("verified");
    const after = await row(id);
    expect(after.verified_status).toBe("verified");
    expect(after.verified_at?.getTime()).toBe(before.verified_at?.getTime());
    expect(after.verified_checked_at!.getTime()).toBeGreaterThan(before.verified_checked_at!.getTime());
  });

  it("falló la verificación: failed y no se puede usar", async () => {
    const id = await newSender();
    provider.answers.set("sutecba.com", { outcome: "failed", code: "FAILED" });
    await senders.verifySenderIdentity(master, id);
    expect((await row(id)).verified_status).toBe("failed");
    await expect(senders.requireUsableSender(master, id)).rejects.toThrow(/no está verificado/);
  });

  it("permiso: quien no administra remitentes no puede verificar", async () => {
    const id = await newSender();
    await expect(senders.verifySenderIdentity(operador, id)).rejects.toThrow();
  });
});

describe("verificar remitente en SES (acción del botón)", () => {
  it("verificado: ok, outcome, identidad y región visibles, y revalida la pantalla", async () => {
    const id = await newSender();
    provider.answers.set("sutecba.com", { outcome: "verified", message: "«sutecba.com» está verificada en Amazon SES (us-east-2)." });
    const r = await actions.verifySenderAction(id);
    expect(r).toMatchObject({ ok: true, outcome: "verified", identity: "sutecba.com", region: "us-east-2" });
    expect(r.detail).toMatch(/verificada/);
    expect(h.revalidate).toHaveBeenCalledWith("/mailing/remitentes");
    expect((await row(id)).verified_status).toBe("verified");
  });

  it("pendiente / inexistente: ok=true (se pudo consultar) pero con outcome y detalle visibles — no es silencioso", async () => {
    const id = await newSender();
    const r = await actions.verifySenderAction(id);
    expect(r).toMatchObject({ ok: true, outcome: "pending", identity: "sutecba.com" });
    expect(r.detail).toBeTruthy();
    expect(h.revalidate).toHaveBeenCalled();
  });

  it("error de AWS: ok=false con mensaje visible, estado intacto", async () => {
    const id = await newSender();
    provider.answers.set("sutecba.com", { outcome: "error", code: "AccessDeniedException", message: "Amazon SES rechazó la consulta (AccessDeniedException)." });
    const r = await actions.verifySenderAction(id);
    expect(r).toMatchObject({ ok: false, outcome: "error" });
    expect(r.error).toMatch(/AccessDenied/);
    expect((await row(id)).verified_status).toBe("pending");
  });

  it("sin permiso o remitente inexistente: error visible, no excepción", async () => {
    const id = await newSender();
    h.actor = operador;
    const denied = await actions.verifySenderAction(id);
    expect(denied.ok).toBe(false);
    expect(denied.error).toBeTruthy();
    h.actor = master;
    const missing = await actions.verifySenderAction(randomUUID());
    expect(missing).toMatchObject({ ok: false });
    expect(missing.error).toMatch(/no encontrado/i);
  });
});

describe("SesProvider.checkIdentity contra un SES simulado (SDK real)", () => {
  async function withServer(handler: (path: string) => { status: number; body: unknown; headers?: Record<string, string> }, run: (p: InstanceType<typeof SesProvider>, seen: string[]) => Promise<void>) {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const r = handler(req.url ?? "");
      res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const saved = { e: process.env.AWS_ENDPOINT_URL, k: process.env.AWS_ACCESS_KEY_ID, s: process.env.AWS_SECRET_ACCESS_KEY };
    process.env.AWS_ENDPOINT_URL = `http://127.0.0.1:${port}`;
    process.env.AWS_ACCESS_KEY_ID = "FAKEFAKEFAKE";
    process.env.AWS_SECRET_ACCESS_KEY = "fakefakefakefake";
    try {
      await run(new SesProvider(), seen);
    } finally {
      process.env.AWS_ENDPOINT_URL = saved.e;
      process.env.AWS_ACCESS_KEY_ID = saved.k;
      process.env.AWS_SECRET_ACCESS_KEY = saved.s;
      if (saved.e === undefined) delete process.env.AWS_ENDPOINT_URL;
      if (saved.k === undefined) delete process.env.AWS_ACCESS_KEY_ID;
      if (saved.s === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("verificada (VerifiedForSendingStatus) → verified y pide /v2/email/identities/sutecba.com", async () => {
    await withServer(
      () => ({ status: 200, body: { IdentityType: "DOMAIN", VerifiedForSendingStatus: true, VerificationStatus: "SUCCESS", DkimAttributes: { Status: "SUCCESS" } } }),
      async (p, seen) => {
        const c = await p.checkIdentity("sutecba.com");
        expect(c).toMatchObject({ outcome: "verified", identity: "sutecba.com", region: "us-east-2" });
        expect(seen).toEqual(["GET /v2/email/identities/sutecba.com"]);
        expect(await p.getIdentityStatus("sutecba.com")).toBe("verified");
      }
    );
  });

  it("existe pero pendiente → pending; 404 NotFoundException → pending con código y región; 403 → error visible", async () => {
    await withServer(
      () => ({ status: 200, body: { VerifiedForSendingStatus: false, VerificationStatus: "PENDING" } }),
      async (p) => expect(await p.checkIdentity("x.com")).toMatchObject({ outcome: "pending", code: "PENDING" })
    );
    await withServer(
      () => ({ status: 404, body: { message: "Email identity does not exist." }, headers: { "x-amzn-errortype": "NotFoundException" } }),
      async (p) => {
        const c = await p.checkIdentity("sutecba.com");
        expect(c).toMatchObject({ outcome: "pending", code: "NotFoundException", region: "us-east-2" });
        expect(c.message).toMatch(/us-east-2/);
      }
    );
    await withServer(
      () => ({ status: 403, body: { message: "not authorized to perform: ses:GetEmailIdentity" }, headers: { "x-amzn-errortype": "AccessDeniedException" } }),
      async (p) => {
        const c = await p.checkIdentity("sutecba.com");
        expect(c.outcome).toBe("error");
        expect(c.message).toMatch(/ses:GetEmailIdentity/);
        expect(await p.getIdentityStatus("sutecba.com")).toBe("unknown");
      }
    );
  });

  it("classifyIdentityError: casos puros", () => {
    expect(classifyIdentityError({ name: "NotFoundException" }, "a.com", "us-east-1")).toMatchObject({ outcome: "pending" });
    expect(classifyIdentityError({ name: "CredentialsProviderError" }, "a.com", null).outcome).toBe("error");
    expect(classifyIdentityError({ name: "TimeoutError", message: "x" }, "a.com", null)).toMatchObject({ outcome: "error", code: "TimeoutError" });
  });
});
