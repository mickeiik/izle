import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadBundle, validateBundle, BundleValidationError, type ValidationIssue } from "../src/index.ts";
import { makeBundle, TINY_JPG, TINY_JPG_NAME, TINY_PNG, TINY_PNG_NAME, type FixtureOptions, type Json } from "./helpers.ts";

const SAMPLE = fileURLToPath(new URL("../../sample-catalog", import.meta.url));
const JPG_NAME = TINY_PNG_NAME.replace(".png", ".jpg");

const errors = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === "error");
const warnings = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === "warning");
const source0 = (i: Json) => i.items[0].episodes[0].sources[0];
const SRC = "/items/0/episodes/0/sources/0";
const unknown = (path: string, name?: string) => ({ path, message: name ? new RegExp(`unknown property "${name}"`) : /unknown property/ });
/** The fixture's live channel. */
const live = (i: Json) => i.items[2];
const LIVE = "/items/2";

function assertError(issues: ValidationIssue[], match: { path?: string; file?: string; message: RegExp }): void {
  const found = errors(issues).find(
    (i) => match.message.test(i.message) && (match.path === undefined || i.path === match.path) && (match.file === undefined || i.file === match.file),
  );
  assert.ok(found, `expected an error matching ${JSON.stringify({ ...match, message: String(match.message) })}, got:\n${JSON.stringify(issues, null, 2)}`);
}

test("the shipped sample catalog and the fixture bundle are valid and warning-free", async () => {
  const sample = await validateBundle(SAMPLE);
  assert.deepEqual(sample.issues, []);
  assert.equal(sample.ok, true);
  assert.equal(sample.bundle?.manifest.catalogId, "izle-sample");
  assert.ok((sample.stats?.items ?? 0) >= 6);
  assert.equal(sample.stats?.live, 0, "the sample catalog stays video on demand");
  assert.equal(sample.stats?.posters, sample.stats?.items);

  const fixture = await validateBundle(await makeBundle());
  assert.deepEqual(fixture.issues, []);
  const stats = { items: 3, movies: 1, series: 1, live: 1, episodes: 3, playableEpisodes: 2, sources: 3, posters: 1, backdrops: 0 };
  assert.deepEqual(fixture.stats, stats);
});

test("semantic, schema and file errors are reported where they are", async () => {
  const cases: Array<[FixtureOptions, { path?: string; file?: string; message: RegExp }]> = [
    [{ items: (i) => (i.items[1].id = "movie-a") }, { path: "/items/1/id", message: /duplicate item id "movie-a"/ }],
    [
      { items: (i) => (i.items[1].episodes[0].id = "movie-a.film") },
      { path: "/items/1/episodes/0/id", message: /duplicate episode id/ },
    ],
    [
      { items: (i) => i.items[0].episodes[0].sources.push({ ...source0(i) }) },
      { path: "/items/0/episodes/0/sources/1/id", message: /duplicate source id/ },
    ],
    [
      { files: { [`assets/${TINY_PNG_NAME}`]: Buffer.concat([TINY_PNG, Buffer.from([0])]) } },
      { file: `assets/${TINY_PNG_NAME}`, message: /sha256 of the content/ },
    ],
    [{ items: (i) => (i.items[0].poster = `assets/${"0".repeat(64)}.png`) }, { path: "/items/0/poster", message: /is missing/ }],
    [
      { items: (i) => (i.items[0].poster = `assets/${JPG_NAME}`), files: { [`assets/${JPG_NAME}`]: TINY_PNG } },
      { message: /content is not a jpg image/ },
    ],
    [{ items: (i) => (i.items[0].poster = "../secret.png") }, { path: "/items/0/poster", message: /pattern/ }],
    [{ items: (i) => (i.items[1].backdrop = `assets/${TINY_JPG_NAME}`) }, { path: "/items/1/backdrop", message: /backdrop file .* is missing/ }],
    [
      { items: (i) => (i.items[1].backdrop = `assets/${TINY_JPG_NAME}`), files: { [`assets/${TINY_JPG_NAME}`]: Buffer.concat([TINY_JPG, Buffer.from([0])]) } },
      { file: `assets/${TINY_JPG_NAME}`, message: /sha256 of the content/ },
    ],
    [
      { items: (i) => (i.items[1].backdrop = `assets/${JPG_NAME}`), files: { [`assets/${JPG_NAME}`]: TINY_PNG } },
      { file: `assets/${JPG_NAME}`, message: /content is not a jpg image/ },
    ],
    [{ items: (i) => (i.items[1].backdrop = "assets/backdrop.gif") }, { path: "/items/1/backdrop", message: /pattern/ }],
    [
      { manifest: (m) => (m.adapters = []) },
      { path: "/items/1/episodes/0/sources/0/adapter", message: /not listed in bundle.json/ },
    ],
    [
      { items: (i) => i.items[0].episodes.push({ id: "movie-a.extra", playbackAllowed: false, sources: [] }) },
      { path: "/items/0/episodes", message: /exactly one episode \(found 2\)/ },
    ],
    [{ items: (i) => (i.items[0].tagline = "x") }, unknown("/items/0")],
    [{ items: (i) => (i.items[0].episodes[0].thumbnail = "x") }, unknown("/items/0/episodes/0")],
    [{ items: (i) => (source0(i).quality = "hd") }, unknown(SRC)],
    [{ items: (i) => (source0(i).media.drm = true) }, unknown(`${SRC}/media`)],
    [{ items: (i) => (source0(i).languages.dub = true) }, unknown(`${SRC}/languages`)],
    [
      { manifest: (m) => (m.homepage = "x") },
      { file: "bundle.json", path: "/", message: /unknown property "homepage"/ },
    ],
    [
      { items: (i) => delete i.items[0].episodes[0].playbackAllowed },
      { path: "/items/0/episodes/0", message: /missing required property "playbackAllowed"/ },
    ],
    [
      { items: (i) => (i.items[1].episodes[1].playbackAllowed = true) },
      { path: "/items/1/episodes/1/playbackAllowed", message: /must be false when sources is empty/ },
    ],
    [{ manifest: (m) => (m.formatVersion = 2) }, { path: "/formatVersion", message: /must be 1/ }],
    [{ manifest: (m) => (m.builtAt = "2026-02-31T00:00:00Z") }, { path: "/builtAt", message: /date-time/ }],
    [{ items: (i) => delete source0(i).languages.subtitles }, { message: /missing required property "subtitles"/ }],
    [{ files: { "items.json": "" } }, { file: "items.json", message: /invalid JSON/ }],
    // Live channels: no episodes or episodic fields, a playable of their own, a known kind.
    [{ items: (i) => (live(i).episodes = []) }, unknown(LIVE, "episodes")],
    [{ items: (i) => (live(i).year = 2020) }, unknown(LIVE, "year")],
    [{ items: (i) => (live(i).autoAdvance = true) }, unknown(LIVE, "autoAdvance")],
    [{ items: (i) => delete live(i).playbackAllowed }, { path: LIVE, message: /missing required property "playbackAllowed"/ }],
    [{ items: (i) => (live(i).sources = []) }, { path: `${LIVE}/playbackAllowed`, message: /must be false when sources is empty/ }],
    [
      { items: (i) => live(i).sources.push({ ...live(i).sources[0] }) },
      { path: `${LIVE}/sources/1/id`, message: /duplicate source id "hls" within the item/ },
    ],
    [{ items: (i) => (live(i).sources[0].media.url = "file:///etc/passwd") }, { path: `${LIVE}/sources/0/media/url`, message: /pattern/ }],
    [{ items: (i) => (live(i).sources[0].media.url = "https://[bad") }, { path: `${LIVE}/sources/0/media/url`, message: /not a valid http\(s\) URL/ }],
    [
      { items: (i) => (live(i).sources[0] = { id: "a", type: "adapter", adapter: "other", ref: {}, languages: { audio: null, subtitles: null } }) },
      { path: `${LIVE}/sources/0/adapter`, message: /adapter "other" is not listed in bundle.json/ },
    ],
    [{ items: (i) => (live(i).id = "movie-a") }, { path: `${LIVE}/id`, message: /duplicate item id "movie-a"/ }],
    [{ items: (i) => (live(i).kind = "podcast") }, { path: `${LIVE}/kind`, message: /must be one of "movie", "series", "live"/ }],
    [{ items: (i) => (i.items[0].sources = []) }, unknown("/items/0", "sources")],
    [{ items: (i) => delete i.items[0].episodes }, { path: "/items/0", message: /missing required property "episodes"/ }],
  ];
  for (const [opts, match] of cases) {
    const result = await validateBundle(await makeBundle(opts));
    assert.equal(result.ok, false, String(match.message));
    assertError(result.issues, match);
  }
  assertError((await validateBundle("/nonexistent/izle/bundle")).issues, { message: /does not exist/ });
});

test("backdrops: optional, checked like posters, counted, and not reported as unreferenced", async () => {
  const withBackdrop = await validateBundle(
    await makeBundle({ items: (i) => (i.items[1].backdrop = `assets/${TINY_JPG_NAME}`), files: { [`assets/${TINY_JPG_NAME}`]: TINY_JPG } }),
  );
  assert.deepEqual(withBackdrop.issues, []);
  assert.equal(withBackdrop.bundle?.items[1]?.backdrop, `assets/${TINY_JPG_NAME}`);
  assert.deepEqual([withBackdrop.stats?.posters, withBackdrop.stats?.backdrops], [1, 1]);

  // The poster's file as the backdrop too, and an explicit null: one file, each check once.
  const shared = await validateBundle(
    await makeBundle({ items: (i) => ((i.items[0].backdrop = `assets/${TINY_PNG_NAME}`), (i.items[1].backdrop = null)) }),
  );
  assert.deepEqual(shared.issues, []);
  assert.deepEqual([shared.stats?.posters, shared.stats?.backdrops], [1, 1]);
  const big = Buffer.concat([TINY_JPG, Buffer.alloc(1024 * 1024)]);
  const bigName = `${createHash("sha256").update(big).digest("hex")}.jpg`;
  const large = await validateBundle(await makeBundle({ items: (i) => (i.items[0].backdrop = `assets/${bigName}`), files: { [`assets/${bigName}`]: big } }));
  assert.equal(large.ok, true);
  assert.deepEqual(warnings(large.issues).map((w) => [w.file, w.message]), [[`assets/${bigName}`, "backdrop is larger than 1048576 bytes"]]);
});

test("ids, languages, URLs and headers are checked", async () => {
  const bad: FixtureOptions["items"][] = [
    ...["a|b", "has space", "-leading", "x".repeat(121), ""].map((id) => (i: Json) => (i.items[0].id = id)),
    (i) => (source0(i).languages.audio = ["english!"]),
    (i) => (source0(i).media.headers = { Referer: "a\r\nX-Evil: 1" }),
    (i) => (source0(i).media.url = "file:///etc/passwd"),
  ];
  for (const items of bad) assert.equal((await validateBundle(await makeBundle({ items }))).ok, false, String(items));
  const referer = { Referer: "https://site.example.test/" };
  const withHeaders = await makeBundle({ items: (i) => (source0(i).media.headers = referer) });
  assert.equal((await validateBundle(withHeaders)).ok, true);
});

test("warnings: unused adapters and unreferenced assets; x- extensions are accepted", async () => {
  const unused = await validateBundle(await makeBundle({ manifest: (m) => m.adapters.push("unused") }));
  assert.equal(unused.ok, true);
  assert.match(warnings(unused.issues)[0]?.message ?? "", /adapter "unused" is not used/);
  const stale = await validateBundle(await makeBundle({ files: { "assets/stale.jpg": "x" } }));
  assert.equal(stale.ok, true);
  assert.equal(warnings(stale.issues)[0]?.file, "assets/stale.jpg");
  const extended = await makeBundle({
    manifest: (m) => (m["x-exporter"] = { run: 7 }),
    items: (i) => {
      i["x-note"] = "top";
      i.items[0]["x-origin"] = "registry-42";
      i.items[0].episodes[0]["x-n"] = 1;
      source0(i)["x-cdn"] = "a";
      live(i)["x-epg"] = "channel-c";
    },
  });
  assert.deepEqual(errors((await validateBundle(extended)).issues), []);
});

test("live channels: counted, warned when not playable", async () => {
  const ts = await validateBundle(await makeBundle({ items: (i) => (live(i).sources[0].media = { kind: "ts", url: "http://iptv.example.test/c.ts" }) }));
  assert.deepEqual(ts.issues, []);
  assert.equal(ts.bundle?.items[2]?.kind, "live");

  const off = await validateBundle(await makeBundle({ items: (i) => Object.assign(live(i), { playbackAllowed: false, sources: [] }) }));
  assert.equal(off.ok, true);
  assert.deepEqual(warnings(off.issues).map((w) => [w.file, w.path]), [["items.json", LIVE]]);
  assert.match(warnings(off.issues)[0]?.message ?? "", /live item "live-c" has playbackAllowed: false/);
  assert.deepEqual([off.stats?.items, off.stats?.live, off.stats?.sources, off.stats?.episodes], [3, 1, 2, 3]);
});

test("invalid JSON is reported without echoing its content", async () => {
  const garbage = await validateBundle(await makeBundle({ files: { "bundle.json": "{ secret-token-value" } }));
  assert.ok(!JSON.stringify(garbage.issues).includes("secret-token-value"));
});

test("loadBundle returns the bundle or throws BundleValidationError", async () => {
  const { bundle } = await loadBundle(await makeBundle());
  assert.equal(bundle.items.length, 3);
  await assert.rejects(loadBundle(await makeBundle({ manifest: (m) => (m.adapters = []) })), BundleValidationError);
});
