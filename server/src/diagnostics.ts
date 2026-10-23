// The admin's catalog checks, one episode or channel at a time: every source through the TV's resolve path (without
// creating sessions), then along the TV's way to its media down to real media bytes. A proxied stream goes through the
// proxy in-process (egress policy, redirects, upstream headers and playlist rewriting as the TV gets them), a direct
// one straight to the upstream. Each source's last report is stored, and summaries are read from those rows. Reports
// hold hosts, statuses and codes only, never URLs, header values, refs or playlist text.
//
// A pass means the server reached real media along the TV's path just now. It does not prove that the TV decodes the
// codecs: those are listed, and the risky ones only warn.

import { createHash } from "node:crypto";
import { isLiveItem, type ResolveResult, type Source } from "@izle/contract";
import { newId } from "./auth.ts";
import { episodeIdOf, liveRef, playableOf, type CatalogService, type PlayableRef } from "./catalog.ts";
import { egressRefusal } from "./egress.ts";
import { HttpError } from "./errors.ts";
import { isPlaylistText, masterPlaylist, mediaPlaylist, rangeHeader, type Variant } from "./hls.ts";
import { requireItem, requirePlayableRef, requireSource, type PlayableId } from "./lookup.ts";
import { iso } from "./presenters.ts";
import { entryPath, linkHost, MAX_PLAYLIST_BYTES, REWRITE_LIMITS, subtitlePath, type ProxyProblem, type ProxyService, type ProxyTarget } from "./proxy.ts";
import { isMedia, sniffContainer, type Container } from "./sniff.ts";
import { checkScope, deliveryPlan, proxyKind, proxySessionFor, type DeliveryPlan, type ResolveService, type UpstreamStream } from "./resolve.ts";
import { stopwatch } from "./stopwatch.ts";
import type { SourceCheck, SourceCheckKey, Store } from "./store.ts";

/** Time for the deep check of one source, every request included. */
const SOURCE_BUDGET_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Variant and rendition playlists fetched from a master playlist; past this, the rest is reported as unchecked. */
const MAX_PLAYLISTS = 16;
/** What is read of a segment or an init section (the signature is in the first bytes; the rest is cancelled). */
const SEGMENT_READ = 256 * 1024;
const FILE_RANGE = "bytes=0-65535";
const FILE_READ = 64 * 1024;
/** What is read of an endless MPEG-TS stream before it is cancelled: this much, or what came this long after its start. */
const STREAM_READ = 64 * 1024;
const STREAM_SETTLE_MS = 2000;
const KEY_READ = 1024;
const SUBTITLE_READ = 64 * 1024;
const PROXY_ERROR_READ = 4096;
/** Codecs that not every TV decodes (HEVC, AV1, Dolby Digital (Plus), Dolby Vision). */
const RISKY_CODECS = new Set(["hvc1", "hev1", "av01", "ec-3", "ac-3", "dvh1", "dvhe"]);
/** The origin of the in-process requests to the proxy (they never reach a socket). */
const PROXY_ORIGIN = "http://proxy.invalid";

export type Verdict = "ok" | "warn" | "fail";
type StepWhat = "playlist" | "variant" | "rendition" | "segment" | "init" | "key" | "subtitle" | "file" | "manifest";
type StepError =
  | "timeout" | "network" | "http" | "not_a_playlist" | "too_large" | "not_media" | "bad_key" | "egress_denied"
  | "not_subtitles" | "not_mpd" | "aborted" | "budget" | "bad_uri";
type CheckWarning =
  | "risky_codec" | "high_resolution" | "sample_aes" | "no_range" | "subtitle_failed" | "manifest_only"
  | "playlists_unchecked";

/** Which variant, rendition or subtitle track a step belongs to. */
type StepAt = Pick<Step, "index" | "of">;

/** One request of a deep check. `host`: the upstream the TV's path reached (for a proxied stream, not the server). */
interface Step {
  what: StepWhat;
  /** The variant, rendition or subtitle track (a segment, init section or key: its variant's or rendition's, `of`). */
  index?: number;
  of?: "variant" | "rendition";
  host: string | null;
  ok: boolean;
  status?: number;
  ms: number;
  error?: StepError;
  bytes?: number;
  container?: Container;
}

export type SourceReport = Record<string, unknown> & { sourceId: string; verdict: Verdict };

/** A playable's check summary over the stored rows of its current sources; null when none has a matching row. */
export type CheckSummary = { verdict: Verdict; checkedAt: string; working: number; total: number; stale: boolean } | null;

/** The check was cancelled (the run, or the request that asked for it, went away): nothing of it is stored. */
export class CheckAborted extends Error {
  override name = "CheckAborted";
}

/** The deep check of a source stops here: cancelled, or out of time. */
class Halt extends Error {}

/** `POST /admin/diagnostics/resolve`: an episode by its id, or a channel by its item id. */
export type DiagnosticsInput = PlayableId & {
  sourceId?: string;
  preferredAudioLanguage?: string | null;
};

/** The verdict of a playable from its sources': the TV falls back through them, so one that works plays. */
export function playableVerdict(verdicts: readonly Verdict[]): Verdict {
  if (!verdicts.some((v) => v !== "fail")) return "fail";
  return verdicts.every((v) => v === "ok") ? "ok" : "warn";
}

/** The id a playable's checks are stored under: the episode's, or the channel's item id. */
export const playableIdOf = (ref: PlayableRef): string => episodeIdOf(ref) ?? ref.item.id;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Catalog objects never change once loaded (a reload makes new ones), so each source is hashed once. */
const fingerprints = new WeakMap<Source, string>();

/** sha256 of the source's canonical JSON: a changed source reads "not checked" until it is checked again. */
export function fingerprint(source: Source): string {
  let f = fingerprints.get(source);
  if (f === undefined) {
    f = createHash("sha256").update(canonicalJson(source)).digest("hex");
    fingerprints.set(source, f);
  }
  return f;
}

function summarize(r: ResolveResult | UpstreamStream, proxyAlways: boolean) {
  const plan = deliveryPlan(r, proxyAlways);
  return {
    kind: r.media.kind, inline: "playlist" in r.media, host: URL.parse("playlist" in r.media ? r.media.baseUrl : r.media.url)?.host || null,
    headerNames: Object.keys(r.headers ?? {}).sort(), delivery: !plan.servable ? "unsupported" : plan.proxyMain ? "proxy" : "direct",
    languages: r.languages ?? null, subtitleTracks: r.subtitleTracks?.length ?? 0, label: r.label ?? null, expiresAt: r.expiresAt ?? null,
  };
}

// --- what came back ------------------------------------------------------------------------------------------

/** A body that answered: its status and its first bytes (`truncated` when more came than were read). */
interface Got {
  status: number;
  bytes: Buffer;
  truncated: boolean;
  /** Where relative URIs in it resolve from: the final URL after redirects, or the proxy path asked. */
  link: string;
}

type Missed = { error: StepError; status?: number };
type Judged = Pick<Step, "ok" | "error" | "container" | "bytes">;

function judgePlaylist(got: Got): Judged {
  if (got.truncated) return { ok: false, error: "too_large" };
  return isPlaylistText(got.bytes.toString("utf8")) ? { ok: true, container: "m3u8" } : { ok: false, error: "not_a_playlist" };
}

/**
 * Media where media was expected, by the proxy's own rule (sniff.ts): an error page that answered 200 is the classic
 * dead link.
 */
function judgeMedia(got: Got): Judged {
  const container = sniffContainer(got.bytes);
  const bytes = got.bytes.length;
  if (!isMedia(got.bytes, container)) return { ok: false, error: "not_media", bytes, ...(container ? { container } : {}) };
  return { ok: true, bytes, ...(container ? { container } : {}) };
}

/** An AES-128 key is 16 bytes, nothing more or less. */
function judgeKey(got: Got): Judged {
  const ok = got.bytes.length === 16 && !got.truncated;
  return { ok, ...(ok ? {} : { error: "bad_key" as const }), bytes: got.bytes.length };
}

function judgeSubtitle(got: Got): Judged {
  const container = sniffContainer(got.bytes);
  const ok = container === "webvtt" || container === "srt" || container === "ttml";
  return { ok, ...(ok ? { container } : { error: "not_subtitles" as const }), bytes: got.bytes.length };
}

function judgeManifest(got: Got): Judged {
  if (got.truncated) return { ok: false, error: "too_large" };
  return sniffContainer(got.bytes) === "mpd" ? { ok: true, container: "mpd" } : { ok: false, error: "not_mpd" };
}

/**
 * Up to `limit` bytes of the body (the rest cancelled); rejects when `signal` aborts first. With `settleMs`, what came
 * that long after the first bytes is enough (an endless stream that trickles).
 */
async function readUpTo(res: Response, limit: number, signal: AbortSignal, settleMs?: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!res.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
  let size = 0;
  let settled: Promise<null> | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    for (;;) {
      const r = await Promise.race(settled ? [reader.read(), aborted, settled] : [reader.read(), aborted]);
      if (r === null) return { bytes: Buffer.concat(chunks), truncated: true };
      if (r.done) return { bytes: Buffer.concat(chunks), truncated: false };
      if (settleMs !== undefined && !settled) settled = new Promise((resolve) => (timer = setTimeout(resolve, settleMs, null)));
      chunks.push(r.value);
      size += r.value.byteLength;
      if (size > limit) return { bytes: Buffer.concat(chunks).subarray(0, limit), truncated: true };
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

/** The proxy's own error answers (see proxy.ts), as a step's error; any other is `http`. */
const PROXY_ERRORS: Record<string, StepError> = {
  upstream_timeout: "timeout", upstream_unreachable: "network", egress_denied: "egress_denied", not_a_playlist: "not_a_playlist",
  not_media: "not_media", playlist_too_large: "too_large", aborted: "aborted",
};

function proxyTarget(rest: string): ProxyTarget {
  if (rest === "index.m3u8") return { type: "index" };
  if (rest === "video.mp4") return { type: "video" };
  if (rest === "stream.ts") return { type: "stream" };
  if (rest.startsWith("sub/")) return { type: "sub", file: rest.slice(4) };
  return { type: "u", ref: rest.startsWith("u/") ? rest.slice(2) : "" };
}

// --- the TV's path -------------------------------------------------------------------------------------------

/**
 * How the TV reaches one resolved stream: links are proxy paths (`/p/<token>/…`, served in-process from a proxy
 * session of its own) for what the TV gets proxied, upstream URLs for what it fetches itself.
 */
class TvPath {
  private readonly deps: { proxy: ProxyService; fetch: typeof fetch };
  private readonly stream: UpstreamStream;
  private readonly plan: DeliveryPlan;
  private readonly problems: Map<string, ProxyProblem | null>;
  private readonly owner = checkScope(newId(12));
  private readonly token: string | null;
  private readonly base: string;
  /** The origins the catalog or the adapter named; the URLs an upstream playlist names go through the egress policy. */
  private readonly trusted: Set<string>;
  readonly entry: string;

  constructor(deps: TvPath["deps"], stream: UpstreamStream, plan: DeliveryPlan, problems: Map<string, ProxyProblem | null>) {
    this.deps = deps;
    this.stream = stream;
    this.plan = plan;
    this.problems = problems;
    const init = proxySessionFor(this.owner, stream, plan, {});
    this.token = init && deps.proxy.create(init);
    this.problems.set(this.owner, null);
    this.base = `/p/${this.token}/`;
    const m = stream.media;
    this.entry = plan.proxyMain ? entryPath(this.token!, proxyKind(m.kind)) : (m as { url: string }).url;
    const urls = [...("url" in m ? [m.url] : []), ...stream.subtitleTracks.map((t) => t.url)];
    this.trusted = new Set(urls.map((u) => URL.parse(u)?.origin).filter((o) => o !== undefined));
  }

  subtitle(index: number): string {
    const t = this.stream.subtitleTracks[index]!;
    return this.plan.proxySubtitles[index] ? subtitlePath(this.token!, index, t.format) : t.url;
  }

  /** How much of a playlist is read: a proxied one is the proxy's rewrite, which grows past what it reads upstream. */
  playlistLimit(link: string): number {
    return this.proxied(link) ? REWRITE_LIMITS.maxLength : MAX_PLAYLIST_BYTES;
  }

  private proxied(link: string): boolean {
    return this.token !== null && link.startsWith(this.base);
  }

  /** A URI as a playlist fetched from `from` writes it, as a link of this path; null when it cannot be fetched. */
  resolve(uri: string, from: string): string | null {
    if (this.proxied(from)) {
      const u = URL.parse(uri.trim(), `${PROXY_ORIGIN}${from}`);
      return u && u.origin === PROXY_ORIGIN && u.pathname.startsWith(this.base) ? u.pathname : null;
    }
    const u = URL.parse(uri.trim(), from);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return null;
    u.hash = "";
    return u.href;
  }

  host(link: string): string | null {
    if (!this.proxied(link)) return URL.parse(link)?.host || null;
    const rest = link.slice(this.base.length);
    if (rest.startsWith("u/")) return linkHost(rest.slice(2));
    const m = this.stream.media;
    const sub = /^sub\/(\d+)\./.exec(rest);
    const url = sub ? this.stream.subtitleTracks[Number(sub[1])]?.url : "playlist" in m ? m.baseUrl : m.url;
    return (url && URL.parse(url)?.host) || null;
  }

  async get(link: string, range: string | null, limit: number, signal: AbortSignal, settleMs?: number): Promise<Got | Missed> {
    const headers: Record<string, string> = range ? { Range: range } : {};
    let res: Response;
    let url = link;
    if (this.proxied(link)) {
      this.problems.set(this.owner, null);
      const req = new Request(`${PROXY_ORIGIN}${link}`, { headers, signal });
      res = await this.deps.proxy.serve(req, this.token!, proxyTarget(link.slice(this.base.length)));
      if (res.status >= 400) return this.proxyError(res, signal);
    } else if (this.trusted.has(URL.parse(link)?.origin ?? "")) {
      res = await this.deps.fetch(link, { headers, redirect: "follow", signal });
      url = res.url || link;
    } else {
      ({ response: res, url } = await this.deps.proxy.fetchVetted(link, headers, signal));
    }
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => {});
      return { error: "http", status: res.status };
    }
    return { status: res.status, ...(await readUpTo(res, limit, signal, settleMs)), link: url };
  }

  /** What the proxy answered instead, with the upstream status its problem report gave (a stale session's 403). */
  private async proxyError(res: Response, signal: AbortSignal): Promise<Missed> {
    let body: { error?: unknown; status?: unknown } = {};
    try {
      body = JSON.parse((await readUpTo(res, PROXY_ERROR_READ, signal)).bytes.toString("utf8"));
    } catch {
      // an upstream answer passed through (416)
    }
    const code = typeof body.error === "string" ? body.error : "";
    const error = PROXY_ERRORS[code] ?? "http";
    const said = this.problems.get(this.owner)?.httpStatus ?? (typeof body.status === "number" ? body.status : null);
    const status = said ?? (error !== "http" ? null : code === "upstream_not_found" ? 404 : res.status);
    return { error, ...(status !== null ? { status } : {}) };
  }

  close(): void {
    this.deps.proxy.dropDevice(this.owner);
    this.problems.delete(this.owner);
  }
}

// --- one source ----------------------------------------------------------------------------------------------

/** The steps of one source's deep check as they are made, and what they found. */
class DeepCheck {
  readonly steps: Step[] = [];
  readonly warnings = new Set<CheckWarning>();
  codecs: Array<Omit<Variant, "uri">> = [];
  failed = false;
  private readonly path: TvPath;
  private readonly signals: { outer: AbortSignal; budget: AbortSignal };

  constructor(path: TvPath, signals: { outer: AbortSignal; budget: AbortSignal }) {
    this.path = path;
    this.signals = signals;
  }

  private push(step: Step, optional: boolean): void {
    this.steps.push(step);
    if (step.ok) return;
    if (optional) this.warnings.add("subtitle_failed");
    else this.failed = true;
  }

  /** A step that could not even be asked (nothing to fetch). */
  missing(what: StepWhat, at: StepAt | undefined, error: StepError, optional = false): void {
    this.push({ what, ...at, host: null, ok: false, ms: 0, error }, optional);
  }

  /** The link of a URI a playlist names; null when there is nothing to fetch (`data:`) or it cannot be (`bad_uri`). */
  private link(what: StepWhat, at: StepAt | undefined, uri: string, from: string, optional = false): string | null {
    const link = this.path.resolve(uri, from);
    if (link === null && !/^data:/i.test(uri.trim())) this.missing(what, at, "bad_uri", optional);
    return link;
  }

  /** Fetches `link` as a step; `judge` says whether what came is what was expected. What came, or null if not. */
  async fetch(
    what: StepWhat,
    at: StepAt | undefined,
    link: string,
    o: { range?: string | null; limit: number; settleMs?: number; optional?: boolean },
    judge: (got: Got) => Judged,
  ): Promise<Got | null> {
    const ms = stopwatch();
    const { outer, budget } = this.signals;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([outer, budget, timeout]);
    let outcome: Got | Missed;
    try {
      outcome = await this.path.get(link, o.range ?? null, o.limit, signal, o.settleMs);
    } catch (err) {
      outcome = { error: egressRefusal(err) ? "egress_denied" : "network" };
    }
    if ("error" in outcome && signal.aborted) outcome = { error: outer.aborted ? "aborted" : budget.aborted ? "budget" : "timeout" };
    const judged: Judged = "error" in outcome ? { ok: false, error: outcome.error } : judge(outcome);
    const status = "error" in outcome ? outcome.status : outcome.status;
    this.push({
      what, ...at, host: this.path.host(link), ok: judged.ok, ...(status !== undefined ? { status } : {}), ms: ms(),
      ...(judged.error ? { error: judged.error } : {}), ...(judged.bytes !== undefined ? { bytes: judged.bytes } : {}),
      ...(judged.container ? { container: judged.container } : {}),
    }, o.optional ?? false);
    if (outer.aborted || budget.aborted) throw new Halt();
    return judged.ok && !("error" in outcome) ? outcome : null;
  }

  async run(stream: UpstreamStream): Promise<void> {
    const { path } = this;
    switch (stream.media.kind) {
      case "hls":
        await this.hls();
        break;
      case "dash":
        this.warnings.add("manifest_only");
        await this.fetch("manifest", undefined, path.entry, { limit: MAX_PLAYLIST_BYTES }, judgeManifest);
        break;
      case "mp4": {
        const got = await this.fetch("file", undefined, path.entry, { range: FILE_RANGE, limit: FILE_READ }, judgeMedia);
        if (got?.status === 200) this.warnings.add("no_range");
        break;
      }
      case "ts":
        await this.fetch("file", undefined, path.entry, { limit: STREAM_READ, settleMs: STREAM_SETTLE_MS }, judgeMedia);
        break;
    }
    for (let i = 0; i < stream.subtitleTracks.length; i++) {
      await this.fetch("subtitle", { index: i }, path.subtitle(i), { limit: SUBTITLE_READ, optional: true }, judgeSubtitle);
    }
  }

  /** The playlist, every variant and rendition playlist, and the media of the first variant and each audio rendition. */
  private async hls(): Promise<void> {
    const main = await this.fetch("playlist", undefined, this.path.entry, { limit: this.path.playlistLimit(this.path.entry) }, judgePlaylist);
    if (!main) return;
    const { variants, renditions } = masterPlaylist(main.bytes.toString("utf8"));
    if (variants.length === 0 && renditions.length === 0) return this.media(main, undefined);
    this.codecs = variants.map(cleanVariant);
    for (const v of this.codecs) {
      if ((v.codecs ?? "").split(",").some((c) => RISKY_CODECS.has(c.trim().split(".")[0]!.toLowerCase()))) this.warnings.add("risky_codec");
      const [w = 0, h = 0] = (v.resolution ?? "").split("x").map(Number);
      if (w > 1920 || h > 1080) this.warnings.add("high_resolution");
    }
    const lists = [
      ...variants.map((v, index) => ({ what: "variant" as const, index, uri: v.uri, type: null })),
      ...renditions.map((r, index) => ({ what: "rendition" as const, index, uri: r.uri, type: r.type })),
    ];
    if (lists.length > MAX_PLAYLISTS) this.warnings.add("playlists_unchecked");
    const loaded: Array<(typeof lists)[number] & { got: Got }> = [];
    for (const l of lists.slice(0, MAX_PLAYLISTS)) {
      // A subtitle rendition that fails is a warning: the picture and the sound play without it.
      const optional = l.type === "SUBTITLES";
      const link = this.link(l.what, { index: l.index }, l.uri, main.link, optional);
      if (link === null) continue;
      const got = await this.fetch(l.what, { index: l.index }, link, { limit: this.path.playlistLimit(link), optional }, judgePlaylist);
      if (got) loaded.push({ ...l, got });
    }
    const first = loaded.find((l) => l.what === "variant");
    for (const l of [...(first ? [first] : []), ...loaded.filter((l) => l.type === "AUDIO")]) await this.media(l.got, { index: l.index, of: l.what });
  }

  /** The first segment of a media playlist (a live one's last: the one a TV starts with), its init section and key. */
  private async media(playlist: Got, at: StepAt | undefined): Promise<void> {
    const { segments, endList } = mediaPlaylist(playlist.bytes.toString("utf8"));
    const segment = endList ? segments[0] : segments.at(-1);
    if (!segment) return this.missing("segment", at, "not_media");
    const from = playlist.link;
    const range = (r: { offset: number; length: number } | null) => (r ? rangeHeader(r) : null);
    const map = segment.map && this.link("init", at, segment.map.uri, from);
    if (map) await this.fetch("init", at, map, { range: range(segment.map!.range), limit: SEGMENT_READ }, judgeMedia);
    if (segment.key?.method === "AES-128") {
      const key = segment.key.uri === null ? null : this.link("key", at, segment.key.uri, from);
      if (segment.key.uri === null) this.missing("key", at, "bad_key");
      else if (key) await this.fetch("key", at, key, { limit: KEY_READ }, judgeKey);
    } else if (segment.key) this.warnings.add("sample_aes");
    const link = this.link("segment", at, segment.uri, from);
    if (link) await this.fetch("segment", at, link, { range: range(segment.range), limit: SEGMENT_READ }, judgeMedia);
  }
}

/** A variant's attributes as reported: values that are not plain codec lists, sizes or numbers are left out. */
function cleanVariant(v: Variant): Omit<Variant, "uri"> {
  return {
    codecs: v.codecs !== null && /^[A-Za-z0-9.,\s+-]{1,200}$/.test(v.codecs) ? v.codecs.replace(/\s+/g, "") : null,
    resolution: v.resolution !== null && /^\d{1,5}x\d{1,5}$/.test(v.resolution) ? v.resolution : null,
    bandwidth: v.bandwidth,
  };
}

// --- the checker ---------------------------------------------------------------------------------------------

interface CheckerDeps {
  catalog: CatalogService;
  resolver: ResolveService;
  proxy: ProxyService;
  store: Store;
  fetch: typeof fetch;
  now: () => number;
}

export interface PlayableCheck {
  ref: PlayableRef;
  verdict: Verdict;
  checkedAt: number;
  sources: SourceReport[];
}

type StoredRow = Omit<SourceCheck, "report">;

export class SourceChecker {
  private readonly o: CheckerDeps;
  /** The last problem the proxy reported for each running check's session (cleared before each request). */
  private readonly problems = new Map<string, ProxyProblem | null>();

  constructor(deps: CheckerDeps) {
    this.o = deps;
  }

  /** The proxy's problem hook: a check's own session's problems tell the upstream status behind a proxy error. */
  proxyProblem(p: ProxyProblem): void {
    if (this.problems.has(p.owner)) this.problems.set(p.owner, p);
  }

  private async checkSource(ref: PlayableRef, source: Source, preferredAudioLanguage: string | null, outer: AbortSignal): Promise<SourceReport> {
    const { resolver } = this.o;
    const { proxyAlways, deadlineMs } = resolver;
    const a = await resolver.attempt(ref, source, { preferredAudioLanguage, deadlineMs, signal: outer });
    if (outer.aborted) throw new CheckAborted();
    const head = {
      sourceId: source.id, type: source.type, ok: a.ok, ms: a.ms, ...(source.type === "adapter" ? { adapterId: source.adapter } : {}),
      // Everything the adapter returned, in its order.
      ...(a.results ? { results: a.results.map((r) => summarize(r, proxyAlways)) } : {}),
    };
    if (!a.ok) {
      const { code, name } = a.tried;
      return { ...head, code, ...(name ? { name } : {}), verdict: "fail", steps: [], codecs: [], warnings: [], checkMs: 0 };
    }
    const checkMs = stopwatch();
    const path = new TvPath(this.o, a.stream, deliveryPlan(a.stream, proxyAlways), this.problems);
    const deep = new DeepCheck(path, { outer, budget: AbortSignal.timeout(SOURCE_BUDGET_MS) });
    try {
      await deep.run(a.stream);
    } catch (err) {
      if (!(err instanceof Halt)) throw err;
    } finally {
      path.close();
    }
    if (outer.aborted) throw new CheckAborted();
    const verdict: Verdict = deep.failed ? "fail" : deep.warnings.size > 0 ? "warn" : "ok";
    return { ...head, stream: summarize(a.stream, proxyAlways), verdict, steps: deep.steps, codecs: deep.codecs, warnings: [...deep.warnings], checkMs: checkMs() };
  }

  /**
   * Checks the playable's sources (or `sourceIds` of them), one after the other in bundle order, and stores each
   * report. Throws CheckAborted (nothing stored) when `signal` aborts.
   */
  async check(ref: PlayableRef, opts: { preferredAudioLanguage: string | null; sources?: Source[]; signal?: AbortSignal | undefined }): Promise<PlayableCheck> {
    const outer = opts.signal ?? new AbortController().signal;
    const sources = opts.sources ?? playableOf(ref).sources;
    const reports: SourceReport[] = [];
    for (const source of sources) reports.push(await this.checkSource(ref, source, opts.preferredAudioLanguage, outer));
    const checkedAt = this.o.now();
    const { catalogId } = this.o.catalog;
    this.o.store.putSourceChecks(reports.map((report, i) => ({
      catalogId, itemId: ref.item.id, playableId: playableIdOf(ref), sourceId: report.sourceId, fingerprint: fingerprint(sources[i]!),
      checkedAt, verdict: report.verdict, report,
    })));
    return { ref, verdict: playableVerdict(reports.map((r) => r.verdict)), checkedAt, sources: reports };
  }

  /** `POST /admin/diagnostics/resolve`. */
  async diagnose(input: DiagnosticsInput, signal?: AbortSignal) {
    const ref = requirePlayableRef(this.o.catalog, input, 404);
    const playable = playableOf(ref);
    const sources = input.sourceId === undefined ? undefined : [requireSource(playable, input.sourceId, 404, "unknown_source")];
    let r: PlayableCheck;
    try {
      r = await this.check(ref, { preferredAudioLanguage: input.preferredAudioLanguage ?? null, ...(sources ? { sources } : {}), signal });
    } catch (err) {
      if (err instanceof CheckAborted) throw new HttpError(503, "aborted");
      throw err;
    }
    return { itemId: ref.item.id, episodeId: episodeIdOf(ref), playbackAllowed: playable.playbackAllowed, verdict: r.verdict, checkedAt: iso(r.checkedAt), sources: r.sources };
  }

  /** The check summaries of every playable of these items, from one query. */
  summaries(itemIds: readonly string[]): (ref: PlayableRef) => CheckSummary {
    const rows = new Map<string, StoredRow[]>();
    for (const r of this.o.store.listSourceChecks(this.o.catalog.catalogId, itemIds)) {
      const key = `${r.itemId}\u0000${r.playableId}`;
      rows.set(key, [...(rows.get(key) ?? []), r]);
    }
    return (ref) => summaryOf(playableOf(ref).sources, rows.get(`${ref.item.id}\u0000${playableIdOf(ref)}`) ?? []);
  }

  /**
   * `GET /admin/checks/playables/:playableId?itemId=`: an episode by its id, else a channel by its item id; with
   * `itemId`, that item's (an episode id may equal a channel's id).
   */
  stored(playableId: string, itemId?: string) {
    const { catalog, store } = this.o;
    const ref = itemId === undefined ? catalog.episode(playableId) ?? requirePlayableRef(catalog, { itemId: playableId }, 404) : playableOfItem(catalog, itemId, playableId);
    const sources = playableOf(ref).sources;
    const rows = store.getSourceChecks(catalog.catalogId, ref.item.id, playableIdOf(ref));
    return {
      itemId: ref.item.id, episodeId: episodeIdOf(ref), check: summaryOf(sources, rows),
      sources: sources.flatMap((s) => {
        const row = rows.find((r) => r.sourceId === s.id);
        return row ? [{ ...row.report, checkedAt: iso(row.checkedAt), stale: row.fingerprint !== fingerprint(s) }] : [];
      }),
    };
  }

  /** Forgets the checks of sources the loaded catalog no longer has (housekeeping). */
  purge(): void {
    const { catalog, store } = this.o;
    const present = (k: SourceCheckKey) => {
      const item = k.catalogId === catalog.catalogId ? catalog.item(k.itemId) : undefined;
      const playable = !item ? undefined : isLiveItem(item) ? (item.id === k.playableId ? item : undefined) : item.episodes.find((e) => e.id === k.playableId);
      return playable?.sources.some((s) => s.id === k.sourceId) ?? false;
    };
    const gone = store.sourceCheckKeys().filter((k) => !present(k));
    if (gone.length > 0) store.deleteSourceChecks(gone);
  }
}

/** The channel `itemId` itself (`playableId` its id), or its episode `playableId`; 404 otherwise. */
function playableOfItem(catalog: CatalogService, itemId: string, playableId: string): PlayableRef {
  const item = requireItem(catalog, itemId, 404, "unknown_item");
  if (isLiveItem(item)) {
    if (item.id !== playableId) throw new HttpError(404, "unknown_episode");
    return liveRef(item);
  }
  const ref = catalog.episode(playableId);
  if (!ref || ref.item.id !== item.id) throw new HttpError(404, "unknown_episode");
  return ref;
}

function summaryOf(sources: readonly Source[], rows: readonly StoredRow[]): CheckSummary {
  const current = sources.flatMap((s) => rows.filter((r) => r.sourceId === s.id && r.fingerprint === fingerprint(s)));
  if (current.length === 0) return null;
  return {
    verdict: playableVerdict(current.map((r) => r.verdict)), checkedAt: iso(Math.min(...current.map((r) => r.checkedAt)))!,
    working: current.filter((r) => r.verdict !== "fail").length, total: sources.length, stale: current.length < sources.length,
  };
}
