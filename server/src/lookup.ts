// Catalog lookups that answer the request with an error when they find nothing. Routes differ in that answer (404 for
// an id in the path, 400 in a body, 403 or 400 for an episode that may not be played), so every caller names it.

import { isLiveItem, type CatalogItem, type EpisodicItem, type Playable, type Source } from "@izle/contract";
import { liveRef, playableOf, type CatalogService, type EpisodeRef, type LiveRef, type PlayableRef } from "./catalog.ts";
import { HttpError } from "./errors.ts";

type LookupStatus = 400 | 403 | 404;

/** How a request body names what to play: an episode by its episode id, or a channel by its item id. */
export type PlayableId = { episodeId: string; itemId?: undefined } | { itemId: string; episodeId?: undefined };

export function requireItem(catalog: CatalogService, itemId: string, status: LookupStatus, code: string): CatalogItem {
  const item = catalog.item(itemId);
  if (!item) throw new HttpError(status, code);
  return item;
}

/** A movie or a series; 400 `unknown_episode` for a channel, which has no episodes. */
export function requireEpisodicItem(catalog: CatalogService, itemId: string, status: LookupStatus, code: string): EpisodicItem {
  const item = requireItem(catalog, itemId, status, code);
  if (isLiveItem(item)) throw new HttpError(400, "unknown_episode", "a channel has no episodes");
  return item;
}

export function requireEpisode(catalog: CatalogService, episodeId: string, status: LookupStatus, code: string): EpisodeRef {
  const ref = catalog.episode(episodeId);
  if (!ref) throw new HttpError(status, code);
  return ref;
}

/** `unknown_episode` or `unknown_item` with `status`; 400 `has_episodes` for an item played through its episodes. */
export function requirePlayableRef(catalog: CatalogService, id: { itemId: string; episodeId?: undefined }, status?: LookupStatus): LiveRef;
export function requirePlayableRef(catalog: CatalogService, id: PlayableId, status?: LookupStatus): PlayableRef;
export function requirePlayableRef(catalog: CatalogService, id: PlayableId, status: LookupStatus = 404): PlayableRef {
  if (id.episodeId !== undefined) return requireEpisode(catalog, id.episodeId, status, "unknown_episode");
  const item = requireItem(catalog, id.itemId, status, "unknown_item");
  if (!isLiveItem(item)) throw new HttpError(400, "has_episodes", "this item is played through its episodes: name an episode of it", { itemId: item.id });
  return liveRef(item);
}

export function requireSource(playable: Playable, sourceId: string, status: LookupStatus, code: string): Source {
  const source = playable.sources.find((s) => s.id === sourceId);
  if (!source) throw new HttpError(status, code);
  return source;
}

export function requireEpisodeSource(catalog: CatalogService, episodeId: string, sourceId: string): { ref: EpisodeRef; source: Source } {
  const ref = requireEpisode(catalog, episodeId, 404, "unknown_episode");
  return { ref, source: requireSource(ref.episode, sourceId, 404, "unknown_source") };
}

/** `not_allowed` with `status` when the episode's or the channel's `playbackAllowed` is false. */
export function requirePlayable(playable: Playable, status: LookupStatus, code = "not_allowed", what = "episode"): void {
  if (!playable.playbackAllowed) throw new HttpError(status, code, `playback of this ${what} is not allowed`);
}

export function requireAllowed(ref: PlayableRef, status: LookupStatus): void {
  requirePlayable(playableOf(ref), status, "not_allowed", ref.kind === "episode" ? "episode" : "channel");
}
