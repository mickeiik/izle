import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, startTestServer, type TestServer } from "./helpers.ts";

async function setup(t: { after(fn: () => unknown): void }) {
  const s = await startTestServer();
  t.after(() => s.close());
  const tv = await s.pair("Salon");
  const as = (method: string, route: string, body?: unknown) => s.call(method, `/api/v1/tv${route}`, { token: tv.token, body });
  return { s, tv, as };
}

const progress = (as: Awaited<ReturnType<typeof setup>>["as"], episodeId: string, status: string, positionMs = 0, durationMs: number | null = 1_200_000) =>
  as("POST", "/progress", { episodeId, positionMs, durationMs, status });

async function continueOf(as: Awaited<ReturnType<typeof setup>>["as"], itemId: string) {
  const state = await as("GET", "/state");
  return state.json.home.find((h: { item: { id: string } }) => h.item.id === itemId)?.continue;
}

test("auth: TV routes need a device token; the admin token is not one", async (t) => {
  const { s, tv } = await setup(t);
  const noToken = await s.call("GET", "/api/v1/tv/state");
  assert.equal(noToken.status, 401);
  assert.match(noToken.headers.get("www-authenticate") ?? "", /^Bearer/);
  assert.equal((await s.call("GET", "/api/v1/tv/state", { token: ADMIN_TOKEN })).status, 401);
  assert.equal((await s.call("GET", "/api/v1/tv/state", { token: `${tv.token}x` })).status, 401);
  assert.equal((await s.call("GET", "/api/v1/tv/state", { headers: { Authorization: tv.token } })).status, 401, "scheme required");
  assert.equal((await s.call("GET", "/api/v1/admin/devices", { token: tv.token })).status, 401);
  assert.equal((await s.call("GET", "/api/v1/tv/state", { token: tv.token })).status, 200);
  await s.admin("DELETE", `/devices/${tv.deviceId}`);
  assert.equal((await s.call("GET", "/api/v1/tv/state", { token: tv.token })).status, 401, "deleted devices lose access");
});

test("state: home list in owner order with continue info; settings fall back to the catalog hints", async (t) => {
  const { s, tv, as } = await setup(t);
  let state = await as("GET", "/state");
  assert.deepEqual(state.json.home, []);
  assert.deepEqual(state.json.device, {
    id: tv.deviceId,
    name: "Salon",
    uiLanguage: "tr",
    preferredAudioLanguage: "tr",
    subtitlesLanguage: null,
    autoplayOnStart: false,
  });
  assert.deepEqual(state.json.catalog, { id: "fixture", buildId: "fixture-1", name: "Fixture catalog" });

  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["film", "show", "silent"] });
  state = await as("GET", "/state");
  assert.deepEqual(state.json.home.map((h: { item: { id: string } }) => h.item.id), ["film", "show", "silent"]);
  const show = state.json.home[1];
  assert.match(show.item.posterUrl, /^\/assets\/[0-9a-f]{64}\.png$/);
  assert.deepEqual(show.continue, {
    episodeId: "show.e1",
    season: 1,
    number: 1,
    title: "Pilot",
    label: null,
    index: 0,
    count: 5,
    positionMs: 0,
    durationMs: 1_200_000,
    status: "new",
  });
  assert.equal(state.json.home[2].item.posterUrl, null);
});

test("progress → finished → cursor advances, skipping disallowed episodes and wrapping at the end", async (t) => {
  const { as } = await setup(t);
  await progress(as, "show.e1", "playing", 60_000);
  // Not on the home list yet: continue info is still computed for any item via /items.
  let item = await as("GET", "/items/show");
  assert.equal(item.json.cursorEpisodeId, "show.e1");
  assert.deepEqual(item.json.episodes[0].progress.status, "watching");
  assert.equal(item.json.episodes[2].playbackAllowed, false);

  const r = await progress(as, "show.e1", "finished", 1_190_000);
  assert.equal(r.status, 200);
  item = await as("GET", "/items/show");
  assert.equal(item.json.cursorEpisodeId, "show.e2");
  assert.equal(item.json.episodes[0].progress.status, "finished");

  await progress(as, "show.e2", "finished", 1_000, 1_000);
  assert.equal((await as("GET", "/items/show")).json.cursorEpisodeId, "show.e4", "e3 is not allowed");
  await progress(as, "show.e4", "finished", 1_000, 1_000);
  await progress(as, "show.e5", "finished", 1_000, 1_000);
  assert.equal((await as("GET", "/items/show")).json.cursorEpisodeId, "show.e1", "wraps to the first allowed episode");
});

test("continue info reflects watching/finished positions", async (t) => {
  const { s, tv, as } = await setup(t);
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["show", "film"] });
  await progress(as, "show.e1", "paused", 300_000);
  let c = await continueOf(as, "show");
  assert.equal(c.status, "watching");
  assert.equal(c.positionMs, 300_000);
  await progress(as, "film.main", "finished", 5_400_000, 5_400_000);
  c = await continueOf(as, "film");
  assert.equal(c.status, "finished");
  assert.equal(c.positionMs, 0, "a finished movie starts over");
});

test("state version: bumped by stop/finish and cursor changes, not by playing heartbeats", async (t) => {
  const { as } = await setup(t);
  const v0 = (await as("GET", "/state")).json.version;
  const a = await progress(as, "show.e1", "playing", 10_000);
  assert.equal(a.json.version, v0 + 1, "the cursor moved to show.e1");
  const b = await progress(as, "show.e1", "playing", 25_000);
  assert.equal(b.json.version, v0 + 1);
  const c = await progress(as, "show.e1", "stopped", 30_000);
  assert.equal(c.json.version, v0 + 2);
  assert.equal((await as("GET", "/state")).json.version, v0 + 2);
});

test("resolve: language order, alternatives, next episode and resume", async (t) => {
  const { s, tv, as } = await setup(t);
  let r = await as("POST", "/resolve", { episodeId: "show.e1" });
  assert.equal(r.status, 200);
  assert.equal(r.json.sourceId, "tr-dub", "device preference tr (catalog hint)");
  assert.deepEqual(r.json.alternatives, ["multi", "unknown", "en-orig"]);
  assert.deepEqual(r.json.media, { kind: "hls", url: "https://media.example.test/tr-dub/master.m3u8" });
  assert.deepEqual(r.json.next, { episodeId: "show.e2", season: 1, number: 2, title: "Season finale", label: null });
  assert.equal(r.json.episode.index, 0);
  assert.equal(r.json.resume, null);
  assert.match(r.json.sessionId, /^[A-Za-z0-9_-]{16}$/);
  assert.ok(!("headers" in r.json.media));

  await s.admin("PATCH", `/devices/${tv.deviceId}`, { preferredAudioLanguage: "en" });
  r = await as("POST", "/resolve", { episodeId: "show.e1" });
  assert.equal(r.json.sourceId, "en-orig");
  assert.deepEqual(r.json.alternatives, ["multi", "unknown", "tr-dub"]);

  await as("POST", "/progress", { sessionId: r.json.sessionId, episodeId: "show.e1", positionMs: 90_000, durationMs: 1_200_000, status: "paused" });
  r = await as("POST", "/resolve", { episodeId: "show.e1" });
  assert.deepEqual(r.json.resume, { positionMs: 90_000, durationMs: 1_200_000 });

  const film = await as("POST", "/resolve", { episodeId: "film.main" });
  assert.equal(film.json.next, null, "movies have no next");
  assert.deepEqual(film.json.subtitleTracks, [{ url: "https://media.example.test/a/tr.vtt", language: "tr", format: "vtt", label: null }]);
  assert.equal((await as("POST", "/resolve", { episodeId: "show.e2" })).json.next, null, "autoAdvance:false boundary");
  assert.equal((await as("POST", "/resolve", { episodeId: "show.e4" })).json.next.episodeId, "show.e5");
});

test("resolve: exclusions and the 10-minute failure penalty", async (t) => {
  const { s, as } = await setup(t);
  let r = await as("POST", "/resolve", { episodeId: "show.e1", exclude: ["tr-dub"] });
  assert.equal(r.json.sourceId, "multi");
  assert.deepEqual(r.json.alternatives, ["unknown", "en-orig"]);
  r = await as("POST", "/resolve", { episodeId: "show.e1" });
  assert.equal(r.json.sourceId, "multi", "tr-dub failed recently and goes last");
  assert.deepEqual(r.json.alternatives, ["unknown", "en-orig", "tr-dub"]);
  s.clock.advance(10 * 60_000 + 1);
  r = await as("POST", "/resolve", { episodeId: "show.e1" });
  assert.equal(r.json.sourceId, "tr-dub");
  r = await as("POST", "/resolve", { episodeId: "show.e1", sourceId: "unknown" });
  assert.equal(r.json.sourceId, "unknown");
  assert.deepEqual(r.json.alternatives, []);
});

test("resolve: not_allowed, unknown ids, header-bound sources proxied, adapter sources without a module", async (t) => {
  const { as } = await setup(t);
  const denied = await as("POST", "/resolve", { episodeId: "show.e3" });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error, "not_allowed");
  assert.equal((await as("POST", "/resolve", { episodeId: "nope" })).status, 404);
  assert.equal((await as("POST", "/resolve", { episodeId: "show.e1", sourceId: "nope" })).status, 404);

  const e4 = await as("POST", "/resolve", { episodeId: "show.e4" });
  assert.equal(e4.json.sourceId, "needs-proxy", "header-bound direct sources go through the proxy");
  assert.match(e4.json.media.url, /^\/p\/[A-Za-z0-9_-]{43}\/index\.m3u8$/);
  assert.deepEqual(e4.json.alternatives, ["plain"], "adapter sources without a resolver module are left out");
  assert.ok(!JSON.stringify(e4.json).includes("site.example.test"), "upstream headers never reach the TV");
  const adapter = await as("POST", "/resolve", { episodeId: "show.e4", exclude: ["plain", "needs-proxy"] });
  assert.equal(adapter.status, 502);
  assert.deepEqual(adapter.json.tried, [{ sourceId: "via-adapter", code: "adapter_unavailable", adapterId: "example" }]);
  assert.ok(!JSON.stringify(adapter.json).includes("ref-value"));
});

test("request validation", async (t) => {
  const { s, tv, as } = await setup(t);
  assert.equal((await as("POST", "/resolve", { episodeId: "show.e1", extra: 1 })).status, 400);
  const bad = await s.call("POST", "/api/v1/tv/progress", { token: tv.token, raw: "{" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "invalid_json");
  const neg = await as("POST", "/progress", { episodeId: "show.e1", positionMs: -1, status: "playing" });
  assert.equal(neg.status, 400);
  assert.equal(neg.json.error, "invalid_request");
  assert.equal((await as("POST", "/progress", { episodeId: "show.e1", positionMs: 1, status: "rewinding" })).status, 400);
  assert.equal((await as("POST", "/progress", { episodeId: "zzz", positionMs: 1, status: "playing" })).status, 404);
  assert.equal((await as("GET", "/items/not-there")).status, 404);
  const big = await s.call("POST", "/api/v1/tv/resolve", { token: tv.token, raw: JSON.stringify({ episodeId: "x".repeat(70_000) }) });
  assert.equal(big.status, 413);
});

export type { TestServer };
