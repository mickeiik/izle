import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadBundle, validateBundle, BundleValidationError, type ValidationIssue } from "../src/index.ts";
import { makeBundle, TINY_PNG, TINY_PNG_NAME } from "./helpers.ts";

const SAMPLE = fileURLToPath(new URL("../../sample-catalog", import.meta.url));

const errors = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === "error");
const warnings = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === "warning");

function assertError(issues: ValidationIssue[], match: { path?: string; file?: string; message: RegExp }): void {
  const found = errors(issues).find(
    (i) => match.message.test(i.message) && (match.path === undefined || i.path === match.path) && (match.file === undefined || i.file === match.file),
  );
  assert.ok(found, `expected an error matching ${JSON.stringify({ ...match, message: String(match.message) })}, got:\n${JSON.stringify(issues, null, 2)}`);
}

test("the shipped sample catalog is valid and warning-free", async () => {
  const result = await validateBundle(SAMPLE);
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  assert.equal(result.bundle?.manifest.catalogId, "izle-sample");
  assert.ok((result.stats?.items ?? 0) >= 6);
  assert.equal(result.stats?.posters, result.stats?.items);
});

test("a well-formed fixture bundle is valid", async () => {
  const result = await validateBundle(await makeBundle());
  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.stats, { items: 2, movies: 1, series: 1, episodes: 3, playableEpisodes: 2, sources: 2, posters: 1 });
});

test("rejects duplicate item ids", async () => {
  const dir = await makeBundle({ items: (i) => (i.items[1].id = "movie-a") });
  const { ok, issues } = await validateBundle(dir);
  assert.equal(ok, false);
  assertError(issues, { path: "/items/1/id", message: /duplicate item id "movie-a"/ });
});

test("rejects duplicate episode ids anywhere in the bundle", async () => {
  const dir = await makeBundle({ items: (i) => (i.items[1].episodes[0].id = "movie-a.film") });
  assertError((await validateBundle(dir)).issues, { path: "/items/1/episodes/0/id", message: /duplicate episode id/ });
});

test("rejects duplicate source ids within an episode", async () => {
  const dir = await makeBundle({
    items: (i) => i.items[0].episodes[0].sources.push({ ...i.items[0].episodes[0].sources[0] }),
  });
  assertError((await validateBundle(dir)).issues, { path: "/items/0/episodes/0/sources/1/id", message: /duplicate source id/ });
});

test("rejects a poster whose content does not match its sha256 name", async () => {
  const dir = await makeBundle({ noPoster: true, files: { [`assets/${TINY_PNG_NAME}`]: Buffer.concat([TINY_PNG, Buffer.from([0])]) } });
  assertError((await validateBundle(dir)).issues, { file: `assets/${TINY_PNG_NAME}`, message: /sha256 of the content/ });
});

test("rejects a missing poster file", async () => {
  const dir = await makeBundle({ noPoster: true });
  assertError((await validateBundle(dir)).issues, { path: "/items/0/poster", message: /is missing/ });
});

test("rejects a poster whose bytes are not of its extension's type", async () => {
  const dir = await makeBundle({ items: (i) => (i.items[0].poster = `assets/${TINY_PNG_NAME.replace(".png", ".jpg")}`), files: { [`assets/${TINY_PNG_NAME.replace(".png", ".jpg")}`]: TINY_PNG } });
  assertError((await validateBundle(dir)).issues, { message: /content is not a jpg image/ });
});

test("rejects a poster path outside assets/ or not content-addressed", async () => {
  const dir = await makeBundle({ items: (i) => (i.items[0].poster = "../secret.png") });
  assertError((await validateBundle(dir)).issues, { path: "/items/0/poster" , message: /pattern/ });
});

test("rejects an adapter source whose adapter is not declared", async () => {
  const dir = await makeBundle({ manifest: (m) => (m.adapters = []) });
  assertError((await validateBundle(dir)).issues, { path: "/items/1/episodes/0/sources/0/adapter", message: /not listed in bundle.json/ });
});

test("warns about declared adapters no source uses", async () => {
  const dir = await makeBundle({ manifest: (m) => m.adapters.push("unused") });
  const result = await validateBundle(dir);
  assert.equal(result.ok, true);
  assert.match(warnings(result.issues)[0]?.message ?? "", /adapter "unused" is not used/);
});

test("rejects a movie with two episodes", async () => {
  const dir = await makeBundle({
    items: (i) => i.items[0].episodes.push({ id: "movie-a.extra", playbackAllowed: false, sources: [] }),
  });
  assertError((await validateBundle(dir)).issues, { path: "/items/0/episodes", message: /exactly one episode \(found 2\)/ });
});

test("rejects unknown fields at every level", async () => {
  const cases: Array<[string, (i: any) => void, string]> = [
    ["item", (i) => (i.items[0].tagline = "x"), "/items/0"],
    ["episode", (i) => (i.items[0].episodes[0].thumbnail = "x"), "/items/0/episodes/0"],
    ["source", (i) => (i.items[0].episodes[0].sources[0].quality = "hd"), "/items/0/episodes/0/sources/0"],
    ["media", (i) => (i.items[0].episodes[0].sources[0].media.drm = true), "/items/0/episodes/0/sources/0/media"],
    ["languages", (i) => (i.items[0].episodes[0].sources[0].languages.dub = true), "/items/0/episodes/0/sources/0/languages"],
  ];
  for (const [what, mutate, path] of cases) {
    const result = await validateBundle(await makeBundle({ items: mutate }));
    assert.equal(result.ok, false, what);
    assertError(result.issues, { path, message: /unknown property/ });
  }
  const manifest = await validateBundle(await makeBundle({ manifest: (m) => (m.homepage = "x") }));
  assertError(manifest.issues, { file: "bundle.json", path: "/", message: /unknown property "homepage"/ });
});

test("accepts x- extension properties", async () => {
  const dir = await makeBundle({
    manifest: (m) => (m["x-exporter"] = { run: 7 }),
    items: (i) => {
      i["x-note"] = "top";
      i.items[0]["x-origin"] = "registry-42";
      i.items[0].episodes[0]["x-n"] = 1;
      i.items[0].episodes[0].sources[0]["x-cdn"] = "a";
    },
  });
  const result = await validateBundle(dir);
  assert.deepEqual(errors(result.issues), []);
});

test("requires playbackAllowed and forbids playable episodes without sources", async () => {
  const missing = await validateBundle(await makeBundle({ items: (i) => delete i.items[0].episodes[0].playbackAllowed }));
  assertError(missing.issues, { path: "/items/0/episodes/0", message: /missing required property "playbackAllowed"/ });

  const empty = await validateBundle(await makeBundle({ items: (i) => (i.items[1].episodes[1].playbackAllowed = true) }));
  assertError(empty.issues, { path: "/items/1/episodes/1/playbackAllowed", message: /must be false when sources is empty/ });
});

test("rejects ids that are not URL-path safe", async () => {
  for (const bad of ["a|b", "has space", "-leading", "x".repeat(121), ""]) {
    const result = await validateBundle(await makeBundle({ items: (i) => (i.items[0].id = bad) }));
    assert.equal(result.ok, false, `id ${JSON.stringify(bad)}`);
  }
});

test("rejects other format versions and bad dates", async () => {
  assertError((await validateBundle(await makeBundle({ manifest: (m) => (m.formatVersion = 2) }))).issues, {
    path: "/formatVersion",
    message: /must be 1/,
  });
  assertError((await validateBundle(await makeBundle({ manifest: (m) => (m.builtAt = "2026-02-31T00:00:00Z") }))).issues, {
    path: "/builtAt",
    message: /date-time/,
  });
});

test("validates language facts", async () => {
  const bad = await validateBundle(await makeBundle({ items: (i) => (i.items[0].episodes[0].sources[0].languages.audio = ["english!"]) }));
  assert.equal(bad.ok, false);
  const missing = await validateBundle(await makeBundle({ items: (i) => delete i.items[0].episodes[0].sources[0].languages.subtitles }));
  assertError(missing.issues, { message: /missing required property "subtitles"/ });
});

test("accepts direct media with upstream headers but rejects header injection", async () => {
  const ok = await validateBundle(
    await makeBundle({ items: (i) => (i.items[0].episodes[0].sources[0].media.headers = { Referer: "https://site.example.test/" }) }),
  );
  assert.equal(ok.ok, true);
  const bad = await validateBundle(
    await makeBundle({ items: (i) => (i.items[0].episodes[0].sources[0].media.headers = { Referer: "a\r\nX-Evil: 1" }) }),
  );
  assert.equal(bad.ok, false);
});

test("rejects non-http media URLs", async () => {
  const result = await validateBundle(await makeBundle({ items: (i) => (i.items[0].episodes[0].sources[0].media.url = "file:///etc/passwd") }));
  assert.equal(result.ok, false);
});

test("reports missing files and invalid JSON without echoing content", async () => {
  const missing = await validateBundle(await makeBundle({ files: { "items.json": "" } }));
  assertError(missing.issues, { file: "items.json", message: /invalid JSON/ });
  const garbage = await validateBundle(await makeBundle({ files: { "bundle.json": "{ secret-token-value" } }));
  assert.ok(!JSON.stringify(garbage.issues).includes("secret-token-value"));
  const nodir = await validateBundle("/nonexistent/izle/bundle");
  assertError(nodir.issues, { message: /does not exist/ });
});

test("warns about unreferenced assets", async () => {
  const result = await validateBundle(await makeBundle({ files: { "assets/stale.jpg": "x" } }));
  assert.equal(result.ok, true);
  assert.equal(warnings(result.issues)[0]?.file, "assets/stale.jpg");
});

test("loadBundle returns the bundle or throws BundleValidationError", async () => {
  const { bundle } = await loadBundle(await makeBundle());
  assert.equal(bundle.items.length, 2);
  await assert.rejects(loadBundle(await makeBundle({ manifest: (m) => (m.adapters = []) })), BundleValidationError);
});
