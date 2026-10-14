import type { Adapter, Episode, LanguageFacts, MediaKind, ResolvedMedia, ResolveResult, Source, SubtitleTrack } from "@izle/contract";
import { newId } from "./auth.ts";
import type { CatalogService, EpisodeRef } from "./catalog.ts";
import { HttpError } from "./errors.ts";
import type { Logger } from "./log.ts";
import { requireEpisode, requirePlayable, requireSource } from "./lookup.ts";
import { orderSources } from "./playback.ts";
import { entryPath, subtitlePath, type ProxyService } from "./proxy.ts";
import { runAdapter, type AdapterFailureCode } from "./resolver.ts";

export const FAILURE_PENALTY_MS = 10 * 60_000;
export const PLAYBACK_SESSION_TTL_MS = 12 * 60 * 60_000;

export interface ResolveInput {
  episodeId: string;
  sourceId?: string;
  exclude?: string[];
}

export interface ResolveOptions {
  /**
   * `companion`: the owner's phone resolving a second source of the episode the TV plays ("Listen along"). Its
   * proxy sessions live under their own owner key, the stream is always proxied (the admin page only loads
   * same-origin media), DASH is refused, and failures do not reorder the TV's fallback.
   */
  scope?: "tv" | "companion";
}

/** Proxy-session owner key of a device's companion streams (separate from the TV's own two sessions). */
export const companionScope = (deviceId: string): string => `companion:${deviceId}`;
/** Whether a proxy-session owner key is a companion scope rather than a TV's device id. */
export const isCompanionScope = (owner: string): boolean => owner.startsWith("companion:");

export interface PlaybackSession {
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

export type Attempt =
  | { ok: true; stream: UpstreamStream; results: ResolveResult[] | null; ms: number }
  | { ok: false; tried: Tried; results: ResolveResult[] | null; ms: number };

export interface ResolveServiceOptions {
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
export const hasHeaders = (h: Record<string, string> | undefined): h is Record<string, string> => h !== undefined && Object.keys(h).length > 0;

/** DASH manifests are not rewritten by the proxy (v1), so DASH that needs upstream headers cannot be served. */
export function servable(media: ResolvedMedia, headers: Record<string, string> | undefined): boolean {
  return !(media.kind === "dash" && hasHeaders(headers));
}

/** How a stream reaches the client. */
export interface DeliveryPlan {
  /** False for DASH that needs upstream headers (see `servable`). */
  servable: boolean;
  /** The main media goes through the proxy: inline playlists, header-bound media, and with `proxyAlways` any HLS or MP4. */
  proxyMain: boolean;
  /** One entry per subtitle track: whether it goes through the proxy. */
  proxySubtitles: boolean[];
}

/** The delivery of a stream, shared by resolve and the admin diagnostics so both always agree. */
export function deliveryPlan(
  s: {
    media: ResolvedMedia;
    headers?: Record<string, string> | undefined;
    subtitleTracks?: ReadonlyArray<{ headers?: Record<string, string> | undefined }> | undefined;
  },
  proxyAlways: boolean,
): DeliveryPlan {
  const inline = "playlist" in s.media;
  return {
    servable: servable(s.media, s.headers),
    proxyMain: inline || (s.media.kind !== "dash" && (hasHeaders(s.headers) || proxyAlways)),
    proxySubtitles: (s.subtitleTracks ?? []).map((t) => hasHeaders(t.headers) || proxyAlways),
  };
}

/** A source's upstream stream from what resolved it (its own media, or an adapter's result), the source filling gaps. */
function upstreamStream(
  source: Source,
  r: Pick<ResolveResult, "media" | "headers" | "languages" | "subtitleTracks" | "label" | "expiresAt">,
): UpstreamStream {
  return {
    media: r.media,
    headers: r.headers ?? {},
    languages: r.languages ?? source.languages,
    subtitleTracks: r.subtitleTracks ?? source.subtitleTracks ?? [],
    label: r.label ?? source.label ?? null,
    expiresAt: r.expiresAt ?? null,
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
    this.prune(t);
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

  private prune(t: number): void {
    if (this.sessions.size < 1000) return;
    for (const [id, s] of this.sessions) if (t - s.createdAt > PLAYBACK_SESSION_TTL_MS) this.sessions.delete(id);
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
  private readonly now: () => number;

  constructor(opts: ResolveServiceOptions) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
  }

  private get catalog(): CatalogService {
    return this.o.catalog;
  }

  /** Time for one adapter call. */
  get deadlineMs(): number {
    return this.o.deadlineMs;
  }

  get proxyAlways(): boolean {
    return this.o.proxyAlways;
  }

  private failureKey(episodeId: string, sourceId: string): string {
    return `${this.catalog.catalogId}\u0000${episodeId}\u0000${sourceId}`;
  }

  /** Records that a source could not be played (the TV excluded it, or its adapter failed). */
  private markFailed(episodeId: string, sourceId: string): void {
    this.failures.set(this.failureKey(episodeId, sourceId), this.now());
  }

  private recentlyFailed(episodeId: string, sources: readonly Source[]): Set<string> {
    const t = this.now();
    const out = new Set<string>();
    for (const s of sources) {
      const at = this.failures.get(this.failureKey(episodeId, s.id));
      if (at !== undefined && t - at < FAILURE_PENALTY_MS) out.add(s.id);
    }
    return out;
  }

  session(id: string): PlaybackSession | undefined {
    return this.o.sessions.get(id);
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
    if (source.type === "direct") {
      return { ok: true, results: null, ms: 0, stream: upstreamStream(source, { media: { kind: source.media.kind, url: source.media.url }, headers: source.media.headers }) };
    }
    const adapter = this.o.adapters!.get(source.adapter)!;
    const outcome = await runAdapter(
      adapter,
      {
        catalogId: this.catalog.catalogId,
        itemId: ref.item.id,
        episodeId: ref.episode.id,
        sourceId: source.id,
        ref: source.ref,
        preferredAudioLanguage: opts.preferredAudioLanguage,
      },
      { deadlineMs: opts.deadlineMs, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    if (!outcome.ok) {
      const tried: Tried = { sourceId: source.id, code: outcome.code, adapterId: adapter.id };
      if (outcome.name) tried.name = outcome.name;
      return { ok: false, tried, results: null, ms: outcome.ms };
    }
    // Results come in the adapter's preference order; the first one the server can serve wins.
    const result = outcome.results.find((r) => servable(r.media, r.headers));
    if (!result) return { ok: false, tried: { sourceId: source.id, code: "unsupported", adapterId: adapter.id }, results: outcome.results, ms: outcome.ms };
    return { ok: true, results: outcome.results, ms: outcome.ms, stream: upstreamStream(source, result) };
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
    let token: string | null = null;
    if (proxyMain || proxySubtitles.some(Boolean)) {
      const m = s.media;
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
    const kind = s.media.kind;
    return {
      media: proxyMain ? { kind, url: entryPath(token!, kind === "mp4" ? "mp4" : "hls") } : { kind, url: (s.media as { url: string }).url },
      subtitleTracks: s.subtitleTracks.map((t, i) => ({
        url: proxySubtitles[i] ? subtitlePath(token!, i, t.format) : t.url,
        language: t.language,
        format: t.format,
        ...(t.label !== undefined ? { label: t.label } : {}),
      })),
      delivery: proxyMain ? "proxy" : "direct",
    };
  }

  async resolve(
    deviceId: string,
    preferredAudioLanguage: string | null,
    input: ResolveInput,
    signal?: AbortSignal,
    opts: ResolveOptions = {},
  ): Promise<ResolvedStream> {
    const ref = requireEpisode(this.catalog, input.episodeId, 404, "unknown_episode");
    requirePlayable(ref.episode, 403, "not_allowed");
    const companion = opts.scope === "companion";
    const candidates = this.candidatesFor(ref.episode, input, preferredAudioLanguage, companion);
    return this.tryCandidates(deviceId, ref, candidates, { preferredAudioLanguage, signal, companion });
  }

  /**
   * The sources to try, in order: the forced one, or the episode's sources by audio language with recent failures
   * last. Sources the TV excluded are left out, and count as failed for the TV.
   */
  private candidatesFor(episode: Episode, input: ResolveInput, preferredAudioLanguage: string | null, companion: boolean): Source[] {
    const exclude = new Set(input.exclude ?? []);
    if (!companion) for (const id of exclude) if (episode.sources.some((s) => s.id === id)) this.markFailed(episode.id, id);
    if (input.sourceId !== undefined) return [requireSource(episode, input.sourceId, 404, "unknown_source")];
    return orderSources(episode.sources, { preferredAudioLanguage, exclude, failed: this.recentlyFailed(episode.id, episode.sources) });
  }

  /**
   * Tries the candidates in order within the request's time budget and delivers the first one that resolves, with
   * a new playback session. None does: 502 `no_playable_source` with what was tried.
   */
  private async tryCandidates(
    deviceId: string,
    ref: EpisodeRef,
    candidates: Source[],
    o: { preferredAudioLanguage: string | null; signal: AbortSignal | undefined; companion: boolean },
  ): Promise<ResolvedStream> {
    const { episode } = ref;
    const { preferredAudioLanguage, signal, companion } = o;
    const owner = companion ? companionScope(deviceId) : deviceId;
    const budgetEnd = performance.now() + this.o.budgetMs;
    const tried: Tried[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const source = candidates[i]!;
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
      const alternatives = candidates.slice(i + 1).filter((s) => this.staticCheck(s) === null).map((s) => s.id);
      this.o.log.info("resolved", {
        deviceId,
        itemId: ref.item.id,
        episodeId: episode.id,
        sourceId: source.id,
        kind: delivered.media.kind,
        delivery: delivered.delivery,
        ...(companion ? { companion: true } : {}),
        ...(source.type === "adapter" ? { adapterId: source.adapter, ms: a.ms } : {}),
      });
      return {
        session,
        ref,
        source,
        ...delivered,
        languages: a.stream.languages,
        alternatives,
        expiresAt: a.stream.expiresAt,
        failed: tried,
      };
    }
    this.o.log.warn("no playable source", { deviceId, episodeId: episode.id, tried: tried.length });
    throw new HttpError(502, "no_playable_source", "none of the episode's sources can be played", { tried });
  }
}
