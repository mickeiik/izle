// The one place where anything reaches the log. Stream URLs, upstream headers, adapter refs, tokens and playlist
// text must never be written (AGENTS.md, "Hard invariants"): keys that can hold them are dropped, strings are
// scrubbed of URLs, playlist text and token-like runs, except catalog ids and problem codes in their own fields. It is a
// heuristic: a value under an innocent key that looks like none of these (a short API key) is written as given, so the
// code must not hand such values to the log.

import { errorName } from "./errors.ts";

export type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** A key with one of these words (camelCase, snake_case or kebab-case) drops the whole value. */
const SECRET_WORDS = new Set([
  "url", "urls", "uri", "href", "header", "headers", "authorization", "cookie", "cookies", "token", "tokens",
  "ref", "refs", "config", "playlist", "password", "secret", "body",
]);

/** `scheme://…`, or protocol-relative `//host…` (not preceded by a word character, `:` or `/`, as in a file path). */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+|(?<![\w:/])\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d+)?(?:[/?#][^\s"'<>`]*)?/gi;
/** Playlist text, whatever key it is under: the whole string goes. */
const PLAYLIST_RE = /^\uFEFF?\s*#EXTM3U/;
const TOKEN_RE = /[A-Za-z0-9_-]{20,}/g;
const MAX_DEPTH = 6;
const MAX_STRING = 500;
const MAX_ARRAY = 50;

function isSecretKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/);
  return words.some((w) => SECRET_WORDS.has(w.toLowerCase()));
}

function urlPlaceholder(match: string): string {
  const host = URL.parse(match, "http://relative.invalid")?.host;
  return host === undefined ? "<url>" : `<url ${host || "?"}>`;
}

/** Playlist text becomes `<playlist>`, URLs `<url host>`, token-like runs what `token` makes of them; capped. */
function scrub(value: string, token: (run: string) => string): string {
  if (PLAYLIST_RE.test(value)) return "<playlist>";
  const out = value.replace(URL_RE, urlPlaceholder).replace(TOKEN_RE, token);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

function redactString(value: string): string {
  return scrub(value, () => "<token>");
}

/**
 * Long runs that read as words, not secrets: SCREAMING_SNAKE and snake/kebab case (number segments of up to four
 * digits) and CamelCase of 3+ letter words, as player error names are. Random base64url runs of 20 characters match
 * about 2 in 100 000 times, of 32 practically never.
 */
const IDENTIFIER_RE = /^(?:[A-Z]+(?:[_-](?:[A-Z]+|[0-9]{1,4}))+|[a-z]+(?:[_-](?:[a-z]+|[0-9]{1,4}))+|(?:[A-Z][a-z]{2,}){2,}|[a-z]{2,}(?:[A-Z][a-z]{2,})+)$/;

/** The redaction for problem text a TV reports (stored, never logged): runs that read as identifiers survive. */
export function redactReportText(value: string): string {
  return scrub(value, (run) => (IDENTIFIER_RE.test(run) ? run : "<token>"));
}

/**
 * A catalog id as catalogs write them: lowercase words, and runs of at most 12 lowercase letters and digits (a number,
 * an 8- or 12-hex suffix, `s1e1`, `1080p`), joined by `-`, `.` or `_`.
 */
const SLUG_RE = /^(?:[a-z]+|[a-z0-9]{1,12})(?:[-._](?:[a-z]+|[a-z0-9]{1,12}))*$/;

/**
 * Fields whose value is written as given when it has their shape (anything else is scrubbed like free text): catalog
 * ids, which the catalog serves to every TV and the admin page shows, and problem codes, already redacted for storage.
 * The shapes leave out what secrets look like: mixed case (base64url: access, device and proxy session tokens, signed
 * links), 13+ letters and digits in a row (hex digests), and `/`, `:`, `?` or `=` (URLs, paths, query strings). A
 * passphrase of lowercase words would pass, so only values the code takes from the catalog or a problem go here.
 */
const ID_FIELDS = new Map<string, RegExp>([
  ["catalogId", SLUG_RE], ["buildId", SLUG_RE], ["itemId", SLUG_RE], ["episodeId", SLUG_RE], ["sourceId", SLUG_RE],
  ["adapterId", SLUG_RE], ["code", IDENTIFIER_RE],
]);

function isIdField(key: string, value: unknown): value is string {
  const shape = ID_FIELDS.get(key);
  return shape !== undefined && typeof value === "string" && value.length <= 200 && shape.test(value);
}

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Error) {
    // Messages and stacks routinely contain URLs; only the class name (an identifier of at most 60 characters,
    // scrubbed like any string) and a short string code are kept.
    const code = (value as { code?: unknown }).code;
    return { name: redactString(errorName(value)), ...(typeof code === "string" && code.length <= 40 ? { code: redactString(code) } : {}) };
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "<circular>";
  if (depth >= MAX_DEPTH) return "<deep>";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1, seen));
    return value.length > MAX_ARRAY ? [...items, `<+${value.length - MAX_ARRAY}>`] : items;
  }
  if (value instanceof Map || value instanceof Set || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `<${value.constructor.name}>`;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k)) continue;
    const r = isIdField(k, v) ? v : redact(v, depth + 1, seen);
    if (r !== undefined) out[redactString(k)] = r;
  }
  return out;
}

export interface Logger extends Record<Level, (msg: string, fields?: Record<string, unknown>) => void> {
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  opts: { level?: Level; write?: (line: string) => void; now?: () => number } = {},
  bound: Record<string, unknown> = {},
): Logger {
  const level = opts.level ?? "info";
  const write = opts.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = opts.now ?? Date.now;
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const safe = redact({ ...bound, ...fields }) as Record<string, unknown>;
    const line: Record<string, unknown> = { time: new Date(now()).toISOString(), level: lvl, msg: redactString(msg) };
    for (const [k, v] of Object.entries(safe)) if (!(k in line)) line[k] = v;
    write(JSON.stringify(line));
  };
  return {
    debug: (m, f) => emit("debug", m, f), info: (m, f) => emit("info", m, f), warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f), child: (fields) => createLogger(opts, { ...bound, ...fields }),
  };
}
