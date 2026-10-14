// The owner's side of the paired TVs (admin API): how a TV appears in the device list and on its page, what it has
// watched and is playing, settings changes, and deletion.

import type { Services } from "./context.ts";
import { iso } from "./presenters.ts";
import type { ProxyService } from "./proxy.ts";
import { companionScope } from "./resolve.ts";
import type { Device, DevicePatch, NowPlaying } from "./store.ts";
import type { TvService } from "./tv.ts";

type DeviceDeps = Services & { tv: TvService; proxy: ProxyService };

export class DeviceService {
  private readonly s: DeviceDeps;

  constructor(deps: DeviceDeps) {
    this.s = deps;
  }

  /** A device as the admin API shows it: status, settings (stored and effective) and recent problems. */
  view(d: Device) {
    return {
      id: d.id,
      name: d.name,
      status: d.tokenHash ? "active" : "pending",
      online: this.s.events.isOnline(d.id),
      createdAt: iso(d.createdAt),
      lastSeenAt: iso(d.lastSeenAt),
      stateVersion: d.stateVersion,
      settings: {
        uiLanguage: d.uiLanguage,
        preferredAudioLanguage: d.preferredAudioLanguage,
        subtitlesLanguage: d.subtitlesLanguage,
        autoplayOnStart: d.autoplayOnStart,
      },
      effective: this.s.tv.settings(d),
      problems: this.s.problems.stats(d.id),
    };
  }

  /** Every device, with the length of its home list. */
  list() {
    const { store, catalog } = this.s;
    return store.listDevices().map((d) => ({ ...this.view(d), homeCount: store.getHomeEntries(d.id, catalog.catalogId).length }));
  }

  /** The device's home list with what OK would play; items gone from the catalog stay and are flagged `missing`. */
  home(d: Device) {
    const { store, catalog, tv } = this.s;
    return store.getHomeEntries(d.id, catalog.catalogId).map(({ itemId, addedAt }) => {
      const item = catalog.item(itemId);
      return {
        itemId,
        title: item?.title ?? null,
        kind: item?.kind ?? null,
        posterUrl: item ? catalog.posterUrl(item) : null,
        missing: !item,
        continue: item ? tv.continueFor(d.id, item) : null,
        newEpisodes: item ? tv.newEpisodesFor(d.id, item, addedAt) : 0,
      };
    });
  }

  /** The device's cursors and saved positions, with titles from the loaded catalog (`missing` when the episode is gone). */
  progress(d: Device) {
    const { store, catalog } = this.s;
    const catalogId = catalog.catalogId;
    const titleOf = (episodeId: string) => {
      const ref = catalog.episode(episodeId);
      return ref
        ? { itemTitle: ref.item.title, kind: ref.item.kind, season: ref.episode.season ?? null, number: ref.episode.number ?? null, episodeTitle: ref.episode.title ?? null }
        : { missing: true };
    };
    return {
      cursors: store.listCursors(d.id, catalogId).map((cur) => ({ itemId: cur.itemId, episodeId: cur.episodeId, updatedAt: iso(cur.updatedAt), ...titleOf(cur.episodeId) })),
      progress: store.listProgress(d.id, catalogId).map((p) => ({
        itemId: p.itemId,
        episodeId: p.episodeId,
        positionMs: p.positionMs,
        durationMs: p.durationMs,
        status: p.status,
        updatedAt: iso(p.updatedAt),
        ...titleOf(p.episodeId),
      })),
    };
  }

  /** What the device is playing (its now-playing row `n`), with the anchor the phone's "Listen along" follows. */
  now(d: Device, n: NowPlaying | null) {
    const ref = n ? this.s.catalog.episode(n.episodeId) : undefined;
    return {
      online: this.s.events.isOnline(d.id),
      serverNowMs: this.s.now(),
      seq: n?.seq ?? 0,
      nowPlaying: n
        ? {
            itemId: n.itemId,
            episodeId: n.episodeId,
            sourceId: n.sourceId,
            itemTitle: ref?.item.title ?? null,
            episodeTitle: ref?.episode.title ?? null,
            positionMs: n.positionMs,
            durationMs: n.durationMs,
            state: n.state,
            updatedAt: iso(n.updatedAt),
            playing: n.playing,
          }
        : null,
      // Where the TV is: positionMs as of atMs (server clock), advancing at `rate` while `playing`.
      anchor: n ? { positionMs: n.positionMs, atMs: n.anchorAt ?? n.updatedAt, playing: n.playing, rate: 1 } : null,
    };
  }

  /** Applies a patch of the name (trimmed) or settings, and tells the TV. */
  update(d: Device, patch: DevicePatch): Device {
    const updated = this.s.store.updateDevice(d.id, { ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) })!;
    this.s.notifier.state(d.id, updated.stateVersion);
    return updated;
  }

  /** Deletes the device (with everything stored for it), closes its event streams and ends its proxy sessions. */
  remove(d: Device): void {
    this.s.store.deleteDevice(d.id);
    this.s.events.closeDevice(d.id);
    this.s.proxy.dropDevice(d.id);
    this.s.proxy.dropDevice(companionScope(d.id));
    this.s.log.info("device deleted", { deviceId: d.id });
  }
}
