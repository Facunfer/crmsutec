import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyResendIdentityResponse, classifyResendResponse, ResendProvider } from "../../lib/mailing/providers/resend.js";
import { parseResendEvent, verifySvixSignature } from "../../lib/mailing/resend-webhook.js";
import { parseSesNotification } from "../../lib/mailing/events.js";
import { loadMailConfig, validateMailConfig } from "../../lib/mailing/config.js";

const KEY_BYTES = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${KEY_BYTES.toString("base64")}`;

function sign(id: string, timestamp: string, body: string, key: Buffer = KEY_BYTES): string {
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

const NOW = new Date("2026-10-14T15:00:00Z");
const ts = String(Math.floor(NOW.getTime() / 1000));

describe("Resend: clasificación de respuestas del envío", () => {
  it("200 con id => accepted; 200 sin id => unknown", () => {
    expect(classifyResendResponse(200, JSON.stringify({ id: "abc" }))).toEqual({ kind: "accepted", messageId: "abc" });
    expect(classifyResendResponse(200, "{}").kind).toBe("unknown");
  });

  it("429 por ritmo => rechazo reintentable; 429 por cuota => rechazo definitivo de cuenta", () => {
    expect(classifyResendResponse(429, JSON.stringify({ name: "rate_limit_exceeded", message: "slow" }))).toMatchObject({ kind: "rejected", retryable: true });
    expect(classifyResendResponse(429, "")).toMatchObject({ kind: "rejected", retryable: true });
    expect(classifyResendResponse(429, JSON.stringify({ name: "daily_quota_exceeded" }))).toMatchObject({ kind: "rejected", retryable: false, code: "daily_quota_exceeded" });
    expect(classifyResendResponse(429, JSON.stringify({ name: "monthly_quota_exceeded" }))).toMatchObject({ kind: "rejected", retryable: false });
  });

  it("401/403/400/422 => rechazo definitivo; 403 validation_error => dominio no verificado (código de cuenta)", () => {
    expect(classifyResendResponse(401, JSON.stringify({ name: "restricted_api_key" }))).toMatchObject({ kind: "rejected", retryable: false, code: "restricted_api_key" });
    expect(classifyResendResponse(401, JSON.stringify({ name: "missing_api_key" }))).toMatchObject({ kind: "rejected", code: "missing_api_key" });
    expect(classifyResendResponse(403, JSON.stringify({ name: "validation_error", message: "domain is not verified" }))).toMatchObject({ kind: "rejected", code: "domain_not_verified", retryable: false });
    expect(classifyResendResponse(400, JSON.stringify({ name: "validation_error" }))).toMatchObject({ kind: "rejected", code: "validation_error", retryable: false });
    expect(classifyResendResponse(422, JSON.stringify({ name: "missing_required_field" }))).toMatchObject({ kind: "rejected", retryable: false });
  });

  it("5xx, 409 y respuestas raras => unknown (nunca se reintenta sola)", () => {
    expect(classifyResendResponse(500, JSON.stringify({ name: "application_error" })).kind).toBe("unknown");
    expect(classifyResendResponse(503, "").kind).toBe("unknown");
    expect(classifyResendResponse(409, JSON.stringify({ name: "concurrent_idempotent_requests" })).kind).toBe("unknown");
    expect(classifyResendResponse(302, "").kind).toBe("unknown");
  });

  it("el mensaje de error nunca arrastra más de 300 caracteres", () => {
    const out = classifyResendResponse(400, JSON.stringify({ name: "validation_error", message: "x".repeat(2000) }));
    expect(out.kind === "rejected" && out.message.length).toBe(300);
  });
});

describe("Resend: verificación de identidad sin permisos extra", () => {
  it("200 => verified; 403 validation_error => pending (no verificada); 401 => error visible", () => {
    expect(classifyResendIdentityResponse("sutecba.com", 200, JSON.stringify({ id: "x" })).outcome).toBe("verified");
    const pending = classifyResendIdentityResponse("sutecba.com", 403, JSON.stringify({ name: "validation_error", message: "The sutecba.com domain is not verified" }));
    expect(pending.outcome).toBe("pending");
    expect(classifyResendIdentityResponse("sutecba.com", 401, JSON.stringify({ name: "restricted_api_key" })).outcome).toBe("error");
    expect(classifyResendIdentityResponse("sutecba.com", 429, "{}").outcome).toBe("error");
    expect(classifyResendIdentityResponse("sutecba.com", 500, "{}").outcome).toBe("error");
  });
});

describe("ResendProvider.send con fetch simulado", () => {
  const calls: Array<{ url: string; init: any }> = [];
  beforeEach(() => {
    calls.length = 0;
    process.env.SUTECBA_ENV = "test";
    process.env.RESEND_API_KEY = "re_test_key_not_real";
  });
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  const message = {
    to: "dest@example.test",
    from: '"SUTECBA" <contacto@sutecba.com>',
    replyTo: "respuestas@sutecba.com",
    subject: "Asunto",
    html: "<p>Hola</p>",
    text: "Hola",
    headers: { "List-Unsubscribe": "<https://crm.test/api/unsubscribe/t>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    tags: { campaign_id: "11111111-1111-1111-1111-111111111111" },
    idempotencyKey: "sutecba-mail-r1-1",
  };

  it("arma la petición correcta y devuelve el id; la clave va solo en Authorization", async () => {
    const provider = new ResendProvider((async (url: string, init: any) => {
      calls.push({ url, init });
      return { status: 200, text: async () => JSON.stringify({ id: "msg-1" }) };
    }) as any);
    const outcome = await provider.send(message);
    expect(outcome).toEqual({ kind: "accepted", messageId: "msg-1" });
    const c = calls[0]!;
    expect(c.url).toBe("https://api.resend.com/emails");
    expect(c.init.headers.Authorization).toBe("Bearer re_test_key_not_real");
    expect(c.init.headers["Idempotency-Key"]).toBe("sutecba-mail-r1-1");
    const body = JSON.parse(c.init.body);
    expect(body).toMatchObject({
      from: message.from,
      to: ["dest@example.test"],
      reply_to: ["respuestas@sutecba.com"],
      subject: "Asunto",
      tags: [{ name: "campaign_id", value: "11111111-1111-1111-1111-111111111111" }],
    });
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(JSON.stringify(body)).not.toContain("re_test_key_not_real");
  });

  it("sin clave: rechazo NotConfigured y no llama a la red", async () => {
    delete process.env.RESEND_API_KEY;
    const provider = new ResendProvider((async () => {
      throw new Error("no debería llamarse");
    }) as any);
    expect(await provider.send(message)).toMatchObject({ kind: "rejected", code: "NotConfigured", retryable: false });
  });

  it("corte de red o timeout => unknown (no se reintenta sola)", async () => {
    const down = new ResendProvider((async () => {
      throw new TypeError("fetch failed");
    }) as any);
    expect(await down.send(message)).toMatchObject({ kind: "unknown", code: "NetworkError" });
    const aborted = new ResendProvider((async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as any);
    expect(await aborted.send(message)).toMatchObject({ kind: "unknown", code: "Timeout" });
  });

  it("checkIdentity prueba contra delivered@resend.dev, con etiqueta kind=verify", async () => {
    const provider = new ResendProvider((async (url: string, init: any) => {
      calls.push({ url, init });
      return { status: 200, text: async () => JSON.stringify({ id: "v-1" }) };
    }) as any);
    expect((await provider.checkIdentity("sutecba.com")).outcome).toBe("verified");
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.to).toEqual(["delivered@resend.dev"]);
    expect(body.from).toBe("verificacion@sutecba.com");
    expect(body.tags).toEqual([{ name: "kind", value: "verify" }]);
  });

  it("getAccountStatus no bloquea el lanzamiento (sin sandbox ni error) cuando hay clave", async () => {
    const provider = new ResendProvider((async () => {
      throw new Error("no se consulta la red");
    }) as any);
    expect(await provider.getAccountStatus()).toEqual({ sandbox: null, sendingEnabled: null, max24HourSend: null, maxSendRate: null, sentLast24Hours: null });
  });
});

describe("Webhook de Resend: firma Svix", () => {
  const body = JSON.stringify({ type: "email.delivered", created_at: NOW.toISOString(), data: { email_id: "e1" } });

  it("firma válida", () => {
    const r = verifySvixSignature(body, { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) }, SECRET, NOW);
    expect(r).toEqual({ ok: true });
  });

  it("acepta la firma correcta dentro de una lista con otra (rotación de secretos)", () => {
    const other = sign("msg_1", ts, body, Buffer.from("otro-secreto-otro-secreto-123456"));
    const r = verifySvixSignature(body, { id: "msg_1", timestamp: ts, signature: `${other} ${sign("msg_1", ts, body)}` }, SECRET, NOW);
    expect(r.ok).toBe(true);
  });

  it("rechaza: cuerpo alterado, firma de otro secreto, id distinto, cabeceras ausentes, timestamp vencido y secreto mal formado", () => {
    const good = sign("msg_1", ts, body);
    expect(verifySvixSignature(body + " ", { id: "msg_1", timestamp: ts, signature: good }, SECRET, NOW)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifySvixSignature(body, { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body, Buffer.from("x".repeat(32))) }, SECRET, NOW)).toMatchObject({ ok: false });
    expect(verifySvixSignature(body, { id: "msg_2", timestamp: ts, signature: good }, SECRET, NOW)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifySvixSignature(body, { id: null, timestamp: ts, signature: good }, SECRET, NOW)).toMatchObject({ ok: false, reason: "missing_headers" });
    const old = String(Math.floor(NOW.getTime() / 1000) - 3600);
    expect(verifySvixSignature(body, { id: "msg_1", timestamp: old, signature: sign("msg_1", old, body) }, SECRET, NOW)).toMatchObject({ ok: false, reason: "stale_timestamp" });
    expect(verifySvixSignature(body, { id: "msg_1", timestamp: ts, signature: good }, "no-es-un-secreto", NOW)).toMatchObject({ ok: false, reason: "bad_secret" });
    expect(verifySvixSignature(body, { id: "msg_1", timestamp: ts, signature: "v2,AAAA" }, SECRET, NOW)).toMatchObject({ ok: false });
  });
});

describe("Webhook de Resend: mapeo de eventos al modelo existente", () => {
  const at = "2026-10-14T15:00:00.000Z";
  const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, created_at: at, data: { email_id: "e1", ...data } });

  it("sent / delivered / delivery_delayed / opened / clicked", () => {
    expect(parseResendEvent(ev("email.sent"))[0]).toMatchObject({ type: "send", messageId: "e1", source: "resend_event" });
    expect(parseResendEvent(ev("email.delivered"))[0]).toMatchObject({ type: "delivery" });
    expect(parseResendEvent(ev("email.delivery_delayed"))[0]).toMatchObject({ type: "delivery_delay" });
    expect(parseResendEvent(ev("email.opened", { open: { timestamp: "2026-10-14T15:01:00.000Z" } }))[0]).toMatchObject({ type: "open" });
    const click = parseResendEvent(ev("email.clicked", { click: { link: "https://sutecba.com/x", timestamp: "2026-10-14T15:02:00.000Z" } }))[0]!;
    expect(click).toMatchObject({ type: "click", safe: { link: "https://sutecba.com/x" } });
  });

  it("bounce Permanent => bounce (suprime); Temporary u otro => soft_bounce (nunca suprime ante la duda)", () => {
    expect(parseResendEvent(ev("email.bounced", { bounce: { type: "Permanent", subType: "Suppressed" } }))[0]).toMatchObject({ type: "bounce", permanent: true });
    expect(parseResendEvent(ev("email.bounced", { bounce: { type: "Temporary", subType: "MailboxFull" } }))[0]).toMatchObject({ type: "soft_bounce", permanent: false });
    expect(parseResendEvent(ev("email.bounced", { bounce: { type: "Undetermined" } }))[0]).toMatchObject({ type: "soft_bounce" });
    expect(parseResendEvent(ev("email.bounced"))[0]).toMatchObject({ type: "soft_bounce" });
  });

  it("complained, failed y suppressed", () => {
    expect(parseResendEvent(ev("email.complained"))[0]).toMatchObject({ type: "complaint" });
    expect(parseResendEvent(ev("email.failed", { failed: { reason: "quota" } }))[0]).toMatchObject({ type: "reject", safe: { reason: "quota" } });
    expect(parseResendEvent(ev("email.suppressed"))[0]).toMatchObject({ type: "reject", safe: { reason: "suppressed" } });
  });

  it("ignora lo que no es correo del CRM: dominios, contactos, recibidos, programados, basura", () => {
    for (const t of ["email.received", "email.scheduled", "domain.updated", "contact.created", "suppression.added"]) {
      expect(parseResendEvent(ev(t))).toEqual([]);
    }
    expect(parseResendEvent(null)).toEqual([]);
    expect(parseResendEvent({ type: "email.delivered", data: {} })).toEqual([]);
    expect(parseResendEvent({ type: 5 })).toEqual([]);
  });

  it("la clave es determinista (un reintento colapsa) y distingue tipo, instante y enlace", () => {
    const a = parseResendEvent(ev("email.delivered"))[0]!;
    const b = parseResendEvent(ev("email.delivered"))[0]!;
    expect(a.key).toBe(b.key);
    expect(a.key.startsWith("resend:e1:delivery:")).toBe(true);
    const c1 = parseResendEvent(ev("email.clicked", { click: { link: "https://a.test", timestamp: at } }))[0]!;
    const c2 = parseResendEvent(ev("email.clicked", { click: { link: "https://b.test", timestamp: at } }))[0]!;
    expect(c1.key).not.toBe(c2.key);
  });

  it("marca como prueba los envíos kind=test / kind=verify (no corresponden a un destinatario)", () => {
    expect(parseResendEvent(ev("email.delivered", { tags: { kind: "verify" } }))[0]!.isTest).toBe(true);
    expect(parseResendEvent(ev("email.delivered", { tags: { kind: "test" } }))[0]!.isTest).toBe(true);
    expect(parseResendEvent(ev("email.delivered", { tags: { campaign_id: "x" } }))[0]!.isTest).toBe(false);
  });

  it("el payload guardado es seguro: sin direcciones, asunto ni agente de usuario", () => {
    const e = parseResendEvent(
      ev("email.clicked", { to: ["secreto@example.test"], subject: "Asunto privado", click: { link: "https://x.test", ipAddress: "1.2.3.4", userAgent: "UA", timestamp: at } })
    )[0]!;
    const dump = JSON.stringify(e.safe);
    expect(dump).not.toContain("secreto@example.test");
    expect(dump).not.toContain("Asunto privado");
    expect(dump).not.toContain("1.2.3.4");
    expect(dump).not.toContain("UA");
  });

  it("el evento de SES conserva su clave y su origen (historial intacto)", () => {
    const body = JSON.stringify({ eventType: "Delivery", mail: { messageId: "ses-1", timestamp: at }, delivery: { timestamp: at } });
    const e = parseSesNotification(body)[0]!;
    expect(e.key.startsWith("ses:ses-1:delivery:")).toBe(true);
    expect(e.source).toBe("ses_event");
  });
});

describe("MAIL_PROVIDER", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["MAIL_PROVIDER", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "AWS_REGION"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("por defecto es SES; resend exige RESEND_API_KEY (bloqueante) y avisa si falta el secreto del webhook", () => {
    process.env.SUTECBA_ENV = "test";
    delete process.env.MAIL_PROVIDER;
    expect(loadMailConfig().provider).toBe("ses");

    process.env.MAIL_PROVIDER = "resend";
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_WEBHOOK_SECRET;
    const issues = validateMailConfig(loadMailConfig());
    expect(issues.find((i) => i.key === "RESEND_API_KEY")?.blocking).toBe(true);
    expect(issues.find((i) => i.key === "RESEND_WEBHOOK_SECRET")?.blocking).toBe(false);
    expect(issues.some((i) => i.key === "AWS_REGION")).toBe(false);
  });

  it("un valor inválido bloquea el envío en vez de caer en silencio a otro proveedor", () => {
    process.env.SUTECBA_ENV = "test";
    process.env.MAIL_PROVIDER = "sendgrid";
    const cfg = loadMailConfig();
    expect(cfg.providerInvalid).toBe(true);
    expect(validateMailConfig(cfg).some((i) => i.key === "MAIL_PROVIDER" && i.blocking)).toBe(true);
  });
});
