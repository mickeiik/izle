// The owner's side of the paired TVs (admin API): the device list and page, settings changes, and deletion.

import { tvActor, type Actor } from "./actor.ts";
import type { AppUpdateService } from "./app-updates.ts";
import { isLiveItem, type CatalogItem } from "@izle/contract";
import { liveRef, type CatalogService, type PlayableRef, type PlayingKey } from "./catalog.ts";
import type { ServerConfig } from "./config.ts";
import type { CheckSummary, SourceChecker } from "./diagnostics.ts";
import { HttpError } from "./errors.ts";
import type { EventLog } from "./eventlog.ts";
import type { EventHub, Notifier } from "./events.ts";
import type { HomeService } from "./home.ts";
import type { Logger } from "./log.ts";
import type { Current } from "./playing.ts";
import { iso } from "./presenters.ts";
import type { ProblemService } from "./problems.ts";
import type { ProxyService } from "./proxy.ts";
import { companionScope } from "./resolve.ts";
import type { Device, DevicePatch, Store, TvAppInfo } from "./store.ts";

interface DeviceDeps {
  config: ServerConfig;
  store: Store;
  catalog: CatalogService;
  events: EventHub;
  notifier: Notifier;
  eventLog: EventLog;
  problems: ProblemService;
  appUpdates: AppUpdateService;
  home: HomeService;
  proxy: ProxyService;
  checker: Pick<SourceChecker, "summaries">;
  log: Logger;
  now: () => number;
}

/** The stored checks of every allowed episode of a show: the worst verdict, counts and the oldest check; null for a channel. */
function checkAllOf(item: CatalogItem, check: (ref: PlayableRef) => CheckSummary) {
  if (isLiveItem(item)) return null;
  const allowed = item.episodes.flatMap((episode, index) => (episode.playbackAllowed ? [check({ kind: "episode", item, episode, index })] : []));
  const checked = allowed.filter((s) => s !== null);
  const failed = checked.filter((s) => s.verdict === "fail").length;
  const warned = checked.filter((s) => s.verdict === "warn").length;
  const verdict = checked.length === 0 ? null : failed > 0 ? "fail" : warned > 0 ? "warn" : "ok";
  const oldest = checked.map((s) => s.checkedAt).sort()[0] ?? null;
  return { verdict, checked: checked.length, total: allowed.length, failed, warned, oldestCheckedAt: oldest };
}

/** The device's settings, falling back to the server's defaults, then to the catalog's hints (what the TV gets). */
export function effectiveSettings(device: Device, config: ServerConfig, catalog: CatalogService) {
  const hints = catalog.current.manifest.defaults ?? {};
  const ui = device.uiLanguage ?? config.defaults.uiLanguage ?? hints.uiLanguage ?? "en";
  return {
    uiLanguage: ui === "tr" ? ("tr" as const) : ("en" as const),
    preferredAudioLanguage: device.preferredAudioLanguage ?? config.defaults.preferredAudioLanguage ?? hints.preferredAudioLanguage ?? null,
    subtitlesLanguage: device.subtitlesLanguage,
    autoplayOnStart: device.autoplayOnStart,
    homeColumns: device.homeColumns,
    homeRows: device.homeRows,
  };
}

export function sameApp(d: Device, info: TvAppInfo): boolean {
  return d.appVersion === info.version && d.appVersionCode === info.versionCode && d.androidSdk === info.androidSdk && d.updateCapability === info.capability;
}

export class DeviceService {
  private readonly s: DeviceDeps;

  constructor(deps: DeviceDeps) {
    this.s = deps;
  }

  /** A device as the admin API shows it: status, settings (stored and effective), recent problems and its app. */
  view(d: Device) {
    return {
      id: d.id, name: d.name, status: d.tokenHash ? "active" : "pending", online: this.s.events.isOnline(d.id), createdAt: iso(d.createdAt),
      lastSeenAt: iso(d.lastSeenAt), stateVersion: d.stateVersion,
      settings: { uiLanguage: d.uiLanguage, preferredAudioLanguage: d.preferredAudioLanguage, subtitlesLanguage: d.subtitlesLanguage, autoplayOnStart: d.autoplayOnStart,
        homeColumns: d.homeColumns, homeRows: d.homeRows },
      effective: effectiveSettings(d, this.s.config, this.s.catalog), problems: this.s.problems.stats(d.id), app: this.app(d),
    };
  }

  /**
   * Where the TV's app stands against the stored APK: `pending` when the TV installs the newer one by itself when idle,
   * `needs_install_now` when it needs the viewer or automatic updates are off (an `update` command starts it).
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
    // Read again inside the transaction: two requests with the new User-Agent record it once.
    const changed = store.transaction(() => {
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

  list() {
    return this.s.store.listDevices().map((d) => ({ ...this.view(d), homeCount: this.s.home.ids(d.id).length }));
  }

  /**
   * The device's home list with what OK would play and its stored check (`checkAll`: every allowed episode's); items
   * gone from the catalog stay and are flagged `missing`.
   */
  home(d: Device) {
    const { catalog } = this.s;
    const entries = this.s.home.list(d.id);
    const check = this.s.checker.summaries(entries.map((e) => e.itemId));
    return entries.map(({ itemId, item, missing, playable, continue: cont, newEpisodes }) => {
      const card = item
        ? { title: item.title, kind: item.kind, posterUrl: catalog.posterUrl(item), backdropUrl: catalog.backdropUrl(item) }
        : { title: null, kind: null, posterUrl: null, backdropUrl: null };
      // What OK plays: the continue episode, or the channel itself when it may play.
      const plays = !item ? undefined : isLiveItem(item) ? (item.playbackAllowed ? liveRef(item) : undefined) : cont ? catalog.episode(cont.episodeId) : undefined;
      return { itemId, ...card, missing, playable, continue: cont, newEpisodes, check: plays ? check(plays) : null, checkAll: item ? checkAllOf(item, check) : null };
    });
  }

  /** The device's cursors and saved positions, with titles from the loaded catalog. */
  progress(d: Device) {
    const { store, catalog } = this.s;
    const catalogId = catalog.catalogId;
    const titlesOf = (key: PlayingKey) => {
      const { itemTitle, itemKind, season, number, episodeTitle, missing } = catalog.describe(key);
      return missing ? { missing } : { itemTitle, kind: itemKind, season, number, episodeTitle };
    };
    return {
      cursors: store.listCursors(d.id, catalogId).map((cur) => ({ itemId: cur.itemId, episodeId: cur.episodeId, updatedAt: iso(cur.updatedAt), ...titlesOf(cur) })),
      progress: store.listProgress(d.id, catalogId).map(({ itemId, episodeId, positionMs, durationMs, status, updatedAt }) =>
        ({ itemId, episodeId, positionMs, durationMs, status, updatedAt: iso(updatedAt), ...titlesOf({ itemId, episodeId }) })),
    };
  }

  /** What the device is playing, with the anchor the phone's "Listen along" follows (none for a channel). */
  now(d: Device, n: Current | null) {
    const about = n && this.s.catalog.describe(n);
    return {
      online: this.s.events.isOnline(d.id),
      serverNowMs: this.s.now(),
      seq: n?.seq ?? 0,
      nowPlaying: n && about && {
        itemId: n.itemId, itemKind: about.itemKind, episodeId: n.episodeId, sourceId: n.sourceId, itemTitle: about.itemTitle, episodeTitle: about.episodeTitle,
        positionMs: n.positionMs, durationMs: n.durationMs, state: n.state, updatedAt: iso(n.updatedAt), playing: n.playing,
        viewingId: n.viewingId,
      },
      // Where the TV is: positionMs as of atMs (server clock), advancing at `rate` while `playing`.
      anchor: n && n.positionMs !== null ? { positionMs: n.positionMs, atMs: n.anchorAt, playing: n.playing, rate: 1 } : null,
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

  /** Gives the viewings of a deleted TV to this one (after replacing a TV the old way: delete, pair anew). */
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
