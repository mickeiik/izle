import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { CatalogService, samePlaying, type PlayingKey } from "../src/catalog.ts";
import { fixtureItems, fixtureManifest, silentLogger, tempDir, writeBundle, type Json } from "./helpers.ts";

/** The fixture catalog plus a channel whose item id is an episode id of the series ("show.e1"): the recorded bug. */
async function catalog(): Promise<CatalogService> {
  const items = fixtureItems(0).items as Json[];
  items.push({ id: "show.e1", kind: "live", title: "Collision TV", poster: null, playbackAllowed: false, sources: [] });
  const dir = await writeBundle(path.join(await tempDir(), "bundle"), fixtureManifest(), { items });
  const c = new CatalogService(dir, silentLogger);
  await c.load();
  return c;
}

const none = { episodeTitle: null, season: null, number: null };

test("describe: titles from the current catalog, missing when what played is gone", async () => {
  const c = await catalog();
  const cases: Array<[string, PlayingKey, object]> = [
    ["episode present", { itemId: "show", episodeId: "show.e1" },
      { itemId: "show", itemKind: "series", itemTitle: "Şov Dünyası", episodeId: "show.e1", episodeTitle: "Pilot", season: 1, number: 1, missing: false }],
    ["episode without a title", { itemId: "film", episodeId: "film.main" },
      { itemId: "film", itemKind: "movie", itemTitle: "Film", episodeId: "film.main", ...none, missing: false }],
    ["episode gone, item present: the item still names it", { itemId: "show", episodeId: "show.e9" },
      { itemId: "show", itemKind: "series", itemTitle: "Şov Dünyası", episodeId: "show.e9", ...none, missing: true }],
    ["episode and item gone", { itemId: "gone", episodeId: "gone.e1" },
      { itemId: "gone", itemKind: null, itemTitle: null, episodeId: "gone.e1", ...none, missing: true }],
    ["episode moved to another item: the catalog's item", { itemId: "film", episodeId: "show.e2" },
      { itemId: "show", itemKind: "series", itemTitle: "Şov Dünyası", episodeId: "show.e2", episodeTitle: "Season finale", season: 1, number: 2, missing: false }],
    ["channel present", { itemId: "news", episodeId: null },
      { itemId: "news", itemKind: "live", itemTitle: "Haber 24", episodeId: null, ...none, missing: false }],
    ["channel gone", { itemId: "gone", episodeId: null },
      { itemId: "gone", itemKind: null, itemTitle: null, episodeId: null, ...none, missing: true }],
    ["channel key naming an episodic item: named by the item, not missing", { itemId: "show", episodeId: null },
      { itemId: "show", itemKind: "series", itemTitle: "Şov Dünyası", episodeId: null, ...none, missing: false }],
    ["channel whose item id is an episode id", { itemId: "show.e1", episodeId: null },
      { itemId: "show.e1", itemKind: "live", itemTitle: "Collision TV", episodeId: null, ...none, missing: false }],
  ];
  for (const [name, key, expected] of cases) assert.deepEqual(c.describe(key), expected, name);
});

test("playing: the episode by its id, the channel by its item id, undefined when gone", async () => {
  const c = await catalog();
  const episode = c.playing({ itemId: "show", episodeId: "show.e1" });
  assert.equal(episode?.kind, "episode");
  assert.equal(episode?.kind === "episode" && episode.episode.title, "Pilot");
  assert.equal(c.playing({ itemId: "film", episodeId: "show.e1" })?.item.id, "show", "lenient: the episode id alone finds it");
  assert.equal(c.playing({ itemId: "show", episodeId: "show.e9" }), undefined, "episode gone");
  const channel = c.playing({ itemId: "news", episodeId: null });
  assert.deepEqual([channel?.kind, channel?.item.id], ["live", "news"]);
  assert.equal(c.playing({ itemId: "gone", episodeId: null }), undefined, "channel gone");
  assert.equal(c.playing({ itemId: "show", episodeId: null }), undefined, "an episodic item is no channel");
  const collision = c.playing({ itemId: "show.e1", episodeId: null });
  assert.deepEqual([collision?.kind, collision?.item.title], ["live", "Collision TV"], "the channel, not the episode with that id");
});

test("samePlaying: both fields, so an episode never equals a channel whose item id is its episode id", () => {
  const episode = { itemId: "show", episodeId: "show.e1" };
  const channel = { itemId: "show.e1", episodeId: null };
  assert.equal(samePlaying(episode, { itemId: "show", episodeId: "show.e1" }), true);
  assert.equal(samePlaying(channel, { itemId: "show.e1", episodeId: null }), true);
  assert.equal(samePlaying(episode, channel), false);
  assert.equal(samePlaying({ itemId: "show.e1", episodeId: "show.e1" }, channel), false, "an episode id equal to the item id is still an episode");
  assert.equal(samePlaying(episode, { itemId: "film", episodeId: "show.e1" }), false, "the same episode id under another item");
  assert.equal(samePlaying({ itemId: "show", episodeId: null }, episode), false, "an item's channel key is not its episode");
  // A stored row carries more than the key; only the key counts.
  const [a, b] = [{ ...channel, sourceId: "a" }, { ...channel, sourceId: "b" }];
  assert.equal(samePlaying(a, b), true);
});
