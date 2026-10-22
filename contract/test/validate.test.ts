import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadBundle, validateBundle, BundleValidationError, type ValidationIssue } from "../src/index.ts";
import { makeBundle, TINY_JPG, TINY_JPG_NAME, TINY_PNG, TINY_PNG_NAME, type FixtureOptions, type Json } from "./helpers.ts";

const SAMPLE = fileURLToPath(new URL("../../sample-catalog", import.meta.url));
const JPG_NAME = TINY_PNG_NAME.replace(".png", ".jpg");

type Match = { path?: string; file?: string; message: RegExp };
const errors = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === "error");
const warnings = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === "warning");
const source0 = (i: Json) => i.items[0].episodes[0].sources[0];
const SRC = "/items/0/episodes/0/sources/0";
/** The fixture's live channel. */
const live = (i: Json) => i.items[2];
const LIVE = "/items/2";
const at = (path: string, message: RegExp): Match => ({ path, message });
const inFile = (file: string, message: RegExp): Match => ({ file, message });
const unknown = (path: string, name?: string) =>
  at(path, name ? new RegExp(`unknown property "${name}"`) : /unknown property/);
const BACKDROP = `assets/${TINY_JPG_NAME}`;
const SOME = { audio: null, subtitles: null };
const edit = (items: (i: Json) => unknown, files?: FixtureOptions["files"]): FixtureOptions => ({ items, files });
const corrupt = (rel: string, bytes: Buffer) => ({ [`assets/${rel}`]: Buffer.concat([bytes, Buffer.from([0])]) });

function assertError(issues: ValidationIssue[], match: Match): void {
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
  const cases: Array<[FixtureOptions, Match]> = [
    [edit((i) => (i.items[1].id = "movie-a")), at("/items/1/id", /duplicate item id "movie-a"/)],
    [edit((i) => (i.items[1].episodes[0].id = "movie-a.film")), at("/items/1/episodes/0/id", /duplicate episode id/)],
    [
      edit((i) => i.items[0].episodes[0].sources.push({ ...source0(i) })),
      at("/items/0/episodes/0/sources/1/id", /duplicate source id/),
    ],
    [{ files: corrupt(TINY_PNG_NAME, TINY_PNG) }, inFile(`assets/${TINY_PNG_NAME}`, /sha256 of the content/)],
    [edit((i) => (i.items[0].poster = `assets/${"0".repeat(64)}.png`)), at("/items/0/poster", /is missing/)],
    [
      edit((i) => (i.items[0].poster = `assets/${JPG_NAME}`), { [`assets/${JPG_NAME}`]: TINY_PNG }),
      { message: /content is not a jpg image/ },
    ],
    [edit((i) => (i.items[0].poster = "../secret.png")), at("/items/0/poster", /pattern/)],
    [edit((i) => (i.items[1].backdrop = BACKDROP)), at("/items/1/backdrop", /backdrop file .* is missing/)],
    [edit((i) => (i.items[1].backdrop = BACKDROP), corrupt(TINY_JPG_NAME, TINY_JPG)), inFile(BACKDROP, /sha256 of/)],
    [
      edit((i) => (i.items[1].backdrop = `assets/${JPG_NAME}`), { [`assets/${JPG_NAME}`]: TINY_PNG }),
      inFile(`assets/${JPG_NAME}`, /content is not a jpg image/),
    ],
    [edit((i) => (i.items[1].backdrop = "assets/backdrop.gif")), at("/items/1/backdrop", /pattern/)],
    [{ manifest: (m) => (m.adapters = []) }, at("/items/1/episodes/0/sources/0/adapter", /not listed in bundle.json/)],
    [
      edit((i) => i.items[0].episodes.push({ id: "movie-a.extra", playbackAllowed: false, sources: [] })),
      at("/items/0/episodes", /exactly one episode \(found 2\)/),
    ],
    [edit((i) => (i.items[0].tagline = "x")), unknown("/items/0")],
    [edit((i) => (i.items[0].episodes[0].thumbnail = "x")), unknown("/items/0/episodes/0")],
    [edit((i) => (source0(i).quality = "hd")), unknown(SRC)],
    [edit((i) => (source0(i).media.drm = true)), unknown(`${SRC}/media`)],
    [edit((i) => (source0(i).languages.dub = true)), unknown(`${SRC}/languages`)],
    [{ manifest: (m) => (m.homepage = "x") }, { file: "bundle.json", ...unknown("/", "homepage") }],
    [
      edit((i) => delete i.items[0].episodes[0].playbackAllowed),
      at("/items/0/episodes/0", /missing required property "playbackAllowed"/),
    ],
    [
      edit((i) => (i.items[1].episodes[1].playbackAllowed = true)),
      at("/items/1/episodes/1/playbackAllowed", /must be false when sources is empty/),
    ],
    [{ manifest: (m) => (m.formatVersion = 2) }, at("/formatVersion", /must be 1/)],
    [{ manifest: (m) => (m.builtAt = "2026-02-31T00:00:00Z") }, at("/builtAt", /date-time/)],
    [edit((i) => delete source0(i).languages.subtitles), { message: /missing required property "subtitles"/ }],
    [{ files: { "items.json": "" } }, inFile("items.json", /invalid JSON/)],
    // Live channels: no episodes or episodic fields, a playable of their own, a known kind.
    [edit((i) => (live(i).episodes = [])), unknown(LIVE, "episodes")],
    [edit((i) => (live(i).year = 2020)), unknown(LIVE, "year")],
    [edit((i) => (live(i).autoAdvance = true)), unknown(LIVE, "autoAdvance")],
    [edit((i) => delete live(i).playbackAllowed), at(LIVE, /missing required property "playbackAllowed"/)],
    [edit((i) => (live(i).sources = [])), at(`${LIVE}/playbackAllowed`, /must be false when sources is empty/)],
    [
      edit((i) => live(i).sources.push({ ...live(i).sources[0] })),
      at(`${LIVE}/sources/1/id`, /duplicate source id "hls" within the item/),
    ],
    [edit((i) => (live(i).sources[0].media.url = "file:///etc/passwd")), at(`${LIVE}/sources/0/media/url`, /pattern/)],
    [
      edit((i) => (live(i).sources[0].media.url = "https://[bad")),
      at(`${LIVE}/sources/0/media/url`, /not a valid http\(s\) URL/),
    ],
    [
      edit((i) => (live(i).sources[0] = { id: "a", type: "adapter", adapter: "other", ref: {}, languages: SOME })),
      at(`${LIVE}/sources/0/adapter`, /adapter "other" is not listed in bundle.json/),
    ],
    [edit((i) => (live(i).id = "movie-a")), at(`${LIVE}/id`, /duplicate item id "movie-a"/)],
    [edit((i) => (live(i).kind = "podcast")), at(`${LIVE}/kind`, /must be one of "movie", "series", "live"/)],
    [edit((i) => (i.items[0].sources = [])), unknown("/items/0", "sources")],
    [edit((i) => delete i.items[0].episodes), at("/items/0", /missing required property "episodes"/)],
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
    await makeBundle(edit((i) => (i.items[1].backdrop = BACKDROP), { [BACKDROP]: TINY_JPG })),
  );
  assert.deepEqual(withBackdrop.issues, []);
  assert.equal(withBackdrop.bundle?.items[1]?.backdrop, BACKDROP);
  assert.deepEqual([withBackdrop.stats?.posters, withBackdrop.stats?.backdrops], [1, 1]);

  // The poster's file as the backdrop too, and an explicit null: one file, each check once.
  const shared = await validateBundle(
    await makeBundle(edit((i) => ((i.items[0].backdrop = `assets/${TINY_PNG_NAME}`), (i.items[1].backdrop = null)))),
  );
  assert.deepEqual(shared.issues, []);
  assert.deepEqual([shared.stats?.posters, shared.stats?.backdrops], [1, 1]);
  const big = Buffer.concat([TINY_JPG, Buffer.alloc(1024 * 1024)]);
  const bigRel = `assets/${createHash("sha256").update(big).digest("hex")}.jpg`;
  const large = await validateBundle(await makeBundle(edit((i) => (i.items[0].backdrop = bigRel), { [bigRel]: big })));
  assert.equal(large.ok, true);
  assert.deepEqual(warnings(large.issues).map((w) => [w.file, w.message]), [[bigRel, "backdrop is larger than 1048576 bytes"]]);
});

test("ids, languages, URLs and headers are checked", async () => {
  const bad: Array<(i: Json) => unknown> = [
    ...["a|b", "has space", "-leading", "x".repeat(121), ""].map((id) => (i: Json) => (i.items[0].id = id)),
    (i) => (source0(i).languages.audio = ["english!"]),
    (i) => (source0(i).media.headers = { Referer: "a\r\nX-Evil: 1" }),
    (i) => (source0(i).media.url = "file:///etc/passwd"),
  ];
  for (const items of bad) assert.equal((await validateBundle(await makeBundle({ items }))).ok, false, String(items));
  const referer = { Referer: "https://site.example.test/" };
  assert.equal((await validateBundle(await makeBundle(edit((i) => (source0(i).media.headers = referer))))).ok, true);
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
  const media = { kind: "ts", url: "http://iptv.example.test/c.ts" };
  const ts = await validateBundle(await makeBundle(edit((i) => (live(i).sources[0].media = media))));
  assert.deepEqual(ts.issues, []);
  assert.equal(ts.bundle?.items[2]?.kind, "live");

  const notPlayable = edit((i) => Object.assign(live(i), { playbackAllowed: false, sources: [] }));
  const off = await validateBundle(await makeBundle(notPlayable));
  assert.equal(off.ok, true);
  assert.deepEqual(warnings(off.issues).map((w) => [w.file, w.path]), [["items.json", LIVE]]);
  assert.match(warnings(off.issues)[0]?.message ?? "", /live item "live-c" has playbackAllowed: false/);
  assert.deepEqual([off.stats?.items, off.stats?.live, off.stats?.sources, off.stats?.episodes], [3, 1, 2, 3]);
});

test("invalid JSON is reported without echoing its content; loadBundle returns the bundle or throws", async () => {
  const garbage = await validateBundle(await makeBundle({ files: { "bundle.json": "{ secret-token-value" } }));
  assert.ok(!JSON.stringify(garbage.issues).includes("secret-token-value"));
  const { bundle } = await loadBundle(await makeBundle());
  assert.equal(bundle.items.length, 3);
  await assert.rejects(loadBundle(await makeBundle({ manifest: (m) => (m.adapters = []) })), BundleValidationError);
});
