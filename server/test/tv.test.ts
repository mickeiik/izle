import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, BACKDROP_NAME, fixtureItems, fixtureManifest, testServer, writeBundle, type Json, type TestServer } from "./helpers.ts";

async function setup(t: { after(fn: () => unknown): void }) {
  const s = await testServer(t);
  const tv = await s.pair("Salon");
  const as = (method: string, route: string, body?: unknown) => s.call(method, `/api/v1/tv${route}`, { token: tv.token, body });
  return { s, tv, as };
}

const progress = (as: Awaited<ReturnType<typeof setup>>["as"], episodeId: string, status: string, positionMs = 0, durationMs: number | null = 1_200_000) =>
  as("POST", "/progress", { episodeId, positionMs, durationMs, status });

async function continueOf(as: Awaited<ReturnType<typeof setup>>["as"], itemId: string) {
  return (await as("GET", "/state")).json.home.find((h: Json) => h.item.id === itemId)?.continue;
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

const newEpisodes = (home: Json[]) => home.map((h) => [h.item?.id ?? h.itemId, h.newEpisodes]);
const BACKDROP = `/assets/${BACKDROP_NAME}`;

test("auth: TV routes need a device token; the admin token is not one", async (t) => {
  const { s, tv } = await setup(t);
  const noToken = await s.call("GET", "/api/v1/tv/state");
  assert.equal(noToken.status, 401);
  assert.match(noToken.headers.get("www-authenticate") ?? "", /^Bearer/);
  const refused: Array<[string, { token?: string; headers?: Record<string, string> }]> = [
    ["/api/v1/tv/state", { token: ADMIN_TOKEN }], ["/api/v1/tv/state", { token: `${tv.token}x` }],
    ["/api/v1/tv/state", { headers: { Authorization: tv.token } }], ["/api/v1/admin/devices", { token: tv.token }],
  ];
  for (const [route, opts] of refused) assert.equal((await s.call("GET", route, opts)).status, 401, JSON.stringify(opts));
  assert.equal((await s.call("GET", "/api/v1/tv/state", { token: tv.token })).status, 200);
  await s.admin("DELETE", `/devices/${tv.deviceId}`);
  assert.equal((await s.call("GET", "/api/v1/tv/state", { token: tv.token })).status, 401, "deleted devices lose access");
});

test("state: home list in owner order with continue info and the cards' images; settings fall back to the catalog hints", async (t) => {
  const { s, tv, as } = await setup(t);
  let state = (await as("GET", "/state")).json;
  assert.deepEqual(state.home, []);
  assert.deepEqual(state.device, {
    id: tv.deviceId, name: "Salon", uiLanguage: "tr", preferredAudioLanguage: "tr", subtitlesLanguage: null, autoplayOnStart: false,
    homeColumns: 4, homeRows: 2,
  });
  assert.deepEqual(state.catalog, { id: "fixture", buildId: "fixture-1", name: "Fixture catalog" });

  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["film", "show", "silent"] });
  state = (await as("GET", "/state")).json;
  assert.deepEqual(state.home.map((h: Json) => h.item.id), ["film", "show", "silent"]);
  const [film, show, silent] = state.home;
  assert.deepEqual(show.continue, {
    episodeId: "show.e1", season: 1, number: 1, title: "Pilot", label: null, index: 0, count: 5, positionMs: 0, durationMs: 1_200_000, status: "new",
  });
  assert.match(show.item.posterUrl, /^\/assets\/[0-9a-f]{64}\.png$/);
  assert.deepEqual([silent.item.posterUrl, film.item.backdropUrl, show.item.backdropUrl], [null, BACKDROP, null]);

  // The backdrop in item details, resolve, search and the admin home rows; served like posters.
  assert.equal((await as("GET", "/items/film")).json.item.backdropUrl, BACKDROP);
  assert.equal((await as("POST", "/resolve", { episodeId: "film.main" })).json.item.backdropUrl, BACKDROP);
  assert.equal((await s.admin("GET", "/catalog/search?q=film")).json.items.find((i: Json) => i.id === "film").backdropUrl, BACKDROP);
  assert.deepEqual((await s.admin("GET", `/devices/${tv.deviceId}`)).json.home.map((r: Json) => r.backdropUrl), [BACKDROP, null, null]);
  const file = await s.call("GET", BACKDROP);
  assert.deepEqual([file.status, file.headers.get("content-type")], [200, "image/jpeg"]);
});

test("progress: finished moves the cursor past disallowed episodes, wrapping; the version moves with the cursor and stops", async (t) => {
  const { as } = await setup(t);
  const v0 = (await as("GET", "/state")).json.version;
  assert.equal((await progress(as, "show.e1", "playing", 10_000)).json.version, v0 + 1, "the cursor moved to show.e1");
  assert.equal((await progress(as, "show.e1", "playing", 25_000)).json.version, v0 + 1, "a playing heartbeat bumps nothing");
  assert.equal((await progress(as, "show.e1", "stopped", 30_000)).json.version, v0 + 2);
  // Not on the home list: continue info is still computed for any item via /items.
  let item = (await as("GET", "/items/show")).json;
  assert.deepEqual([item.cursorEpisodeId, item.episodes[0].progress.status, item.episodes[2].playbackAllowed], ["show.e1", "watching", false]);

  assert.equal((await progress(as, "show.e1", "finished", 1_190_000)).status, 200);
  item = (await as("GET", "/items/show")).json;
  assert.deepEqual([item.cursorEpisodeId, item.episodes[0].progress.status], ["show.e2", "finished"]);
  await progress(as, "show.e2", "finished", 1_000, 1_000);
  assert.equal((await as("GET", "/items/show")).json.cursorEpisodeId, "show.e4", "e3 is not allowed");
  await progress(as, "show.e4", "finished", 1_000, 1_000);
  await progress(as, "show.e5", "finished", 1_000, 1_000);
  assert.equal((await as("GET", "/items/show")).json.cursorEpisodeId, "show.e1", "wraps to the first allowed episode");
});

test("newEpisodes: allowed episodes a reload added after the item went on the list and after the last progress", async (t) => {
  const { s, tv, as } = await setup(t);
  const kitchen = await s.pair("Mutfak");
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["show", "film"] });
  s.clock.advance(1_000);
  await progress(as, "show.e1", "stopped", 60_000);
  assert.deepEqual(newEpisodes((await as("GET", "/state")).json.home), [["show", 0], ["film", 0]], "the first load is the baseline");

  s.clock.advance(1_000);
  await appendToShow(s, "fixture-2", [extraEpisode("show.e6", 4), extraEpisode("show.e7", 5, false)]);
  s.clock.advance(1_000);
  await s.admin("PUT", `/devices/${kitchen.deviceId}/home`, { itemIds: ["show"] });
  const state = (await as("GET", "/state")).json;
  assert.deepEqual(newEpisodes(state.home), [["show", 1], ["film", 0]], "show.e7 is not allowed");
  assert.equal(state.home[0].continue.episodeId, "show.e1", "the count does not change what OK plays");
  const kitchenState = await s.call("GET", "/api/v1/tv/state", { token: kitchen.token });
  assert.deepEqual(newEpisodes(kitchenState.json.home), [["show", 0]], "put on the list after the reload");
  assert.deepEqual(newEpisodes((await s.admin("GET", `/devices/${tv.deviceId}`)).json.home), [["show", 1], ["film", 0]]);

  s.clock.advance(1_000);
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["film", "show"] });
  assert.deepEqual(newEpisodes((await as("GET", "/state")).json.home), [["film", 0], ["show", 1]], "a reorder keeps the date");
  s.clock.advance(1_000);
  await progress(as, "show.e1", "playing", 70_000);
  assert.deepEqual(newEpisodes((await as("GET", "/state")).json.home), [["film", 0], ["show", 0]], "any progress on the item clears it");
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
  assert.equal((await progress(as, "show.e1", "playing", 5_000)).json.version, v + 1, "the cursor stays on show.e1 but is no longer wrapped");
  c = await continueOf(as, "show");
  assert.deepEqual([c.episodeId, c.status, c.positionMs], ["show.e1", "watching", 5_000]);
});

test("resolve: language order, alternatives, next episode, resume; exclusions and the 10-minute failure penalty", async (t) => {
  const { s, tv, as } = await setup(t);
  const resolve = async (body: unknown) => (await as("POST", "/resolve", body)).json;
  let r = await resolve({ episodeId: "show.e1" });
  assert.deepEqual([r.sourceId, r.alternatives], ["tr-dub", ["multi", "unknown", "en-orig"]], "device preference tr (catalog hint)");
  assert.deepEqual(r.media, { kind: "hls", url: "https://media.example.test/tr-dub/master.m3u8" }, "no headers");
  assert.deepEqual(r.next, { episodeId: "show.e2", season: 1, number: 2, title: "Season finale", label: null });
  assert.deepEqual([r.episode.index, r.resume], [0, null]);
  assert.match(r.sessionId, /^[A-Za-z0-9_-]{16}$/);

  await s.admin("PATCH", `/devices/${tv.deviceId}`, { preferredAudioLanguage: "en" });
  r = await resolve({ episodeId: "show.e1" });
  assert.deepEqual([r.sourceId, r.alternatives], ["en-orig", ["multi", "unknown", "tr-dub"]]);
  await as("POST", "/progress", { sessionId: r.sessionId, episodeId: "show.e1", positionMs: 90_000, durationMs: 1_200_000, status: "paused" });
  assert.deepEqual((await resolve({ episodeId: "show.e1" })).resume, { positionMs: 90_000, durationMs: 1_200_000 });

  const film = await resolve({ episodeId: "film.main" });
  assert.equal(film.next, null, "movies have no next");
  assert.deepEqual(film.subtitleTracks, [{ url: "https://media.example.test/a/tr.vtt", language: "tr", format: "vtt", label: null }]);
  assert.equal((await resolve({ episodeId: "show.e2" })).next, null, "autoAdvance:false boundary");
  assert.equal((await resolve({ episodeId: "show.e4" })).next.episodeId, "show.e5");

  await s.admin("PATCH", `/devices/${tv.deviceId}`, { preferredAudioLanguage: null });
  r = await resolve({ episodeId: "show.e1", exclude: ["tr-dub"] });
  assert.deepEqual([r.sourceId, r.alternatives], ["multi", ["unknown", "en-orig"]]);
  r = await resolve({ episodeId: "show.e1" });
  assert.deepEqual([r.sourceId, r.alternatives], ["multi", ["unknown", "en-orig", "tr-dub"]], "tr-dub failed recently and goes last");
  s.clock.advance(10 * 60_000 + 1);
  assert.equal((await resolve({ episodeId: "show.e1" })).sourceId, "tr-dub");
  r = await resolve({ episodeId: "show.e1", sourceId: "unknown" });
  assert.deepEqual([r.sourceId, r.alternatives], ["unknown", []]);
});

test("resolve: header-bound sources proxied, adapter sources without a module", async (t) => {
  const { as } = await setup(t);
  const e4 = (await as("POST", "/resolve", { episodeId: "show.e4" })).json;
  assert.equal(e4.sourceId, "needs-proxy", "header-bound direct sources go through the proxy");
  assert.match(e4.media.url, /^\/p\/[A-Za-z0-9_-]{43}\/index\.m3u8$/);
  assert.deepEqual(e4.alternatives, ["plain"], "adapter sources without a resolver module are left out");
  assert.ok(!JSON.stringify(e4).includes("site.example.test"), "upstream headers never reach the TV");
  const adapter = await as("POST", "/resolve", { episodeId: "show.e4", exclude: ["plain", "needs-proxy"] });
  assert.equal(adapter.status, 502);
  assert.deepEqual(adapter.json.tried, [{ sourceId: "via-adapter", code: "adapter_unavailable", adapterId: "example" }]);
  assert.ok(!JSON.stringify(adapter.json).includes("ref-value"));
});

test("request validation", async (t) => {
  const { s, tv, as } = await setup(t);
  const cases: Array<[Promise<Json>, number, string?]> = [
    [as("POST", "/resolve", { episodeId: "show.e1", extra: 1 }), 400, "invalid_request"],
    [s.call("POST", "/api/v1/tv/progress", { token: tv.token, raw: "{" }), 400, "invalid_json"],
    [as("POST", "/progress", { episodeId: "show.e1", positionMs: -1, status: "playing" }), 400, "invalid_request"],
    [as("POST", "/progress", { episodeId: "show.e1", positionMs: 1, status: "rewinding" }), 400, "invalid_request"],
    [as("POST", "/progress", { episodeId: "zzz", positionMs: 1, status: "playing" }), 404],
    [as("GET", "/items/not-there"), 404],
    [s.call("POST", "/api/v1/tv/resolve", { token: tv.token, raw: JSON.stringify({ episodeId: "x".repeat(70_000) }) }), 413, "body_too_large"],
  ];
  for (const [i, [answer, status, error]] of cases.entries()) {
    const r = await answer;
    assert.equal(r.status, status, `case ${i}`);
    if (error) assert.equal(r.json.error, error, `case ${i}`);
  }
});

test("channels: on Home with continue null, their sources under channel, never a cursor; unplayable ones stay off Home", async (t) => {
  const { s, tv, as } = await setup(t);
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["news", "film"] });
  const [news, film] = (await as("GET", "/state")).json.home;
  const card = { id: "news", kind: "live", title: "Haber 24", year: null, posterUrl: news.item.posterUrl, backdropUrl: null };
  assert.match(card.posterUrl, /^\/assets\/[0-9a-f]{64}\.png$/);
  assert.deepEqual(news, { item: card, continue: null, newEpisodes: 0 });
  assert.ok(film.continue, "episodes keep their continue");
  const refused = await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["news", "off-air"] });
  assert.deepEqual([refused.status, refused.json.error, refused.json.itemId], [400, "not_playable", "off-air"]);

  const item = (await as("GET", "/items/news")).json;
  assert.deepEqual(item, {
    item: { ...card, originalTitle: null, synopsis: null, genres: [] },
    channel: {
      playbackAllowed: true,
      sources: [
        { id: "hls", label: null, languages: { audio: ["tr"], subtitles: [] } },
        { id: "ts", label: null, languages: { audio: ["tr"], subtitles: [] } },
        { id: "en", label: null, languages: { audio: ["en"], subtitles: [] } },
      ],
    },
  }, "no episodes, no cursor, no URLs or headers");
  assert.deepEqual((await as("GET", "/items/off-air")).json.channel, { playbackAllowed: false, sources: [] });
  const cursor = await s.admin("PUT", `/devices/${tv.deviceId}/cursor`, { itemId: "news", episodeId: "news" });
  assert.deepEqual([cursor.status, cursor.json.error], [400, "unknown_episode"], "a channel has no cursor");
});

test("resolve by item id: a channel plays at its live edge, MPEG-TS with headers comes as stream.ts; the errors of both", async (t) => {
  const { s, tv, as } = await setup(t);
  const r = (await as("POST", "/resolve", { itemId: "news" })).json;
  assert.equal(r.sourceId, "hls", "device preference tr: hls and ts match, en does not");
  assert.deepEqual([r.media, r.alternatives], [{ kind: "hls", url: "https://media.example.test/news/live.m3u8" }, ["ts", "en"]]);
  assert.deepEqual([r.next, r.episode, r.resume, r.expiresAt], [null, null, null, null]);
  assert.deepEqual([r.item.id, r.item.kind, r.item.year], ["news", "live", null]);
  assert.match(r.sessionId, /^[A-Za-z0-9_-]{16}$/);

  const ts = (await as("POST", "/resolve", { itemId: "news", sourceId: "ts" })).json;
  assert.match(ts.media.url, /^\/p\/[A-Za-z0-9_-]{43}\/stream\.ts$/, "header-bound MPEG-TS goes through the proxy");
  assert.deepEqual([ts.media.kind, ts.alternatives], ["ts", []]);
  assert.ok(!JSON.stringify(ts).includes("site.example.test"), "upstream headers never reach the TV");

  // A failure on the channel is remembered for the channel, like an episode's.
  assert.equal((await as("POST", "/resolve", { itemId: "news", exclude: ["hls"] })).json.sourceId, "ts");
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
    [{ episodeId: "show.e3" }, 403, "not_allowed"], [{ episodeId: "nope" }, 404, "unknown_episode"], [{ episodeId: "show.e1", sourceId: "nope" }, 404, "unknown_source"],
  ];
  for (const [body, status, error] of errors) {
    const e = await as("POST", "/resolve", body);
    assert.deepEqual([e.status, e.json.error], [status, error], JSON.stringify(body));
  }
});

test("a channel's report: no position, no cursor, no state bump; now playing with null positions", async (t) => {
  const { s, tv, as } = await setup(t);
  const now = async () => (await s.admin("GET", `/devices/${tv.deviceId}/now`)).json;
  const r = await as("POST", "/resolve", { itemId: "news" });
  const v0 = (await as("GET", "/state")).json.version;
  const t0 = s.clock.now();
  const hb = await as("POST", "/progress", { sessionId: r.json.sessionId, itemId: "news", status: "playing" });
  assert.deepEqual([hb.status, hb.json], [200, { ok: true, version: v0 }]);
  let n = await now();
  assert.deepEqual([n.nowPlaying.state, n.nowPlaying.playing, n.nowPlaying.sourceId, n.nowPlaying.positionMs, n.nowPlaying.durationMs, n.anchor], ["playing", true, "hls", null, null, null]);
  s.clock.advance(15_000);
  await as("POST", "/progress", { itemId: "news", status: "playing", playing: false, ageMs: 2_000 });
  n = await now();
  assert.deepEqual([n.nowPlaying.playing, n.nowPlaying.sourceId, n.nowPlaying.updatedAt], [false, null, new Date(t0 + 15_000).toISOString()], "a stall; no session named");
  assert.equal((await as("POST", "/progress", { itemId: "news", status: "stopped" })).json.version, v0, "a channel's stop never bumps the state version");
  assert.equal((await now()).nowPlaying.state, "stopped");
  assert.deepEqual((await s.admin("GET", `/devices/${tv.deviceId}/progress`)).json, { cursors: [], progress: [] }, "nothing saved");

  for (const bad of [
    { itemId: "news", status: "paused" }, { itemId: "news", status: "finished" }, { itemId: "news", status: "playing", positionMs: 0 },
    { itemId: "news", status: "playing", durationMs: 1 }, { itemId: "news", episodeId: "show.e1", status: "playing", positionMs: 0 }, { itemId: "news" },
    { status: "playing" }, { itemId: "news", status: "playing", ageMs: 60_001 },
  ]) {
    const e = await as("POST", "/progress", bad);
    assert.deepEqual([e.status, e.json.error], [400, "invalid_request"], JSON.stringify(bad));
  }
  assert.equal((await as("POST", "/progress", { itemId: "nope", status: "playing" })).status, 404);
  const show = await as("POST", "/progress", { itemId: "show", status: "playing" });
  assert.deepEqual([show.status, show.json.error], [400, "has_episodes"]);
});

test("state: homeSections cut home in Home order; sections left empty by missing or unplayable items are left out", async (t) => {
  const { s, tv, as } = await setup(t);
  const state = async () => (await as("GET", "/state")).json;
  assert.deepEqual((await state()).homeSections, [], "an empty Home has no sections to show");
  const home = (method: string, route: string, body?: unknown) => s.admin(method, `/devices/${tv.deviceId}/home${route}`, body);
  const channels = (await home("POST", "/sections", { title: "Channels", layout: "row" })).json.sectionId;
  const films = (await home("POST", "/sections", { title: "Films", position: 0 })).json.sectionId;
  await home("POST", "/sections", { title: "Empty" });
  await home("PUT", "", { itemIds: ["show", "silent", "news", "film"] });
  await home("PATCH", "/items/news", { sectionId: channels });
  const last = await home("PATCH", "/items/film", { sectionId: films });

  let st = await state();
  assert.equal(st.version, last.json.version);
  assert.deepEqual(st.homeSections, [
    { id: films, title: "Films", layout: "grid", itemIds: ["film"] },
    { id: "untitled", title: null, layout: "grid", itemIds: ["show", "silent"] },
    { id: channels, title: "Channels", layout: "row", itemIds: ["news"] },
  ]);
  assert.deepEqual(st.home.map((h: Json) => h.item.id), ["film", "show", "silent", "news"], "home in Home order: the sections' items one after another");
  const moved = await home("PATCH", "/sections/untitled", { position: 0 });
  st = await state();
  assert.deepEqual([st.version, st.home.map((h: Json) => h.item.id)], [moved.json.version, ["show", "silent", "film", "news"]], "a section change is a new state version");

  // A reload takes "film" away and leaves "news" unplayable: their sections have nothing left to show.
  const items = fixtureItems();
  items.items = items.items.filter((i: Json) => i.id !== "film").map((i: Json) => (i.id === "news" ? { ...i, playbackAllowed: false } : i));
  await writeBundle(s.bundleDir, { ...fixtureManifest(), buildId: "fixture-2" }, items);
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 200);
  st = await state();
  assert.deepEqual([st.homeSections, st.home.map((h: Json) => h.item.id)], [[{ id: "untitled", title: null, layout: "grid", itemIds: ["show", "silent"] }], ["show", "silent"]]);
  const detail = (await s.admin("GET", `/devices/${tv.deviceId}`)).json;
  assert.deepEqual(detail.sections.map((x: Json) => [x.title, x.itemIds]), [[null, ["show", "silent"]], ["Films", ["film"]], ["Channels", ["news"]], ["Empty", []]],
    "the admin page keeps every section and item");
  assert.deepEqual(detail.home.map((h: Json) => [h.itemId, h.missing, h.playable]), [["show", false, true], ["silent", false, true], ["film", true, false], ["news", false, false]]);
});
