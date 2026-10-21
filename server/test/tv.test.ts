import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, BACKDROP_NAME, fixtureItems, fixtureManifest, startTestServer, writeBundle, type Json, type TestServer } from "./helpers.ts";

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

/** A playable episode shaped like the fixture's last episode of "show"; `allowed: false` makes it not playable. */
const extraEpisode = (id: string, number: number, allowed = true): Json => ({
  ...fixtureItems().items[0].episodes.at(-1), id, season: 3, number, ...(allowed ? {} : { playbackAllowed: false, sources: [] }),
});

/** Publishes the fixture with `episodes` appended to "show" as build `buildId` and reloads the server's catalog. */
async function appendToShow(s: TestServer, buildId: string, episodes: Json[]) {
  const items = fixtureItems();
  items.items[0].episodes.push(...episodes);
  await writeBundle(s.bundleDir, { ...fixtureManifest(), buildId }, items);
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 200);
}

const newEpisodes = (home: Array<{ item: { id: string }; newEpisodes: number }>) => home.map((h) => [h.item.id, h.newEpisodes]);

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
    id: tv.deviceId, name: "Salon", uiLanguage: "tr", preferredAudioLanguage: "tr", subtitlesLanguage: null, autoplayOnStart: false,
    homeColumns: 4, homeRows: 2,
  });
  assert.deepEqual(state.json.catalog, { id: "fixture", buildId: "fixture-1", name: "Fixture catalog" });

  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["film", "show", "silent"] });
  state = await as("GET", "/state");
  assert.deepEqual(state.json.home.map((h: { item: { id: string } }) => h.item.id), ["film", "show", "silent"]);
  const show = state.json.home[1];
  assert.match(show.item.posterUrl, /^\/assets\/[0-9a-f]{64}\.png$/);
  assert.deepEqual(show.continue, {
    episodeId: "show.e1", season: 1, number: 1, title: "Pilot", label: null, index: 0, count: 5, positionMs: 0, durationMs: 1_200_000, status: "new",
  });
  assert.equal(state.json.home[2].item.posterUrl, null);
  assert.equal(state.json.home[0].item.backdropUrl, `/assets/${BACKDROP_NAME}`);
  assert.equal(show.item.backdropUrl, null, "no backdrop in the catalog");
});

test("backdrops: the card's backdropUrl in item details, resolve and search, served like posters", async (t) => {
  const { s, tv, as } = await setup(t);
  const film = await as("GET", "/items/film");
  assert.equal(film.json.item.backdropUrl, `/assets/${BACKDROP_NAME}`);
  assert.equal((await as("GET", "/items/show")).json.item.backdropUrl, null);
  const resolved = await as("POST", "/resolve", { episodeId: "film.main" });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.json.item.backdropUrl, `/assets/${BACKDROP_NAME}`);
  const found = (await s.admin("GET", "/catalog/search?q=film")).json.items.find((i: { id: string }) => i.id === "film");
  assert.equal(found.backdropUrl, `/assets/${BACKDROP_NAME}`);
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["film", "show"] });
  const rows = (await s.admin("GET", `/devices/${tv.deviceId}`)).json.home;
  assert.deepEqual(rows.map((r: Json) => r.backdropUrl), [`/assets/${BACKDROP_NAME}`, null], "the admin home rows too");
  const file = await s.call("GET", film.json.item.backdropUrl);
  assert.deepEqual([file.status, file.headers.get("content-type")], [200, "image/jpeg"]);
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

test("newEpisodes: allowed episodes a reload added after the item went on the list and after the last progress", async (t) => {
  const { s, tv, as } = await setup(t);
  const kitchen = await s.pair("Mutfak");
  const asKitchen = (method: string, route: string) => s.call(method, `/api/v1/tv${route}`, { token: kitchen.token });
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["show", "film"] });
  s.clock.advance(1_000);
  await progress(as, "show.e1", "stopped", 60_000);
  assert.deepEqual(newEpisodes((await as("GET", "/state")).json.home), [["show", 0], ["film", 0]], "the first load is the baseline");

  s.clock.advance(1_000);
  await appendToShow(s, "fixture-2", [extraEpisode("show.e6", 4), extraEpisode("show.e7", 5, false)]);
  s.clock.advance(1_000);
  await s.admin("PUT", `/devices/${kitchen.deviceId}/home`, { itemIds: ["show"] });

  let state = await as("GET", "/state");
  assert.deepEqual(newEpisodes(state.json.home), [["show", 1], ["film", 0]], "show.e7 is not allowed");
  assert.equal(state.json.home[0].continue.episodeId, "show.e1", "the count does not change what OK plays");
  assert.deepEqual(newEpisodes((await asKitchen("GET", "/state")).json.home), [["show", 0]], "put on the list after the reload");
  const detail = await s.admin("GET", `/devices/${tv.deviceId}`);
  assert.deepEqual(detail.json.home.map((h: { itemId: string; newEpisodes: number }) => [h.itemId, h.newEpisodes]), [["show", 1], ["film", 0]]);

  s.clock.advance(1_000);
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["film", "show"] });
  assert.deepEqual(newEpisodes((await as("GET", "/state")).json.home), [["film", 0], ["show", 1]], "a reorder keeps the date");

  s.clock.advance(1_000);
  await progress(as, "show.e1", "playing", 70_000);
  state = await as("GET", "/state");
  assert.deepEqual(newEpisodes(state.json.home), [["film", 0], ["show", 0]], "any progress on the item clears it");
  assert.equal((await s.admin("GET", `/devices/${tv.deviceId}`)).json.home[1].newEpisodes, 0);
});

test("a finished show that gains an episode resumes there until the owner's cursor or any progress", async (t) => {
  const { s, tv, as } = await setup(t);
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["show"] });
  for (const e of ["show.e1", "show.e2", "show.e4", "show.e5"]) await progress(as, e, "finished", 1_000, 1_000);
  let c = await continueOf(as, "show");
  assert.deepEqual([c.episodeId, c.status, c.positionMs], ["show.e1", "finished", 0], "wrapped, from the start");

  s.clock.advance(1_000);
  await appendToShow(s, "fixture-2", [extraEpisode("show.e6", 4, false), extraEpisode("show.e7", 5)]);
  c = await continueOf(as, "show");
  assert.deepEqual([c.episodeId, c.index, c.count, c.positionMs, c.status], ["show.e7", 6, 7, 0, "new"], "the first new allowed episode");
  assert.equal((await as("GET", "/items/show")).json.cursorEpisodeId, "show.e7");
  assert.equal((await s.admin("GET", `/devices/${tv.deviceId}`)).json.home[0].continue.episodeId, "show.e7");

  await s.admin("PUT", `/devices/${tv.deviceId}/cursor`, { itemId: "show", episodeId: "show.e2" });
  c = await continueOf(as, "show");
  assert.deepEqual([c.episodeId, c.status], ["show.e2", "new"], "the owner's cursor wins");

  // Watched to the end again, then another episode arrives; a report on the cursor episode makes it ordinary.
  await progress(as, "show.e7", "finished", 1_000, 1_000);
  assert.equal((await continueOf(as, "show")).episodeId, "show.e1");
  s.clock.advance(1_000);
  await appendToShow(s, "fixture-3", [extraEpisode("show.e6", 4, false), extraEpisode("show.e7", 5), extraEpisode("show.e8", 6)]);
  assert.equal((await continueOf(as, "show")).episodeId, "show.e8");
  const v = (await as("GET", "/state")).json.version;
  const r = await progress(as, "show.e1", "playing", 5_000);
  assert.equal(r.json.version, v + 1, "the cursor stays on show.e1 but is no longer wrapped");
  c = await continueOf(as, "show");
  assert.deepEqual([c.episodeId, c.status, c.positionMs], ["show.e1", "watching", 5_000]);
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

test("channels: on Home with continue null, their sources under channel, never a cursor; unplayable ones stay off Home", async (t) => {
  const { s, tv, as } = await setup(t);
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["news", "film"] });
  const state = await as("GET", "/state");
  const [news] = state.json.home;
  assert.match(news.item.posterUrl, /^\/assets\/[0-9a-f]{64}\.png$/);
  assert.deepEqual(news, { item: { id: "news", kind: "live", title: "Haber 24", year: null, posterUrl: news.item.posterUrl, backdropUrl: null }, continue: null, newEpisodes: 0 });
  assert.ok(state.json.home[1].continue, "episodes keep their continue");
  const refused = await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["news", "off-air"] });
  assert.deepEqual([refused.status, refused.json.error, refused.json.itemId], [400, "not_playable", "off-air"]);

  const item = await as("GET", "/items/news");
  assert.equal(item.status, 200);
  assert.deepEqual(Object.keys(item.json).sort(), ["channel", "item"], "no episodes, no cursor");
  assert.deepEqual(item.json.item, { id: "news", kind: "live", title: "Haber 24", year: null, posterUrl: news.item.posterUrl, backdropUrl: null, originalTitle: null, synopsis: null, genres: [] });
  assert.deepEqual(item.json.channel, {
    playbackAllowed: true,
    sources: [
      { id: "hls", label: null, languages: { audio: ["tr"], subtitles: [] } },
      { id: "ts", label: null, languages: { audio: ["tr"], subtitles: [] } },
      { id: "en", label: null, languages: { audio: ["en"], subtitles: [] } },
    ],
  });
  assert.ok(!JSON.stringify(item.json).includes("example.test"), "no URLs or headers reach the TV");
  assert.deepEqual((await as("GET", "/items/off-air")).json.channel, { playbackAllowed: false, sources: [] });

  const cursor = await s.admin("PUT", `/devices/${tv.deviceId}/cursor`, { itemId: "news", episodeId: "news" });
  assert.deepEqual([cursor.status, cursor.json.error], [400, "unknown_episode"], "a channel has no cursor");
});

test("resolve by item id: a channel plays at its live edge, MPEG-TS with headers comes as stream.ts; the errors", async (t) => {
  const { s, tv, as } = await setup(t);
  const r = await as("POST", "/resolve", { itemId: "news" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sourceId, "hls", "device preference tr: hls and ts match, en does not");
  assert.deepEqual(r.json.media, { kind: "hls", url: "https://media.example.test/news/live.m3u8" });
  assert.deepEqual(r.json.alternatives, ["ts", "en"]);
  assert.deepEqual([r.json.next, r.json.episode, r.json.resume, r.json.expiresAt], [null, null, null, null]);
  assert.deepEqual([r.json.item.id, r.json.item.kind, r.json.item.year], ["news", "live", null]);
  assert.match(r.json.sessionId, /^[A-Za-z0-9_-]{16}$/);

  const ts = await as("POST", "/resolve", { itemId: "news", sourceId: "ts" });
  assert.equal(ts.json.media.kind, "ts");
  assert.match(ts.json.media.url, /^\/p\/[A-Za-z0-9_-]{43}\/stream\.ts$/, "header-bound MPEG-TS goes through the proxy");
  assert.ok(!JSON.stringify(ts.json).includes("site.example.test"), "upstream headers never reach the TV");
  assert.deepEqual(ts.json.alternatives, []);

  // A failure on the channel is remembered for the channel, like an episode's.
  const excluded = await as("POST", "/resolve", { itemId: "news", exclude: ["hls"] });
  assert.equal(excluded.json.sourceId, "ts");
  assert.deepEqual((await as("POST", "/resolve", { itemId: "news" })).json.alternatives, ["en", "hls"], "hls failed recently and goes last");

  const now = (await s.admin("GET", `/devices/${tv.deviceId}/now`)).json;
  const { itemId, itemKind, episodeId, sourceId, itemTitle, episodeTitle, positionMs, durationMs, state } = now.nowPlaying;
  assert.deepEqual({ itemId, itemKind, episodeId, sourceId, itemTitle, episodeTitle, positionMs, durationMs, state }, {
    itemId: "news", itemKind: "live", episodeId: null, sourceId: "ts", itemTitle: "Haber 24", episodeTitle: null, positionMs: null, durationMs: null, state: "starting",
  });
  assert.equal(now.anchor, null, "a channel has no timeline to anchor");

  const errors: Array<[Json, number, string]> = [
    [{ itemId: "show" }, 400, "has_episodes"], [{ itemId: "nope" }, 404, "unknown_item"], [{ itemId: "off-air" }, 403, "not_allowed"],
    [{ itemId: "news", sourceId: "nope" }, 404, "unknown_source"], [{ episodeId: "news" }, 404, "unknown_episode"],
    [{ itemId: "news", episodeId: "show.e1" }, 400, "invalid_request"], [{}, 400, "invalid_request"], [{ itemId: "" }, 400, "invalid_request"],
  ];
  for (const [body, status, error] of errors) {
    const e = await as("POST", "/resolve", body);
    assert.deepEqual([e.status, e.json.error], [status, error], JSON.stringify(body));
  }
});

test("a channel's report: no position, no cursor, no state bump; now playing with null positions", async (t) => {
  const { s, tv, as } = await setup(t);
  const r = await as("POST", "/resolve", { itemId: "news" });
  const v0 = (await as("GET", "/state")).json.version;
  const t0 = s.clock.now();
  const hb = await as("POST", "/progress", { sessionId: r.json.sessionId, itemId: "news", status: "playing" });
  assert.deepEqual([hb.status, hb.json], [200, { ok: true, version: v0 }]);
  let now = (await s.admin("GET", `/devices/${tv.deviceId}/now`)).json;
  assert.deepEqual(
    [now.nowPlaying.state, now.nowPlaying.playing, now.nowPlaying.sourceId, now.nowPlaying.positionMs, now.nowPlaying.durationMs, now.anchor],
    ["playing", true, "hls", null, null, null],
  );
  s.clock.advance(15_000);
  await as("POST", "/progress", { itemId: "news", status: "playing", playing: false, ageMs: 2_000 });
  now = (await s.admin("GET", `/devices/${tv.deviceId}/now`)).json;
  assert.deepEqual([now.nowPlaying.playing, now.nowPlaying.sourceId, now.nowPlaying.updatedAt], [false, null, new Date(t0 + 15_000).toISOString()], "a stall; no session named");
  const stop = await as("POST", "/progress", { itemId: "news", status: "stopped" });
  assert.equal(stop.json.version, v0, "a channel's stop never bumps the state version");
  assert.equal((await as("GET", "/state")).json.version, v0);
  assert.equal((await s.admin("GET", `/devices/${tv.deviceId}/now`)).json.nowPlaying.state, "stopped");
  assert.deepEqual((await s.admin("GET", `/devices/${tv.deviceId}/progress`)).json, { cursors: [], progress: [] }, "nothing saved");

  for (const bad of [
    { itemId: "news", status: "paused" }, { itemId: "news", status: "finished" }, { itemId: "news", status: "playing", positionMs: 0 },
    { itemId: "news", status: "playing", durationMs: 1 }, { itemId: "news", episodeId: "show.e1", status: "playing", positionMs: 0 }, { itemId: "news" },
    { status: "playing" }, { itemId: "news", status: "playing", ageMs: 60_001 },
  ]) {
    const e = await as("POST", "/progress", bad);
    assert.deepEqual([e.status, e.json.error], [400, "invalid_request"], JSON.stringify(bad));
  }
  assert.deepEqual([(await as("POST", "/progress", { itemId: "nope", status: "playing" })).status], [404]);
  const show = await as("POST", "/progress", { itemId: "show", status: "playing" });
  assert.deepEqual([show.status, show.json.error], [400, "has_episodes"]);
});
