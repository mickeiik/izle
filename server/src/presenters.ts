// Response shapes shared by the TV and admin APIs. Only shapes that are the same everywhere live here: the source
// projections differ by what each side may see, and stay with their services and routes.

import type { CatalogItem, Episode } from "@izle/contract";
import type { CatalogService } from "./catalog.ts";

/** Epoch milliseconds as an ISO 8601 string; null stays null. */
export const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** How an episode is named. */
export function episodeSummary(episode: Episode) {
  return { season: episode.season ?? null, number: episode.number ?? null, title: episode.title ?? null, label: episode.label ?? null };
}

/** An item as a tile. */
export function itemCard(catalog: CatalogService, item: CatalogItem) {
  return { id: item.id, kind: item.kind, title: item.title, year: item.year ?? null, posterUrl: catalog.posterUrl(item), backdropUrl: catalog.backdropUrl(item) };
}

export function itemDetails(catalog: CatalogService, item: CatalogItem) {
  return { ...itemCard(catalog, item), originalTitle: item.originalTitle ?? null, synopsis: item.synopsis ?? null, genres: item.genres ?? [] };
}

/** An episode in an item's episode list. */
export function episodeDetails(episode: Episode, index: number) {
  return { id: episode.id, index, ...episodeSummary(episode), durationMs: episode.durationMs ?? null, playbackAllowed: episode.playbackAllowed };
}
