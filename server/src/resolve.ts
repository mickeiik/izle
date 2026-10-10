import type { LanguageFacts, MediaKind, Source, SubtitleTrack } from "@izle/contract";
import { newId } from "./auth.ts";
import type { CatalogService, EpisodeRef } from "./catalog.ts";
import { HttpError } from "./errors.ts";
import type { Logger } from "./log.ts";
import { orderSources } from "./playback.ts";

export const FAILURE_PENALTY_MS = 10 * 60_000;
export const PLAYBACK_SESSION_TTL_MS = 12 * 60 * 60_000;

export interface ResolveInput {
  episodeId: string;
  sourceId?: string;
  exclude?: string[];
}

export interface PlaybackSession {
  id: string;
  deviceId: string;
  catalogId: string;
  itemId: string;
  episodeId: string;
  sourceId: string;
  createdAt: number;
}

export interface ResolvedStream {
  session: PlaybackSession;
  ref: EpisodeRef;
  source: Source;
  media: { kind: MediaKind; url: string };
  subtitleTracks: SubtitleTrack[];
  languages: LanguageFacts;
  /** Remaining candidate source ids, in the order the TV should try them next. */
  alternatives: string[];
}

export type UnavailableCode = "proxy_unavailable" | "adapter_unavailable";

/**
 * Picks the source to play for an episode. Direct sources without upstream headers are handed to the TV as-is.
 * Sources that need the proxy (upstream headers) or a resolver module (adapter sources) are skipped by this
 * version; both arrive with the resolver/proxy phase.
 */
export class ResolveService {
  private readonly failures = new Map<string, number>();
  private readonly sessions = new Map<string, PlaybackSession>();

  private readonly catalog: CatalogService;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(catalog: CatalogService, log: Logger, now: () => number = Date.now) {
    this.catalog = catalog;
    this.log = log;
    this.now = now;
  }

  private failureKey(episodeId: string, sourceId: string): string {
    return `${this.catalog.catalogId}\u0000${episodeId}\u0000${sourceId}`;
  }

  /** Records that the TV could not play a source (it re-resolves with the source in `exclude`). */
  markFailed(episodeId: string, sourceId: string): void {
    this.failures.set(this.failureKey(episodeId, sourceId), this.now());
  }

  recentlyFailed(episodeId: string, sources: readonly Source[]): Set<string> {
    const t = this.now();
    const out = new Set<string>();
    for (const s of sources) {
      const at = this.failures.get(this.failureKey(episodeId, s.id));
      if (at !== undefined && t - at < FAILURE_PENALTY_MS) out.add(s.id);
    }
    return out;
  }

  session(id: string): PlaybackSession | undefined {
    const s = this.sessions.get(id);
    if (s && this.now() - s.createdAt > PLAYBACK_SESSION_TTL_MS) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  private unavailable(source: Source): UnavailableCode | null {
    if (source.type === "adapter") return "adapter_unavailable";
    if (source.media.headers && Object.keys(source.media.headers).length > 0) return "proxy_unavailable";
    return null;
  }

  async resolve(deviceId: string, preferredAudioLanguage: string | null, input: ResolveInput): Promise<ResolvedStream> {
    const ref = this.catalog.episode(input.episodeId);
    if (!ref) throw new HttpError(404, "unknown_episode");
    const { episode } = ref;
    if (!episode.playbackAllowed) throw new HttpError(403, "not_allowed", "playback of this episode is not allowed");

    const exclude = new Set(input.exclude ?? []);
    for (const id of exclude) if (episode.sources.some((s) => s.id === id)) this.markFailed(episode.id, id);

    let candidates: Source[];
    if (input.sourceId !== undefined) {
      const forced = episode.sources.find((s) => s.id === input.sourceId);
      if (!forced) throw new HttpError(404, "unknown_source");
      candidates = [forced];
    } else {
      candidates = orderSources(episode.sources, {
        preferredAudioLanguage,
        exclude,
        failed: this.recentlyFailed(episode.id, episode.sources),
      });
    }

    const tried: Array<{ sourceId: string; code: UnavailableCode }> = [];
    for (let i = 0; i < candidates.length; i++) {
      const source = candidates[i]!;
      const code = this.unavailable(source);
      if (code) {
        tried.push({ sourceId: source.id, code });
        continue;
      }
      if (source.type !== "direct") continue;
      const t = this.now();
      this.pruneSessions(t);
      const session: PlaybackSession = {
        id: newId(16),
        deviceId,
        catalogId: this.catalog.catalogId,
        itemId: ref.item.id,
        episodeId: episode.id,
        sourceId: source.id,
        createdAt: t,
      };
      this.sessions.set(session.id, session);
      const alternatives = candidates.slice(i + 1).filter((s) => this.unavailable(s) === null).map((s) => s.id);
      this.log.info("resolved", { deviceId, itemId: ref.item.id, episodeId: episode.id, sourceId: source.id, kind: source.media.kind });
      return {
        session,
        ref,
        source,
        media: { kind: source.media.kind, url: source.media.url },
        subtitleTracks: source.subtitleTracks ?? [],
        languages: source.languages,
        alternatives,
      };
    }
    this.log.warn("no playable source", { deviceId, episodeId: episode.id, tried: tried.length });
    throw new HttpError(502, "no_playable_source", "none of the episode's sources can be played", { tried });
  }

  private pruneSessions(t: number): void {
    if (this.sessions.size < 1000) return;
    for (const [id, s] of this.sessions) if (t - s.createdAt > PLAYBACK_SESSION_TTL_MS) this.sessions.delete(id);
  }
}
