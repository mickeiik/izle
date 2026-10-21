// The Home list of each TV, bound to the catalog: its entries as data (what OK would play on each, the new episodes,
// whether the item left the catalog or cannot play) and the owner's operations on it (the whole list, one item
// added, moved or removed, the "continue from" override). The TV's state (tv.ts) and the admin page (devices.ts)
// are two projections of `list`: the TV drops what it cannot play, the admin page flags it.

import { isLiveItem, type CatalogItem, type EpisodicItem } from "@izle/contract";
import type { Actor } from "./actor.ts";
import type { CatalogService } from "./catalog.ts";
import { HttpError } from "./errors.ts";
import type { EventLog } from "./eventlog.ts";
import type { Notifier } from "./events.ts";
import { requireEpisodicItem, requirePlayable } from "./lookup.ts";
import { cursorIndex, isPlayable } from "./playback.ts";
import { episodeSummary } from "./presenters.ts";
import type { Cursor, Progress, Store } from "./store.ts";

/** A technical safety limit on every device's home list, not a product rule: Home scrolls past one screen. */
export const HOME_MAX_ITEMS = 200;

/** Per-TV home grid: cards per row and rows per screen (the owner's setting; the defaults are migration 8's). */
export const HOME_COLUMNS = { min: 3, max: 6, default: 4 } as const;
export const HOME_ROWS = { min: 1, max: 4, default: 2 } as const;

/** What the device saved about one item: positions by episode, the play cursor, and the episodes new since a time. */
interface ItemFacts {
  progress: Map<string, Progress>;
  cursor: Cursor | null;
  /** The item's present episodes that first appeared after `sinceMs`, oldest first. */
  seenAfter: (sinceMs: number) => string[];
}

/** The episode OK plays for an item and where it starts. */
export interface Continue {
  episodeId: string;
  season: number | null;
  number: number | null;
  title: string | null;
  label: string | null;
  index: number;
  count: number;
  positionMs: number;
  durationMs: number | null;
  status: Progress["status"] | "new";
}

/** One entry of a TV's home list, as data: what OK would play and whether it can. */
export interface HomeEntry {
  itemId: string;
  /** The catalog item; null when it left the catalog (`missing`). */
  item: CatalogItem | null;
  missing: boolean;
  playable: boolean;
  /** What OK plays and where it starts; null for a channel or when nothing is playable. */
  continue: Continue | null;
  newEpisodes: number;
  addedAt: number | null;
}

interface HomeDeps {
  store: Store;
  catalog: CatalogService;
  eventLog: EventLog;
  notifier: Notifier;
  now: () => number;
}

export class HomeService {
  private readonly s: HomeDeps;

  constructor(deps: HomeDeps) {
    this.s = deps;
  }

  /**
   * The device's home list in display order, every entry: items gone after a catalog reload are `missing`, items
   * nothing of which may play are not `playable`. A channel has no `continue` and no new episodes.
   */
  list(deviceId: string): HomeEntry[] {
    const { store, catalog } = this.s;
    const factsFor = this.homeFacts(deviceId);
    return store.getHomeEntries(deviceId, catalog.catalogId).map(({ itemId, addedAt }) => {
      const item = catalog.item(itemId);
      if (!item) return { itemId, item: null, missing: true, playable: false, continue: null, newEpisodes: 0, addedAt };
      const entry = { itemId, item, missing: false, playable: isPlayable(item), continue: null, newEpisodes: 0, addedAt };
      if (isLiveItem(item)) return entry;
      const facts = factsFor(item.id);
      return { ...entry, continue: this.continueWith(item, facts), newEpisodes: this.newEpisodesWith(item, addedAt, facts) };
    });
  }

  /** What OK would play for the item on this device right now; null when nothing is playable. */
  continueFor(deviceId: string, item: EpisodicItem): Continue | null {
    return this.continueWith(item, this.itemFacts(deviceId, item.id));
  }

  /** The hidden menu's view of an item on this device: the saved position of each episode, and what OK would play. */
  itemProgress(deviceId: string, item: EpisodicItem): { progress: ReadonlyMap<string, Progress>; continue: Continue | null } {
    const facts = this.itemFacts(deviceId, item.id);
    return { progress: facts.progress, continue: this.continueWith(item, facts) };
  }

  /** The device's home list as item ids, in display order (items gone from the catalog included). */
  ids(deviceId: string): string[] {
    return this.s.store.getHomeEntries(deviceId, this.s.catalog.catalogId).map((e) => e.itemId);
  }

  /**
   * Replaces the home list; returns the new state version. With `expected` (the list the caller saw), answers 409
   * `home_changed` when the list is no longer that, so two editors do not overwrite each other.
   */
  set(deviceId: string, itemIds: string[], actor: Actor, expected?: string[]): number {
    if (itemIds.length > HOME_MAX_ITEMS) {
      throw new HttpError(400, "too_many_items", `a home list holds at most ${HOME_MAX_ITEMS} items`, { max: HOME_MAX_ITEMS });
    }
    const seen = new Set<string>();
    for (const id of itemIds) {
      if (seen.has(id)) throw new HttpError(400, "duplicate_item", "an item appears twice", { itemId: id });
      seen.add(id);
      const item = this.s.catalog.item(id);
      if (!item) throw new HttpError(400, "unknown_item", "no such item in the catalog", { itemId: id });
      if (!isPlayable(item)) throw new HttpError(400, "not_playable", "the item has no episode with playback allowed, or is a channel whose playback is not allowed", { itemId: id });
    }
    this.s.store.transaction(() => {
      const before = this.ids(deviceId);
      if (expected && (before.length !== expected.length || before.some((id, i) => id !== expected[i]))) {
        throw new HttpError(409, "home_changed", "the home list changed in the meantime", { itemIds: before });
      }
      this.s.store.setHome(deviceId, this.s.catalog.catalogId, itemIds, this.s.now());
      const was = new Set(before);
      const is = new Set(itemIds);
      this.s.eventLog.append("home.changed", deviceId, actor, { itemIds, added: itemIds.filter((id) => !was.has(id)), removed: before.filter((id) => !is.has(id)) });
    });
    return this.s.notifier.bump(deviceId);
  }

  /** Puts the item at `position` (0-based; default and upper bound: the end). Like every single change, through `set`. */
  add(deviceId: string, itemId: string, position: number | undefined, actor: Actor): number {
    const ids = this.ids(deviceId);
    ids.splice(Math.min(position ?? ids.length, ids.length), 0, itemId);
    return this.set(deviceId, ids, actor);
  }

  /** Moves an item of the list to `position` (clamped to the end). */
  move(deviceId: string, itemId: string, position: number, actor: Actor): number {
    const ids = this.without(deviceId, itemId);
    ids.splice(Math.min(position, ids.length), 0, itemId);
    return this.set(deviceId, ids, actor);
  }

  remove(deviceId: string, itemId: string, actor: Actor): number {
    return this.set(deviceId, this.without(deviceId, itemId), actor);
  }

  /**
   * Owner override "continue from episode X": moves the cursor (an ordinary one, so it wins over episodes added
   * after a wrap) and forgets X's saved position so it starts over. A channel has no cursor (400 `unknown_episode`).
   */
  setCursor(deviceId: string, itemId: string, episodeId: string, actor: Actor): number {
    const item = requireEpisodicItem(this.s.catalog, itemId, 404, "unknown_item");
    const episode = item.episodes.find((e) => e.id === episodeId);
    if (!episode) throw new HttpError(400, "unknown_episode", "the episode does not belong to this item");
    requirePlayable(episode, 400, "not_allowed");
    const catalogId = this.s.catalog.catalogId;
    this.s.store.transaction(() => {
      this.s.store.setCursor(deviceId, { catalogId, itemId, episodeId, updatedAt: this.s.now() });
      this.s.store.deleteProgress(deviceId, catalogId, episodeId);
      this.s.eventLog.append("cursor.changed", deviceId, actor, { itemId, episodeId });
    });
    return this.s.notifier.bump(deviceId);
  }

  /** The list without the item; 404 `not_on_home` when it is not on it. */
  private without(deviceId: string, itemId: string): string[] {
    const ids = this.ids(deviceId);
    if (!ids.includes(itemId)) throw new HttpError(404, "not_on_home", "the item is not on this TV's home list");
    return ids.filter((id) => id !== itemId);
  }

  /** What the device saved about one item, a few queries. */
  private itemFacts(deviceId: string, itemId: string): ItemFacts {
    const { store, catalog } = this.s;
    const catalogId = catalog.catalogId;
    return {
      progress: new Map(store.listProgress(deviceId, catalogId, itemId).map((p) => [p.episodeId, p])),
      cursor: store.getCursor(deviceId, catalogId, itemId),
      seenAfter: (sinceMs) => store.episodesSeenAfter(catalogId, itemId, sinceMs),
    };
  }

  /**
   * The same facts for every item of a device's home list (up to HOME_MAX_ITEMS), read in three queries rather than
   * a few per item.
   */
  private homeFacts(deviceId: string): (itemId: string) => ItemFacts {
    const { store, catalog } = this.s;
    const catalogId = catalog.catalogId;
    const progress = new Map<string, Map<string, Progress>>();
    for (const p of store.listProgress(deviceId, catalogId)) {
      const byEpisode = progress.get(p.itemId) ?? new Map<string, Progress>();
      progress.set(p.itemId, byEpisode.set(p.episodeId, p));
    }
    const cursors = new Map(store.listCursors(deviceId, catalogId).map((c) => [c.itemId, c]));
    const seen = store.listSeen(catalogId);
    return (itemId) => ({
      progress: progress.get(itemId) ?? new Map(),
      cursor: cursors.get(itemId) ?? null,
      seenAfter: (sinceMs) => (seen.get(itemId) ?? []).filter((e) => e.firstSeenAt > sinceMs).map((e) => e.episodeId),
    });
  }

  /**
   * The episode OK would play for this item and where it would start. Null when nothing is playable. After the
   * item was watched to the end (a wrapped cursor), episodes the catalog gained since then come first.
   */
  private continueWith(item: EpisodicItem, facts: ItemFacts): Continue | null {
    const { progress, cursor } = facts;
    const appended = cursor?.wrapped ? new Set(facts.seenAfter(cursor.updatedAt)) : undefined;
    const index = cursorIndex(item, cursor, progress, appended);
    if (index < 0) return null;
    const episode = item.episodes[index]!;
    const p = progress.get(episode.id);
    const status = p?.status ?? "new";
    const positionMs = status === "watching" ? p!.positionMs : 0;
    const durationMs = p?.durationMs ?? episode.durationMs ?? null;
    return { episodeId: episode.id, ...episodeSummary(episode), index, count: item.episodes.length, positionMs, durationMs, status };
  }

  /**
   * How many episodes of the item with playbackAllowed entered the catalog after both the device's last progress
   * report on the item and the moment the item went on its home list (`addedAt`). Episodes of the first load of
   * the catalog (the history's baseline) never count.
   */
  private newEpisodesWith(item: EpisodicItem, addedAt: number | null, facts: ItemFacts): number {
    const lastProgressAt = Math.max(0, ...[...facts.progress.values()].map((p) => p.updatedAt));
    const added = facts.seenAfter(Math.max(lastProgressAt, addedAt ?? 0));
    const allowed = new Set(item.episodes.filter((e) => e.playbackAllowed).map((e) => e.id));
    return added.filter((id) => allowed.has(id)).length;
  }
}
