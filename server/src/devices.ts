// The owner's side of the paired TVs (admin API): how a TV appears in the device list and on its page, what it has
// watched and is playing, settings changes, and deletion.

import { tvActor, type Actor } from "./actor.ts";
import type { Services } from "./context.ts";
import { HttpError } from "./errors.ts";
import { iso } from "./presenters.ts";
import type { ProxyService } from "./proxy.ts";
import { companionScope } from "./resolve.ts";
import type { Device, DevicePatch, NowPlaying, TvAppInfo } from "./store.ts";
import type { TvService } from "./tv.ts";

type DeviceDeps = Services & { tv: TvService; proxy: ProxyService };

/** Whether the device row already has what the TV reports. */
export function sameApp(d: Device, info: TvAppInfo): boolean {
  return d.appVersion === info.version && d.appVersionCode === info.versionCode && d.androidSdk === info.androidSdk && d.updateCapability === info.capability;
}

export class DeviceService {
  private readonly s: DeviceDeps;

  constructor(deps: DeviceDeps) {
    this.s = deps;
  }

  /** A device as the admin API shows it: status, settings (stored and effective) and recent problems. */
  view(d: Device) {
    return {
      id: d.id, name: d.name, status: d.tokenHash ? "active" : "pending", online: this.s.events.isOnline(d.id), createdAt: iso(d.createdAt),
      lastSeenAt: iso(d.lastSeenAt), stateVersion: d.stateVersion,
      settings: { uiLanguage: d.uiLanguage, preferredAudioLanguage: d.preferredAudioLanguage, subtitlesLanguage: d.subtitlesLanguage, autoplayOnStart: d.autoplayOnStart,
        homeColumns: d.homeColumns, homeRows: d.homeRows },
      effective: this.s.tv.settings(d), problems: this.s.problems.stats(d.id), app: this.app(d),
    };
  }

  /**
   * The TV's app as its User-Agent reported it, and where it stands against the stored APK: `unknown` (no report,
   * or no APK), `up_to_date`, `pending` (newer APK; the TV installs it by itself when idle) or `needs_install_now`
   * (newer APK; the TV needs the viewer, or automatic updates are off: an `update` command starts it).
   */
  app(d: Device) {
    const apk = this.s.appUpdates.current();
    let update: "unknown" | "up_to_date" | "pending" | "needs_install_now" = "unknown";
    if (d.appVersionCode !== null && apk) {
      if (d.appVersionCode >= apk.versionCode) update = "up_to_date";
      else update = d.updateCapability === "silent" && this.s.appUpdates.config.auto ? "pending" : "needs_install_now";
    }
    return { version: d.appVersion, versionCode: d.appVersionCode, androidSdk: d.androidSdk, capability: d.updateCapability, reportedAt: iso(d.appReportedAt), update };
  }

  /** Records the app a TV reports when it differs from what is stored; returns the device as it is now. */
  recordApp(d: Device, info: TvAppInfo): Device {
    const { store, eventLog, now } = this.s;
    const changed = store.transaction(() => {
      // Read again inside the transaction: two requests with the new User-Agent record it once.
      const current = store.getDevice(d.id);
      if (!current || sameApp(current, info)) return null;
      store.setDeviceApp(d.id, info, now());
      eventLog.append("device.app_version", d.id, tvActor(d.id), {
        from: current.appVersion, to: info.version, versionCode: info.versionCode, androidSdk: info.androidSdk, capability: info.capability,
      });
      return store.getDevice(d.id);
    });
    if (!changed) return d;
    this.s.log.info("device app version", { deviceId: d.id, appVersion: info.version, versionCode: info.versionCode, androidSdk: info.androidSdk, capability: info.capability });
    return changed;
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
      if (!item) return { itemId, title: null, kind: null, posterUrl: null, backdropUrl: null, missing: true, continue: null, newEpisodes: 0 };
      const { title, kind } = item;
      const continueFrom = tv.continueFor(d.id, item);
      return {
        itemId, title, kind, posterUrl: catalog.posterUrl(item), backdropUrl: catalog.backdropUrl(item), missing: false, continue: continueFrom,
        newEpisodes: tv.newEpisodesFor(d.id, item, addedAt),
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
      progress: store.listProgress(d.id, catalogId).map(({ itemId, episodeId, positionMs, durationMs, status, updatedAt }) => {
        return { itemId, episodeId, positionMs, durationMs, status, updatedAt: iso(updatedAt), ...titleOf(episodeId) };
      }),
    };
  }

  /** What the device is playing (its now-playing row `n`), with the anchor the phone's "Listen along" follows. */
  now(d: Device, n: NowPlaying | null) {
    const ref = n ? this.s.catalog.episode(n.episodeId) : undefined;
    // The running viewing, while it is the one the row reports on; null once it ended.
    const running = n ? this.s.viewings.running(d.id) : null;
    return {
      online: this.s.events.isOnline(d.id),
      serverNowMs: this.s.now(),
      seq: n?.seq ?? 0,
      nowPlaying: n && {
        itemId: n.itemId, episodeId: n.episodeId, sourceId: n.sourceId, itemTitle: ref?.item.title ?? null, episodeTitle: ref?.episode.title ?? null,
        positionMs: n.positionMs, durationMs: n.durationMs, state: n.state, updatedAt: iso(n.updatedAt), playing: n.playing,
        viewingId: running?.episodeId === n.episodeId ? running.id : null,
      },
      // Where the TV is: positionMs as of atMs (server clock), advancing at `rate` while `playing`.
      anchor: n ? { positionMs: n.positionMs, atMs: n.anchorAt ?? n.updatedAt, playing: n.playing, rate: 1 } : null,
    };
  }

  /** Applies a patch of the name (trimmed) or settings, and tells the TV. */
  update(d: Device, patch: DevicePatch, actor: Actor): Device {
    const { store, eventLog } = this.s;
    const updated = store.transaction(() => {
      const u = store.updateDevice(d.id, { ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}) })!;
      eventLog.append("device.updated", d.id, actor, { fields: Object.keys(patch) });
      return u;
    });
    this.s.notifier.state(d.id, updated.stateVersion);
    return updated;
  }

  /** Deletes the device (with everything stored for it), closes its event streams and ends its proxy sessions. */
  remove(d: Device, actor: Actor): void {
    const { store, eventLog } = this.s;
    store.transaction(() => {
      store.deleteDevice(d.id);
      eventLog.append("device.removed", d.id, actor, { name: d.name });
    });
    this.s.events.closeDevice(d.id);
    this.s.proxy.dropDevice(d.id);
    this.s.proxy.dropDevice(companionScope(d.id));
    this.s.log.info("device deleted", { deviceId: d.id });
  }

  /**
   * Gives the viewings of a deleted TV to this one (after replacing a TV the old way: delete, pair anew). 409
   * `device_exists` while `fromDeviceId` is still a device: its history is its own.
   */
  adoptHistory(d: Device, fromDeviceId: string, actor: Actor): number {
    const { store, eventLog } = this.s;
    if (store.getDevice(fromDeviceId)) throw new HttpError(409, "device_exists", "that TV still exists; delete it first");
    return store.transaction(() => {
      const moved = store.adoptViewings(fromDeviceId, d.id, d.name);
      if (moved > 0) eventLog.append("history.changed", d.id, actor, { moved });
      return moved;
    });
  }
}
