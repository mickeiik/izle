// "Listen along" (docs/spec/server-api-v1.md): the owner's phone plays a second source of the episode the TV is
// playing, in sync with the picture. The companion stream resolves under its own proxy scope, so the TV's sessions
// are never disturbed. A link the owner found in a browser plays on the phone only; its timing is kept here under the
// reserved source id PASTED_SOURCE_ID, which no bundle source has.

import { PASTED_SOURCE_ID, type Episode } from "@izle/contract";
import type { CatalogService, EpisodeRef } from "./catalog.ts";
import { HttpError } from "./errors.ts";
import { requireEpisode, requireEpisodeSource } from "./lookup.ts";
import type { PlayingService } from "./playing.ts";
import { iso } from "./presenters.ts";
import type { ResolveService } from "./resolve.ts";
import type { CompanionLink, Device, Store } from "./store.ts";

export type LinkInput = Pick<CompanionLink, "offsetMs" | "rate"> & { language?: string | null };

export interface CompanionResolveInput {
  episodeId: string;
  sourceId: string;
  language?: string | null;
}

/** A link as the admin API shows it: the stored values, or the defaults (no offset, same speed). */
const linkJson = (l: CompanionLink | null) => ({ offsetMs: l?.offsetMs ?? 0, rate: l?.rate ?? 1, language: l?.language ?? null, updatedAt: l ? iso(l.updatedAt) : null });

interface CompanionDeps {
  store: Store;
  catalog: CatalogService;
  resolver: ResolveService;
  playing: PlayingService;
  now: () => number;
}

export class CompanionService {
  private readonly s: CompanionDeps;

  constructor(deps: CompanionDeps) {
    this.s = deps;
  }

  private link(episodeId: string, sourceId: string) {
    return linkJson(this.s.store.getCompanionLink(this.s.catalog.catalogId, episodeId, sourceId));
  }

  /** The episode a link is stored for: any episode for the pasted link, else one with that source (404 otherwise). */
  private linkEpisode(episodeId: string, sourceId: string): EpisodeRef {
    if (sourceId === PASTED_SOURCE_ID) return requireEpisode(this.s.catalog, episodeId, 404, "unknown_episode");
    return requireEpisodeSource(this.s.catalog, episodeId, sourceId).ref;
  }

  /**
   * Links belong to the media (two releases of the same episode), not to a TV: keyed by episode and source only. They
   * are timing data, so an episode that may not be played still takes one.
   */
  putLink(episodeId: string, sourceId: string, input: LinkInput) {
    const ref = this.linkEpisode(episodeId, sourceId);
    const { offsetMs, rate, language = null } = input;
    const ids = { catalogId: this.s.catalog.catalogId, itemId: ref.item.id, episodeId: ref.episode.id, sourceId };
    this.s.store.putCompanionLink({ ...ids, language, offsetMs, rate, updatedAt: this.s.now() });
    return { episodeId: ref.episode.id, sourceId, ...this.link(ref.episode.id, sourceId) };
  }

  /**
   * Copies an episode's stored link to every other episode of its item that has a source with the same id (the pasted
   * link: to every other episode).
   */
  copyToItem(episodeId: string, sourceId: string) {
    const ref = this.linkEpisode(episodeId, sourceId);
    const from = this.s.store.getCompanionLink(this.s.catalog.catalogId, ref.episode.id, sourceId);
    if (!from) throw new HttpError(404, "no_link", "this episode has no stored link for that source");
    const t = this.s.now();
    const takes = (e: Episode) => sourceId === PASTED_SOURCE_ID || e.sources.some((s) => s.id === sourceId);
    const episodeIds = ref.item.episodes.filter((e) => e.id !== ref.episode.id && takes(e)).map((e) => e.id);
    this.s.store.transaction(() => {
      for (const id of episodeIds) this.s.store.putCompanionLink({ ...from, episodeId: id, updatedAt: t });
    });
    return { updated: episodeIds.length, episodeIds };
  }

  /**
   * The sources of the episode the TV is playing, with their stored links, then the pasted link's candidate (played
   * by the companion app only); a channel has none (no timeline). `durationMs` is the TV's last reported duration.
   */
  candidates(device: Device) {
    const n = this.s.playing.current(device.id);
    const about = n && this.s.catalog.describe(n);
    if (!n || !about || about.missing) return { nowPlaying: null, candidates: [] };
    const { itemId, itemKind, episodeId, itemTitle, episodeTitle } = about;
    const nowPlaying = { itemId, itemKind, episodeId, sourceId: n.sourceId, itemTitle, episodeTitle, state: n.state, durationMs: n.durationMs };
    const ref = this.s.catalog.playing(n);
    if (ref?.kind !== "episode") return { nowPlaying, candidates: [] };
    const { episode } = ref;
    const links = new Map(this.s.store.listCompanionLinks(this.s.catalog.catalogId, episode.id).map((l) => [l.sourceId, l]));
    const sources = episode.sources.map((s) => {
      const kind = s.type === "direct" ? s.media.kind : null;
      // A browser plays neither DASH (not proxied) nor MPEG-TS; an adapter that answers either is refused on resolve.
      const reason = kind === "dash" || kind === "ts" ? kind : null;
      const link = linkJson(links.get(s.id) ?? null);
      const current = s.id === n.sourceId;
      return { sourceId: s.id, type: s.type, kind, label: s.label ?? null, languages: s.languages, current, supported: reason === null, reason, link };
    });
    // The pasted link's type has the reserved id's name; the server never sees the link, so nothing to resolve.
    const pasted = {
      sourceId: PASTED_SOURCE_ID, type: PASTED_SOURCE_ID, kind: null, label: null, languages: { audio: null, subtitles: null },
      current: false, supported: true, reason: null, link: linkJson(links.get(PASTED_SOURCE_ID) ?? null),
    };
    // Upstream URLs, headers and refs are deliberately not exposed (the admin item view has the same rule).
    return { nowPlaying, candidates: [...sources, pasted] };
  }

  /** The forced source, always proxied, without touching the TV's now-playing row or playback session. */
  async resolve(device: Device, input: CompanionResolveInput, signal?: AbortSignal) {
    const { ref } = requireEpisodeSource(this.s.catalog, input.episodeId, input.sourceId);
    const episodeId = ref.episode.id;
    const forced = { episodeId, sourceId: input.sourceId };
    const r = await this.s.resolver.resolve(device.id, input.language ?? null, forced, signal, { scope: "companion" });
    const { source, media, languages, expiresAt } = r;
    return { episodeId, sourceId: source.id, media, languages, expiresAt, link: this.link(episodeId, source.id) };
  }
}
