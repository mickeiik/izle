import type { Adapter, Episode, LanguageFacts, MediaKind, ResolvedMedia, ResolveResult, Source, SubtitleTrack } from "@izle/contract";
import { newId } from "./auth.ts";
import type { CatalogService, EpisodeRef } from "./catalog.ts";
import { HttpError } from "./errors.ts";
import type { Logger } from "./log.ts";
import { requireEpisode, requirePlayable, requireSource } from "./lookup.ts";
import { orderSources } from "./playback.ts";
import { entryPath, subtitlePath, type ProxyService } from "./proxy.ts";
import { runAdapter, type AdapterFailureCode } from "./resolver.ts";

const FAILURE_PENALTY_MS = 10 * 60_000;
const PLAYBACK_SESSION_TTL_MS = 12 * 60 * 60_000;

export interface ResolveInput {
  episodeId: string;
  sourceId?: string;
  exclude?: string[];
}

/** Proxy-session owner key of a device's companion streams (separate from the TV's own two sessions). */
export const companionScope = (deviceId: string): string => `companion:${deviceId}`;
export const isCompanionScope = (owner: string): boolean => owner.startsWith("companion:");

interface PlaybackSession {
  id: string;
  deviceId: string;
  catalogId: string;
  itemId: string;
  episodeId: string;
  sourceId: string;
  createdAt: number;
}

/** What a source resolves to upstream, before the server decides how the TV gets it. */
export interface UpstreamStream {
  media: ResolvedMedia;
  headers: Record<string, string>;
  languages: LanguageFacts;
  subtitleTracks: Array<SubtitleTrack & { headers?: Record<string, string> }>;
  label: string | null;
  expiresAt: string | null;
}

export interface ResolvedStream {
  session: PlaybackSession;
  ref: EpisodeRef;
  source: Source;
  /** What the TV plays: the upstream URL, or a server-relative `/p/<token>/…` URL when proxied. */
  media: { kind: MediaKind; url: string };
  subtitleTracks: SubtitleTrack[];
  languages: LanguageFacts;
  /** Remaining candidate source ids, in the order the TV should try them next. */
  alternatives: string[];
  delivery: "direct" | "proxy";
  expiresAt: string | null;
  /** Candidates tried before this one that produced nothing (the server fell back past them). */
  failed: Tried[];
}

/**
 * Why a source produced nothing: `adapter_unavailable` (no resolver module provides its adapter), `unsupported`
 * (DASH that needs upstream headers), or the adapter's failure (`timeout`, `abort`, `error`, `empty`).
 */
export type TriedCode = "adapter_unavailable" | "unsupported" | AdapterFailureCode;

export interface Tried {
  sourceId: string;
  code: TriedCode;
  adapterId?: string;
  /** Error class name (never the message); `BudgetExhausted` when the request's time budget ran out first. */
  name?: string;
}

type Attempt =
  | { ok: true; stream: UpstreamStream; results: ResolveResult[] | null; ms: number }
  | { ok: false; tried: Tried; results: ResolveResult[] | null; ms: number };

interface ResolveServiceOptions {
  catalog: CatalogService;
  log: Logger;
  now?: () => number;
  proxy: ProxyService;
  /** Where resolve opens the playback sessions that progress and problem reports refer to. */
  sessions: PlaybackSessions;
  /** Adapters of the loaded resolver module; null when none is configured. */
  adapters: ReadonlyMap<string, Adapter> | null;
  /** `proxy.always`: send every HLS/MP4 stream through the proxy. */
  proxyAlways: boolean;
  /** Time for one adapter call. */
  deadlineMs: number;
  /** Time for all adapter calls of one resolve request. */
  budgetMs: number;
}

/** Whether a set of upstream request headers is present and not empty. */
export const hasHeaders = (h: Record<string, string> | undefined): h is Record<string, string> =>
  h !== undefined && Object.keys(h).length > 0;

/** DASH manifests are not rewritten by the proxy (v1), so DASH that needs upstream headers cannot be served. */
const servable = (media: ResolvedMedia, headers: Record<string, string> | undefined): boolean =>
  !(media.kind === "dash" && hasHeaders(headers));

/**
 * How a stream reaches the client, shared by resolve and the admin diagnostics so both always agree. The main
 * media goes through the proxy when it is an inline playlist, needs headers, or is HLS/MP4 under `proxyAlways`;
 * each subtitle track when it needs headers or under `proxyAlways`.
 */
export function deliveryPlan(
  s: {
    media: ResolvedMedia;
    headers?: Record<string, string> | undefined;
    subtitleTracks?: ReadonlyArray<{ headers?: Record<string, string> | undefined }> | undefined;
  },
  proxyAlways: boolean,
): { servable: boolean; proxyMain: boolean; proxySubtitles: boolean[] } {
  return {
    servable: servable(s.media, s.headers),
    proxyMain: "playlist" in s.media || (s.media.kind !== "dash" && (hasHeaders(s.headers) || proxyAlways)),
    proxySubtitles: (s.subtitleTracks ?? []).map((t) => hasHeaders(t.headers) || proxyAlways),
  };
}

/** The playback sessions resolve hands out, in memory; progress and problem reports name them. */
export class PlaybackSessions {
  private readonly sessions = new Map<string, PlaybackSession>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Opens a session (pruning expired ones once there are many). */
  open(s: Omit<PlaybackSession, "id" | "createdAt">): PlaybackSession {
    const t = this.now();
    if (this.sessions.size >= 1000) {
      for (const [id, old] of this.sessions) if (t - old.createdAt > PLAYBACK_SESSION_TTL_MS) this.sessions.delete(id);
    }
    const session: PlaybackSession = { id: newId(16), ...s, createdAt: t };
    this.sessions.set(session.id, session);
    return session;
  }

  /** A session by id, until it is older than PLAYBACK_SESSION_TTL_MS. */
  get(id: string): PlaybackSession | undefined {
    const s = this.sessions.get(id);
    if (s && this.now() - s.createdAt > PLAYBACK_SESSION_TTL_MS) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  /**
   * The session `id` names, if it belongs to the device and, when `episodeId` is given, plays that episode: a
   * report names only its TV's own sessions.
   */
  owned(id: string | null | undefined, deviceId: string, episodeId?: string): PlaybackSession | undefined {
    const s = id ? this.get(id) : undefined;
    return s && s.deviceId === deviceId && (episodeId === undefined || s.episodeId === episodeId) ? s : undefined;
  }
}

/**
 * Picks the source to play for an episode and decides how the TV gets it. Direct sources without upstream headers
 * go to the TV as they are; adapter sources are resolved by the owner's resolver module under deadlines; anything
 * that needs upstream headers or comes as an inline playlist is served through the proxy.
 */
export class ResolveService {
  private readonly failures = new Map<string, number>();
  private readonly o: ResolveServiceOptions;
  private readonly catalog: CatalogService;
  private readonly now: () => number;
  /** Time for one adapter call. */
  readonly deadlineMs: number;
  readonly proxyAlways: boolean;

  constructor(opts: ResolveServiceOptions) {
    this.o = opts;
    this.catalog = opts.catalog;
    this.now = opts.now ?? Date.now;
    this.deadlineMs = opts.deadlineMs;
    this.proxyAlways = opts.proxyAlways;
  }

  private failureKey(episodeId: string, sourceId: string): string {
    return `${this.catalog.catalogId}\u0000${episodeId}\u0000${sourceId}`;
  }

  /** Records that a source could not be played (the TV excluded it, or its adapter failed). */
  private markFailed(episodeId: string, sourceId: string): void {
    this.failures.set(this.failureKey(episodeId, sourceId), this.now());
  }

  /** Whether a source can be tried at all (known before resolving it). */
  private staticCheck(source: Source): Tried | null {
    if (source.type === "adapter") {
      return this.o.adapters?.has(source.adapter) ? null : { sourceId: source.id, code: "adapter_unavailable", adapterId: source.adapter };
    }
    return servable(source.media, source.media.headers) ? null : { sourceId: source.id, code: "unsupported" };
  }

  /**
   * Resolves one source to its upstream stream without delivering it (no proxy session, no playback session).
   * Used by resolve and by the admin diagnostics.
   */
  async attempt(
    ref: EpisodeRef,
    source: Source,
    opts: { preferredAudioLanguage: string | null; deadlineMs: number; signal?: AbortSignal | undefined },
  ): Promise<Attempt> {
    const unavailable = this.staticCheck(source);
    if (unavailable) return { ok: false, tried: unavailable, results: null, ms: 0 };
    // A source's stream from what resolved it (its own media, or an adapter's result), the source filling gaps.
    const stream = (r: ResolveResult): UpstreamStream => ({
      media: r.media, headers: r.headers ?? {}, languages: r.languages ?? source.languages,
      subtitleTracks: r.subtitleTracks ?? source.subtitleTracks ?? [], label: r.label ?? source.label ?? null, expiresAt: r.expiresAt ?? null,
    });
    if (source.type === "direct") {
      const { kind, url, headers } = source.media;
      return { ok: true, results: null, ms: 0, stream: stream({ media: { kind, url }, headers }) };
    }
    const adapter = this.o.adapters!.get(source.adapter)!;
    const req = { catalogId: this.catalog.catalogId, itemId: ref.item.id, episodeId: ref.episode.id, sourceId: source.id, ref: source.ref };
    const outcome = await runAdapter(
      adapter,
      { ...req, preferredAudioLanguage: opts.preferredAudioLanguage },
      { deadlineMs: opts.deadlineMs, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    if (!outcome.ok) {
      const tried: Tried = { sourceId: source.id, code: outcome.code, adapterId: adapter.id };
      if (outcome.name) tried.name = outcome.name;
      return { ok: false, tried, results: null, ms: outcome.ms };
    }
    const { results, ms } = outcome;
    // Results come in the adapter's preference order; the first one the server can serve wins.
    const result = results.find((r) => servable(r.media, r.headers));
    if (!result) return { ok: false, tried: { sourceId: source.id, code: "unsupported", adapterId: adapter.id }, results, ms };
    return { ok: true, results, ms, stream: stream(result) };
  }

  /**
   * Turns an upstream stream into what the client gets, creating a proxy session (owned by `owner`, labelled with
   * the episode and source for problem reports) when needed.
   */
  private deliver(
    owner: string,
    s: UpstreamStream,
    proxyAlways: boolean,
    playing: { episodeId: string; sourceId: string },
  ): Pick<ResolvedStream, "media" | "subtitleTracks" | "delivery"> {
    const { proxyMain, proxySubtitles } = deliveryPlan(s, proxyAlways);
    const m = s.media;
    let token: string | null = null;
    if (proxyMain || proxySubtitles.some(Boolean)) {
      token = this.o.proxy.create({
        deviceId: owner,
        ...playing,
        main: !proxyMain
          ? null
          : "playlist" in m
            ? { kind: "hls", playlist: m.playlist, baseUrl: m.baseUrl }
            : { kind: m.kind === "mp4" ? "mp4" : "hls", url: m.url },
        headers: s.headers,
        subtitles: s.subtitleTracks.map((t, i) => (proxySubtitles[i] ? { url: t.url, headers: t.headers ?? {} } : null)),
      });
    }
    const url = proxyMain ? entryPath(token!, m.kind === "mp4" ? "mp4" : "hls") : (m as { url: string }).url;
    return {
      media: { kind: m.kind, url },
      subtitleTracks: s.subtitleTracks.map((t, i) => ({
        url: proxySubtitles[i] ? subtitlePath(token!, i, t.format) : t.url, language: t.language, format: t.format,
        ...(t.label !== undefined ? { label: t.label } : {}),
      })),
      delivery: proxyMain ? "proxy" : "direct",
    };
  }

  /**
   * Tries the episode's candidate sources in order within the request's time budget and delivers the first one
   * that resolves, with a new playback session. None does: 502 `no_playable_source` with what was tried.
   *
   * `companion`: the owner's phone resolving a second source of the episode the TV plays ("Listen along"). Its
   * proxy sessions live under their own owner key, the stream is always proxied (the admin page only loads
   * same-origin media), DASH is refused, and failures do not reorder the TV's fallback.
   */
  async resolve(
    deviceId: string,
    preferredAudioLanguage: string | null,
    input: ResolveInput,
    signal?: AbortSignal,
    opts: { scope?: "tv" | "companion" } = {},
  ): Promise<ResolvedStream> {
    const ref = requireEpisode(this.catalog, input.episodeId, 404, "unknown_episode");
    const { episode } = ref;
    requirePlayable(episode, 403, "not_allowed");
    const companion = opts.scope === "companion";
    const candidates = this.candidatesFor(episode, input, preferredAudioLanguage, companion);
    const owner = companion ? companionScope(deviceId) : deviceId;
    const budgetEnd = performance.now() + this.o.budgetMs;
    const tried: Tried[] = [];
    for (const [i, source] of candidates.entries()) {
      const remaining = Math.floor(budgetEnd - performance.now());
      if (source.type === "adapter" && remaining < 50 && this.staticCheck(source) === null) {
        tried.push({ sourceId: source.id, code: "timeout", adapterId: source.adapter, name: "BudgetExhausted" });
        continue;
      }
      const a = await this.attempt(ref, source, { preferredAudioLanguage, deadlineMs: Math.min(this.o.deadlineMs, remaining), signal });
      if (!a.ok) {
        if (a.tried.code === "abort") throw new HttpError(503, "aborted");
        tried.push(a.tried);
        if (source.type === "adapter" && a.tried.code !== "adapter_unavailable") {
          // A phone's failure must not reorder the TV's fallback.
          if (!companion) this.markFailed(episode.id, source.id);
          const { sourceId, code, adapterId, name } = a.tried;
          this.o.log.warn("adapter failed", { deviceId, episodeId: episode.id, sourceId, code, adapterId, name, ms: a.ms, ...(companion ? { companion: true } : {}) });
        }
        continue;
      }
      if (companion && a.stream.media.kind === "dash") {
        throw new HttpError(400, "unsupported_media", "DASH cannot be played on the phone: the proxy does not rewrite manifests", { kind: "dash" });
      }
      const session = this.o.sessions.open({ deviceId: owner, catalogId: this.catalog.catalogId, itemId: ref.item.id, episodeId: episode.id, sourceId: source.id });
      const delivered = this.deliver(owner, a.stream, this.o.proxyAlways || companion, { episodeId: episode.id, sourceId: source.id });
      const fields = { deviceId, itemId: ref.item.id, episodeId: episode.id, sourceId: source.id, kind: delivered.media.kind, delivery: delivered.delivery };
      this.o.log.info("resolved", { ...fields, ...(companion ? { companion: true } : {}), ...(source.type === "adapter" ? { adapterId: source.adapter, ms: a.ms } : {}) });
      const alternatives = candidates.slice(i + 1).filter((s) => this.staticCheck(s) === null).map((s) => s.id);
      return { session, ref, source, ...delivered, languages: a.stream.languages, alternatives, expiresAt: a.stream.expiresAt, failed: tried };
    }
    this.o.log.warn("no playable source", { deviceId, episodeId: episode.id, tried: tried.length });
    throw new HttpError(502, "no_playable_source", "none of the episode's sources can be played", { tried });
  }

  /**
   * The sources to try, in order: the forced one, or the episode's sources by audio language with recent failures
   * last. Sources the TV excluded are left out, and count as failed for the TV.
   */
  private candidatesFor(episode: Episode, input: ResolveInput, preferredAudioLanguage: string | null, companion: boolean): Source[] {
    const exclude = new Set(input.exclude ?? []);
    if (!companion) for (const id of exclude) if (episode.sources.some((s) => s.id === id)) this.markFailed(episode.id, id);
    if (input.sourceId !== undefined) return [requireSource(episode, input.sourceId, 404, "unknown_source")];
    const t = this.now();
    const recentlyFailed = (s: Source) => {
      const at = this.failures.get(this.failureKey(episode.id, s.id));
      return at !== undefined && t - at < FAILURE_PENALTY_MS;
    };
    const failed = new Set(episode.sources.filter(recentlyFailed).map((s) => s.id));
    return orderSources(episode.sources, { preferredAudioLanguage, exclude, failed });
  }
}
