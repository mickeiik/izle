// The apps a TV can open, as it reports them, for the owner's app cards: the TV's list (in its order, with a picture
// per app), the pictures themselves (PNGs named by their SHA-256, uploaded once for all TVs and served publicly as
// posters are), and the list the admin page shows: the reported apps, then the app cards whose app the TV no longer has.

import { createHash } from "node:crypto";
import { tvActor } from "./actor.ts";
import { HttpError } from "./errors.ts";
import type { EventLog } from "./eventlog.ts";
import type { HomeService } from "./home.ts";
import type { Logger } from "./log.ts";
import { iso } from "./presenters.ts";
import type { Device, DeviceApp, Store } from "./store.ts";

/** Apps a TV's list holds at most. */
export const APPS_MAX = 200;
export const APP_LABEL_MAX = 100;
/** An app id: an Android package name. */
export const APP_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
export const APP_ID_MAX = 200;
export const APP_IMAGE_MAX_BYTES = 256 * 1024;
export const APP_IMAGE_MEDIA_TYPE = "image/png";
export const SHA256_HEX = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const isAppId = (value: string) => value.length <= APP_ID_MAX && APP_ID.test(value);

/** Where a picture is served. */
export const appImageUrl = (sha256: string) => `/app-images/${sha256}.png`;

/** An app as the admin page lists it. */
export interface AppView {
  appId: string;
  label: string;
  imageUrl: string | null;
  /** In the TV's last report. */
  installed: boolean;
  onHome: boolean;
}

interface AppDeps {
  store: Store;
  home: HomeService;
  eventLog: EventLog;
  log: Logger;
  now: () => number;
}

export class AppService {
  private readonly s: AppDeps;

  constructor(deps: AppDeps) {
    this.s = deps;
  }

  /**
   * The TV's new list (labels trimmed): stored and announced (`device.apps`) only when it differs from the stored
   * one, or the TV never sent one. Answers the pictures the server does not have yet, in the list's order.
   */
  report(d: Device, input: DeviceApp[]): { missingImages: string[] } {
    const { store, eventLog, now } = this.s;
    const apps = input.map((a) => ({ appId: a.appId, label: a.label.trim(), image: a.image }));
    const twice = apps.find((a, i) => apps.findIndex((b) => b.appId === a.appId) !== i);
    if (twice) throw new HttpError(400, "duplicate_app", "an app appears twice", { appId: twice.appId });
    const changed = store.transaction(() => {
      const current = store.getDevice(d.id);
      const before = store.getDeviceApps(d.id);
      const same = current?.appsReportedAt !== null && before.length === apps.length &&
        before.every((b, i) => b.appId === apps[i]!.appId && b.label === apps[i]!.label && b.image === apps[i]!.image);
      if (!current || same) return null;
      store.setDeviceApps(d.id, apps, now());
      const ids = new Set(apps.map((a) => a.appId));
      const was = new Set(before.map((a) => a.appId));
      const event = { count: apps.length, added: apps.filter((a) => !was.has(a.appId)).map((a) => a.appId), removed: before.filter((a) => !ids.has(a.appId)).map((a) => a.appId) };
      eventLog.append("device.apps", d.id, tvActor(d.id), event);
      return event;
    });
    if (changed) this.s.log.info("device apps", { deviceId: d.id, count: changed.count, added: changed.added.length, removed: changed.removed.length });
    const images = [...new Set(apps.flatMap((a) => (a.image === null ? [] : [a.image])))];
    const stored = store.storedAppImages(images);
    return { missingImages: images.filter((sha) => !stored.has(sha)) };
  }

  /**
   * Stores a picture the TV's last report names: a PNG (its signature) whose SHA-256 is `sha256`. 404 `not_found` when
   * the report does not name it, 400 `invalid_image` for anything else.
   */
  storeImage(d: Device, sha256: string, contentType: string | undefined, png: Uint8Array): void {
    if (!SHA256_HEX.test(sha256) || !this.s.store.deviceNamesAppImage(d.id, sha256)) throw new HttpError(404, "not_found");
    const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== APP_IMAGE_MEDIA_TYPE) throw new HttpError(400, "invalid_image", `the body must be ${APP_IMAGE_MEDIA_TYPE}`);
    if (png.byteLength < PNG_SIGNATURE.length || PNG_SIGNATURE.some((b, i) => png[i] !== b)) throw new HttpError(400, "invalid_image", "the body is not a PNG");
    if (createHash("sha256").update(png).digest("hex") !== sha256) throw new HttpError(400, "invalid_image", "the body's SHA-256 is not the one in the path");
    this.s.store.insertAppImage(sha256, png, this.s.now());
  }

  /** A stored picture, by its file name (`<sha256>.png`); null for anything else. */
  image(file: string): Uint8Array | null {
    const sha256 = file.endsWith(".png") ? file.slice(0, -4) : "";
    return SHA256_HEX.test(sha256) ? this.s.store.getAppImage(sha256) : null;
  }

  /**
   * The TV's apps for the admin page: those of its last report in its order, then the app cards on Home that report
   * does not name (with the label and picture of the last report that named them). A picture not stored has no URL.
   */
  list(d: Device): { apps: AppView[]; appsReportedAt: string | null } {
    const { store, home } = this.s;
    const reported = store.getDeviceApps(d.id);
    const cards = home.appCards(d.id);
    const onHome = new Set(cards.map((c) => c.appId));
    const named = new Set(reported.map((a) => a.appId));
    const gone = cards.filter((c) => !named.has(c.appId));
    const stored = store.storedAppImages([...new Set([...reported, ...gone].flatMap((a) => (a.image === null ? [] : [a.image])))]);
    const view = (a: { appId: string; label: string; image: string | null }, installed: boolean): AppView => ({
      appId: a.appId, label: a.label, imageUrl: a.image !== null && stored.has(a.image) ? appImageUrl(a.image) : null, installed, onHome: onHome.has(a.appId),
    });
    return { apps: [...reported.map((a) => view(a, true)), ...gone.map((a) => view(a, false))], appsReportedAt: iso(store.getDevice(d.id)?.appsReportedAt ?? null) };
  }
}
