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
import { HOME_MAX_SECTIONS, HomeService, type ExpectedSection, type HomeEntry, type Section, type SectionInput } from "../src/home.ts";
import { Store } from "../src/store.ts";
import { fakeClock, fixtureItems, publishBuild, silentLogger, tempDir, untitled, writeBundle, type Json } from "./helpers.ts";

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
  store.setHome(device.id, CATALOG, untitled(["show", "gone", "locked", "news", "off-air"]), 1);
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
  assert.deepEqual(gone, { itemId: "gone", item: null, missing: true, playable: false, continue: null, newEpisodes: 0, addedAt: 1, sectionId: "untitled" });
  assert.deepEqual(home.ids(device.id), ["show", "gone", "locked", "news", "off-air"]);
});

test("new episodes after a wrap: a finished item continues at the episode a reload added; the first load never counts", async (t) => {
  const { store, clock, catalog, home, device, publish, rows } = await setup(t);
  // On the list since the epoch: only the baseline's own "first seen" (0) could count, and it does not.
  store.setHome(device.id, CATALOG, untitled(["show"]), 0);
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

  refuses(() => home.add(device.id, "nope", {}, OWNER), 400, "unknown_item");
  refuses(() => home.add(device.id, "locked", {}, OWNER), 400, "not_playable");
  refuses(() => home.add(device.id, "off-air", {}, OWNER), 400, "not_playable");
  refuses(() => home.add(device.id, "film", {}, OWNER), 400, "duplicate_item");
  home.add(device.id, "show", { position: 0 }, OWNER);
  home.add(device.id, "news", { position: 99 }, OWNER);
  assert.deepEqual(home.ids(device.id), ["show", "film", "news"], "a position past the end is the end");

  home.move(device.id, "show", { position: 99 }, OWNER);
  assert.deepEqual(home.ids(device.id), ["film", "news", "show"], "moves clamp to the end");
  refuses(() => home.move(device.id, "silent", { position: 0 }, OWNER), 404, "not_on_home");

  refuses(() => home.remove(device.id, "silent", OWNER), 404, "not_on_home");
  assert.equal(home.remove(device.id, "news", OWNER), version());
  assert.deepEqual(home.ids(device.id), ["film", "show"]);
  assert.equal(version(), v0 + 6, "refusals bump nothing");
  assert.deepEqual(events("home.changed").at(-1), { itemIds: ["film", "show"], added: [], removed: ["news"] });
});

test("a list holding missing or unplayable items still takes edits: only items new to it are checked", async (t) => {
  const { store, home, device } = await setup(t);
  // As a catalog reload leaves a list: an item gone, items no longer playable.
  store.setHome(device.id, CATALOG, untitled(["show", "gone", "locked", "off-air"]), 1);
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

/** The sections as `[id, title, layout, itemIds]`. */
const shape = (sections: Section[]) => sections.map((s) => [s.id, s.title, s.layout, s.itemIds]);

test("sections: a new Home is the untitled section alone; sections created, retitled, laid out, moved and deleted", async (t) => {
  const { home, device, version, events } = await setup(t);
  assert.deepEqual(shape(home.sections(device.id)), [["untitled", null, "grid", []]], "a new TV has only the untitled section");
  home.set(device.id, ["show", "film", "news"], OWNER);
  const v0 = version();

  const kids = home.createSection(device.id, "  Kids  ", undefined, undefined, OWNER);
  assert.match(kids.sectionId, /^[A-Za-z0-9]{8}$/);
  assert.equal(kids.version, v0 + 1);
  const channels = home.createSection(device.id, "Channels", "row", 0, OWNER).sectionId;
  assert.deepEqual(shape(home.sections(device.id)), [
    [channels, "Channels", "row", []],
    ["untitled", null, "grid", ["show", "film", "news"]],
    [kids.sectionId, "Kids", "grid", []],
  ], "titles trimmed; a new section goes at its position, by default after the others");

  home.move(device.id, "news", { sectionId: channels }, OWNER);
  home.move(device.id, "show", { sectionId: kids.sectionId }, OWNER);
  home.add(device.id, "silent", { sectionId: kids.sectionId, position: 0 }, OWNER);
  assert.deepEqual(home.ids(device.id), ["news", "film", "silent", "show"], "Home order: the sections in order, each with its items");

  home.updateSection(device.id, "untitled", { position: 99, layout: "row" }, OWNER);
  home.updateSection(device.id, kids.sectionId, { title: "Çocuklar", position: 0 }, OWNER);
  assert.deepEqual(shape(home.sections(device.id)), [
    [kids.sectionId, "Çocuklar", "grid", ["silent", "show"]],
    [channels, "Channels", "row", ["news"]],
    ["untitled", null, "row", ["film"]],
  ]);
  const before = version();
  refuses(() => home.updateSection(device.id, "untitled", { title: "More" }, OWNER), 400, "untitled_section");
  refuses(() => home.deleteSection(device.id, "untitled", OWNER), 400, "untitled_section");
  refuses(() => home.updateSection(device.id, "nope1234", { layout: "grid" }, OWNER), 404, "unknown_section");
  refuses(() => home.deleteSection(device.id, "nope1234", OWNER), 404, "unknown_section");
  refuses(() => home.add(device.id, "filler-01", { sectionId: "nope1234" }, OWNER), 404, "unknown_section");
  refuses(() => home.move(device.id, "film", { sectionId: "nope1234" }, OWNER), 404, "unknown_section");
  refuses(() => home.add(device.id, "film", { sectionId: channels }, OWNER), 400, "duplicate_item");

  home.deleteSection(device.id, kids.sectionId, OWNER);
  assert.deepEqual(shape(home.sections(device.id)), [[channels, "Channels", "row", ["news"]], ["untitled", null, "row", ["film", "silent", "show"]]],
    "a deleted section's items go to the end of the untitled section, in their order");
  assert.equal(version(), before + 1, "refusals bump nothing");
  const changed = events("home.changed");
  assert.deepEqual(changed.at(-1), { itemIds: ["news", "film", "silent", "show"], added: [], removed: [] }, "nothing leaves Home");
  assert.deepEqual(changed[1], { itemIds: ["show", "film", "news"], added: [], removed: [] }, "a section created: a change with nothing added or removed");
});

test("sections: at most 20 besides the untitled one", async (t) => {
  const { home, device } = await setup(t);
  for (let i = 0; i < HOME_MAX_SECTIONS; i++) home.createSection(device.id, `S${i}`, undefined, undefined, OWNER);
  assert.equal(home.sections(device.id).length, HOME_MAX_SECTIONS + 1);
  assert.throws(() => home.createSection(device.id, "One more", undefined, undefined, OWNER), (err: Json) => err.code === "too_many_sections" && err.extra.max === 20);
  const sections = home.sections(device.id).map(({ id, title, itemIds }) => ({ id, title, itemIds }));
  refuses(() => home.setSections(device.id, [...sections, { title: "One more", itemIds: [] }], OWNER), 400, "too_many_sections");
  home.setSections(device.id, sections, OWNER);
  assert.equal(home.sections(device.id).length, HOME_MAX_SECTIONS + 1);
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

test("PUT {sections} replaces the whole Home: new, kept and left-out sections, the untitled one once, expected in its shape", async (t) => {
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

  const refusals: Array<[object[], number, string]> = [
    [[{ title: "X", itemIds: [] }], 400, "untitled_section"],
    [[{ id: "untitled", itemIds: [] }, { id: "untitled", itemIds: [] }], 400, "untitled_section"],
    [[{ id: "untitled", title: "More", itemIds: [] }], 400, "untitled_section"],
    [[{ id: "untitled", itemIds: [] }, { id: fresh, title: "A", itemIds: [] }, { id: fresh, title: "A", itemIds: [] }], 400, "duplicate_section"],
    [[{ id: "untitled", itemIds: [] }, { id: b, title: "B", itemIds: [] }], 404, "unknown_section"],
    [[{ id: "untitled", itemIds: [] }, { title: null, itemIds: [] }], 400, "invalid_request"],
    [[{ id: "untitled", itemIds: [] }, { id: fresh, itemIds: [] }], 400, "invalid_request"],
    [[{ id: "untitled", itemIds: ["show"] }, { id: fresh, title: "A", itemIds: ["show"] }], 400, "duplicate_item"],
    [[{ id: "untitled", itemIds: ["locked"] }], 400, "not_playable"],
    [[{ id: "untitled", itemIds: ["ghost"] }], 400, "unknown_item"],
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
