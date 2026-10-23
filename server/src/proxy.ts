// The media proxy: serves header-bound and inline-playlist streams so upstream request headers never leave the
// server. `/p/<token>/index.m3u8` (or `video.mp4`, `stream.ts`) is the entry, every URI in a playlist is rewritten to
// `/p/<token>/u/<signed ref>`, subtitles are `/p/<token>/sub/<n>.<ext>`. A playlist is fetched anew on every request
// (a live one slides on); MP4 and MPEG-TS bodies stream through. Sessions live in memory: after a restart they
// answer 410 and the TV re-resolves.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { newToken } from "./auth.ts";
import { egressFetch, egressPolicy, egressRefusal, type EgressPolicy, type UpstreamFetch } from "./egress.ts";
import { isPlaylistText, PlaylistTooLarge, rewritePlaylist, tsSyncOffset, TS_ALIGN_LOOKAHEAD, type LinkKind, type RewriteLimits } from "./hls.ts";
import { errorName } from "./errors.ts";
import type { Logger } from "./log.ts";
import { isMedia, sniffContainer, type Container } from "./sniff.ts";

const MAX_SESSIONS_PER_DEVICE = 2;
/** Absolute session lifetime, whatever the sliding TTL. */
const SESSION_MAX_AGE_MS = 12 * 60 * 60_000;
export const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
/** Every rewritten link embeds its URL: without a bound, a long base URL would blow up a playlist of short lines. */
export const REWRITE_LIMITS: RewriteLimits = { maxLines: 250_000, maxLength: 4 * MAX_PLAYLIST_BYTES, maxUrlLength: 4096 };
/** Time for an upstream to answer with headers; the body then streams for as long as the TV reads. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
/** Request headers that carry a credential: sent only to the origin they were given for. */
const CREDENTIAL_HEADER = /authorization|cookie|token|secret|passw|api-?key|session/i;

export const PROXY_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const PLAYLIST_TYPE = "application/vnd.apple.mpegurl";
const SUBTITLE_TYPES: Record<string, string> = { vtt: "text/vtt; charset=utf-8", srt: "application/x-subrip; charset=utf-8", ttml: "application/ttml+xml" };
/** Response headers passed to the TV; everything else (cookies, redirects, CORS) is dropped. */
const PASSED_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];
/** Subtitle containers: a segment of an HLS subtitle rendition labelled as a playlist streams through like media. */
const SUBTITLE_CONTAINERS = new Set<Container>(["webvtt", "srt", "ttml"]);
const NOT_TS_EXTENSIONS = new Set(["m4s", "mp4", "m4a", "m4v", "cmfv", "cmfa", "aac", "mp3", "ac3", "ec3", "vtt", "webvtt", "key"]);
/** What is read of a body labelled as a playlist where a segment was linked, to tell a playlist from media. */
const SNIFF_BYTES = TS_ALIGN_LOOKAHEAD;
/** The type a segment labelled as a playlist is passed on with (none when its container has no sure one). */
const MEDIA_TYPES: Partial<Record<Container, string>> = {
  ts: "video/mp2t", mp4: "video/mp4", fmp4: "video/mp4", aac: "audio/aac",
  webvtt: SUBTITLE_TYPES.vtt, srt: SUBTITLE_TYPES.srt, ttml: SUBTITLE_TYPES.ttml,
};

export type ProxyMainKind = "hls" | "mp4" | "ts";

export interface ProxySessionInit {
  deviceId: string;
  itemId?: string | null;
  episodeId?: string | null;
  sourceId?: string | null;
  main: { kind: ProxyMainKind; url: string; playlist?: undefined } | { kind: "hls"; playlist: string; baseUrl: string } | null;
  headers: Record<string, string>;
  subtitles: Array<{ url: string; headers: Record<string, string> } | null>;
}

interface Session extends ProxySessionInit {
  token: string;
  key: Buffer;
  createdAt: number;
  lastUsedAt: number;
  stale: boolean;
}

export type ProxyTarget = { type: "index" } | { type: "video" } | { type: "stream" } | { type: "u"; ref: string } | { type: "sub"; file: string };

/**
 * `upstream_<status>` (the session went stale), `upstream_error` (5xx, or a body read here that broke off),
 * `upstream_unreachable` (network error or no answer in time), `egress_denied` (a non-public address, see egress.ts),
 * `not_media` (a segment labelled as a playlist that is neither playlist nor media).
 */
export type ProxyProblemCode =
  `upstream_${401 | 403 | 410}` | "upstream_error" | "upstream_unreachable" | "not_a_playlist" | "not_media" | "playlist_too_large" | "egress_denied";

export interface ProxyProblem {
  owner: string;
  itemId: string | null;
  episodeId: string | null;
  sourceId: string | null;
  code: ProxyProblemCode;
  httpStatus: number | null;
  /** What was requested (`playlist`, `segment`, `video`, `stream`, `subtitles`) and, when unreachable, why. Never a URL. */
  detail: string;
}

interface ProxyOptions {
  log: Logger;
  now?: () => number;
  ttlMs: number;
  alignTsSegments?: boolean;
  privateUpstreams?: string[];
  fetch?: UpstreamFetch;
  onProblem?: (problem: ProxyProblem) => void;
}

const ENTRY_FILE: Record<ProxyMainKind, string> = { hls: "index.m3u8", mp4: "video.mp4", ts: "stream.ts" };

export const entryPath = (token: string, kind: ProxyMainKind): string => `/p/${token}/${ENTRY_FILE[kind]}`;

export const subtitlePath = (token: string, index: number, format: string): string => `/p/${token}/sub/${index}.${format}`;

/** The upstream host a rewritten link (`/p/<token>/u/<ref>`'s ref) points at, for the admin checks; null if none. */
export function linkHost(ref: string): string | null {
  const b64 = ref.split(".")[1];
  return b64 && /^[A-Za-z0-9_-]+$/.test(b64) ? (URL.parse(Buffer.from(b64, "base64url").toString("utf8"))?.host ?? null) : null;
}

const extensionOf = (url: string): string | null =>
  /\.([A-Za-z0-9]{1,5})$/.exec(URL.parse(url)?.pathname ?? "")?.[1]?.toLowerCase() ?? null;

function json(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error, ...extra }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

/** A stream error that @hono/node-server treats as a closed connection rather than a crash to print. */
const prematureClose = (): Error => Object.assign(new Error("upstream closed early"), { code: "ERR_STREAM_PREMATURE_CLOSE" });

/** An upstream body being read: what was read ahead of the rest (`head`), and how the body ended if it did. */
interface ReadAhead {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  head: Buffer;
  end: "done" | "broken" | null;
  /** Why it broke. */
  error?: unknown;
}

const readAhead = (body: ReadableStream<Uint8Array>): ReadAhead => ({ reader: body.getReader(), head: Buffer.alloc(0), end: null });

/** Reads on until `ahead.head` holds `size` bytes or the body ends; a body that breaks ends `broken`. */
async function fill(ahead: ReadAhead, size: number): Promise<void> {
  const chunks: Uint8Array[] = [ahead.head];
  let length = ahead.head.byteLength;
  try {
    while (length < size && !ahead.end) {
      const { done, value } = await ahead.reader.read();
      if (done) ahead.end = "done";
      else {
        chunks.push(value);
        length += value.byteLength;
      }
    }
  } catch (err) {
    ahead.end = "broken";
    ahead.error = err;
  }
  ahead.head = Buffer.concat(chunks);
}

/** The body again, what was read ahead first, chunk by chunk; a broken upstream ends it like a dropped connection. */
function rest(ahead: ReadAhead, log: Logger): ReadableStream<Uint8Array> {
  let head: Buffer | null = ahead.head;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = head;
      head = null;
      if (chunk?.byteLength) return controller.enqueue(chunk);
      if (ahead.end === "broken") {
        log.debug("upstream stream broke", { error: errorName(ahead.error) });
        return controller.error(prematureClose());
      }
      if (ahead.end === "done") return controller.close();
      try {
        const { done, value } = await ahead.reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        log.debug("upstream stream broke", { error: errorName(err) });
        controller.error(prematureClose());
      }
    },
    cancel: (reason) => ahead.reader.cancel(reason).catch(() => {}),
  });
}

const cancel = (res: Response): Promise<void> => res.body?.cancel().catch(() => {}) ?? Promise.resolve();

/** A body's media type as a problem report may name it (never anything else the upstream wrote there). */
function mediaType(headers: Headers): string {
  const type = (headers.get("content-type") ?? "").split(";")[0]!.trim();
  return /^[\w.+-]{1,40}\/[\w.+-]{1,60}$/.test(type) ? type : "unknown content type";
}

/** The network error code (`ECONNREFUSED`, the error's own or its cause's) or the class name, never the message. */
function networkReason(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(code) ? code : errorName(err);
}

/** The body as UTF-8 text; null (the rest cancelled) past `limit` bytes. */
export async function readText(res: Response, limit: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    size += r.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class ProxyService {
  private readonly sessions = new Map<string, Session>();
  private readonly o: ProxyOptions;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly fetch: UpstreamFetch;
  private readonly policy: EgressPolicy;

  constructor(opts: ProxyOptions) {
    this.o = opts;
    this.log = opts.log.child({ component: "proxy" });
    this.now = opts.now ?? Date.now;
    this.policy = egressPolicy(opts.privateUpstreams);
    this.fetch = opts.fetch ?? egressFetch(this.policy);
  }

  private problem(s: Session, code: ProxyProblemCode, httpStatus: number | null, detail: string): void {
    try {
      const { deviceId: owner, itemId = null, episodeId = null, sourceId = null } = s;
      this.o.onProblem?.({ owner, itemId, episodeId, sourceId, code, httpStatus, detail });
    } catch (err) {
      this.log.warn("problem hook failed", { error: err });
    }
  }

  /** Creates a session and returns its token. An owner keeps at most two; older ones end (410). */
  create(init: ProxySessionInit): string {
    const t = this.now();
    for (const s of this.sessions.values()) if (this.expired(s, t)) this.sessions.delete(s.token);
    const mine = [...this.sessions.values()].filter((s) => s.deviceId === init.deviceId).sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= MAX_SESSIONS_PER_DEVICE) this.sessions.delete(mine.shift()!.token);
    const token = newToken();
    this.sessions.set(token, { ...init, token, key: randomBytes(32), createdAt: t, lastUsedAt: t, stale: false });
    return token;
  }

  dropDevice(deviceId: string): void {
    for (const s of this.sessions.values()) if (s.deviceId === deviceId) this.sessions.delete(s.token);
  }

  private expired(s: Session, t: number): boolean {
    return t - s.lastUsedAt > this.o.ttlMs || t - s.createdAt > SESSION_MAX_AGE_MS;
  }

  /** A link's signature: the first 16 bytes of the session key's HMAC of `<kind>.<base64url URL>`. */
  private mac(s: Session, kind: LinkKind, b64: string): Buffer {
    return createHmac("sha256", s.key).update(`${kind}.${b64}`).digest().subarray(0, 16);
  }

  private sign(s: Session, url: string, kind: LinkKind): string {
    const b64 = Buffer.from(url, "utf8").toString("base64url");
    const ext = extensionOf(url);
    return `${kind}.${b64}.${this.mac(s, kind, b64).toString("base64url")}${ext ? `.${ext}` : ""}`;
  }

  private verify(s: Session, ref: string): { url: string; kind: LinkKind } | null {
    const [kind, b64, mac] = ref.split(".");
    if ((kind !== "p" && kind !== "r") || !b64 || !mac || !/^[A-Za-z0-9_-]+$/.test(b64)) return null;
    const expected = this.mac(s, kind, b64);
    const given = Buffer.from(mac, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const url = Buffer.from(b64, "base64url").toString("utf8");
    return /^https?:\/\//.test(url) ? { url, kind } : null;
  }

  async serve(req: Request, token: string, target: ProxyTarget): Promise<Response> {
    const t = this.now();
    const s = this.sessions.get(token);
    if (!s || this.expired(s, t)) {
      if (s) this.sessions.delete(token);
      return json(410, "gone");
    }
    if (s.stale) return json(410, "stale");
    s.lastUsedAt = t;

    // The session's credential-type headers go to the origin of the URL the catalog or adapter gave, nowhere else.
    const origin = s.main && (URL.parse(s.main.playlist !== undefined ? s.main.baseUrl : s.main.url)?.origin ?? null);
    switch (target.type) {
      case "index":
        if (s.main?.kind !== "hls") break;
        if (s.main.playlist !== undefined) return this.playlistResponse(s, s.main.playlist, s.main.baseUrl, "u/", null, "playlist");
        return this.forward(req, s, s.main.url, s.headers, { kind: "p", prefix: "u/", what: "playlist", origin });
      case "video":
      case "stream":
        if (s.main?.kind !== (target.type === "video" ? "mp4" : "ts")) break;
        return this.forward(req, s, s.main.url, s.headers, { kind: "r", prefix: null, what: target.type, origin });
      case "u": {
        const link = this.verify(s, target.ref);
        if (!link) break;
        return this.forward(req, s, link.url, s.headers, { kind: link.kind, prefix: "", what: link.kind === "p" ? "playlist" : "segment", origin });
      }
      case "sub": {
        const m = /^(\d{1,2})\.(vtt|srt|ttml)$/.exec(target.file);
        const sub = m && s.subtitles[Number(m[1])];
        if (!sub) break;
        const opts = { kind: "r" as const, prefix: null, contentType: SUBTITLE_TYPES[m[2]!], what: "subtitles", origin: URL.parse(sub.url)?.origin ?? null };
        return this.forward(req, s, sub.url, sub.headers, opts);
      }
    }
    return json(404, "not_found");
  }

  private playlistResponse(s: Session, text: string, baseUrl: string, prefix: string, status: number | null, what: string): Response {
    let body: string;
    try {
      body = rewritePlaylist(text, baseUrl, (url, kind) => prefix + this.sign(s, url, kind), REWRITE_LIMITS);
    } catch (err) {
      if (!(err instanceof PlaylistTooLarge)) throw err;
      this.problem(s, "playlist_too_large", status, `${what}: ${err.message}`);
      return json(502, "playlist_too_large");
    }
    return new Response(body, { status: 200, headers: { "Content-Type": PLAYLIST_TYPE, "Cache-Control": "no-store" } });
  }

  /**
   * A GET of `url` without a session, as the proxy would make it: the egress policy vets the URL and each redirect
   * (at most MAX_REDIRECTS; past that, the redirect is the answer). The admin checks follow URLs that an upstream
   * playlist named with it. Rejects like fetch; `egressRefusal` tells a refused destination.
   */
  async fetchVetted(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ response: Response; url: string }> {
    for (let hops = 0; ; hops++) {
      const target = new URL(url);
      this.policy.check(target);
      const response = await this.fetch(target.href, { headers, redirect: "manual", signal });
      const location = REDIRECT_STATUS.has(response.status) ? response.headers.get("location") : null;
      const next = location === null ? null : URL.parse(location, target.href);
      if (next === null || hops >= MAX_REDIRECTS) return { response, url: target.href };
      await cancel(response);
      next.hash = "";
      url = next.href;
    }
  }

  /**
   * Fetches `url` with the upstream headers, following redirects here (each Location vetted by the egress policy).
   * Playlists (`kind` p, or a playlist content type) are rewritten; anything else streams through with `Range`. A
   * segment link whose body is labelled as a playlist but starts as media or subtitles (sniff.ts) streams through.
   * `prefix`: how rewritten URIs are written relative to the requested path (null: never a playlist). `what` names
   * the request in problem reports. Credential-type headers go to `origin` only.
   */
  private async forward(
    req: Request,
    s: Session,
    url: string,
    headers: Record<string, string>,
    opts: { kind: LinkKind; prefix: string | null; contentType?: string | undefined; what: string; origin: string | null },
  ): Promise<Response> {
    const range = opts.kind === "r" ? req.headers.get("range") : null;
    const extra = { ...(range ? { Range: range } : {}), ...(opts.kind === "r" ? { "Accept-Encoding": "identity" } : {}) };
    const foreign = Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADER.test(name)));
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), UPSTREAM_HEADERS_TIMEOUT_MS);
    const signal = AbortSignal.any([req.signal, timeout.signal]);
    let upstream: Response;
    try {
      for (let hops = 0; ; hops++) {
        const target = new URL(url);
        this.policy.check(target);
        const sent = target.origin === opts.origin ? headers : foreign;
        upstream = await this.fetch(target.href, { headers: { ...sent, ...extra }, redirect: "manual", signal });
        if (!REDIRECT_STATUS.has(upstream.status)) break;
        await cancel(upstream);
        const location = upstream.headers.get("location");
        const next = location === null ? null : URL.parse(location, target.href);
        if (next === null || hops >= MAX_REDIRECTS) {
          const reason = next === null ? "no_location" : "too_many";
          this.log.warn("upstream redirect not followed", { deviceId: s.deviceId, status: upstream.status, hops, reason });
          const why = next === null ? "redirect without a valid Location" : `more than ${MAX_REDIRECTS} redirects`;
          this.problem(s, "upstream_error", upstream.status, `${opts.what}: ${why}`);
          return json(502, "upstream_error", { status: upstream.status });
        }
        next.hash = "";
        url = next.href;
      }
    } catch (err) {
      if (req.signal.aborted) return json(503, "aborted");
      const refused = egressRefusal(err);
      if (refused) {
        // The URL came from upstream playlist text or a redirect; it is never logged (nor its address).
        this.log.warn("upstream destination refused", { deviceId: s.deviceId, reason: refused.reason });
        this.problem(s, "egress_denied", null, `${opts.what}: ${refused.reason.replaceAll("_", " ")}`);
        return json(502, "egress_denied");
      }
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
      await cancel(upstream);
      s.stale = true;
      this.log.warn("upstream refused the session; marked stale", { deviceId: s.deviceId, status });
      this.problem(s, `upstream_${status}`, status, opts.what);
      return json(410, "stale");
    }
    if (status >= 400 && status !== 416) {
      await cancel(upstream);
      this.log.warn("upstream error", { deviceId: s.deviceId, status });
      if (status >= 500) this.problem(s, "upstream_error", status, opts.what);
      return status === 404 ? json(404, "upstream_not_found") : json(502, "upstream_error", { status });
    }

    const labelled = /mpegurl/i.test(upstream.headers.get("content-type") ?? "");
    const ahead = upstream.body && readAhead(upstream.body);
    let mislabelled: { container: Container | null } | null = null;
    if (opts.prefix !== null && status === 200 && (opts.kind === "p" || labelled)) {
      if (opts.kind === "p" || !ahead) return this.upstreamPlaylist(req, s, upstream, ahead, url, opts.prefix, opts.what);
      // A playlist named under a segment-like URI is rewritten; some upstreams label a segment's media so too. The
      // read ahead gets the upstream's headers deadline again: a body that stalls must not hold the TV's request.
      const stall = setTimeout(() => timeout.abort(), UPSTREAM_HEADERS_TIMEOUT_MS);
      await fill(ahead, SNIFF_BYTES);
      clearTimeout(stall);
      if (ahead.end === "broken") return this.broke(req, s, status, opts.what, ahead.error, timeout.signal.aborted);
      if (isPlaylistText(ahead.head.subarray(0, 1024).toString("utf8"))) {
        return this.upstreamPlaylist(req, s, upstream, ahead, url, opts.prefix, opts.what);
      }
      const container = sniffContainer(ahead.head);
      if (!isMedia(ahead.head, container) && !(container && SUBTITLE_CONTAINERS.has(container))) {
        await ahead.reader.cancel().catch(() => {});
        this.problem(s, "not_media", status, `${opts.what}: ${mediaType(upstream.headers)}`);
        return json(502, "not_media");
      }
      mislabelled = { container };
      this.log.debug("media labelled as a playlist passed as media", { deviceId: s.deviceId, container: container ?? "unknown" });
    }

    const out = new Headers({ "Cache-Control": "no-store" });
    for (const name of PASSED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    if (upstream.headers.has("content-encoding")) out.delete("content-length"); // fetch already decoded the body
    if (opts.contentType) out.set("content-type", opts.contentType);
    if (mislabelled) {
      const type = mislabelled.container && MEDIA_TYPES[mislabelled.container];
      if (type) out.set("content-type", type);
      else out.delete("content-type");
    }
    if (!ahead) return new Response(null, { status, headers: out });
    const align = !!this.o.alignTsSegments && s.main?.kind === "hls" && opts.prefix === "" && status === 200 && range === null;
    const body = await this.stream(ahead, align && !NOT_TS_EXTENSIONS.has(extensionOf(url) ?? ""), out);
    return new Response(body, { status, headers: out });
  }

  /** `ahead`: the upstream's body, maybe partly read already (null: none). */
  private async upstreamPlaylist(
    req: Request,
    s: Session,
    upstream: Response,
    ahead: ReadAhead | null,
    url: string,
    prefix: string,
    what: string,
  ): Promise<Response> {
    const status = upstream.status;
    if (ahead) await fill(ahead, MAX_PLAYLIST_BYTES + 1);
    if (ahead?.end === "broken") return this.broke(req, s, status, what, ahead.error, false);
    if (ahead && ahead.head.byteLength > MAX_PLAYLIST_BYTES) {
      await ahead.reader.cancel().catch(() => {});
      this.problem(s, "playlist_too_large", status, `${what}: larger than ${MAX_PLAYLIST_BYTES / (1024 * 1024)} MiB`);
      return json(502, "playlist_too_large");
    }
    const text = ahead?.head.toString("utf8") ?? "";
    if (!isPlaylistText(text)) {
      // The media type says what came instead (an HTML page is a block or captcha page); its text is never kept.
      this.problem(s, "not_a_playlist", status, `${what}: ${mediaType(upstream.headers)}`);
      return json(502, "not_a_playlist");
    }
    // `url` is the playlist's own URL after redirects: relative URIs resolve against it.
    return this.playlistResponse(s, text, url, prefix, status, what);
  }

  /** An upstream body that broke off (or stalled, `timedOut`) while it was read here. */
  private broke(req: Request, s: Session, status: number, what: string, err: unknown, timedOut: boolean): Response {
    if (req.signal.aborted) return json(503, "aborted");
    this.log.warn("upstream body read failed", { deviceId: s.deviceId, code: timedOut ? "timeout" : "broken", error: errorName(err) });
    if (timedOut) {
      this.problem(s, "upstream_unreachable", null, `${what}: no body within ${Math.round(UPSTREAM_HEADERS_TIMEOUT_MS / 1000)} s`);
      return json(504, "upstream_timeout");
    }
    this.problem(s, "upstream_error", status, `${what}: broke off (${networkReason(err)})`);
    return json(502, "upstream_error");
  }

  /**
   * The upstream body streamed chunk by chunk; a broken upstream ends the response like a dropped connection. With
   * `align`, junk before the first MPEG-TS packet (within TS_ALIGN_LOOKAHEAD bytes) is cut off and `headers` get the
   * shorter length and the MPEG-TS content type.
   */
  private async stream(ahead: ReadAhead, align: boolean, headers: Headers): Promise<ReadableStream<Uint8Array>> {
    if (align) {
      await fill(ahead, TS_ALIGN_LOOKAHEAD);
      const offset = tsSyncOffset(ahead.head);
      if (offset > 0) {
        const length = Number(headers.get("content-length"));
        if (Number.isFinite(length) && length > offset) headers.set("content-length", String(length - offset));
        else headers.delete("content-length");
        headers.set("content-type", "video/mp2t");
        this.log.debug("aligned TS segment", { trimmedBytes: offset });
      }
      ahead.head = ahead.head.subarray(offset);
    }
    return rest(ahead, this.log);
  }
}
