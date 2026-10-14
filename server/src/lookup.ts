// Catalog lookups that answer the request with an error when they find nothing. Routes differ in that answer (404 for
// an id in the path, 400 for one in a request body, 403 or 400 for an episode that may not be played), so every
// caller names its status and code; only the "Listen along" routes' episode-and-source pair has its own function.

import type { CatalogItem, Episode, Source } from "@izle/contract";
import type { CatalogService, EpisodeRef } from "./catalog.ts";
import { HttpError } from "./errors.ts";

export type LookupStatus = 400 | 403 | 404;

/** The item with this id in the loaded catalog. */
export function requireItem(catalog: CatalogService, itemId: string, status: LookupStatus, code: string): CatalogItem {
  const item = catalog.item(itemId);
  if (!item) throw new HttpError(status, code);
  return item;
}

/** The episode with this id in the loaded catalog, with its item and place in the play order. */
export function requireEpisode(catalog: CatalogService, episodeId: string, status: LookupStatus, code: string): EpisodeRef {
  const ref = catalog.episode(episodeId);
  if (!ref) throw new HttpError(status, code);
  return ref;
}

/** The episode's source with this id. */
export function requireSource(episode: Episode, sourceId: string, status: LookupStatus, code: string): Source {
  const source = episode.sources.find((s) => s.id === sourceId);
  if (!source) throw new HttpError(status, code);
  return source;
}

/** The episode (404 `unknown_episode`) and its source (404 `unknown_source`) that a "Listen along" route names. */
export function requireEpisodeSource(catalog: CatalogService, episodeId: string, sourceId: string): { ref: EpisodeRef; source: Source } {
  const ref = requireEpisode(catalog, episodeId, 404, "unknown_episode");
  return { ref, source: requireSource(ref.episode, sourceId, 404, "unknown_source") };
}

/** Throws unless the episode has playbackAllowed. */
export function requirePlayable(episode: Episode, status: LookupStatus, code: string): void {
  if (!episode.playbackAllowed) throw new HttpError(status, code, "playback of this episode is not allowed");
}
