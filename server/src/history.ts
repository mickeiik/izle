import { isLiveItem, type EpisodicItem } from "@izle/contract";
import type { LoadedCatalog } from "./catalog.ts";
import type { Logger } from "./log.ts";
import type { CatalogBuild, CatalogChanges, SeenEpisode, SeenItem, Store } from "./store.ts";

/** The longest each list in a build's changes gets; the counts on the build stay exact. */
const CHANGES_CAP = 500;

const cap = <T>(list: T[]): T[] => list.slice(0, CHANGES_CAP);

function buildRow(next: LoadedCatalog, baseline: boolean, counts: Pick<CatalogBuild, "itemsAdded" | "itemsRemoved" | "episodesAdded" | "episodesRemoved">): CatalogBuild {
  const { catalogId, buildId, builtAt } = next.manifest;
  return { catalogId, buildId, builtAt, loadedAt: next.loadedAt, baseline, items: next.items.length, episodes: next.episodesById.size, ...counts };
}

/**
 * Records every catalog build the server loads, and when each episode (and each channel, by its item id) first
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
   * Records `next`; a build id equal to the latest recorded one (a restart, a reload of the same build) changes
   * nothing. The first load of a catalog id is its baseline: everything is seen at 0, so nothing in it ever counts as
   * new. `previous` (same catalog id only) supplies the titles of what was removed. Null when skipped.
   */
  record(next: LoadedCatalog, previous: LoadedCatalog | null): CatalogBuild | null {
    const { catalogId, buildId } = next.manifest;
    const build = this.store.transaction(() => {
      if (this.store.listCatalogBuilds(catalogId, 1)[0]?.buildId === buildId) return null;
      const seen = this.store.catalogSeen(catalogId);
      const seenItems = this.store.catalogSeenItems(catalogId);
      if (seen.length === 0 && seenItems.length === 0) return this.baseline(next);
      return this.update(next, previous?.manifest.catalogId === catalogId ? previous : null, seen, seenItems);
    });
    if (build) {
      const { baseline, itemsAdded, itemsRemoved, episodesAdded, episodesRemoved } = build;
      this.log.info("catalog build recorded", { catalogId, buildId, baseline, itemsAdded, itemsRemoved, episodesAdded, episodesRemoved });
    }
    return build;
  }

  private baseline(next: LoadedCatalog): CatalogBuild {
    const { catalogId, buildId } = next.manifest;
    const episodic = next.items.filter((i): i is EpisodicItem => !isLiveItem(i));
    this.store.insertSeen(catalogId, buildId, 0, episodic.flatMap((item) => item.episodes.map((e) => ({ episodeId: e.id, itemId: item.id }))));
    this.store.insertSeenItems(catalogId, buildId, 0, next.items.filter(isLiveItem).map((c) => c.id));
    const build = buildRow(next, true, { itemsAdded: 0, itemsRemoved: 0, episodesAdded: 0, episodesRemoved: 0 });
    this.store.recordCatalogBuild(build, { items: { added: [], removed: [] }, episodes: { added: [], removed: [] } });
    return build;
  }

  private update(next: LoadedCatalog, previous: LoadedCatalog | null, seen: SeenEpisode[], seenItems: SeenItem[]): CatalogBuild {
    const { catalogId, buildId } = next.manifest;
    const channels = next.items.filter(isLiveItem);
    const known = new Map(seen.map((s) => [s.episodeId, s]));
    const knownItems = new Map(seenItems.map((s) => [s.itemId, s]));
    // Items count as present while one of their episodes is (every item has one), channels while their row is.
    const presentBefore = new Set([...seen, ...seenItems].filter((s) => s.removedAt === null).map((s) => s.itemId));
    const titleOf = (itemId: string) => previous?.itemsById.get(itemId)?.title ?? next.itemsById.get(itemId)?.title ?? null;

    const added: CatalogChanges["episodes"]["added"] = [];
    const returning: string[] = [];
    const moved: Array<{ episodeId: string; itemId: string }> = [];
    for (const item of next.items) {
      if (isLiveItem(item)) continue;
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
    const channelIds = new Set(channels.map((c) => c.id));
    const itemsAdded = next.items.filter((item) => !presentBefore.has(item.id));
    const itemsRemoved = [...presentBefore].filter((id) => !next.itemsById.has(id));

    this.store.insertSeen(catalogId, buildId, next.loadedAt, added.map((e) => ({ episodeId: e.id, itemId: e.itemId })));
    this.store.setSeenRemoved(catalogId, returning, null);
    this.store.moveSeen(catalogId, moved);
    this.store.setSeenRemoved(catalogId, removed.map((s) => s.episodeId), next.loadedAt);
    // Channels: new ones, ones back after an absence, and ones gone (or no longer a channel).
    this.store.insertSeenItems(catalogId, buildId, next.loadedAt, channels.filter((c) => !knownItems.has(c.id)).map((c) => c.id));
    this.store.setSeenRemoved(catalogId, channels.filter((c) => knownItems.get(c.id)?.removedAt != null).map((c) => c.id), null, true);
    const removedChannels = seenItems.filter((s) => s.removedAt === null && !channelIds.has(s.itemId)).map((s) => s.itemId);
    this.store.setSeenRemoved(catalogId, removedChannels, next.loadedAt, true);

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
