// The media proxy. It serves header-bound and inline-playlist streams to the TV so upstream request headers never
// leave the server: `/p/<token>/index.m3u8` (or `video.mp4`) is the entry point, every URI inside a playlist is
// rewritten to `/p/<token>/u/<signed ref>`, and subtitle files are served from `/p/<token>/sub/<n>.<ext>`.
// Sessions live in memory only; a restart answers 410 and the TV re-resolves.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { newToken } from "./auth.ts";
import { isPlaylistText, rewritePlaylist, tsSyncOffset, TS_ALIGN_LOOKAHEAD, type LinkKind } from "./hls.ts";
import type { Logger } from "./log.ts";
import { errorName } from "./resolver.ts";

export const MAX_SESSIONS_PER_DEVICE = 2;
/** Absolute session lifetime, whatever the sliding TTL. */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60_000;
/** Largest upstream playlist the proxy reads into memory. */
export const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
/** Time allowed for an upstream to answer with headers; the body then streams for as long as the TV reads. */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 20_000;

/** Session tokens are 32 random bytes, base64url. */
export const PROXY_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const PLAYLIST_TYPE = "application/vnd.apple.mpegurl";
const SUBTITLE_TYPES: Record<string, string> = { vtt: "text/vtt; charset=utf-8", srt: "application/x-subrip; charset=utf-8", ttml: "application/ttml+xml" };
/** Response headers passed from the upstream to the TV; everything else (cookies, redirects, CORS) is dropped. */
const PASSED_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];
/** Formats the TS aligner never touches (by URL extension). */
const NOT_TS_EXTENSIONS = new Set(["m4s", "mp4", "m4a", "m4v", "cmfv", "cmfa", "aac", "mp3", "ac3", "ec3", "vtt", "webvtt", "key"]);

export type ProxyMain =
  | { kind: "hls" | "mp4"; url: string; playlist?: undefined }
  | { kind: "hls"; playlist: string; baseUrl: string; url?: undefined };

export interface ProxySessionInit {
  /** Owner key of the session-limit bucket: the TV's device id, or `companion:<deviceId>` for the phone. */
  deviceId: string;
  /** What the session plays, for problem reports. */
  episodeId?: string | null;
  sourceId?: string | null;
  /** Null when only subtitle tracks need the proxy. */
  main: ProxyMain | null;
  /** Upstream headers for the main media and everything its playlists reference. */
  headers: Record<string, string>;
  /** One entry per subtitle track the TV gets; null = that track is not proxied. */
  subtitles: Array<{ url: string; headers: Record<string, string> } | null>;
}

interface Session extends ProxySessionInit {
  token: string;
  /** Per-session key that signs the URLs written into rewritten playlists. */
  key: Buffer;
  createdAt: number;
  lastUsedAt: number;
  stale: boolean;
}

export type ProxyTarget = { type: "index" } | { type: "video" } | { type: "u"; ref: string } | { type: "sub"; file: string };

/**
 * `upstream_<status>` (401/403/410: the session went stale), `upstream_error` (5xx, or a playlist that broke off),
 * `upstream_unreachable` (network error or no answer in time), `not_a_playlist`, `playlist_too_large`.
 */
export type ProxyProblemCode =
  | "upstream_401"
  | "upstream_403"
  | "upstream_410"
  | "upstream_error"
  | "upstream_unreachable"
  | "not_a_playlist"
  | "playlist_too_large";

/** An upstream request of a session that failed in a way the owner should hear about. */
export interface ProxyProblem {
  /** The session's owner key: a TV's device id, or `companion:<deviceId>`. */
  owner: string;
  episodeId: string | null;
  sourceId: string | null;
  code: ProxyProblemCode;
  httpStatus: number | null;
  /** What was requested (`playlist`, `segment`, `video`, `subtitles`) and, when unreachable, why. Never a URL. */
  detail: string;
}

export interface ProxyOptions {
  log: Logger;
  now?: () => number;
  /** Sliding session lifetime. */
  ttlMs: number;
  alignTsSegments?: boolean;
  fetch?: typeof fetch;
  /** Told about failed upstream requests (problem reports). */
  onProblem?: (problem: ProxyProblem) => void;
}

export function entryPath(token: string, kind: "hls" | "mp4"): string {
  return `/p/${token}/${kind === "hls" ? "index.m3u8" : "video.mp4"}`;
}

export function subtitlePath(token: string, index: number, format: string): string {
  return `/p/${token}/sub/${index}.${format}`;
}

function extensionOf(url: string): string | null {
  try {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(new URL(url).pathname);
    return m ? m[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

function json(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** A stream error that @hono/node-server treats as a closed connection rather than a crash to print. */
function prematureClose(): Error {
  return Object.assign(new Error("upstream closed early"), { code: "ERR_STREAM_PREMATURE_CLOSE" });
}

/** Why a fetch failed, without its message: the network error code (`ECONNREFUSED`, `ENOTFOUND`) or the class name. */
function networkReason(err: unknown): string {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(code) ? code : errorName(err);
}

async function readText(res: Response, limit: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class ProxyService {
  private readonly sessions = new Map<string, Session>();
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly alignTs: boolean;
  private readonly fetch: typeof fetch;
  private readonly onProblem: ((problem: ProxyProblem) => void) | undefined;

  constructor(opts: ProxyOptions) {
    this.log = opts.log.child({ component: "proxy" });
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs;
    this.alignTs = opts.alignTsSegments ?? false;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.onProblem = opts.onProblem;
  }

  private problem(s: Session, code: ProxyProblemCode, httpStatus: number | null, detail: string): void {
    if (!this.onProblem) return;
    try {
      this.onProblem({ owner: s.deviceId, episodeId: s.episodeId ?? null, sourceId: s.sourceId ?? null, code, httpStatus, detail });
    } catch (err) {
      this.log.warn("problem hook failed", { error: err });
    }
  }

  /** Creates a session and returns its token. An owner keeps at most two; older ones end (410). */
  create(init: ProxySessionInit): string {
    const t = this.now();
    this.prune(t);
    const mine = [...this.sessions.values()].filter((s) => s.deviceId === init.deviceId).sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= MAX_SESSIONS_PER_DEVICE) this.sessions.delete(mine.shift()!.token);
    const token = newToken();
    this.sessions.set(token, { ...init, token, key: randomBytes(32), createdAt: t, lastUsedAt: t, stale: false });
    return token;
  }

  /** Ends every session of an owner key (the device was deleted). */
  dropDevice(deviceId: string): void {
    for (const s of this.sessions.values()) if (s.deviceId === deviceId) this.sessions.delete(s.token);
  }

  private prune(t: number): void {
    for (const s of this.sessions.values()) if (this.expired(s, t)) this.sessions.delete(s.token);
  }

  private expired(s: Session, t: number): boolean {
    return t - s.lastUsedAt > this.ttlMs || t - s.createdAt > SESSION_MAX_AGE_MS;
  }

  private sign(s: Session, url: string, kind: LinkKind): string {
    const b64 = Buffer.from(url, "utf8").toString("base64url");
    const mac = createHmac("sha256", s.key).update(`${kind}.${b64}`).digest().subarray(0, 16).toString("base64url");
    const ext = extensionOf(url);
    return `${kind}.${b64}.${mac}${ext ? `.${ext}` : ""}`;
  }

  private verify(s: Session, ref: string): { url: string; kind: LinkKind } | null {
    const [kind, b64, mac] = ref.split(".");
    if ((kind !== "p" && kind !== "r") || !b64 || !mac || !/^[A-Za-z0-9_-]+$/.test(b64)) return null;
    const expected = createHmac("sha256", s.key).update(`${kind}.${b64}`).digest().subarray(0, 16);
    const given = Buffer.from(mac, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const url = Buffer.from(b64, "base64url").toString("utf8");
    return /^https?:\/\//.test(url) ? { url, kind } : null;
  }

  /** Answers one proxy request. */
  async serve(req: Request, token: string, target: ProxyTarget): Promise<Response> {
    const t = this.now();
    const s = this.sessions.get(token);
    if (!s || this.expired(s, t)) {
      if (s) this.sessions.delete(token);
      return json(410, "gone");
    }
    if (s.stale) return json(410, "stale");
    s.lastUsedAt = t;

    switch (target.type) {
      case "index": {
        if (s.main?.kind !== "hls") return json(404, "not_found");
        if (s.main.playlist !== undefined) return this.playlistResponse(s, s.main.playlist, s.main.baseUrl, "u/");
        return this.forward(req, s, s.main.url, s.headers, { kind: "p", prefix: "u/", what: "playlist" });
      }
      case "video": {
        if (s.main?.kind !== "mp4" || s.main.url === undefined) return json(404, "not_found");
        return this.forward(req, s, s.main.url, s.headers, { kind: "r", prefix: null, what: "video" });
      }
      case "u": {
        const link = this.verify(s, target.ref);
        if (!link) return json(404, "not_found");
        return this.forward(req, s, link.url, s.headers, { kind: link.kind, prefix: "", what: link.kind === "p" ? "playlist" : "segment" });
      }
      case "sub": {
        const m = /^(\d{1,2})\.(vtt|srt|ttml)$/.exec(target.file);
        const sub = m ? s.subtitles[Number(m[1])] : undefined;
        if (!m || !sub) return json(404, "not_found");
        return this.forward(req, s, sub.url, sub.headers, { kind: "r", prefix: null, contentType: SUBTITLE_TYPES[m[2]!], what: "subtitles" });
      }
    }
  }

  private playlistResponse(s: Session, text: string, baseUrl: string, prefix: string): Response {
    const body = rewritePlaylist(text, baseUrl, (url, kind) => prefix + this.sign(s, url, kind));
    return new Response(body, { status: 200, headers: { "Content-Type": PLAYLIST_TYPE, "Cache-Control": "no-store" } });
  }

  /**
   * Fetches `url` with the upstream headers. Playlists (`kind` p, or a playlist content type) are read, rewritten
   * and answered; anything else streams through with `Range` forwarded. `prefix` is how rewritten URIs are
   * written relative to the requested path (null: the response is never treated as a playlist). `what` names the
   * request in problem reports.
   */
  private async forward(
    req: Request,
    s: Session,
    url: string,
    headers: Record<string, string>,
    opts: { kind: LinkKind; prefix: string | null; contentType?: string | undefined; what: string },
  ): Promise<Response> {
    const range = opts.kind === "r" ? req.headers.get("range") : null;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), UPSTREAM_HEADERS_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await this.fetch(url, {
        headers: { ...headers, ...(range ? { Range: range } : {}), ...(opts.kind === "r" ? { "Accept-Encoding": "identity" } : {}) },
        redirect: "follow",
        signal: AbortSignal.any([req.signal, timeout.signal]),
      });
    } catch (err) {
      if (req.signal.aborted) return json(503, "aborted");
      const timedOut = timeout.signal.aborted;
      this.log.warn("upstream unreachable", { deviceId: s.deviceId, code: timedOut ? "timeout" : "network", error: errorName(err) });
      const why = timedOut ? `no answer within ${Math.round(UPSTREAM_HEADERS_TIMEOUT_MS / 1000)} s` : networkReason(err);
      this.problem(s, "upstream_unreachable", null, `${opts.what}: ${why}`);
      return json(timedOut ? 504 : 502, timedOut ? "upstream_timeout" : "upstream_unreachable");
    } finally {
      clearTimeout(timer);
    }

    const status = upstream.status;
    if (status === 401 || status === 403 || status === 410) {
      await upstream.body?.cancel().catch(() => {});
      s.stale = true;
      this.log.warn("upstream refused the session; marked stale", { deviceId: s.deviceId, status });
      this.problem(s, `upstream_${status}`, status, opts.what);
      return json(410, "stale");
    }
    if (status >= 400 && status !== 416) {
      await upstream.body?.cancel().catch(() => {});
      this.log.warn("upstream error", { deviceId: s.deviceId, status });
      if (status >= 500) this.problem(s, "upstream_error", status, opts.what);
      return status === 404 ? json(404, "upstream_not_found") : json(502, "upstream_error", { status });
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (opts.prefix !== null && status === 200 && (opts.kind === "p" || /mpegurl/i.test(contentType))) {
      let text: string | null;
      try {
        text = await readText(upstream, MAX_PLAYLIST_BYTES);
      } catch (err) {
        if (req.signal.aborted) return json(503, "aborted");
        this.log.warn("upstream playlist read failed", { deviceId: s.deviceId, error: errorName(err) });
        this.problem(s, "upstream_error", status, `${opts.what}: broke off (${errorName(err)})`);
        return json(502, "upstream_error");
      }
      if (text === null) {
        this.problem(s, "playlist_too_large", status, `${opts.what}: larger than ${MAX_PLAYLIST_BYTES / (1024 * 1024)} MiB`);
        return json(502, "playlist_too_large");
      }
      if (!isPlaylistText(text)) {
        // The media type says what came instead (an HTML page is a block or captcha page); its text is never kept.
        const type = contentType.split(";")[0]!.trim();
        this.problem(s, "not_a_playlist", status, `${opts.what}: ${/^[\w.+-]{1,40}\/[\w.+-]{1,60}$/.test(type) ? type : "unknown content type"}`);
        return json(502, "not_a_playlist");
      }
      return this.playlistResponse(s, text, upstream.url || url, opts.prefix);
    }

    const out = new Headers({ "Cache-Control": "no-store" });
    for (const name of PASSED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    if (upstream.headers.has("content-encoding")) out.delete("content-length"); // fetch already decoded the body
    if (opts.contentType) out.set("content-type", opts.contentType);
    if (!upstream.body) return new Response(null, { status, headers: out });

    const align =
      this.alignTs && s.main?.kind === "hls" && opts.prefix === "" && status === 200 && range === null && !NOT_TS_EXTENSIONS.has(extensionOf(url) ?? "");
    return new Response(await this.stream(upstream.body, align, out), { status, headers: out });
  }

  /**
   * Wraps the upstream body so it streams chunk by chunk, a broken upstream ends the response like a dropped
   * connection, and (when `align` is set) junk before the first MPEG-TS packet is cut off.
   */
  private async stream(body: ReadableStream<Uint8Array>, align: boolean, headers: Headers): Promise<ReadableStream<Uint8Array>> {
    const reader = body.getReader();
    let head: Uint8Array | null = null;
    let ended = false;
    let broken = false;
    if (align) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (size < TS_ALIGN_LOOKAHEAD) {
          const { done, value } = await reader.read();
          if (done) {
            ended = true;
            break;
          }
          chunks.push(value);
          size += value.byteLength;
        }
      } catch {
        broken = true;
      }
      const buffered = Buffer.concat(chunks);
      const offset = tsSyncOffset(buffered);
      head = buffered.subarray(offset);
      if (offset > 0) {
        const length = Number(headers.get("content-length"));
        if (Number.isFinite(length) && length > offset) headers.set("content-length", String(length - offset));
        else headers.delete("content-length");
        headers.set("content-type", "video/mp2t");
        this.log.debug("aligned TS segment", { trimmedBytes: offset });
      }
    }
    const log = this.log;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (head) {
          const chunk = head;
          head = null;
          if (chunk.byteLength > 0) {
            controller.enqueue(chunk);
            return;
          }
        }
        if (broken) {
          controller.error(prematureClose());
          return;
        }
        if (ended) {
          controller.close();
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (err) {
          log.debug("upstream stream broke", { error: errorName(err) });
          controller.error(prematureClose());
        }
      },
      cancel(reason) {
        return reader.cancel(reason).catch(() => {});
      },
    });
  }
}
