import { describe, expect, it } from "vitest";
import { canonicalizeIp, FALLBACK_CLIENT_IP, resolveClientIp, trustedProxyHops } from "../../lib/security/client-ip.js";

const h = (xff?: string) => new Headers(xff === undefined ? {} : { "x-forwarded-for": xff });

describe("resolveClientIp (S4): solo cuenta lo que agregó un proxy propio", () => {
  it("con un nginx delante, manda la entrada de la DERECHA (la que agregó el proxy), no la que escribió el cliente", () => {
    // nginx `$proxy_add_x_forwarded_for`: lo del cliente se conserva y se agrega la IP real del que se conectó.
    expect(resolveClientIp(h("198.51.100.7"), 1)).toBe("198.51.100.7");
    expect(resolveClientIp(h("6.6.6.6, 198.51.100.7"), 1)).toBe("198.51.100.7");
    expect(resolveClientIp(h("6.6.6.6, 7.7.7.7, 8.8.8.8, 198.51.100.7"), 1)).toBe("198.51.100.7");
  });

  it("un atacante que rota el encabezado falso NO cambia su IP efectiva (no evade el límite por IP)", () => {
    const seen = new Set<string>();
    for (let i = 1; i <= 50; i += 1) seen.add(resolveClientIp(h(`9.9.9.${i}, 203.0.113.50`), 1));
    expect([...seen]).toEqual(["203.0.113.50"]);
  });

  it("con más proxies propios (hops=2) se salta el último proxy y toma al cliente", () => {
    // cliente -> CDN/proxy A -> nginx: XFF = "falso, cliente-real, ip-de-A"
    expect(resolveClientIp(h("6.6.6.6, 198.51.100.7, 10.0.0.2"), 2)).toBe("198.51.100.7");
  });

  it("hops=0 (sin proxy): el encabezado se ignora por completo", () => {
    expect(resolveClientIp(h("198.51.100.7"), 0)).toBe(FALLBACK_CLIENT_IP);
  });

  it("encabezado ausente, vacío, basura o gigante => IP de reserva válida (nunca rompe la columna inet)", () => {
    expect(resolveClientIp(h(), 1)).toBe(FALLBACK_CLIENT_IP);
    expect(resolveClientIp(h(""), 1)).toBe(FALLBACK_CLIENT_IP);
    expect(resolveClientIp(h(" , , "), 1)).toBe(FALLBACK_CLIENT_IP);
    expect(resolveClientIp(h("no-es-una-ip"), 1)).toBe(FALLBACK_CLIENT_IP);
    expect(resolveClientIp(h("1.1.1.1, 999.1.1.1"), 1)).toBe(FALLBACK_CLIENT_IP);
    expect(resolveClientIp(h("1.1.1.1; DROP TABLE people"), 1)).toBe(FALLBACK_CLIENT_IP);
    expect(resolveClientIp(h("1.".repeat(4000)), 1)).toBe(FALLBACK_CLIENT_IP);
  });

  it("menos entradas que proxies esperados: toma la primera que existe en lugar de inventar", () => {
    expect(resolveClientIp(h("198.51.100.7"), 3)).toBe("198.51.100.7");
  });

  it("ignora X-Real-IP: el cliente puede mandarlo y nadie lo pisa", () => {
    const headers = new Headers({ "x-real-ip": "6.6.6.6" });
    expect(resolveClientIp(headers, 1)).toBe(FALLBACK_CLIENT_IP);
  });
});

describe("canonicalizeIp: una clave de límite por cliente real", () => {
  it("IPv4 y IPv4 mapeada en IPv6 son la misma clave", () => {
    expect(canonicalizeIp("203.0.113.9")).toBe("203.0.113.9");
    expect(canonicalizeIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(canonicalizeIp("::FFFF:cb00:7109")).toBe("203.0.113.9");
  });

  it("IPv6 se agrupa por /64: rotar dentro del /64 propio no da identidades nuevas", () => {
    const a = canonicalizeIp("2001:db8:abcd:12::1");
    const b = canonicalizeIp("2001:db8:abcd:12:ffff:ffff:ffff:ffff");
    expect(a).toBe("2001:db8:abcd:12::");
    expect(b).toBe(a);
    expect(canonicalizeIp("2001:db8:abcd:13::1")).not.toBe(a);
    expect(canonicalizeIp("[2001:db8:abcd:12::1]")).toBe(a);
  });

  it("no acepta lo que no es una IP", () => {
    expect(canonicalizeIp("")).toBeNull();
    expect(canonicalizeIp("1.2.3")).toBeNull();
    expect(canonicalizeIp("gggg::1")).toBeNull();
  });
});

describe("trustedProxyHops: configuración defensiva", () => {
  it("default 1; acepta 0..5; un valor inválido vuelve al default (nunca a «confiar en todo»)", () => {
    expect(trustedProxyHops(undefined)).toBe(1);
    expect(trustedProxyHops("")).toBe(1);
    expect(trustedProxyHops("0")).toBe(0);
    expect(trustedProxyHops("2")).toBe(2);
    expect(trustedProxyHops("5")).toBe(5);
    expect(trustedProxyHops("6")).toBe(1);
    expect(trustedProxyHops("-1")).toBe(1);
    expect(trustedProxyHops("uno")).toBe(1);
    expect(trustedProxyHops("1.5")).toBe(1);
  });
});
