// "Listen along": the owner's phone plays a second source of the episode the TV is playing, in sync with the
// picture (docs/spec/server-api-v1.md, "Listen along"). This service lists the candidate sources of what is
// playing, keeps the owner's timing links (offset, speed, audio language) and resolves the companion stream under
// its own proxy scope so the TV's sessions are never disturbed.

import type { Services } from "./context.ts";
import { HttpError } from "./errors.ts";
import { requireEpisodeSource } from "./lookup.ts";
import { iso } from "./presenters.ts";
import type { CompanionLink, Device } from "./store.ts";

export interface LinkInput {
  /** Companion position when the TV is at 0. */
  offsetMs: number;
  /** Companion seconds per TV second. */
  rate: number;
  /** Audio language to pick inside the companion stream; null = the player's default. */
  language?: string | null;
}

export interface CompanionResolveInput {
  episodeId: string;
  sourceId: string;
  language?: string | null;
}

/** A link as the admin API shows it: the stored values, or the defaults (no offset, same speed). */
const linkJson = (l: CompanionLink | null) => ({ offsetMs: l?.offsetMs ?? 0, rate: l?.rate ?? 1, language: l?.language ?? null, updatedAt: l ? iso(l.updatedAt) : null });

export class CompanionService {
  private readonly s: Services;

  constructor(services: Services) {
    this.s = services;
  }

  private link(episodeId: string, sourceId: string) {
    return linkJson(this.s.store.getCompanionLink(this.s.catalog.catalogId, episodeId, sourceId));
  }

  /**
   * Stores the owner's timing for a companion source of an episode. Links belong to the media (two releases of
   * the same episode), not to a TV, so they are keyed by catalog, episode and source only.
   */
  putLink(episodeId: string, sourceId: string, input: LinkInput) {
    const { ref } = requireEpisodeSource(this.s.catalog, episodeId, sourceId);
    const { offsetMs, rate, language = null } = input;
    const ids = { catalogId: this.s.catalog.catalogId, itemId: ref.item.id, episodeId: ref.episode.id, sourceId };
    this.s.store.putCompanionLink({ ...ids, language, offsetMs, rate, updatedAt: this.s.now() });
    return { episodeId: ref.episode.id, sourceId, ...this.link(ref.episode.id, sourceId) };
  }

  /** Copies an episode's stored link to every other episode of its item that has a source with the same id. */
  copyToItem(episodeId: string, sourceId: string) {
    const { ref } = requireEpisodeSource(this.s.catalog, episodeId, sourceId);
    const from = this.s.store.getCompanionLink(this.s.catalog.catalogId, ref.episode.id, sourceId);
    if (!from) throw new HttpError(404, "no_link", "this episode has no stored link for that source");
    const t = this.s.now();
    const episodeIds = ref.item.episodes.filter((e) => e.id !== ref.episode.id && e.sources.some((s) => s.id === sourceId)).map((e) => e.id);
    this.s.store.transaction(() => {
      for (const id of episodeIds) this.s.store.putCompanionLink({ ...from, episodeId: id, updatedAt: t });
    });
    return { updated: episodeIds.length, episodeIds };
  }

  /** The sources of the episode the TV is playing, as companion candidates, with their stored links. */
  candidates(device: Device) {
    const n = this.s.store.getNowPlaying(device.id);
    const ref = n ? this.s.catalog.episode(n.episodeId) : undefined;
    if (!n || !ref) return { nowPlaying: null, candidates: [] };
    const links = new Map(this.s.store.listCompanionLinks(this.s.catalog.catalogId, ref.episode.id).map((l) => [l.sourceId, l]));
    const { item, episode } = ref;
    return {
      nowPlaying: { itemId: item.id, itemKind: item.kind, episodeId: episode.id, sourceId: n.sourceId, itemTitle: item.title, episodeTitle: episode.title ?? null, state: n.state },
      // Upstream URLs, headers and refs are deliberately not exposed (the admin item view has the same rule).
      candidates: episode.sources.map((s) => {
        const kind = s.type === "direct" ? s.media.kind : null;
        const supported = kind !== "dash"; // an adapter that answers DASH is refused at resolve time
        const link = linkJson(links.get(s.id) ?? null);
        return { sourceId: s.id, type: s.type, kind, label: s.label ?? null, languages: s.languages, current: s.id === n.sourceId, supported, reason: supported ? null : "dash", link };
      }),
    };
  }

  /**
   * Resolves a companion source for the phone: the forced source, under the companion proxy scope, always
   * proxied, without touching the TV's now-playing row or playback session.
   */
  async resolve(device: Device, input: CompanionResolveInput, signal?: AbortSignal) {
    const { ref } = requireEpisodeSource(this.s.catalog, input.episodeId, input.sourceId);
    const episodeId = ref.episode.id;
    const forced = { episodeId, sourceId: input.sourceId };
    const r = await this.s.resolver.resolve(device.id, input.language ?? null, forced, signal, { scope: "companion" });
    const { source, media, languages, expiresAt } = r;
    return { episodeId, sourceId: source.id, media, languages, expiresAt, link: this.link(episodeId, source.id) };
  }
}
