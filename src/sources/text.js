// Safe conversion of untrusted, possibly HTML-encoded text into plain text.
// Pure string processing: nothing is ever parsed into a DOM, evaluated, or rendered as HTML, so imported or fetched
// content cannot execute. All markup is removed; only text (with line breaks for block elements) survives.

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', bull: "*", middot: "·", copy: "(c)", reg: "(r)", trade: "(tm)", euro: "EUR ", pound: "GBP ", yen: "JPY ",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", ntilde: "ñ", uuml: "ü", ouml: "ö", auml: "ä",
};

// Decode &amp; &lt; &#39; &#x27; style entities once. Unknown names are left as-is; invalid code points are dropped.
export function decodeEntities(input) {
  return String(input).replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,15});/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) return "";
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‍﻿]/g;

// Strip markup and return readable plain text.
//   options.escaped  true when the input is HTML that was itself entity-escaped (as the Greenhouse API does):
//                    it is decoded once first so the tags can be recognised and removed.
export function htmlToText(input, { escaped = false, maxLength = 100000 } = {}) {
  if (input == null) return "";
  let s = String(input);
  if (escaped) s = decodeEntities(s);
  s = s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|iframe|object|embed|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|h[1-6]|ul|ol|table|tr|blockquote)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?[A-Za-z!][^>]*>/g, "");
  s = decodeEntities(s).replace(/&nbsp;/gi, " ").replace(CONTROL_CHARS, "");
  s = s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > maxLength ? s.slice(0, maxLength) : s;
}

// Single-line text (titles, names): markup removed, whitespace collapsed.
export function plainLine(input, maxLength = 500) {
  const t = htmlToText(input, { maxLength }).replace(/\s+/g, " ").trim();
  return t.length > maxLength ? t.slice(0, maxLength) : t;
}
