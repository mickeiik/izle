// Response shapes shared by the TV and admin APIs. Only shapes that are the same everywhere live here: the source
// projections differ by what each side may see, and stay with their services and routes.

import { isLiveItem, type CatalogItem, type Episode, type Source } from "@izle/contract";
import type { CatalogService } from "./catalog.ts";

/** Epoch milliseconds as an ISO 8601 string; null stays null. */
export const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** How an episode is named. */
export function episodeSummary(episode: Episode) {
  return { season: episode.season ?? null, number: episode.number ?? null, title: episode.title ?? null, label: episode.label ?? null };
}

/** An item as a tile. A channel has no year. */
export function itemCard(catalog: CatalogService, item: CatalogItem) {
  const year = isLiveItem(item) ? null : (item.year ?? null);
  return { id: item.id, kind: item.kind, title: item.title, year, posterUrl: catalog.posterUrl(item), backdropUrl: catalog.backdropUrl(item) };
}

export function itemDetails(catalog: CatalogService, item: CatalogItem) {
  return { ...itemCard(catalog, item), originalTitle: item.originalTitle ?? null, synopsis: item.synopsis ?? null, genres: item.genres ?? [] };
}

/** An episode in an item's episode list. */
export function episodeDetails(episode: Episode, index: number) {
  return { id: episode.id, index, ...episodeSummary(episode), durationMs: episode.durationMs ?? null, playbackAllowed: episode.playbackAllowed };
}

/** A source as the TV sees it (the hidden menu): its id, label and language facts, never where it comes from. */
export function tvSource(s: Source) {
  return { id: s.id, label: s.label ?? null, languages: s.languages };
}
