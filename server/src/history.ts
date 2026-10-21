import { isLiveItem, type EpisodicItem, type LiveItem } from "@izle/contract";
import type { LoadedCatalog } from "./catalog.ts";
import type { Logger } from "./log.ts";
import type { CatalogBuild, CatalogChanges, SeenEpisode, SeenItem, Store } from "./store.ts";

/** The longest each list in a build's changes gets; the counts on the build stay exact. */
const CHANGES_CAP = 500;

const cap = <T>(list: T[]): T[] => list.slice(0, CHANGES_CAP);

type ChangeCounts = Pick<CatalogBuild, "itemsAdded" | "itemsRemoved" | "episodesAdded" | "episodesRemoved">;

function buildRow(next: LoadedCatalog, baseline: boolean, counts: ChangeCounts): CatalogBuild {
  const { catalogId, buildId, builtAt } = next.manifest;
  return { catalogId, buildId, builtAt, loadedAt: next.loadedAt, baseline, items: next.items.length, episodes: next.episodesById.size, ...counts };
}

/** The items of a catalog by what the history tracks: the episodes of movies and series, and channels by their id. */
function split(next: LoadedCatalog): { episodic: EpisodicItem[]; channels: LiveItem[] } {
  const episodic: EpisodicItem[] = [];
  const channels: LiveItem[] = [];
  for (const item of next.items) {
    if (isLiveItem(item)) channels.push(item);
    else episodic.push(item);
  }
  return { episodic, channels };
}

/**
 * Records every catalog build the server loads, and when each episode (and each channel, which has none) first
 * appeared, so that what a later build added can be told apart from what was always there. Runs synchronously from
 * the catalog's load hook.
 */
export class CatalogHistory {
  private readonly store: Store;
  private readonly log: Logger;

  constructor(store: Store, log: Logger) {
    this.store = store;
    this.log = log;
  }

  /**
   * Records `next` against the history of its catalog id. A build id equal to the latest recorded one (a restart,
   * or a reload of the same build) changes nothing. The first load of a catalog id is its baseline: every episode
   * and channel is stored as seen at 0, so none of them ever counts as new. `previous` (same catalog id only)
   * supplies the titles of what was removed. Returns the recorded build, or null when it was skipped.
   */
  record(next: LoadedCatalog, previous: LoadedCatalog | null): CatalogBuild | null {
    const { catalogId, buildId } = next.manifest;
    const build = this.store.transaction(() => {
      if (this.store.listCatalogBuilds(catalogId, 1)[0]?.buildId === buildId) return null;
      const seen = this.store.catalogSeen(catalogId);
      const seenItems = this.store.catalogSeenItems(catalogId);
      const fresh = seen.length === 0 && seenItems.length === 0;
      return fresh ? this.baseline(next) : this.update(next, previous?.manifest.catalogId === catalogId ? previous : null, seen, seenItems);
    });
    if (build) {
      const { baseline, itemsAdded, itemsRemoved, episodesAdded, episodesRemoved } = build;
      this.log.info("catalog build recorded", { catalogId, buildId, baseline, itemsAdded, itemsRemoved, episodesAdded, episodesRemoved });
    }
    return build;
  }

  private baseline(next: LoadedCatalog): CatalogBuild {
    const { catalogId, buildId } = next.manifest;
    const { episodic, channels } = split(next);
    this.store.insertSeen(catalogId, buildId, 0, episodic.flatMap((item) => item.episodes.map((e) => ({ episodeId: e.id, itemId: item.id }))));
    this.store.insertSeenItems(catalogId, buildId, 0, channels.map((c) => c.id));
    const build = buildRow(next, true, { itemsAdded: 0, itemsRemoved: 0, episodesAdded: 0, episodesRemoved: 0 });
    this.store.recordCatalogBuild(build, { items: { added: [], removed: [] }, episodes: { added: [], removed: [] } });
    return build;
  }

  private update(next: LoadedCatalog, previous: LoadedCatalog | null, seen: SeenEpisode[], seenItems: SeenItem[]): CatalogBuild {
    const { catalogId, buildId } = next.manifest;
    const { episodic, channels } = split(next);
    const known = new Map(seen.map((s) => [s.episodeId, s]));
    const knownItems = new Map(seenItems.map((s) => [s.itemId, s]));
    // Items count as present while at least one of their episodes is (every item has one), channels while their row
    // is. Before: the seen state; after this record: exactly the items of `next`.
    const presentBefore = new Set([...seen.filter((s) => s.removedAt === null).map((s) => s.itemId), ...seenItems.filter((s) => s.removedAt === null).map((s) => s.itemId)]);
    const titleOf = (itemId: string) => previous?.itemsById.get(itemId)?.title ?? next.itemsById.get(itemId)?.title ?? null;

    const added: CatalogChanges["episodes"]["added"] = [];
    const returning: string[] = [];
    const moved: Array<{ episodeId: string; itemId: string }> = [];
    for (const item of episodic) {
      for (const episode of item.episodes) {
        const s = known.get(episode.id);
        if (!s) {
          const { season = null, number = null, label = null, playbackAllowed } = episode;
          added.push({ id: episode.id, itemId: item.id, itemTitle: item.title, season, number, label, playbackAllowed });
          continue;
        }
        // A returning episode keeps its first-seen date: it is not new to anyone who saw it before.
        if (s.removedAt !== null) returning.push(episode.id);
        if (s.itemId !== item.id) moved.push({ episodeId: episode.id, itemId: item.id });
      }
    }
    const removed = seen.filter((s) => s.removedAt === null && !next.episodesById.has(s.episodeId));
    // Channels, by their item id: new ones, ones back after an absence, and ones gone (or no longer a channel).
    const channelIds = new Set(channels.map((c) => c.id));
    const newChannels = channels.filter((c) => !knownItems.has(c.id)).map((c) => c.id);
    const returningChannels = channels.filter((c) => knownItems.get(c.id)?.removedAt != null).map((c) => c.id);
    const removedChannels = seenItems.filter((s) => s.removedAt === null && !channelIds.has(s.itemId)).map((s) => s.itemId);
    const itemsAdded = next.items.filter((item) => !presentBefore.has(item.id));
    const itemsRemoved = [...presentBefore].filter((id) => !next.itemsById.has(id));

    this.store.insertSeen(catalogId, buildId, next.loadedAt, added.map((e) => ({ episodeId: e.id, itemId: e.itemId })));
    this.store.clearSeenRemoved(catalogId, returning);
    this.store.moveSeen(catalogId, moved);
    this.store.markSeenRemoved(catalogId, removed.map((s) => s.episodeId), next.loadedAt);
    this.store.insertSeenItems(catalogId, buildId, next.loadedAt, newChannels);
    this.store.clearSeenItemsRemoved(catalogId, returningChannels);
    this.store.markSeenItemsRemoved(catalogId, removedChannels, next.loadedAt);

    const changes: CatalogChanges = {
      items: {
        added: cap(itemsAdded).map((item) => ({ id: item.id, title: item.title, kind: item.kind })),
        removed: cap(itemsRemoved).map((id) => ({ id, title: titleOf(id) })),
      },
      episodes: { added: cap(added), removed: cap(removed).map((s) => ({ id: s.episodeId, itemId: s.itemId, itemTitle: titleOf(s.itemId) })) },
    };
    const counts = { itemsAdded: itemsAdded.length, itemsRemoved: itemsRemoved.length, episodesAdded: added.length, episodesRemoved: removed.length };
    const build = buildRow(next, false, counts);
    this.store.recordCatalogBuild(build, changes);
    return build;
  }
}
