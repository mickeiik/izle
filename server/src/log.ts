// The one place where anything reaches the log. Stream URLs, upstream headers, adapter refs, tokens and playlist
// text must never be written: keys that can hold them are dropped, and strings are scrubbed of URLs and
// token-like runs. See AGENTS.md ("Hard invariants").

export type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Words that, when they appear in a key (camelCase, snake_case or kebab-case), drop the whole value. */
const SECRET_WORDS = new Set([
  "url", "urls", "uri", "href", "header", "headers", "authorization", "cookie", "cookies", "token", "tokens",
  "ref", "refs", "config", "playlist", "password", "secret", "body",
]);

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const TOKEN_RE = /[A-Za-z0-9_-]{20,}/g;
const MAX_DEPTH = 6;
const MAX_STRING = 500;
const MAX_ARRAY = 50;

function isSecretKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/);
  return words.some((w) => SECRET_WORDS.has(w.toLowerCase()));
}

function urlPlaceholder(match: string): string {
  try {
    return `<url ${new URL(match).host || "?"}>`;
  } catch {
    return "<url>";
  }
}

/** URLs become `<url host>`, token-like runs whatever `token` makes of them, and the result is capped. */
function scrub(value: string, token: (run: string) => string): string {
  const out = value.replace(URL_RE, urlPlaceholder).replace(TOKEN_RE, token);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

function redactString(value: string): string {
  return scrub(value, () => "<token>");
}

/**
 * Long runs that read as words, not secrets: SCREAMING_SNAKE and snake/kebab case (whole number segments of up to
 * four digits allowed) and CamelCase of words with three or more letters, without digits. Player error names take
 * these shapes (`ERROR_CODE_IO_BAD_HTTP_STATUS`, `InvalidResponseCodeException`); random base64url runs of 20
 * characters match about 2 in 100 000 times, of 32 characters practically never (they mix cases and digits).
 */
const IDENTIFIER_RE = /^(?:[A-Z]+(?:[_-](?:[A-Z]+|[0-9]{1,4}))+|[a-z]+(?:[_-](?:[a-z]+|[0-9]{1,4}))+|(?:[A-Z][a-z]{2,}){2,}|[a-z]{2,}(?:[A-Z][a-z]{2,})+)$/;

/**
 * The same redaction for text a TV reports about a problem (stored for the owner, never logged): URLs become
 * `<url host>` and token-like runs `<token>`, except runs that read as identifiers, so error names survive.
 */
export function redactReportText(value: string): string {
  return scrub(value, (run) => (IDENTIFIER_RE.test(run) ? run : "<token>"));
}

/** Returns a log-safe deep copy of `value`. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Error) {
    // Messages and stacks routinely contain URLs; only the class name (and a short string code) are kept.
    const code = (value as { code?: unknown }).code;
    return { name: value.name, ...(typeof code === "string" && code.length <= 40 ? { code: redactString(code) } : {}) };
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
    const r = redact(v, depth + 1, seen);
    if (r !== undefined) out[redactString(k)] = r;
  }
  return out;
}

export interface Logger extends Record<Level, (msg: string, fields?: Record<string, unknown>) => void> {
  /** A logger whose lines all carry `fields`. */
  child(fields: Record<string, unknown>): Logger;
}

/** `write` receives one JSON line (without the trailing newline); stdout by default. */
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
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger(opts, { ...bound, ...fields }),
  };
}
