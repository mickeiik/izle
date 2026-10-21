// The viewing history's owner side: the owner's seen marks and the deletion of viewings. The TV side (a viewing
// starts with a successful resolve, follows the TV's reports and ends with a stop, a finish, another resolve or
// silence) lives with the now-playing row in playing.ts, which owns what a TV is playing. Every change appends its
// event in its own transaction.

import type { Actor } from "./actor.ts";
import type { CatalogService } from "./catalog.ts";
import type { EventLog } from "./eventlog.ts";
import { HttpError } from "./errors.ts";
import type { Store } from "./store.ts";

/** What a TV may say started a playback (`POST /tv/resolve`); without it the viewing's trigger is `unknown`. */
export const VIEWING_TRIGGERS = ["viewer", "autoplay", "next", "command"] as const;
export type ResolveTrigger = (typeof VIEWING_TRIGGERS)[number];

interface ViewingDeps {
  store: Store;
  catalog: CatalogService;
  eventLog: EventLog;
  now: () => number;
}

export class ViewingService {
  private readonly s: ViewingDeps;

  constructor(deps: ViewingDeps) {
    this.s = deps;
  }

  /**
   * The owner's word on episodes (`seen: null` removes it); each must be in the catalog or the history. Returns how
   * many. A channel's item id is no episode id: channels are never marked.
   */
  setMarks(episodeIds: readonly string[], seen: boolean | null, actor: Actor): number {
    const { store, catalog } = this.s;
    const catalogId = catalog.catalogId;
    const entries = new Map<string, { episodeId: string; itemId: string }>();
    for (const episodeId of episodeIds) {
      const itemId = catalog.episode(episodeId)?.item.id ?? store.historyEpisodeItem(catalogId, episodeId) ?? store.getMark(catalogId, episodeId)?.itemId;
      if (itemId === undefined || itemId === null) throw new HttpError(400, "unknown_episode", "the episode is neither in the catalog nor in the history", { episodeId });
      entries.set(episodeId, { episodeId, itemId });
    }
    store.transaction(() => {
      store.setMarks(catalogId, [...entries.values()], seen, this.s.now());
      this.s.eventLog.append("history.changed", null, actor, { episodeIds: [...entries.keys()], seen });
    });
    return entries.size;
  }

  /** Deletes the viewings of a TV (when given) started before `olderThan` (when given), running ones too. */
  deleteViewings(deviceId: string | null, olderThan: number | null, actor: Actor): number {
    return this.s.store.transaction(() => {
      const deleted = this.s.store.deleteViewings(this.s.catalog.catalogId, deviceId, olderThan);
      this.s.eventLog.append("history.changed", deviceId, actor, { deleted });
      return deleted;
    });
  }

  /** Deletes one viewing; false when there is none with this id. */
  deleteViewing(id: number, actor: Actor): boolean {
    return this.s.store.transaction(() => {
      const v = this.s.store.getViewing(id);
      if (!v) return false;
      this.s.store.deleteViewing(id);
      this.s.eventLog.append("history.changed", v.deviceId, actor, { deleted: 1 });
      return true;
    });
  }
}
