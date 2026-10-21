// The Home list of a TV, driven directly (no HTTP): its entries as data, new episodes after a wrap, and the owner's
// operations on it with their refusals.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { EpisodicItem } from "@izle/contract";
import { OWNER } from "../src/actor.ts";
import { CatalogService } from "../src/catalog.ts";
import { EventLog } from "../src/eventlog.ts";
import { EventHub, Notifier } from "../src/events.ts";
import { CatalogHistory } from "../src/history.ts";
import { HomeService, type HomeEntry } from "../src/home.ts";
import { Store } from "../src/store.ts";
import { fakeClock, fixtureItems, publishBuild, silentLogger, tempDir, writeBundle, type Json } from "./helpers.ts";

const CATALOG = "fixture";

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await tempDir();
  const store = new Store(path.join(root, "izle.db"));
  t.after(() => store.close());
  const clock = fakeClock();
  const history = new CatalogHistory(store, silentLogger);
  const bundleDir = await writeBundle(path.join(root, "bundle"));
  const catalog = new CatalogService(bundleDir, silentLogger, clock.now, null, { onLoaded: (next, previous) => void history.record(next, previous) });
  await catalog.load();
  const eventLog = new EventLog(store, silentLogger, clock.now, 30);
  const home = new HomeService({ store, catalog, eventLog, notifier: new Notifier(store, new EventHub()), now: clock.now });
  const device = store.createDevice({ id: "tv1", name: "Salon", tokenHash: null, now: clock.now() });
  return {
    store, clock, catalog, home, device,
    publish: publishBuild.bind(null, bundleDir),
    /** The entries as `[itemId, missing, playable, continue's episode, newEpisodes]`. */
    rows: () => home.list(device.id).map((e: HomeEntry) => [e.itemId, e.missing, e.playable, e.continue?.episodeId ?? null, e.newEpisodes]),
    version: () => store.getDevice(device.id)!.stateVersion,
    events: (type: string) => store.listEvents({ after: 0, limit: 100, types: [type] }).map((e) => e.data),
  };
}

/** Throws `HttpError(status, code)`. */
function refuses(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, (err: Json) => err.status === status && err.code === code, `${status} ${code}`);
}

test("list: every entry in order, a missing item and unplayable ones flagged, a channel without continue or new episodes", async (t) => {
  const { store, home, device, rows } = await setup(t);
  // Written past the owner's checks, as a catalog reload leaves a list: an item gone, items no longer playable.
  store.setHome(device.id, CATALOG, ["show", "gone", "locked", "news", "off-air"], 1);
  assert.deepEqual(rows(), [
    ["show", false, true, "show.e1", 0],
    ["gone", true, false, null, 0],
    ["locked", false, false, null, 0],
    ["news", false, true, null, 0],
    ["off-air", false, false, null, 0],
  ]);
  const [show, gone] = home.list(device.id);
  assert.equal(show?.item?.id, "show");
  assert.deepEqual(show?.continue, { episodeId: "show.e1", season: 1, number: 1, title: "Pilot", label: null, index: 0, count: 5, positionMs: 0, durationMs: 1_200_000, status: "new" });
  assert.deepEqual(gone, { itemId: "gone", item: null, missing: true, playable: false, continue: null, newEpisodes: 0, addedAt: 1 });
  assert.deepEqual(home.ids(device.id), ["show", "gone", "locked", "news", "off-air"]);
});

test("new episodes after a wrap: a finished item continues at the episode a reload added; the first load never counts", async (t) => {
  const { store, clock, catalog, home, device, publish, rows } = await setup(t);
  // On the list since the epoch: only the baseline's own "first seen" (0) could count, and it does not.
  store.setHome(device.id, CATALOG, ["show"], 0);
  assert.deepEqual(rows(), [["show", false, true, "show.e1", 0]], "the first load is the baseline");

  clock.advance(60_000);
  const t1 = clock.now();
  store.upsertProgress(device.id, { catalogId: CATALOG, itemId: "show", episodeId: "show.e5", positionMs: 1000, durationMs: 1000, status: "finished", updatedAt: t1 });
  store.setCursor(device.id, { catalogId: CATALOG, itemId: "show", episodeId: "show.e1", updatedAt: t1, wrapped: true });
  assert.deepEqual(rows(), [["show", false, true, "show.e1", 0]], "watched to the end: OK starts it again");

  clock.advance(60_000);
  const e6 = { ...fixtureItems().items[0].episodes.at(-1), id: "show.e6", season: 3, number: 1 };
  await publish("fixture-2", (items: Json[]) => items.map((i) => (i.id === "show" ? { ...i, episodes: [...i.episodes, e6] } : i)));
  assert.equal((await catalog.reload()).ok, true);
  assert.deepEqual(rows(), [["show", false, true, "show.e6", 1]]);
  const cont = home.continueFor(device.id, catalog.item("show") as EpisodicItem);
  assert.deepEqual([cont?.episodeId, cont?.index, cont?.count, cont?.status], ["show.e6", 5, 6, "new"]);
});

test("set, add, move, remove: the expected-list check, the refusals, clamping, each a new state version and a home.changed", async (t) => {
  const { home, device, version, events } = await setup(t);
  const v0 = version();
  assert.equal(home.set(device.id, ["show", "film"], OWNER), v0 + 1);
  refuses(() => home.set(device.id, ["film"], OWNER, ["show"]), 409, "home_changed");
  assert.equal(home.set(device.id, ["film"], OWNER, ["show", "film"]), v0 + 2);

  refuses(() => home.add(device.id, "nope", undefined, OWNER), 400, "unknown_item");
  refuses(() => home.add(device.id, "locked", undefined, OWNER), 400, "not_playable");
  refuses(() => home.add(device.id, "off-air", undefined, OWNER), 400, "not_playable");
  refuses(() => home.add(device.id, "film", undefined, OWNER), 400, "duplicate_item");
  home.add(device.id, "show", 0, OWNER);
  home.add(device.id, "news", 99, OWNER);
  assert.deepEqual(home.ids(device.id), ["show", "film", "news"], "a position past the end is the end");

  home.move(device.id, "show", 99, OWNER);
  assert.deepEqual(home.ids(device.id), ["film", "news", "show"], "moves clamp to the end");
  refuses(() => home.move(device.id, "silent", 0, OWNER), 404, "not_on_home");

  refuses(() => home.remove(device.id, "silent", OWNER), 404, "not_on_home");
  assert.equal(home.remove(device.id, "news", OWNER), version());
  assert.deepEqual(home.ids(device.id), ["film", "show"]);
  assert.equal(version(), v0 + 6, "refusals bump nothing");
  assert.deepEqual(events("home.changed").at(-1), { itemIds: ["film", "show"], added: [], removed: ["news"] });
});

test("setCursor: forgets the episode's saved position and bumps the version; a channel has no cursor", async (t) => {
  const { store, catalog, home, device, version, events } = await setup(t);
  store.upsertProgress(device.id, { catalogId: CATALOG, itemId: "show", episodeId: "show.e4", positionMs: 30_000, durationMs: 60_000, status: "watching", updatedAt: 1 });
  const v0 = version();
  assert.equal(home.setCursor(device.id, "show", "show.e4", OWNER), v0 + 1);
  assert.equal(store.getProgress(device.id, CATALOG, "show.e4"), null);
  const cont = home.continueFor(device.id, catalog.item("show") as EpisodicItem);
  assert.deepEqual([cont?.episodeId, cont?.positionMs, cont?.status], ["show.e4", 0, "new"], "starts over");
  assert.deepEqual(events("cursor.changed"), [{ itemId: "show", episodeId: "show.e4" }]);

  refuses(() => home.setCursor(device.id, "news", "news", OWNER), 400, "unknown_episode");
  refuses(() => home.setCursor(device.id, "show", "film.main", OWNER), 400, "unknown_episode");
  refuses(() => home.setCursor(device.id, "show", "show.e3", OWNER), 400, "not_allowed");
  refuses(() => home.setCursor(device.id, "nope", "x", OWNER), 404, "unknown_item");
  assert.equal(version(), v0 + 1);
});
