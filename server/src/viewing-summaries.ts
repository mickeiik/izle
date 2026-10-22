// The viewing history's reading side: a viewing as the admin API shows it, the titles with their status, an item's
// episodes with what was seen and covered, and the day counts. Marks are the family's: `device` narrows the viewings
// and the counts, never whether an episode is seen.

import { isLiveItem, type CatalogItem, type Episode } from "@izle/contract";
import { byTitle, type CatalogService } from "./catalog.ts";
import { HttpError } from "./errors.ts";
import { iso } from "./presenters.ts";
import type { EpisodeMark, EpisodeViewingStats, Store, Viewing } from "./store.ts";

export const TITLE_STATUSES = ["finished", "new_episodes", "watching", "idle"] as const;
export type TitleStatus = (typeof TITLE_STATUSES)[number];
export const TITLE_SORTS = ["recent", "watched", "title"] as const;
export type TitleSort = (typeof TITLE_SORTS)[number];

/** A title is `watching` while it had a viewing in the last 30 days. */
const WATCHING_WINDOW_MS = 30 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** The longest span `GET /history/days` answers. */
export const DAYS_MAX = 366;
const DAYS_DEFAULT = 30;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface SummaryDeps {
  store: Store;
  catalog: CatalogService;
  now: () => number;
}

/** A viewing as the admin API shows it (the running state stays inside). */
export function viewingJson(v: Viewing) {
  const { id, deviceId, deviceName, itemId, itemKind, itemTitle, episodeId, episodeTitle, season, number, sourceId, startedAt, endedAt } = v;
  const { startPositionMs, endPositionMs, durationMs, watchedMs, endReason, seen, trigger, actor, commandId } = v;
  return {
    id, deviceId, deviceName, itemId, itemKind, itemTitle, episodeId, episodeTitle, season, number, sourceId, startedAt: iso(startedAt), endedAt: iso(endedAt),
    startPositionMs, endPositionMs, durationMs, watchedMs, endReason, seen, trigger, actor, commandId,
  };
}

/** The union of ranges, merged, in position order. */
export function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** The share of `durationMs` the ranges cover, two decimals, at most 1. */
function coveredFraction(ranges: ReadonlyArray<readonly [number, number]>, durationMs: number): number {
  const covered = mergeRanges(ranges).reduce((sum, [from, to]) => sum + Math.max(0, Math.min(to, durationMs) - from), 0);
  return Math.min(1, Math.round((covered / durationMs) * 100) / 100);
}

/** What every summary is built from: the per-episode stats (filtered by device) and the family's seen state. */
class HistoryView {
  readonly statsByItem = new Map<string, EpisodeViewingStats[]>();
  readonly statsByEpisode = new Map<string, EpisodeViewingStats>();
  /** When each episode was first seen by a viewing, over every TV. */
  readonly seenAt = new Map<string, number>();
  readonly marks: Map<string, EpisodeMark>;
  /** When each present catalog episode first appeared (the "new episodes" status). */
  private readonly firstSeen: Map<string, number>;
  /** What the history last called each item (for one that left the catalog). */
  private readonly known: Map<string, { kind: string; title: string }>;
  private readonly d: SummaryDeps;

  constructor(d: SummaryDeps, deviceId: string | null, itemId: string | null) {
    this.d = d;
    const catalogId = d.catalog.catalogId;
    for (const s of d.store.episodeViewingStats(catalogId, deviceId, itemId)) {
      if (s.episodeId !== null) this.statsByEpisode.set(s.episodeId, s); // a channel's viewings have no episode
      this.statsByItem.set(s.itemId, [...(this.statsByItem.get(s.itemId) ?? []), s]);
    }
    for (const e of d.store.episodeSeenAt(catalogId, itemId)) this.seenAt.set(e.episodeId, e.seenAt);
    this.marks = d.store.listMarks(catalogId, itemId);
    this.firstSeen = d.store.episodeFirstSeen(catalogId, itemId);
    this.known = d.store.historyItems(catalogId, itemId);
  }

  /** Whether the episode is seen: the mark's word, else any seen viewing of any TV. */
  isSeen(episodeId: string): boolean {
    return this.marks.get(episodeId)?.seen ?? this.seenAt.has(episodeId);
  }

  /** When the episode was first seen: the end of its first seen viewing, or an earlier `true` mark; null while not seen. */
  seenSince(episodeId: string): number | null {
    if (!this.isSeen(episodeId)) return null;
    const mark = this.marks.get(episodeId);
    const byViewing = this.seenAt.get(episodeId);
    const byMark = mark?.seen ? mark.at : undefined;
    return Math.min(byViewing ?? Infinity, byMark ?? Infinity);
  }

  /** The episodes the history knows of an item that is not (or no longer) in the catalog: with a viewing or a mark. */
  knownEpisodes(itemId: string): string[] {
    const ids = new Set((this.statsByItem.get(itemId) ?? []).flatMap((s) => (s.episodeId === null ? [] : [s.episodeId])));
    for (const m of this.marks.values()) if (m.itemId === itemId) ids.add(m.episodeId);
    return [...ids];
  }

  /**
   * `TitleSummary` of an item with a viewing or a mark; `item` is its catalog entry, when it has one. A channel has
   * no episodes to count or see: `episodes` is null, and its status is `watching` or `idle` by the 30-day rule.
   */
  title(itemId: string, item: CatalogItem | undefined) {
    const known = item ? null : this.known.get(itemId);
    const kind = item?.kind ?? known?.kind ?? null;
    const stats = this.statsByItem.get(itemId) ?? [];
    const lastWatchedAt = stats.length > 0 ? Math.max(...stats.map((s) => s.lastStartedAt)) : null;
    const watching = lastWatchedAt !== null && this.d.now() - lastWatchedAt <= WATCHING_WINDOW_MS;
    const common = {
      itemId, kind, title: item?.title ?? known?.title ?? itemId, inCatalog: item !== undefined,
      firstWatchedAt: iso(stats.length > 0 ? Math.min(...stats.map((s) => s.firstStartedAt)) : null), lastWatchedAt: iso(lastWatchedAt),
      viewings: sum(stats, (s) => s.viewings), watchedMs: sum(stats, (s) => s.watchedMs), shortViewings: sum(stats, (s) => s.shortViewings),
    };
    if (kind === "live") {
      const status: TitleStatus = watching ? "watching" : "idle";
      return { ...common, status, episodes: null, seasons: [], rewatches: 0 };
    }
    const started = new Set(stats.map((s) => s.episodeId));
    // The universe the counts are over: the item's playable episodes, or, once it left the catalog, what was seen or started.
    const episodes: Array<{ id: string; season: number | null }> = item
      ? (isLiveItem(item) ? [] : item.episodes).filter((e) => e.playbackAllowed).map((e) => ({ id: e.id, season: e.season ?? null }))
      : this.knownEpisodes(itemId).filter((id) => this.isSeen(id) || started.has(id)).map((id) => ({ id, season: this.statsByEpisode.get(id)?.season ?? null }));
    const count = (list: Array<{ id: string }>) => ({ total: list.length, seen: list.filter((e) => this.isSeen(e.id)).length, started: list.filter((e) => started.has(e.id)).length });
    const seasons = [...new Set(episodes.map((e) => e.season))].map((season) => ({ season, ...count(episodes.filter((e) => e.season === season)) }));
    const counts = count(episodes);
    const unseen = episodes.filter((e) => !this.isSeen(e.id)).map((e) => e.id);
    let status: TitleStatus = "idle";
    if (counts.total > 0 && counts.seen === counts.total) status = "finished";
    else if (item && lastWatchedAt !== null && unseen.length > 0 && unseen.every((id) => (this.firstSeen.get(id) ?? 0) > lastWatchedAt)) status = "new_episodes";
    else if (watching) status = "watching";
    return { ...common, status, episodes: counts, seasons: kind === "series" ? seasons : [], rewatches: sum(stats, (s) => Math.max(0, s.seenViewings - 1)) };
  }

  /** `EpisodeHistory` of one episode (`episode` its catalog entry, when it has one), with the ranges of its viewings. */
  episode(episodeId: string, episode: Episode | undefined, ranges: ReadonlyArray<readonly [number, number]>) {
    const stats = this.statsByEpisode.get(episodeId);
    const durationMs = episode?.durationMs ?? stats?.lastDurationMs ?? null;
    const covered = stats && durationMs ? coveredFraction(ranges, durationMs) : null;
    return {
      episodeId, season: episode?.season ?? stats?.season ?? null, number: episode?.number ?? stats?.number ?? null, title: episode?.title ?? stats?.episodeTitle ?? null,
      inCatalog: episode !== undefined, seen: this.isSeen(episodeId), seenAt: iso(this.seenSince(episodeId)), mark: this.marks.get(episodeId)?.seen ?? null,
      viewings: stats?.viewings ?? 0, watchedMs: stats?.watchedMs ?? 0, coveredFraction: covered, lastWatchedAt: iso(stats?.lastStartedAt ?? null),
      lastPositionMs: stats?.lastPositionMs ?? null,
    };
  }
}

const sum = <T>(list: T[], of: (t: T) => number) => list.reduce((acc, t) => acc + of(t), 0);

export type TitleSummary = ReturnType<HistoryView["title"]>;

/** `GET /history/titles`: the titles with a viewing or a mark, filtered by status, sorted, at most `limit`. */
export function titleSummaries(d: SummaryDeps, opts: { deviceId: string | null; statuses: readonly TitleStatus[] | null; sort: TitleSort; limit: number }): TitleSummary[] {
  const view = new HistoryView(d, opts.deviceId, null);
  const itemIds = opts.deviceId === null ? d.store.historyItemIds(d.catalog.catalogId) : [...new Set([...view.statsByItem.keys(), ...[...view.marks.values()].map((m) => m.itemId)])];
  const titles = itemIds.map((id) => view.title(id, d.catalog.item(id))).filter((t) => opts.statuses === null || opts.statuses.includes(t.status));
  const recent = (t: TitleSummary) => (t.lastWatchedAt === null ? -Infinity : Date.parse(t.lastWatchedAt));
  const order: Record<TitleSort, (a: TitleSummary, b: TitleSummary) => number> = {
    recent: (a, b) => recent(b) - recent(a) || byTitle(a.title, b.title),
    watched: (a, b) => b.watchedMs - a.watchedMs || byTitle(a.title, b.title),
    title: (a, b) => byTitle(a.title, b.title),
  };
  return titles.sort(order[opts.sort]).slice(0, opts.limit);
}

/** `GET /history/titles/:itemId`: the summary and the episodes in play order, then those that left the catalog. */
export function titleDetail(d: SummaryDeps, itemId: string, deviceId: string | null) {
  const item = d.catalog.item(itemId);
  const view = new HistoryView(d, deviceId, itemId);
  // Known to the history by an episode's viewing or mark, or (a channel) by a viewing of the item alone.
  if (!item && view.knownEpisodes(itemId).length === 0 && !view.statsByItem.has(itemId)) throw new HttpError(404, "unknown_item");
  const ranges = d.store.itemRanges(d.catalog.catalogId, deviceId, itemId);
  const catalogEpisodes = item && !isLiveItem(item) ? item.episodes : [];
  const inCatalog = new Set(catalogEpisodes.map((e) => e.id));
  const gone = view.knownEpisodes(itemId).filter((id) => !inCatalog.has(id));
  const key = (id: string) => [view.statsByEpisode.get(id)?.season ?? Infinity, view.statsByEpisode.get(id)?.number ?? Infinity, id] as const;
  gone.sort((a, b) => {
    const [sa, na, ia] = key(a);
    const [sb, nb, ib] = key(b);
    return sa - sb || na - nb || ia.localeCompare(ib);
  });
  const episodes = [
    ...catalogEpisodes.map((e) => view.episode(e.id, e, ranges.get(e.id) ?? [])),
    ...gone.map((id) => view.episode(id, undefined, ranges.get(id) ?? [])),
  ];
  return { title: view.title(itemId, item), episodes };
}

/** A formatter whose `format` gives the calendar date (`YYYY-MM-DD`) of an instant in `tz`; throws on an unknown zone. */
function dateFormatter(tz: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    throw new HttpError(400, "invalid_request", "tz must be an IANA time zone name");
  }
}

/** The UTC midnight of a `YYYY-MM-DD` date (as epoch ms); 400 for anything else. */
function parseDate(value: string, name: string): number {
  const ms = DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new HttpError(400, "invalid_request", `${name} must be a date (YYYY-MM-DD)`);
  return ms;
}

/** `GET /history/days`: one entry per calendar day (in `tz`) with a viewing, a viewing counted on the day it started. */
export function dayCounts(d: SummaryDeps, opts: { deviceId: string | null; tz: string | null; from: string | null; to: string | null }) {
  const fmt = dateFormatter(opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const dateOf = (ms: number) => fmt.format(new Date(ms));
  const toMs = opts.to === null ? parseDate(dateOf(d.now()), "to") : parseDate(opts.to, "to");
  const fromMs = opts.from === null ? toMs - (DAYS_DEFAULT - 1) * DAY_MS : parseDate(opts.from, "from");
  const span = (toMs - fromMs) / DAY_MS + 1;
  if (span < 1 || span > DAYS_MAX) throw new HttpError(400, "invalid_request", `from must not be after to, and the span at most ${DAYS_MAX} days`);
  const from = new Date(fromMs).toISOString().slice(0, 10);
  const to = new Date(toMs).toISOString().slice(0, 10);
  // A day's bounds in the zone are at most a day away from UTC's: fetch a day more on each side and bucket by the zone's date.
  const days = new Map<string, { date: string; watchedMs: number; viewings: number; items: Map<string, { itemId: string; title: string; watchedMs: number }> }>();
  for (const v of d.store.viewingsBetween(d.catalog.catalogId, opts.deviceId, fromMs - DAY_MS, toMs + 2 * DAY_MS)) {
    const date = dateOf(v.startedAt);
    if (date < from || date > to) continue;
    const day = days.get(date) ?? { date, watchedMs: 0, viewings: 0, items: new Map() };
    days.set(date, day);
    day.watchedMs += v.watchedMs;
    day.viewings += 1;
    const entry = day.items.get(v.itemId) ?? { itemId: v.itemId, title: d.catalog.item(v.itemId)?.title ?? v.itemTitle, watchedMs: 0 };
    day.items.set(v.itemId, entry);
    entry.watchedMs += v.watchedMs;
  }
  return {
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => ({
      ...day, items: [...day.items.values()].sort((a, b) => b.watchedMs - a.watchedMs || byTitle(a.title, b.title)),
    })),
  };
}
