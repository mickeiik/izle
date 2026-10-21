// Catalog lookups that answer the request with an error when they find nothing. Routes differ in that answer (404 for
// an id in the path, 400 for one in a request body, 403 or 400 for an episode that may not be played), so every
// caller names its status and code.

import { isLiveItem, type CatalogItem, type EpisodicItem, type Playable, type Source } from "@izle/contract";
import { liveRef, type CatalogService, type EpisodeRef, type PlayableRef } from "./catalog.ts";
import { HttpError } from "./errors.ts";

type LookupStatus = 400 | 403 | 404;

/**
 * How a request body names what to play: an episode by its episode id, or a channel by its item id (exactly one;
 * the two id spaces are separate).
 */
export type PlayableId = { episodeId: string; itemId?: undefined } | { itemId: string; episodeId?: undefined };

export function requireItem(catalog: CatalogService, itemId: string, status: LookupStatus, code: string): CatalogItem {
  const item = catalog.item(itemId);
  if (!item) throw new HttpError(status, code);
  return item;
}

/** An item played through its episodes (a movie or a series); 400 `unknown_episode` for a channel, which has none. */
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

/**
 * The episode (`unknown_episode`) or the channel (`unknown_item`) a body names, with `status` for either. An
 * `itemId` naming an item that is played through its episodes answers 400 `has_episodes`: name one of them.
 */
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

/** The episode (404 `unknown_episode`) and its source (404 `unknown_source`) that a "Listen along" route names. */
export function requireEpisodeSource(catalog: CatalogService, episodeId: string, sourceId: string): { ref: EpisodeRef; source: Source } {
  const ref = requireEpisode(catalog, episodeId, 404, "unknown_episode");
  return { ref, source: requireSource(ref.episode, sourceId, 404, "unknown_source") };
}

/** `not_allowed` with `status` when the episode's or the channel's `playbackAllowed` is false. */
export function requirePlayable(playable: Playable, status: LookupStatus, code = "not_allowed", what = "episode"): void {
  if (!playable.playbackAllowed) throw new HttpError(status, code, `playback of this ${what} is not allowed`);
}

/** `requirePlayable` for a ref, naming an episode or a channel in the message. */
export function requireAllowed(ref: PlayableRef, status: LookupStatus): void {
  requirePlayable(ref.kind === "episode" ? ref.episode : ref.item, status, "not_allowed", ref.kind === "episode" ? "episode" : "channel");
}
