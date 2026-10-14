import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { CatalogService, type CatalogLoadedHook } from "../src/catalog.ts";
import { CatalogHistory, CHANGES_CAP } from "../src/history.ts";
import { createLogger } from "../src/log.ts";
import { Store } from "../src/store.ts";
import { fakeClock, fixtureItems, publishBuild, tempDir, writeBundle, type Json } from "./helpers.ts";

const CATALOG = "fixture";

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await tempDir();
  const store = new Store(path.join(root, "izle.db"));
  t.after(() => store.close());
  const clock = fakeClock();
  const logs: string[] = [];
  const log = createLogger({ level: "debug", write: (l) => void logs.push(l), now: clock.now });
  const history = new CatalogHistory(store, log);
  const bundleDir = await writeBundle(path.join(root, "bundle"));
  /** A catalog service on the test bundle whose loads are recorded (a new one = a server restart). */
  const service = (onLoaded: CatalogLoadedHook = (next, previous) => void history.record(next, previous)) =>
    new CatalogService(bundleDir, log, clock.now, null, { onLoaded });
  const publish = publishBuild.bind(null, bundleDir);
  const builds = (catalogId = CATALOG) => store.listCatalogBuilds(catalogId, 50);
  const seenAt = (episodeId: string, catalogId = CATALOG) => store.catalogSeen(catalogId).find((e) => e.episodeId === episodeId);
  return { store, clock, logs, service, publish, builds, seenAt };
}

/** A playable episode shaped like the fixture's last episode of "show". */
const episode = (id: string, number: number): Json => ({ ...fixtureItems().items[0].episodes.at(-1), id, season: 3, number });
const withShowEpisode = (id: string, number: number) => (items: Json[]) =>
  items.map((i) => (i.id === "show" ? { ...i, episodes: [...i.episodes, episode(id, number)] } : i));
const without = (...ids: string[]) => (items: Json[]) =>
  items.filter((i) => !ids.includes(i.id)).map((i) => ({ ...i, episodes: i.episodes.filter((e: Json) => !ids.includes(e.id)) }));

test("baseline: the first load of a catalog id records every episode as always there", async (t) => {
  const { store, clock, service, builds, seenAt } = await setup(t);
  const catalog = service();
  await catalog.load();
  const fixture = fixtureItems().items as Json[];
  const episodes = fixture.reduce((n, i) => n + i.episodes.length, 0);

  assert.deepEqual(builds(), [
    {
      catalogId: CATALOG,
      buildId: "fixture-1",
      builtAt: "2026-10-10T12:00:00Z",
      loadedAt: clock.now(),
      baseline: true,
      items: fixture.length,
      episodes,
      itemsAdded: 0,
      itemsRemoved: 0,
      episodesAdded: 0,
      episodesRemoved: 0,
    },
  ]);
  assert.deepEqual(store.getCatalogBuild(CATALOG, "fixture-1")?.changes, { items: { added: [], removed: [] }, episodes: { added: [], removed: [] } });
  const seen = store.catalogSeen(CATALOG);
  assert.equal(seen.length, episodes);
  assert.ok(seen.every((e) => e.firstSeenAt === 0 && e.removedAt === null && e.buildId === "fixture-1"));
  assert.equal(seenAt("show.e4")?.itemId, "show");
  assert.deepEqual(store.episodesSeenAfter(CATALOG, "show", 0), [], "baseline episodes never count as new");
});

test("append: a later build's episodes and items are seen at its load time", async (t) => {
  const { store, clock, service, publish, builds, seenAt } = await setup(t);
  const catalog = service();
  await catalog.load();
  clock.advance(60_000);
  await publish("fixture-2", (items) => [
    ...withShowEpisode("show.e6", 4)(items),
    { id: "newshow", kind: "series", title: "Yeni Dizi", poster: null, episodes: [episode("newshow.e1", 1), { ...episode("newshow.e2", 2), playbackAllowed: false, sources: [] }] },
  ]);
  assert.equal((await catalog.reload()).ok, true);

  const [latest, first] = builds();
  assert.equal(first?.buildId, "fixture-1");
  assert.deepEqual(
    { ...latest, loadedAt: latest?.loadedAt === clock.now() },
    { catalogId: CATALOG, buildId: "fixture-2", builtAt: "2026-10-10T12:00:00Z", loadedAt: true, baseline: false, items: 17, episodes: 23, itemsAdded: 1, itemsRemoved: 0, episodesAdded: 3, episodesRemoved: 0 },
  );
  const { changes } = store.getCatalogBuild(CATALOG, "fixture-2")!;
  assert.deepEqual(changes.items, { added: [{ id: "newshow", title: "Yeni Dizi", kind: "series" }], removed: [] });
  assert.deepEqual(changes.episodes.removed, []);
  assert.deepEqual(changes.episodes.added, [
    { id: "show.e6", itemId: "show", itemTitle: "Şov Dünyası", season: 3, number: 4, label: null, playbackAllowed: true },
    { id: "newshow.e1", itemId: "newshow", itemTitle: "Yeni Dizi", season: 3, number: 1, label: null, playbackAllowed: true },
    { id: "newshow.e2", itemId: "newshow", itemTitle: "Yeni Dizi", season: 3, number: 2, label: null, playbackAllowed: false },
  ], "in catalog order");
  assert.deepEqual(store.episodesSeenAfter(CATALOG, "show", 0), ["show.e6"]);
  assert.deepEqual(store.episodesSeenAfter(CATALOG, "show", clock.now()), []);
  assert.deepEqual(seenAt("show.e6"), { episodeId: "show.e6", itemId: "show", firstSeenAt: clock.now(), buildId: "fixture-2", removedAt: null });
  assert.equal(seenAt("show.e1")?.firstSeenAt, 0);
});

test("remove and return: an episode that comes back keeps its first-seen date and is not new again", async (t) => {
  const { store, clock, service, publish, seenAt } = await setup(t);
  const catalog = service();
  await catalog.load();

  clock.advance(1_000);
  const t2 = clock.now();
  await publish("fixture-2", (items) => without("film", "show.e5")(withShowEpisode("show.e6", 4)(items)));
  await catalog.reload();
  const b2 = store.getCatalogBuild(CATALOG, "fixture-2")!;
  assert.deepEqual([b2.build.itemsRemoved, b2.build.episodesRemoved, b2.build.episodesAdded], [1, 2, 1]);
  assert.deepEqual(b2.changes.items.removed, [{ id: "film", title: "Film" }], "the title comes from the catalog loaded before");
  assert.deepEqual(b2.changes.episodes.removed, [
    { id: "film.main", itemId: "film", itemTitle: "Film" },
    { id: "show.e5", itemId: "show", itemTitle: "Şov Dünyası" },
  ]);
  assert.equal(seenAt("show.e5")?.removedAt, t2);

  clock.advance(1_000);
  const t3 = clock.now();
  await publish("fixture-3"); // film and show.e5 are back, show.e6 is gone
  await catalog.reload();
  const b3 = store.getCatalogBuild(CATALOG, "fixture-3")!;
  assert.deepEqual(b3.changes.episodes.added, [], "returning episodes are not listed as added");
  assert.deepEqual(b3.changes.items.added, [{ id: "film", title: "Film", kind: "movie" }], "a show whose episodes all came back is in the catalog again");
  assert.deepEqual(b3.changes.episodes.removed, [{ id: "show.e6", itemId: "show", itemTitle: "Şov Dünyası" }]);
  assert.deepEqual([seenAt("show.e5")?.firstSeenAt, seenAt("show.e5")?.removedAt], [0, null]);
  assert.deepEqual([seenAt("show.e6")?.firstSeenAt, seenAt("show.e6")?.removedAt], [t2, t3]);
  assert.deepEqual(store.episodesSeenAfter(CATALOG, "show", 0), [], "a removed episode does not count");

  clock.advance(1_000);
  await publish("fixture-4", withShowEpisode("show.e6", 4));
  await catalog.reload();
  const b4 = store.getCatalogBuild(CATALOG, "fixture-4")!;
  assert.deepEqual([b4.build.episodesAdded, b4.build.episodesRemoved, b4.build.itemsAdded], [0, 0, 0]);
  assert.deepEqual(seenAt("show.e6"), { episodeId: "show.e6", itemId: "show", firstSeenAt: t2, buildId: "fixture-2", removedAt: null });
  assert.deepEqual(store.episodesSeenAfter(CATALOG, "show", 0), ["show.e6"]);
});

test("the same build loaded twice is recorded once; a restart on a new build has no titles for removals", async (t) => {
  const { store, clock, logs, service, publish, builds } = await setup(t);
  const catalog = service();
  await catalog.load();
  clock.advance(1_000);
  assert.equal((await catalog.reload()).ok, true);
  await service().load(); // a restart
  assert.deepEqual(builds().map((b) => [b.buildId, b.baseline, b.loadedAt]), [["fixture-1", true, Date.parse("2026-10-10T12:00:00Z")]]);
  assert.equal(logs.filter((l) => JSON.parse(l).msg === "catalog build recorded").length, 1);

  // The bundle changed while the server was down: the history still has the episodes, not the old titles.
  clock.advance(1_000);
  await publish("fixture-2", without("film"));
  await service().load();
  const b2 = store.getCatalogBuild(CATALOG, "fixture-2")!;
  assert.equal(b2.build.baseline, false);
  assert.deepEqual(b2.changes.items.removed, [{ id: "film", title: null }]);
  assert.deepEqual(b2.changes.episodes.removed, [{ id: "film.main", itemId: "film", itemTitle: null }]);
});

test("two catalog ids keep independent histories", async (t) => {
  const { store, clock, service, publish, builds, seenAt } = await setup(t);
  const catalog = service();
  await catalog.load();

  clock.advance(1_000);
  await publish("fixture-1", (items) => items.slice(0, 2), { catalogId: "other" }); // same build id, another catalog
  await catalog.reload();
  assert.deepEqual(builds("other").map((b) => [b.buildId, b.baseline, b.items]), [["fixture-1", true, 2]]);
  assert.ok(store.catalogSeen("other").every((e) => e.firstSeenAt === 0));
  assert.equal(seenAt("filler-01.main")?.removedAt, null, "the other catalog leaves this one's episodes alone");

  clock.advance(1_000);
  await publish("fixture-2", withShowEpisode("show.e6", 4));
  await catalog.reload();
  assert.deepEqual(builds().map((b) => [b.buildId, b.baseline, b.episodesAdded, b.episodesRemoved, b.itemsAdded]), [
    ["fixture-2", false, 1, 0, 0],
    ["fixture-1", true, 0, 0, 0],
  ]);
  assert.equal(builds("other").length, 1);
  assert.equal(seenAt("show.e6", "other"), undefined);
});

test(`changes lists are capped at ${CHANGES_CAP}; the counts stay exact`, async (t) => {
  const { store, clock, service, publish } = await setup(t);
  const catalog = service();
  await catalog.load();
  clock.advance(1_000);
  const big = { id: "big", kind: "series", title: "Big", poster: null, episodes: Array.from({ length: CHANGES_CAP + 100 }, (_, i) => episode(`big.e${i + 1}`, i + 1)) };
  await publish("fixture-2", (items) => [...items, big]);
  await catalog.reload();
  const { build, changes } = store.getCatalogBuild(CATALOG, "fixture-2")!;
  assert.equal(build.episodesAdded, CHANGES_CAP + 100);
  assert.equal(changes.episodes.added.length, CHANGES_CAP);
  assert.equal(changes.episodes.added[0]?.id, "big.e1");
});

test("a failing load hook is logged and the catalog still loads and reloads", async (t) => {
  const { logs, service, publish } = await setup(t);
  const catalog = service(() => {
    throw new Error("history unavailable");
  });
  await catalog.load();
  await publish("fixture-2");
  const r = await catalog.reload();
  assert.equal(r.ok, true);
  assert.equal(catalog.current.manifest.buildId, "fixture-2");
  assert.equal(logs.filter((l) => JSON.parse(l).msg === "catalog load hook failed").length, 2);
});
