// The owner's catalog browser (admin API): an index built once per loaded catalog (folded text and genres, the
// first-seen dates the catalog history recorded, three orders and the facets) and the filtered, paged query over it.
// The admin page's "Add shows" and the Catalog page's "Shows" both read it through `GET /admin/catalog/search`.

import { isLiveItem, type CatalogItem } from "@izle/contract";
import { byTitle, fold, type CatalogService, type LoadedCatalog } from "./catalog.ts";
import { isPlayable } from "./playback.ts";
import type { SeenItem, Store } from "./store.ts";

export type ItemKind = CatalogItem["kind"];

export const ITEM_KINDS: readonly ItemKind[] = ["movie", "series", "live"];

/** The orders the browser offers: by title, by year (newest first), by when the catalog got it (newest first). */
export const BROWSE_SORTS = ["title", "year", "newest"] as const;
export type BrowseSort = (typeof BROWSE_SORTS)[number];

/** One item as the browser filters and orders it. */
export interface BrowseEntry {
  item: CatalogItem;
  /** Folded title, original title and id, joined so that no match spans two of them. */
  text: string;
  /** Folded genres, each once. */
  genres: string[];
  /** Null for a channel or a show without one. */
  year: number | null;
  playable: boolean;
  /** When the catalog first carried it (epoch ms): its oldest present episode, or the channel's row; 0 = always there or unknown. */
  firstSeenAt: number;
  /** When its newest present episode first appeared; 0 for a channel, or when always there. */
  latestEpisodeAt: number;
  /** When each present episode first appeared, ascending (empty for a channel). */
  episodeSeen: number[];
}

/** What the catalog holds, for the browser's filter choices. */
export interface BrowseFacets {
  kinds: Record<ItemKind, number>;
  /** By item count (descending), then name; a genre spelled several ways is listed once, under its first spelling. */
  genres: Array<{ name: string; count: number }>;
  /** The years of the movies and series; null when none has one. */
  years: { min: number; max: number } | null;
}

export interface BrowseIndex {
  byTitle: BrowseEntry[];
  /** Year descending, items without a year last, then title. */
  byYear: BrowseEntry[];
  /** Latest of first seen and newest episode descending, then title. */
  byNewest: BrowseEntry[];
  facets: BrowseFacets;
}

export interface BrowseQuery {
  /** Matched in title, original title and id (case-, accent- and dotless-ı-insensitive); "" matches everything. */
  q: string;
  kinds?: readonly ItemKind[];
  /** Any of these (folded on the way in). */
  genres?: readonly string[];
  yearFrom?: number;
  yearTo?: number;
  /** Only items OK can play. */
  playable: boolean;
  /** Only items the catalog got, or got an episode of, at or after this time (epoch ms). */
  since?: number;
  /** Item ids left out (a TV's Home). */
  exclude?: ReadonlySet<string>;
  sort: BrowseSort;
  offset: number;
  limit: number;
}

export interface BrowseHit {
  entry: BrowseEntry;
  /** Present episodes first seen at or after `since` (0 without it); null for a channel. */
  newEpisodes: number | null;
}

export interface BrowseResult {
  hits: BrowseHit[];
  /** Every match, not just this page. */
  total: number;
  offset: number;
}

type SeenEpisodes = ReadonlyMap<string, ReadonlyArray<{ episodeId: string; firstSeenAt: number }>>;

const entryTitle = (a: BrowseEntry, b: BrowseEntry) => byTitle(a.item.title, b.item.title) || byTitle(a.item.id, b.item.id);
const newest = (e: BrowseEntry) => Math.max(e.firstSeenAt, e.latestEpisodeAt);

function entryOf(item: CatalogItem, seen: SeenEpisodes, channels: ReadonlyMap<string, number>): BrowseEntry {
  const text = [item.title, item.originalTitle ?? "", item.id].map(fold).join("\u0000");
  const genres = [...new Set((item.genres ?? []).map((g) => fold(g.trim())).filter((g) => g !== ""))];
  const base = { item, text, genres, playable: isPlayable(item) };
  if (isLiveItem(item)) return { ...base, year: null, firstSeenAt: channels.get(item.id) ?? 0, latestEpisodeAt: 0, episodeSeen: [] };
  // Only the item's own episodes: the history and the loaded catalog agree unless the history failed to record.
  const own = new Set(item.episodes.map((e) => e.id));
  const episodeSeen = (seen.get(item.id) ?? []).filter((s) => own.has(s.episodeId)).map((s) => s.firstSeenAt);
  return { ...base, year: item.year ?? null, firstSeenAt: episodeSeen[0] ?? 0, latestEpisodeAt: episodeSeen.at(-1) ?? 0, episodeSeen };
}

function facetsOf(entries: readonly BrowseEntry[]): BrowseFacets {
  const kinds: Record<ItemKind, number> = { movie: 0, series: 0, live: 0 };
  const genres = new Map<string, { name: string; count: number }>();
  let years: BrowseFacets["years"] = null;
  for (const e of entries) {
    kinds[e.item.kind]++;
    for (const name of e.item.genres ?? []) {
      const key = fold(name.trim());
      if (key !== "" && !genres.has(key)) genres.set(key, { name: name.trim(), count: 0 });
    }
    for (const key of e.genres) genres.get(key)!.count++;
    if (e.year !== null) years = years ? { min: Math.min(years.min, e.year), max: Math.max(years.max, e.year) } : { min: e.year, max: e.year };
  }
  return { kinds, genres: [...genres.values()].sort((a, b) => b.count - a.count || byTitle(a.name, b.name)), years };
}

/**
 * The browser's index of a loaded catalog. `seen` is the history's present episodes by item (`Store.listSeen`),
 * `seenItems` its channel rows (`Store.catalogSeenItems`; removed ones are ignored).
 */
export function buildIndex(loaded: Pick<LoadedCatalog, "items">, seen: SeenEpisodes, seenItems: ReadonlyArray<Pick<SeenItem, "itemId" | "firstSeenAt" | "removedAt">>): BrowseIndex {
  const channels = new Map(seenItems.filter((s) => s.removedAt === null).map((s) => [s.itemId, s.firstSeenAt]));
  const entries = loaded.items.map((item) => entryOf(item, seen, channels));
  const sorted = [...entries].sort(entryTitle);
  return {
    byTitle: sorted,
    byYear: [...sorted].sort((a, b) => (a.year === b.year ? entryTitle(a, b) : a.year === null ? 1 : b.year === null ? -1 : b.year - a.year)),
    byNewest: [...sorted].sort((a, b) => newest(b) - newest(a) || entryTitle(a, b)),
    facets: facetsOf(entries),
  };
}

const ORDERS: Record<BrowseSort, keyof Omit<BrowseIndex, "facets">> = { title: "byTitle", year: "byYear", newest: "byNewest" };

/** The page of `query` over `index`, with the count of every match. */
export function browse(index: BrowseIndex, query: BrowseQuery): BrowseResult {
  const q = fold(query.q.trim());
  const kinds = query.kinds && new Set(query.kinds);
  const genres = query.genres && new Set(query.genres.map((g) => fold(g.trim())));
  const { yearFrom, yearTo, since, exclude } = query;
  const matches = (e: BrowseEntry) =>
    (q === "" || e.text.includes(q)) &&
    (!kinds || kinds.has(e.item.kind)) &&
    (!genres || e.genres.some((g) => genres.has(g))) &&
    (yearFrom === undefined || (e.year !== null && e.year >= yearFrom)) &&
    (yearTo === undefined || (e.year !== null && e.year <= yearTo)) &&
    (!query.playable || e.playable) &&
    // `>=`: what a build added carries exactly that build's load time.
    (since === undefined || e.firstSeenAt >= since || e.latestEpisodeAt >= since) &&
    (!exclude || !exclude.has(e.item.id));
  const all = index[ORDERS[query.sort]].filter(matches);
  const newEpisodes = (e: BrowseEntry) => (isLiveItem(e.item) ? null : since === undefined ? 0 : e.episodeSeen.filter((t) => t >= since).length);
  const hits = all.slice(query.offset, query.offset + query.limit).map((entry) => ({ entry, newEpisodes: newEpisodes(entry) }));
  return { hits, total: all.length, offset: query.offset };
}

interface BrowserDeps {
  catalog: CatalogService;
  store: Pick<Store, "listSeen" | "catalogSeenItems">;
}

/**
 * The browser over the loaded catalog. The index is rebuilt on the first query after a load: the catalog history
 * records a build inside the load hook, before any request sees the new catalog, so the first-seen dates it reads
 * then are those of the catalog it indexes.
 */
export class CatalogBrowser {
  private readonly s: BrowserDeps;
  private indexed: { catalog: LoadedCatalog; index: BrowseIndex } | null = null;

  constructor(deps: BrowserDeps) {
    this.s = deps;
  }

  index(): BrowseIndex {
    const current = this.s.catalog.current;
    if (this.indexed?.catalog !== current) {
      const { catalogId } = current.manifest;
      this.indexed = { catalog: current, index: buildIndex(current, this.s.store.listSeen(catalogId), this.s.store.catalogSeenItems(catalogId)) };
    }
    return this.indexed.index;
  }

  search(query: BrowseQuery): BrowseResult {
    return browse(this.index(), query);
  }

  facets(): BrowseFacets {
    return this.index().facets;
  }
}
