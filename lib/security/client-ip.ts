import { isIP } from "node:net";

/**
 * IP del cliente detrás de proxies de confianza (hallazgo S4).
 *
 * Por qué NO se toma el primer valor de `X-Forwarded-For`: nginx con `$proxy_add_x_forwarded_for` (la configuración documentada
 * en SUTECBA_DESPLIEGUE.md) CONSERVA lo que mande el cliente y AGREGA al final la IP real del que se conectó. El valor de la
 * izquierda lo escribe el cliente (`X-Forwarded-For: 1.2.3.4`) y cambia en cada pedido: quien lo toma regala un bypass de todos
 * los límites por IP. El valor de la DERECHA lo agrega el proxy propio y no es falsificable.
 *
 * Regla: se confía solo en las últimas `SUTECBA_TRUSTED_PROXY_HOPS` entradas (por defecto 1 = un nginx delante). La IP del
 * cliente es la entrada número `hops` contando desde la derecha. `0` = la app está expuesta directamente (ningún proxy):
 * `X-Forwarded-For` se ignora por completo. `X-Real-IP` nunca se usa: nginx de este VPS no está documentado como su origen
 * y es igual de falsificable si el proxy no lo pisa.
 *
 * Funciones puras (sin `next/headers`) para poder probarlas con encabezados armados a mano.
 */

/** IP de reserva cuando no hay una válida (desarrollo local sin proxy, encabezado ausente o mal formado). */
export const FALLBACK_CLIENT_IP = "127.0.0.1";

const DEFAULT_TRUSTED_PROXY_HOPS = 1;
const MAX_TRUSTED_PROXY_HOPS = 5;
/** Defensa: un encabezado absurdamente largo no se procesa entero. */
const MAX_HEADER_LENGTH = 2048;

export interface HeaderReader {
  get(name: string): string | null;
}

/** Cantidad de proxies propios delante de la app. Valor inválido => el default (1), nunca "confiar en todo". */
export function trustedProxyHops(raw: string | undefined = process.env.SUTECBA_TRUSTED_PROXY_HOPS): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TRUSTED_PROXY_HOPS;
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_TRUSTED_PROXY_HOPS;
  const n = Number(raw.trim());
  return n >= 0 && n <= MAX_TRUSTED_PROXY_HOPS ? n : DEFAULT_TRUSTED_PROXY_HOPS;
}

/** Expande una IPv6 válida a sus 8 grupos de 16 bits (soporta `::` y sufijo IPv4). */
function expandIpv6(ip: string): number[] | null {
  let text = ip.split("%")[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const o = v4[1]!.split(".").map(Number);
    text = text.slice(0, -v4[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill("0") : []), ...tail];
  const parsed = groups.map((g) => parseInt(g, 16));
  return parsed.length === 8 && parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? parsed : null;
}

/**
 * IP canónica para usar como clave de límite: IPv4 tal cual; IPv4 mapeada en IPv6 (`::ffff:a.b.c.d`) como IPv4; IPv6 truncada a su
 * /64, porque cada hogar/móvil recibe un /64 completo y rotar dentro de él es trivial (sin esto el límite por IP no limita nada).
 */
export function canonicalizeIp(candidate: string): string | null {
  const value = candidate.trim().replace(/^\[|\]$/g, "");
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;
  const groups = expandIpv6(value);
  if (!groups) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::`;
}

/**
 * IP del cliente según las entradas que agregaron NUESTROS proxies. Siempre devuelve una IP válida para una columna `inet`.
 */
export function resolveClientIp(headers: HeaderReader, hops: number = trustedProxyHops()): string {
  if (hops <= 0) return FALLBACK_CLIENT_IP;
  const raw = headers.get("x-forwarded-for");
  if (!raw || raw.length > MAX_HEADER_LENGTH) return FALLBACK_CLIENT_IP;
  const entries = raw.split(",").map((e) => e.trim()).filter((e) => e !== "");
  if (entries.length === 0) return FALLBACK_CLIENT_IP;
  // Hay menos entradas que proxies esperados: ningún valor de la izquierda fue agregado por un proxy propio más allá de
  // las que existen; se toma la primera (la más externa que sí vimos) en lugar de adivinar.
  const picked = entries[Math.max(entries.length - hops, 0)]!;
  return canonicalizeIp(picked) ?? FALLBACK_CLIENT_IP;
}
