/**
 * Plantillas del Mailing: sanitizado de HTML (lista blanca), variables controladas (sin eval) y armado del mensaje final.
 * Puro (sin base ni red): se usa en el servidor y en las pruebas.
 *
 * Reglas:
 *  - El HTML del operador se SANITIZA al guardar y otra vez al renderizar (defensa en profundidad): sin scripts, sin manejadores
 *    on*, sin javascript:/data: en URLs, sin iframes/objetos/formularios.
 *  - Las variables se sustituyen DESPUÉS de sanitizar y siempre escapadas: un nombre con `<script>` no inyecta nada.
 *  - Variable sin dato → cadena neutra (se elimina junto con el espacio que la precede: «Hola {{nombre}},» → «Hola,»).
 */

export const TEMPLATE_VARIABLES = ["nombre", "apellido", "nombre_completo", "organizacion", "baja_url"] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export interface MergeVars {
  nombre?: string | null;
  apellido?: string | null;
  nombre_completo?: string | null;
  organizacion?: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sanitizado de HTML
// ---------------------------------------------------------------------------------------------------------------------
const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "center", "code", "div", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
  "li", "ol", "p", "pre", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
/** Etiquetas cuyo CONTENIDO también se descarta. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "template", "svg", "math", "head", "title",
  "form", "textarea", "select", "button", "audio", "video", "canvas", "link", "meta", "base", "xml",
]);
const GLOBAL_ATTRS = new Set(["style", "class", "align", "valign", "width", "height", "bgcolor", "dir", "lang", "title", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "color", "size", "face"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel", "name"]),
  img: new Set(["src", "alt"]),
};

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", colon: ":", tab: "\t", newline: "\n", lpar: "(", rpar: ")" };

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d: string) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);?/gi, (m, n: string) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  return String.fromCodePoint(cp);
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** URL permitida: http(s), mailto, tel (y, para enlaces, `#ancla`). Se decodifican entidades y se quitan controles antes de mirar. */
function safeUrl(raw: string, options: { allowFragment: boolean; allowMailto: boolean }): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = decodeEntities(raw).replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Zs}]+/gu, "");
  if (cleaned === "") return null;
  if (options.allowFragment && cleaned.startsWith("#")) return cleaned;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!scheme) return null; // relativas no sirven en un email
  const s = scheme[1]!.toLowerCase();
  if (s === "http" || s === "https") return cleaned;
  if (options.allowMailto && (s === "mailto" || s === "tel")) return cleaned;
  return null;
}

function safeStyle(raw: string): string {
  const decoded = decodeEntities(raw);
  return decoded
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d !== "" && /^[a-z-]+\s*:/i.test(d) && !/(expression|javascript|vbscript|behavior|@import|url\s*\(|-moz-binding|<|>)/i.test(d))
    .join("; ");
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|[^<]+|</g;

export function sanitizeEmailHtml(html: string): string {
  const out: string[] = [];
  let skipUntil: string | null = null;
  let skipDepth = 0;
  const open: string[] = [];
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(html)) !== null) {
    const token = match[0];
    const closing = match[1] === "/";
    const rawName = match[2];
    if (!rawName) {
      // texto, comentario, doctype, etc.
      if (skipUntil) continue;
      if (token.startsWith("<!") || token.startsWith("<?")) continue;
      if (token === "<") out.push("&lt;");
      else out.push(token.replace(/>/g, "&gt;"));
      continue;
    }
    const name = rawName.toLowerCase();
    if (skipUntil) {
      if (name === skipUntil) {
        if (closing) {
          skipDepth -= 1;
          if (skipDepth <= 0) skipUntil = null;
        } else if (!token.endsWith("/>")) skipDepth += 1;
      }
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing && !token.endsWith("/>") && !VOID_TAGS.has(name)) {
        skipUntil = name;
        skipDepth = 1;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue; // se descarta la etiqueta, queda su contenido
    if (closing) {
      const idx = open.lastIndexOf(name);
      if (idx === -1) continue;
      while (open.length > idx) out.push(`</${open.pop()}>`);
      continue;
    }
    const attrs: string[] = [];
    const allowedForTag = TAG_ATTRS[name];
    let a: RegExpExecArray | null;
    ATTR_RE.lastIndex = 0;
    const attrSource = match[3] ?? "";
    let hasHref = false;
    while ((a = ATTR_RE.exec(attrSource)) !== null) {
      const attr = a[1]!.toLowerCase();
      const value = a[2] ?? a[3] ?? a[4] ?? "";
      if (attr.startsWith("on")) continue;
      if (!(GLOBAL_ATTRS.has(attr) || allowedForTag?.has(attr))) continue;
      if (attr === "href" && /^\{\{\s*baja_url\s*\}\}$/.test(value.trim())) {
        hasHref = true;
        attrs.push('href="{{baja_url}}"');
      } else if (attr === "href") {
        const url = safeUrl(value, { allowFragment: true, allowMailto: true });
        if (!url) continue;
        hasHref = true;
        attrs.push(`href="${escapeHtml(url)}"`);
      } else if (attr === "src") {
        const url = safeUrl(value, { allowFragment: false, allowMailto: false });
        if (!url) continue;
        attrs.push(`src="${escapeHtml(url)}"`);
      } else if (attr === "style") {
        const style = safeStyle(value);
        if (style) attrs.push(`style="${escapeHtml(style)}"`);
      } else if (attr === "target" || attr === "rel") {
        continue; // se fijan abajo
      } else {
        attrs.push(`${attr}="${escapeHtml(decodeEntities(value))}"`);
      }
    }
    if (name === "a" && hasHref) attrs.push('target="_blank"', 'rel="noopener noreferrer"');
    if (name === "img" && !attrs.some((x) => x.startsWith("src="))) continue;
    out.push(`<${name}${attrs.length ? " " + attrs.join(" ") : ""}>`);
    if (!VOID_TAGS.has(name) && !token.endsWith("/>")) open.push(name);
  }
  while (open.length > 0) out.push(`</${open.pop()}>`);
  return out.join("");
}

// ---------------------------------------------------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------------------------------------------------
const VAR_RE = /(\s*)\{\{\s*([a-zA-Z_]+)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;

export function findUnknownVariables(template: string): string[] {
  const unknown = new Set<string>();
  VAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VAR_RE.exec(template)) !== null) {
    const name = m[2]!.toLowerCase();
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) unknown.add(name);
  }
  return [...unknown];
}

/** Sustituye variables. `escape` = true para HTML. Una variable desconocida o sin dato se elimina (con su espacio previo). */
export function renderVariables(template: string, vars: Record<string, string | null | undefined>, options: { escape: boolean }): string {
  return template.replace(VAR_RE, (_m, space: string, rawName: string, fallback: string | undefined) => {
    const name = rawName.toLowerCase();
    const known = (TEMPLATE_VARIABLES as readonly string[]).includes(name);
    let value = known ? (vars[name] ?? "").trim() : "";
    if (value === "" && fallback !== undefined) value = fallback.trim();
    if (value === "") return "";
    return space + (options.escape ? escapeHtml(value) : value);
  });
}

export function buildMergeVars(person: { firstName?: string | null; lastName?: string | null; organizationName?: string | null } | null): Required<MergeVars> {
  const first = (person?.firstName ?? "").trim();
  const last = (person?.lastName ?? "").trim();
  return {
    nombre: first,
    apellido: last,
    nombre_completo: [first, last].filter(Boolean).join(" "),
    organizacion: (person?.organizationName ?? "").trim(),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Mensaje final
// ---------------------------------------------------------------------------------------------------------------------
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
      .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
        const text = label.replace(/<[^>]+>/g, "").trim();
        return text && text !== href ? `${text} (${href})` : href;
      })
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface RenderInput {
  subject: string;
  preheader?: string | null;
  htmlBody: string;
  textBody: string;
  vars: MergeVars;
  unsubscribeUrl: string;
}

export interface RenderedMessage {
  subject: string;
  html: string;
  text: string;
}

const FOOTER_HTML = (url: string) =>
  `<hr style="border:none;border-top:1px solid #dddddd;margin:24px 0 12px"><p style="font-size:12px;color:#666666;line-height:1.4">Si no querés recibir más comunicaciones, podés <a href="${escapeHtml(url)}">darte de baja acá</a>.</p>`;
const FOOTER_TEXT = (url: string) => `\n\n--\nSi no querés recibir más comunicaciones, podés darte de baja acá: ${url}`;

export function renderMessage(input: RenderInput): RenderedMessage {
  const vars: Record<string, string | null | undefined> = { ...input.vars, baja_url: input.unsubscribeUrl };
  const subject = renderVariables(input.subject, vars, { escape: false }).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();

  const cleanHtml = sanitizeEmailHtml(input.htmlBody);
  let html = cleanHtml !== "" ? cleanHtml : escapeHtml(input.textBody).replace(/\n/g, "<br>");
  html = renderVariables(html, vars, { escape: true });
  const hasOwnUnsubscribe = input.htmlBody.includes("{{baja_url") || input.htmlBody.includes("{{ baja_url");
  const pre = input.preheader?.trim()
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(renderVariables(input.preheader.trim(), vars, { escape: false }))}</div>`
    : "";
  const body = `${pre}${html}${hasOwnUnsubscribe ? "" : FOOTER_HTML(input.unsubscribeUrl)}`;
  const finalHtml = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222222">${body}</body></html>`;

  const baseText = input.textBody.trim() !== "" ? input.textBody : htmlToText(cleanHtml);
  const textHasUnsub = input.textBody.includes("{{baja_url") || (input.textBody.trim() === "" && hasOwnUnsubscribe);
  const text = renderVariables(baseText, vars, { escape: false }) + (textHasUnsub ? "" : FOOTER_TEXT(input.unsubscribeUrl));
  return { subject, html: finalHtml, text };
}
