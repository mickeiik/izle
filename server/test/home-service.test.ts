// The Home list of a TV, driven directly (no HTTP): its entries as data, and what the owner's operations do beyond
// what admin.test.ts checks through the routes (new episodes and wraps: tv.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { EpisodicItem } from "@izle/contract";
import { OWNER } from "../src/actor.ts";
import { CatalogService } from "../src/catalog.ts";
import { EventLog } from "../src/eventlog.ts";
import { EventHub, Notifier } from "../src/events.ts";
import { HOME_MAX_SECTIONS, HomeService, type ExpectedSection, type Section, type SectionInput } from "../src/home.ts";
import { Store } from "../src/store.ts";
import { fakeClock, silentLogger, tempDir, untitled, writeBundle, type Json } from "./helpers.ts";

const CATALOG = "fixture";

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await tempDir();
  const store = new Store(path.join(root, "izle.db"));
  t.after(() => store.close());
  const clock = fakeClock();
  const catalog = new CatalogService(await writeBundle(path.join(root, "bundle")), silentLogger, clock.now);
  await catalog.load();
  const eventLog = new EventLog(store, silentLogger, clock.now, 30);
  const home = new HomeService({ store, catalog, eventLog, notifier: new Notifier(store, new EventHub()), now: clock.now });
  const device = store.createDevice({ id: "tv1", name: "Salon", tokenHash: null, now: clock.now() });
  return {
    store, catalog, home, device,
    version: () => store.getDevice(device.id)!.stateVersion,
    events: (type: string) => store.listEvents({ after: 0, limit: 100, types: [type] }).map((e) => e.data),
  };
}

/** Throws `HttpError(status, code)`. */
function refuses(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, (err: Json) => err.status === status && err.code === code, `${status} ${code}`);
}

/** The sections as `[id, title, layout, itemIds]`. */
const shape = (sections: Section[]) => sections.map((s) => [s.id, s.title, s.layout, s.itemIds]);

test("list: every entry in order, a missing item and unplayable ones flagged, a channel without continue or new episodes", async (t) => {
  const { store, home, device } = await setup(t);
  // Written past the owner's checks, as a catalog reload leaves a list: an item gone, items no longer playable.
  store.setHome(device.id, CATALOG, untitled(["show", "gone", "locked", "news", "off-air"]), 1);
  const list = home.list(device.id);
  assert.deepEqual(list.map((e) => [e.itemId, e.missing, e.playable, e.continue?.episodeId ?? null, e.newEpisodes]), [
    ["show", false, true, "show.e1", 0],
    ["gone", true, false, null, 0],
    ["locked", false, false, null, 0],
    ["news", false, true, null, 0],
    ["off-air", false, false, null, 0],
  ]);
  assert.equal(list[0]?.item?.id, "show");
  assert.deepEqual(list[0]?.continue, { episodeId: "show.e1", season: 1, number: 1, title: "Pilot", label: null, index: 0, count: 5, positionMs: 0, durationMs: 1_200_000, status: "new" });
  assert.deepEqual(list[1], { itemId: "gone", item: null, missing: true, playable: false, continue: null, newEpisodes: 0, addedAt: 1, sectionId: "untitled" });
  assert.deepEqual(home.ids(device.id), ["show", "gone", "locked", "news", "off-air"]);
});

test("a list holding missing or unplayable items still takes edits: only items new to it are checked; refusals bump nothing", async (t) => {
  const { store, home, device, version } = await setup(t);
  store.setHome(device.id, CATALOG, untitled(["show", "gone", "locked", "off-air"]), 1);
  const v0 = version();
  home.remove(device.id, "show", OWNER);
  home.move(device.id, "gone", { position: 2 }, OWNER);
  home.add(device.id, "film", { position: 0 }, OWNER);
  home.set(device.id, ["film", "locked", "off-air", "gone"], OWNER, ["film", "locked", "off-air", "gone"]);
  assert.deepEqual(home.ids(device.id), ["film", "locked", "off-air", "gone"]);
  home.remove(device.id, "gone", OWNER);
  refuses(() => home.add(device.id, "gone", {}, OWNER), 400, "unknown_item");
  refuses(() => home.add(device.id, "locked", {}, OWNER), 400, "duplicate_item");
  home.remove(device.id, "locked", OWNER);
  refuses(() => home.add(device.id, "locked", {}, OWNER), 400, "not_playable");
  home.remove(device.id, "off-air", OWNER);
  refuses(() => home.add(device.id, "off-air", {}, OWNER), 400, "not_playable");
  assert.equal(version(), v0 + 7);
});

test("setCursor: forgets the episode's saved position and bumps the version; a channel has no cursor", async (t) => {
  const { store, catalog, home, device, version } = await setup(t);
  store.upsertProgress(device.id, { catalogId: CATALOG, itemId: "show", episodeId: "show.e4", positionMs: 30_000, durationMs: 60_000, status: "watching", updatedAt: 1 });
  const v0 = version();
  assert.equal(home.setCursor(device.id, "show", "show.e4", OWNER), v0 + 1);
  assert.equal(store.getProgress(device.id, CATALOG, "show.e4"), null);
  const cont = home.continueFor(device.id, catalog.item("show") as EpisodicItem);
  assert.deepEqual([cont?.episodeId, cont?.positionMs, cont?.status], ["show.e4", 0, "new"], "starts over");
  refuses(() => home.setCursor(device.id, "news", "news", OWNER), 400, "unknown_episode");
  refuses(() => home.setCursor(device.id, "show", "show.e3", OWNER), 400, "not_allowed");
  assert.equal(version(), v0 + 1);
});

test("PUT {itemIds} keeps the sections: an item stays in its section, a new one goes to the untitled one", async (t) => {
  const { home, device, events } = await setup(t);
  const top = home.createSection(device.id, "Top", undefined, 0, OWNER).sectionId;
  const empty = home.createSection(device.id, "Empty", "row", undefined, OWNER).sectionId;
  home.set(device.id, ["show", "film", "news"], OWNER);
  home.move(device.id, "news", { sectionId: top }, OWNER);
  home.move(device.id, "film", { sectionId: top, position: 0 }, OWNER);
  assert.deepEqual(home.ids(device.id), ["film", "news", "show"]);

  // Reordered, "film" left out, "silent" and "filler-01" new: each section follows the body's order.
  home.set(device.id, ["silent", "news", "show", "filler-01"], OWNER, ["film", "news", "show"]);
  assert.deepEqual(shape(home.sections(device.id)), [[top, "Top", "grid", ["news"]], ["untitled", null, "grid", ["silent", "show", "filler-01"]], [empty, "Empty", "row", []]]);
  assert.deepEqual(events("home.changed").at(-1), { itemIds: ["news", "silent", "show", "filler-01"], added: ["silent", "filler-01"], removed: ["film"] });
  assert.throws(
    () => home.set(device.id, [], OWNER, ["silent", "news", "show", "filler-01"]),
    (err: Json) => err.status === 409 && err.code === "home_changed" && err.extra.itemIds.join() === "news,silent,show,filler-01" && err.extra.sections.length === 3,
    "expected is the list in Home order; the conflict answers it and the sections",
  );
  home.set(device.id, [], OWNER);
  assert.deepEqual(home.sections(device.id).map((s) => s.id), [top, "untitled", empty], "an empty Home keeps its sections");
});

test("PUT {sections} replaces the whole Home: new, kept and left-out sections, expected compared in its shape", async (t) => {
  const { home, device, events } = await setup(t);
  const a = home.createSection(device.id, "A", "row", undefined, OWNER).sectionId;
  const b = home.createSection(device.id, "B", undefined, undefined, OWNER).sectionId;
  home.set(device.id, ["show", "film"], OWNER);
  home.move(device.id, "film", { sectionId: b }, OWNER);
  const seen = home.sections(device.id);

  home.setSections(device.id, [
    { title: "New", itemIds: ["news"] },
    { id: a, title: " A2 ", itemIds: ["film"] },
    { id: "untitled", itemIds: ["show"], layout: "row" },
  ], OWNER, seen as ExpectedSection[]);
  const after = home.sections(device.id);
  const fresh = after[0]!.id;
  assert.deepEqual(shape(after), [[fresh, "New", "grid", ["news"]], [a, "A2", "row", ["film"]], ["untitled", null, "row", ["show"]]],
    "a new section is grid by default, a kept one keeps its layout, B is deleted");
  assert.match(fresh, /^[A-Za-z0-9]{8}$/);
  assert.deepEqual(events("home.changed").at(-1), { itemIds: ["news", "film", "show"], added: ["news"], removed: [] });

  // A section left out takes its items off Home unless another lists them.
  home.setSections(device.id, [{ id: "untitled", title: null, itemIds: ["show", "film"] }, { id: fresh, title: "New", itemIds: [] }], OWNER);
  assert.deepEqual(events("home.changed").at(-1), { itemIds: ["show", "film"], added: [], removed: ["news"] });
  const now = home.sections(device.id);

  const stale = (expected: object[]) => refuses(() => home.setSections(device.id, [{ id: "untitled", itemIds: [] }], OWNER, expected as never), 409, "home_changed");
  stale(after);
  stale(now.map((s) => ({ ...s, title: s.id === fresh ? "Old" : s.title })));
  stale(now.map((s) => ({ ...s, layout: "row" })));
  stale(now.slice(1));
  stale(now.map((s) => ({ ...s, itemIds: [...s.itemIds].reverse() })));
  // Title and layout are compared only when given.
  home.setSections(device.id, now as SectionInput[], OWNER, now.map(({ id, itemIds }) => ({ id, itemIds })));

  const many = Array.from({ length: HOME_MAX_SECTIONS + 1 }, (_, i) => ({ title: `S${i}`, itemIds: [] }));
  const refusals: Array<[object[], number, string]> = [
    [[{ id: "untitled", itemIds: [] }, { id: "untitled", itemIds: [] }], 400, "untitled_section"],
    [[{ id: "untitled", title: "More", itemIds: [] }], 400, "untitled_section"],
    [[{ id: "untitled", itemIds: [] }, { title: null, itemIds: [] }], 400, "invalid_request"],
    [[{ id: "untitled", itemIds: [] }, { id: fresh, itemIds: [] }], 400, "invalid_request"],
    [[{ id: "untitled", itemIds: ["locked"] }], 400, "not_playable"],
    [[{ id: "untitled", itemIds: ["ghost"] }], 400, "unknown_item"],
    [[{ id: "untitled", itemIds: [] }, ...many], 400, "too_many_sections"],
  ];
  for (const [body, status, code] of refusals) refuses(() => home.setSections(device.id, body as never, OWNER), status, code);
  assert.deepEqual(shape(home.sections(device.id)), shape(now), "refusals change nothing");
});

test("moving an item: within its section by default, to the end of another, or to a position there", async (t) => {
  const { home, device } = await setup(t);
  const s = home.createSection(device.id, "S", undefined, undefined, OWNER).sectionId;
  home.set(device.id, ["show", "film", "silent", "news"], OWNER);
  home.move(device.id, "show", { sectionId: s }, OWNER);
  home.move(device.id, "film", { sectionId: s }, OWNER);
  assert.deepEqual(shape(home.sections(device.id)), [["untitled", null, "grid", ["silent", "news"]], [s, "S", "grid", ["show", "film"]]], "the end by default");
  home.move(device.id, "news", { sectionId: s, position: 1 }, OWNER);
  home.move(device.id, "film", { sectionId: s }, OWNER);
  assert.deepEqual(home.sections(device.id)[1]!.itemIds, ["show", "news", "film"], "its own section without a position: it stays");
  home.move(device.id, "film", { position: 0 }, OWNER);
  home.move(device.id, "silent", { sectionId: "untitled", position: 5 }, OWNER);
  assert.deepEqual(shape(home.sections(device.id)), [["untitled", null, "grid", ["silent"]], [s, "S", "grid", ["film", "show", "news"]]]);
  home.remove(device.id, "show", OWNER);
  assert.deepEqual(home.ids(device.id), ["silent", "film", "news"]);
});
