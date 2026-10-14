import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadBundle, validateBundle, BundleValidationError, type ValidationIssue } from "../src/index.ts";
import { makeBundle, TINY_PNG, TINY_PNG_NAME, type FixtureOptions, type Json } from "./helpers.ts";

const SAMPLE = fileURLToPath(new URL("../../sample-catalog", import.meta.url));
const JPG_NAME = TINY_PNG_NAME.replace(".png", ".jpg");

const errors = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === "error");
const warnings = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === "warning");
const source0 = (i: Json) => i.items[0].episodes[0].sources[0];
const SRC = "/items/0/episodes/0/sources/0";
const unknown = (path: string) => ({ path, message: /unknown property/ });

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
  assert.equal(sample.stats?.posters, sample.stats?.items);

  const fixture = await validateBundle(await makeBundle());
  assert.deepEqual(fixture.issues, []);
  const stats = { items: 2, movies: 1, series: 1, episodes: 3, playableEpisodes: 2, sources: 2, posters: 1 };
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
      { noPoster: true, files: { [`assets/${TINY_PNG_NAME}`]: Buffer.concat([TINY_PNG, Buffer.from([0])]) } },
      { file: `assets/${TINY_PNG_NAME}`, message: /sha256 of the content/ },
    ],
    [{ noPoster: true }, { path: "/items/0/poster", message: /is missing/ }],
    [
      { items: (i) => (i.items[0].poster = `assets/${JPG_NAME}`), files: { [`assets/${JPG_NAME}`]: TINY_PNG } },
      { message: /content is not a jpg image/ },
    ],
    [{ items: (i) => (i.items[0].poster = "../secret.png") }, { path: "/items/0/poster", message: /pattern/ }],
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
  ];
  for (const [opts, match] of cases) {
    const result = await validateBundle(await makeBundle(opts));
    assert.equal(result.ok, false, String(match.message));
    assertError(result.issues, match);
  }
  assertError((await validateBundle("/nonexistent/izle/bundle")).issues, { message: /does not exist/ });
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
    },
  });
  assert.deepEqual(errors((await validateBundle(extended)).issues), []);
});

test("invalid JSON is reported without echoing its content", async () => {
  const garbage = await validateBundle(await makeBundle({ files: { "bundle.json": "{ secret-token-value" } }));
  assert.ok(!JSON.stringify(garbage.issues).includes("secret-token-value"));
});

test("loadBundle returns the bundle or throws BundleValidationError", async () => {
  const { bundle } = await loadBundle(await makeBundle());
  assert.equal(bundle.items.length, 2);
  await assert.rejects(loadBundle(await makeBundle({ manifest: (m) => (m.adapters = []) })), BundleValidationError);
});
