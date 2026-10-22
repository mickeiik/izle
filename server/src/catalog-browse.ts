// The owner's catalog browser (`GET /admin/catalog/search`): an index built once per loaded catalog (folded text and
// genres, first-seen dates from the catalog history, three orders, the facets) and the paged query over it.

import { isLiveItem, type CatalogItem } from "@izle/contract";
import { byTitle, fold, type CatalogService, type LoadedCatalog } from "./catalog.ts";
import { isPlayable } from "./playback.ts";
import type { SeenItem, Store } from "./store.ts";

export type ItemKind = CatalogItem["kind"];

export const ITEM_KINDS: readonly ItemKind[] = ["movie", "series", "live"];

export const BROWSE_SORTS = ["title", "year", "newest"] as const;
export type BrowseSort = (typeof BROWSE_SORTS)[number];

interface BrowseEntry {
  item: CatalogItem;
  /** Folded title, original title and id, joined so that no match spans two of them. */
  text: string;
  genres: string[];
  year: number | null;
  playable: boolean;
  /** Its oldest present episode's first-seen time, or the channel's row's; 0 = always there or unknown. */
  firstSeenAt: number;
  /** Its newest present episode's first-seen time; 0 for a channel, or when always there. */
  latestEpisodeAt: number;
  /** Each present episode's first-seen time, ascending. */
  episodeSeen: number[];
}

type BrowseIndex = ReturnType<typeof buildIndex>;

export interface BrowseQuery {
  q: string;
  kinds?: readonly ItemKind[];
  genres?: readonly string[];
  yearFrom?: number;
  yearTo?: number;
  playable: boolean;
  /** Only items the catalog got, or got an episode of, at or after this time. */
  since?: number;
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

/** Genres by item count, then name, each under its first spelling. */
function facetsOf(entries: readonly BrowseEntry[]) {
  const kinds: Record<ItemKind, number> = { movie: 0, series: 0, live: 0 };
  const genres = new Map<string, { name: string; count: number }>();
  let years: { min: number; max: number } | null = null;
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

/** `seen`: the history's present episodes by item (`Store.listSeen`), `seenItems` its channel rows. */
export function buildIndex(loaded: Pick<LoadedCatalog, "items">, seen: SeenEpisodes, seenItems: ReadonlyArray<Pick<SeenItem, "itemId" | "firstSeenAt" | "removedAt">>) {
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

export function browse(index: BrowseIndex, query: BrowseQuery) {
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
 * The index is rebuilt on the first query after a load: the catalog history records a build inside the load hook,
 * before any request sees the new catalog, so the first-seen dates it reads are those of the catalog it indexes.
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

  search(query: BrowseQuery) {
    return browse(this.index(), query);
  }

  facets() {
    return this.index().facets;
  }
}
