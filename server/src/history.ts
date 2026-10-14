import type { LoadedCatalog } from "./catalog.ts";
import type { Logger } from "./log.ts";
import type { CatalogBuild, CatalogChanges, SeenEpisode, Store } from "./store.ts";

/** The longest each list in a build's changes gets; the counts on the build stay exact. */
export const CHANGES_CAP = 500;

const cap = <T>(list: T[]): T[] => list.slice(0, CHANGES_CAP);

type ChangeCounts = Pick<CatalogBuild, "itemsAdded" | "itemsRemoved" | "episodesAdded" | "episodesRemoved">;

function buildRow(next: LoadedCatalog, baseline: boolean, counts: ChangeCounts): CatalogBuild {
  const { catalogId, buildId, builtAt } = next.manifest;
  return { catalogId, buildId, builtAt, loadedAt: next.loadedAt, baseline, items: next.items.length, episodes: next.episodesById.size, ...counts };
}

/**
 * Records every catalog build the server loads, and when each episode first appeared, so that episodes added by a
 * later build can be told apart from those that were always there. Runs synchronously from the catalog's load hook.
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
   * or a reload of the same build) changes nothing. The first load of a catalog id is its baseline: every episode is
   * stored as seen at 0, so none of them ever counts as new. `previous` (same catalog id only) supplies the titles of
   * what was removed. Returns the recorded build, or null when it was skipped.
   */
  record(next: LoadedCatalog, previous: LoadedCatalog | null): CatalogBuild | null {
    const { catalogId, buildId } = next.manifest;
    const build = this.store.transaction(() => {
      if (this.store.listCatalogBuilds(catalogId, 1)[0]?.buildId === buildId) return null;
      const seen = this.store.catalogSeen(catalogId);
      return seen.length === 0 ? this.baseline(next) : this.update(next, previous?.manifest.catalogId === catalogId ? previous : null, seen);
    });
    if (build) {
      const { baseline, itemsAdded, itemsRemoved, episodesAdded, episodesRemoved } = build;
      this.log.info("catalog build recorded", { catalogId, buildId, baseline, itemsAdded, itemsRemoved, episodesAdded, episodesRemoved });
    }
    return build;
  }

  private baseline(next: LoadedCatalog): CatalogBuild {
    const { catalogId, buildId } = next.manifest;
    this.store.insertSeen(catalogId, buildId, 0, next.items.flatMap((item) => item.episodes.map((e) => ({ episodeId: e.id, itemId: item.id }))));
    const build = buildRow(next, true, { itemsAdded: 0, itemsRemoved: 0, episodesAdded: 0, episodesRemoved: 0 });
    this.store.recordCatalogBuild(build, { items: { added: [], removed: [] }, episodes: { added: [], removed: [] } });
    return build;
  }

  private update(next: LoadedCatalog, previous: LoadedCatalog | null, seen: SeenEpisode[]): CatalogBuild {
    const { catalogId, buildId } = next.manifest;
    const known = new Map(seen.map((s) => [s.episodeId, s]));
    // Items count as present while at least one of their episodes is (every item has one). Before: the seen state;
    // after this record: exactly the items of `next`.
    const presentBefore = new Set(seen.filter((s) => s.removedAt === null).map((s) => s.itemId));
    const titleOf = (itemId: string) => previous?.itemsById.get(itemId)?.title ?? next.itemsById.get(itemId)?.title ?? null;

    const added: CatalogChanges["episodes"]["added"] = [];
    const returning: string[] = [];
    const moved: Array<{ episodeId: string; itemId: string }> = [];
    for (const item of next.items) {
      for (const episode of item.episodes) {
        const s = known.get(episode.id);
        if (!s) {
          added.push({
            id: episode.id,
            itemId: item.id,
            itemTitle: item.title,
            season: episode.season ?? null,
            number: episode.number ?? null,
            label: episode.label ?? null,
            playbackAllowed: episode.playbackAllowed,
          });
          continue;
        }
        // A returning episode keeps its first-seen date: it is not new to anyone who saw it before.
        if (s.removedAt !== null) returning.push(episode.id);
        if (s.itemId !== item.id) moved.push({ episodeId: episode.id, itemId: item.id });
      }
    }
    const removed = seen.filter((s) => s.removedAt === null && !next.episodesById.has(s.episodeId));
    const itemsAdded = next.items.filter((item) => !presentBefore.has(item.id));
    const itemsRemoved = [...presentBefore].filter((id) => !next.itemsById.has(id));

    this.store.insertSeen(catalogId, buildId, next.loadedAt, added.map((e) => ({ episodeId: e.id, itemId: e.itemId })));
    this.store.clearSeenRemoved(catalogId, returning);
    this.store.moveSeen(catalogId, moved);
    this.store.markSeenRemoved(catalogId, removed.map((s) => s.episodeId), next.loadedAt);

    const changes: CatalogChanges = {
      items: {
        added: cap(itemsAdded).map((item) => ({ id: item.id, title: item.title, kind: item.kind })),
        removed: cap(itemsRemoved).map((id) => ({ id, title: titleOf(id) })),
      },
      episodes: {
        added: cap(added),
        removed: cap(removed).map((s) => ({ id: s.episodeId, itemId: s.itemId, itemTitle: titleOf(s.itemId) })),
      },
    };
    const build = buildRow(next, false, {
      itemsAdded: itemsAdded.length,
      itemsRemoved: itemsRemoved.length,
      episodesAdded: added.length,
      episodesRemoved: removed.length,
    });
    this.store.recordCatalogBuild(build, changes);
    return build;
  }
}
