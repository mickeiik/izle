// Loads the owner's resolver module (a local file, never downloaded) and runs its adapters under deadlines.
// The module is owner-trusted, in-process code: the only protections are deadlines, result validation, and
// reducing every failure to {adapterId, code, name} so error messages (which often hold URLs) never travel.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ID_PATTERN, MAX_INLINE_PLAYLIST_BYTES, RESOLVER_API_VERSION, validateResolveResultsSchema } from "@izle/contract";
import type { Adapter, AdapterContext, LogLevel, ResolveRequest, ResolveResult } from "@izle/contract";
import { errorName } from "./errors.ts";
import { isPlaylistText } from "./hls.ts";
import type { Logger } from "./log.ts";
import { stopwatch } from "./stopwatch.ts";

/** Time allowed for `createAdapters` at startup. */
const CREATE_ADAPTERS_TIMEOUT_MS = 30_000;
/** Time allowed for one adapter's `healthcheck`. */
const HEALTHCHECK_TIMEOUT_MS = 15_000;

export class ResolverLoadError extends Error {
  override name = "ResolverLoadError";
}

export interface LoadedResolver {
  /** Absolute path of the module file. */
  file: string;
  sha256: string;
  adapters: ReadonlyMap<string, Adapter>;
}

/** Resolves when `promise` settles, or rejects with a TimeoutError after `ms` (the promise is left to settle alone). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {}); // a late rejection must not become an unhandled rejection
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DOMException("timed out", "TimeoutError")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Calls `fn` so that synchronous throws become rejections. */
function call<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Imports the module, checks the API version and creates the adapters once. Throws ResolverLoadError with a
 * message fit for the owner's terminal (it never includes the module's own error messages).
 */
export async function loadResolver(opts: {
  module: string;
  config: Record<string, unknown>;
  /** The server's data directory; the module gets `<dataDir>/resolver`. */
  dataDir: string;
  log: Logger;
}): Promise<LoadedResolver> {
  const file = path.resolve(opts.module);
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new ResolverLoadError(`cannot read resolver module ${file}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  let ns: Record<string, unknown>;
  try {
    ns = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (err) {
    const why = `${errorName(err)}; run it with node to see the details`;
    throw new ResolverLoadError(`cannot import resolver module ${file} (${why})`, { cause: err });
  }
  const mod = (ns.default ?? ns) as Record<string, unknown>;
  if (mod.apiVersion !== RESOLVER_API_VERSION) {
    const declared = typeof mod.apiVersion === "number" ? String(mod.apiVersion) : "none";
    throw new ResolverLoadError(`resolver module ${file} declares apiVersion ${declared}; this server implements resolver API ${RESOLVER_API_VERSION}`);
  }
  if (typeof mod.createAdapters !== "function") throw new ResolverLoadError(`resolver module ${file} does not export createAdapters()`);

  const dataDir = path.join(opts.dataDir, "resolver");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const log = opts.log.child({ component: "resolver" });
  // The adapter-facing logger is the server's redacted logger, with level and arguments sanitized.
  const adapterLog = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    const lvl = level === "warn" || level === "error" ? level : "info";
    log[lvl](String(msg), fields !== null && typeof fields === "object" ? fields : undefined);
  };
  const ctx: AdapterContext = { config: opts.config, dataDir, fetch: globalThis.fetch, log: adapterLog };
  const createAdapters = mod.createAdapters as (ctx: AdapterContext) => unknown;

  let created: unknown;
  try {
    created = await withTimeout(call(() => createAdapters(ctx)), CREATE_ADAPTERS_TIMEOUT_MS);
  } catch (err) {
    throw new ResolverLoadError(`createAdapters() of ${file} failed (${errorName(err)})`, { cause: err });
  }
  if (!Array.isArray(created)) throw new ResolverLoadError(`createAdapters() of ${file} must return an array of adapters`);
  const adapters = new Map<string, Adapter>();
  for (const [i, a] of created.entries()) {
    const candidate = a as Partial<Adapter> | null;
    if (!candidate || typeof candidate.id !== "string" || !ID_PATTERN.test(candidate.id) || typeof candidate.resolve !== "function") {
      throw new ResolverLoadError(`adapter #${i} of ${file} needs an id (catalog id syntax) and a resolve() function`);
    }
    if (candidate.healthcheck !== undefined && typeof candidate.healthcheck !== "function") {
      throw new ResolverLoadError(`adapter "${candidate.id}" of ${file} has a healthcheck that is not a function`);
    }
    if (adapters.has(candidate.id)) throw new ResolverLoadError(`resolver module ${file} provides adapter "${candidate.id}" twice`);
    adapters.set(candidate.id, candidate as Adapter);
  }
  // 16 hex digits identify the build; the full hash (64 characters) would be redacted as token-like.
  opts.log.info("resolver module loaded", { file, sha256: sha256.slice(0, 16), adapters: [...adapters.keys()] });
  return { file, sha256, adapters };
}

export type AdapterFailureCode = "timeout" | "abort" | "error" | "empty";

type AdapterOutcome =
  | { ok: true; results: ResolveResult[]; ms: number }
  | { ok: false; code: AdapterFailureCode; name: string | null; ms: number };

/**
 * Runs `adapter.resolve` under `AbortSignal.any([signal, <deadline>])`. A call that ignores the signal is abandoned
 * when the deadline passes. Results are schema-validated; an invalid result counts as an error named
 * `InvalidResult`. The deadline is an ordinary timer rather than `AbortSignal.timeout()`, whose timer does not keep
 * the process alive: a CLI run or a test with nothing else pending would end before the deadline fires.
 */
export async function runAdapter(
  adapter: Adapter,
  req: Omit<ResolveRequest, "signal" | "deadlineMs">,
  opts: { deadlineMs: number; signal?: AbortSignal },
): Promise<AdapterOutcome> {
  const ms = stopwatch();
  const fail = (code: AdapterFailureCode, name: string | null): AdapterOutcome => ({ ok: false, code, name, ms: ms() });
  const deadlineController = new AbortController();
  const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const timer = setTimeout(() => deadlineController.abort(timeoutError), Math.max(1, opts.deadlineMs));
  const deadline = deadlineController.signal;
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  const running = call(() => adapter.resolve({ ...req, ref: structuredClone(req.ref), signal, deadlineMs: opts.deadlineMs }));
  running.catch(() => {});
  let value: unknown;
  try {
    value = await Promise.race([running, aborted]);
  } catch (err) {
    const code = deadline.aborted ? "timeout" : opts.signal?.aborted ? "abort" : "error";
    return fail(code, code === "error" ? errorName(err) : code === "timeout" ? "TimeoutError" : "AbortError");
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  if (!validateResolveResultsSchema(value)) return fail("error", "InvalidResult");
  for (const { media } of value) {
    if (!("playlist" in media)) continue;
    if (Buffer.byteLength(media.playlist, "utf8") > MAX_INLINE_PLAYLIST_BYTES) return fail("error", "PlaylistTooLarge");
    if (!isPlaylistText(media.playlist)) return fail("error", "NotAPlaylist");
  }
  if (value.length === 0) return fail("empty", null);
  return { ok: true, results: value, ms: ms() };
}

type HealthOutcome =
  | { adapterId: string; ok: true; ms: number; /** the adapter has no healthcheck */ skipped: boolean }
  | { adapterId: string; ok: false; code: "timeout" | "error"; name: string; ms: number };

/** Runs every adapter's healthcheck (adapters without one count as healthy). */
export async function healthcheckAll(resolver: LoadedResolver): Promise<HealthOutcome[]> {
  return Promise.all(
    [...resolver.adapters.values()].map(async (adapter): Promise<HealthOutcome> => {
      const ms = stopwatch();
      if (!adapter.healthcheck) return { adapterId: adapter.id, ok: true, ms: 0, skipped: true };
      const signal = AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS);
      try {
        await withTimeout(call(() => adapter.healthcheck!(signal)), HEALTHCHECK_TIMEOUT_MS);
        return { adapterId: adapter.id, ok: true, ms: ms(), skipped: false };
      } catch (err) {
        const timedOut = signal.aborted || (err instanceof DOMException && err.name === "TimeoutError");
        return { adapterId: adapter.id, ok: false, ...(timedOut ? { code: "timeout", name: "TimeoutError" } : { code: "error", name: errorName(err) }), ms: ms() };
      }
    }),
  );
}
