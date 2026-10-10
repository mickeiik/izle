// The one place where anything reaches the log. Stream URLs, upstream headers, adapter refs, tokens and playlist
// text must never be written: keys that can hold them are dropped, and strings are scrubbed of URLs and
// token-like runs. See AGENTS.md ("Hard invariants").

export type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Words that, when they appear in a key (camelCase, snake_case or kebab-case), drop the whole value. */
const SECRET_WORDS = new Set([
  "url",
  "urls",
  "uri",
  "href",
  "header",
  "headers",
  "authorization",
  "cookie",
  "cookies",
  "token",
  "tokens",
  "ref",
  "refs",
  "config",
  "playlist",
  "password",
  "secret",
  "body",
]);

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const TOKEN_RE = /[A-Za-z0-9_-]{20,}/g;
const MAX_DEPTH = 6;
const MAX_STRING = 500;
const MAX_ARRAY = 50;

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function isSecretKey(key: string): boolean {
  return keyWords(key).some((w) => SECRET_WORDS.has(w));
}

export function redactString(value: string): string {
  let out = value.replace(URL_RE, (match) => {
    try {
      return `<url ${new URL(match).host || "?"}>`;
    } catch {
      return "<url>";
    }
  });
  out = out.replace(TOKEN_RE, "<token>");
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
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

export interface Logger {
  level: Level;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** A logger whose lines all carry `fields`. */
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: Level;
  /** Receives one JSON line (without the trailing newline). Defaults to stdout. */
  write?: (line: string) => void;
  now?: () => number;
}

export function createLogger(opts: LoggerOptions = {}, bound: Record<string, unknown> = {}): Logger {
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
    level,
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger(opts, { ...bound, ...fields }),
  };
}

/** A logger that discards everything (tests). */
export const silentLogger: Logger = createLogger({ write: () => {} });
