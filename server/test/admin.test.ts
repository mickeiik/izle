import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER } from "../src/actor.ts";
import { reloadOnSignal } from "../src/catalog-admin.ts";
import { HOME_MAX_ITEMS } from "../src/home.ts";
import { fixtureItems, fixtureManifest, logged, openEvents, publishBuild, testServer, tempDir, writeBundle, type Json } from "./helpers.ts";

/** A server with a paired TV; `fillers` playable movies beyond the fixture's usual ones (for the home limit). */
async function setup(t: { after(fn: () => unknown): void }, fillers?: number) {
  const bundleDir = fillers === undefined ? undefined : await writeBundle(await tempDir(), fixtureManifest(), fixtureItems(fillers));
  const s = await testServer(t, { bundleDir });
  const tv = await s.pair("Salon");
  return { s, tv };
}

const withoutFilm = (items: Json[]) => items.filter((i) => i.id !== "film");
const fillerIds = (n: number) => Array.from({ length: n }, (_, i) => `filler-${String(i + 1).padStart(2, "0")}`);

test("devices: list, detail, settings PATCHed into the TV's state with a version each, refusals change nothing, delete", async (t) => {
  const { s, tv } = await setup(t);
  const state = async () => (await s.call("GET", "/api/v1/tv/state", { token: tv.token })).json;
  const [d] = (await s.admin("GET", "/devices")).json.devices;
  assert.deepEqual([d.id, d.online, d.problems], [tv.deviceId, false, { recent: 0, lastAt: null }]);
  let settings: Json = { uiLanguage: null, preferredAudioLanguage: null, subtitlesLanguage: null, autoplayOnStart: false, homeColumns: 4, homeRows: 2 };
  assert.deepEqual(d.settings, settings);
  assert.deepEqual(d.effective, { ...settings, uiLanguage: "tr", preferredAudioLanguage: "tr" }, "the catalog's hints");
  const v0 = (await state()).version;

  // Each changes what it names only; the grid's columns and rows either alone.
  const patches = [
    { name: "Yatak odası", uiLanguage: "en", subtitlesLanguage: "tr" }, { uiLanguage: null }, { autoplayOnStart: true },
    { homeColumns: 6, homeRows: 1 }, { homeRows: 4 }, { homeColumns: 3 }, { autoplayOnStart: false, name: "Salon 2" },
  ];
  for (const [i, { name, ...patch }] of patches.entries()) {
    const r = await s.admin("PATCH", `/devices/${tv.deviceId}`, { name, ...patch });
    settings = { ...settings, ...patch };
    assert.equal(r.status, 200, JSON.stringify(patch));
    assert.deepEqual([r.json.device.settings, r.json.device.stateVersion], [settings, v0 + i + 1], JSON.stringify(patch));
  }
  const effective = { uiLanguage: "tr", preferredAudioLanguage: "tr", subtitlesLanguage: "tr", autoplayOnStart: false, homeColumns: 3, homeRows: 4 };
  assert.deepEqual((await state()).device, { id: tv.deviceId, name: "Salon 2", ...effective }, "the TV re-reads its state");
  assert.deepEqual((await s.admin("GET", "/devices")).json.devices[0].effective, effective);

  const bad = [
    {}, { uiLanguage: "fr" }, ...["yes", 1, null, "true"].map((v) => ({ autoplayOnStart: v })),
    ...[2, 7, "4", null, 4.5].map((v) => ({ homeColumns: v })), ...[0, 5, "2", null].map((v) => ({ homeRows: v })),
  ];
  for (const body of bad) {
    const r = await s.admin("PATCH", `/devices/${tv.deviceId}`, body);
    assert.deepEqual([r.status, r.json.error], [400, "invalid_request"], JSON.stringify(body));
  }
  assert.equal((await state()).version, v0 + patches.length, "refused patches change nothing");
  assert.equal((await s.admin("PATCH", "/devices/nope", { name: "x" })).status, 404);

  const detail = await s.admin("GET", `/devices/${tv.deviceId}`);
  assert.deepEqual([detail.json.device.settings, detail.json.homeMax], [settings, HOME_MAX_ITEMS]);
  assert.equal((await s.admin("DELETE", `/devices/${tv.deviceId}`)).status, 204);
  assert.equal((await s.admin("GET", `/devices/${tv.deviceId}`)).status, 404);
});

test("home routes: each answers version, home and sections; bodies and ids are checked, the service's refusals pass through", async (t) => {
  const { s, tv } = await setup(t, HOME_MAX_ITEMS);
  const home = (method: string, route: string, body?: unknown) => s.admin(method, `/devices/${tv.deviceId}/home${route}`, body);
  const shape = (r: Json) => [r.json.version, r.json.home.map((h: Json) => h.itemId), r.json.sections.map((x: Json) => [x.id, x.title, x.layout, x.itemIds])];
  const detail = (await s.admin("GET", `/devices/${tv.deviceId}`)).json;
  assert.deepEqual([detail.sections, detail.sectionsMax], [[{ id: "untitled", title: null, layout: "grid", itemIds: [] }], 20]);
  const v0 = detail.device.stateVersion;

  const created = await home("POST", "/sections", { title: " Kanallar ", layout: "row", position: 0 });
  const ch = created.json.sectionId;
  assert.match(ch, /^[A-Za-z0-9]{8}$/);
  const untitled = (itemIds: string[]) => ["untitled", null, "grid", itemIds];
  // [method, route, body, home and sections afterwards]
  const steps: Array<[string, string, unknown, string[], unknown[]]> = [
    ["PUT", "", { itemIds: ["show", "film"] }, ["show", "film"], [[ch, "Kanallar", "row", []], untitled(["show", "film"])]],
    ["POST", "/items", { itemId: "news", sectionId: ch }, ["news", "show", "film"], [[ch, "Kanallar", "row", ["news"]], untitled(["show", "film"])]],
    ["POST", "/items", { itemId: "silent", position: 0 }, ["news", "silent", "show", "film"], [[ch, "Kanallar", "row", ["news"]], untitled(["silent", "show", "film"])]],
    ["PATCH", "/items/film", { sectionId: ch, position: 0 }, ["film", "news", "silent", "show"], [[ch, "Kanallar", "row", ["film", "news"]], untitled(["silent", "show"])]],
    ["PATCH", `/sections/${ch}`, { title: "Channels", layout: "grid", position: 5 }, ["silent", "show", "film", "news"], [untitled(["silent", "show"]), [ch, "Channels", "grid", ["film", "news"]]]],
    ["DELETE", "/items/silent", undefined, ["show", "film", "news"], [untitled(["show"]), [ch, "Channels", "grid", ["film", "news"]]]],
    ["PUT", "", { sections: [{ id: ch, title: "Channels", itemIds: ["news"] }, { id: "untitled", title: null, itemIds: ["film", "show"] }] }, ["news", "film", "show"], [[ch, "Channels", "grid", ["news"]], untitled(["film", "show"])]],
    ["DELETE", `/sections/${ch}`, undefined, ["film", "show", "news"], [untitled(["film", "show", "news"])]],
  ];
  for (const [i, [method, route, body, ids, sections]] of steps.entries()) {
    const r = await home(method, route, body);
    assert.equal(r.status, 200, `${method} ${route}`);
    assert.deepEqual(shape(r), [v0 + i + 2, ids, sections], `${method} ${route}`);
  }
  const current = (await s.admin("GET", `/devices/${tv.deviceId}`)).json;
  assert.deepEqual(current.sections, [{ id: "untitled", title: null, layout: "grid", itemIds: ["film", "show", "news"] }], "the device page agrees");

  const refused: Array<[string, string, unknown, number, string]> = [
    ["POST", "/items", { itemId: "silent", position: -1 }, 400, "invalid_request"],
    ["POST", "/items", { position: 0 }, 400, "invalid_request"],
    ["POST", "/items", { itemId: "show" }, 400, "duplicate_item"],
    ["PATCH", "/items/show", {}, 400, "invalid_request"],
    ["PATCH", "/items/show", { position: 1.5 }, 400, "invalid_request"],
    ["PATCH", "/items/silent", { position: 0 }, 404, "not_on_home"],
    ["DELETE", "/items/not-an-id!", undefined, 404, "not_on_home"],
    ["POST", "/sections", { title: "   " }, 400, "invalid_request"],
    ["POST", "/sections", { title: "x".repeat(41) }, 400, "invalid_request"],
    ["POST", "/sections", { title: "Ok", layout: "carousel" }, 400, "invalid_request"],
    ["POST", "/sections", { layout: "row" }, 400, "invalid_request"],
    ["POST", "/sections", { title: "Ok", position: -1 }, 400, "invalid_request"],
    ["PATCH", "/sections/untitled", {}, 400, "invalid_request"],
    ["PATCH", "/sections/untitled", { title: null }, 400, "invalid_request"],
    ["PATCH", "/sections/untitled", { title: "More" }, 400, "untitled_section"],
    ["PATCH", "/sections/not-an-id!", { layout: "row" }, 404, "unknown_section"],
    ["DELETE", "/sections/not-an-id!", undefined, 404, "unknown_section"],
    ["PUT", "", { sections: [{ id: "untitled", itemIds: [] }, { title: "", itemIds: [] }] }, 400, "invalid_request"],
    ["PUT", "", { sections: [{ id: "untitled", itemIds: [], layout: "carousel" }] }, 400, "invalid_request"],
    ["PUT", "", { itemIds: [], sections: [{ id: "untitled", itemIds: [] }] }, 400, "invalid_request"],
    ["PUT", "", { itemIds: [], expected: [{ id: "untitled", itemIds: [] }] }, 400, "invalid_request"],
    ["PUT", "", { sections: [{ id: "untitled", itemIds: [] }], expected: ["show"] }, 400, "invalid_request"],
    ["PUT", "", { itemIds: [], expected: ["show", "film", "news"] }, 409, "home_changed"],
  ];
  for (const [method, route, body, status, error] of refused) {
    const r = await home(method, route, body);
    assert.deepEqual([r.status, r.json.error], [status, error], `${method} ${route} ${JSON.stringify(body)}`);
    if (error === "home_changed") assert.deepEqual([r.json.itemIds, r.json.sections], [["film", "show", "news"], current.sections], "a conflict answers the current Home");
  }
  assert.equal((await s.admin("POST", "/devices/ghost/home/items", { itemId: "show" })).json.error, "unknown_device");

  const full = await home("PUT", "", { itemIds: fillerIds(HOME_MAX_ITEMS) });
  assert.deepEqual([full.status, full.json.home.length], [200, 200]);
  assert.equal((await s.call("GET", "/api/v1/tv/state", { token: tv.token })).json.home.length, 200, "the TV gets every show");
  for (const r of [await home("PUT", "", { itemIds: [...fillerIds(HOME_MAX_ITEMS), "show"] }), await home("POST", "/items", { itemId: "show" })]) {
    assert.deepEqual([r.status, r.json.error, r.json.max], [400, "too_many_items", HOME_MAX_ITEMS]);
  }
});

test("cursor override and progress: continue from episode X, X's position forgotten; what the TV saved", async (t) => {
  const { s, tv } = await setup(t);
  const as = (m: string, r: string, b?: unknown) => s.call(m, `/api/v1/tv${r}`, { token: tv.token, body: b });
  await as("POST", "/progress", { episodeId: "show.e2", positionMs: 500_000, durationMs: 1_000_000, status: "stopped" });
  await as("POST", "/progress", { episodeId: "show.e4", positionMs: 10_000, durationMs: 1_000_000, status: "stopped" });
  const r = await s.admin("PUT", `/devices/${tv.deviceId}/cursor`, { itemId: "show", episodeId: "show.e2" });
  assert.equal(r.status, 200);
  const item = await as("GET", "/items/show");
  assert.equal(item.json.cursorEpisodeId, "show.e2");
  assert.equal(item.json.episodes[1].progress, null, "rewatch starts from the beginning");
  assert.equal(item.json.episodes[3].progress.positionMs, 10_000, "other episodes keep their progress");
  assert.equal((await s.admin("PUT", `/devices/${tv.deviceId}/cursor`, { itemId: "show", episodeId: "show.e3" })).json.error, "not_allowed");

  const prog = (await s.admin("GET", `/devices/${tv.deviceId}/progress`)).json;
  assert.deepEqual(prog.cursors.map((c: Json) => c.episodeId), ["show.e2"]);
  assert.deepEqual(prog.progress.map((p: Json) => [p.episodeId, p.itemTitle, p.kind]), [["show.e4", "Şov Dünyası", "series"]]);
});

test("commands: every type is validated and stored with its payload; acknowledged by its TV only; the log never has a message's text", async (t) => {
  const { s, tv } = await setup(t);
  const send = (body: unknown) => s.admin("POST", `/devices/${tv.deviceId}/commands`, body);
  const TEXT = "Yemek hazır, anneanne!";
  const good: Array<[unknown, Record<string, unknown>]> = [
    [{ type: "stop" }, {}], [{ type: "pause" }, {}], [{ type: "resume" }, {}], [{ type: "next" }, {}], [{ type: "previous" }, {}],
    [{ type: "seek", deltaMs: -30_000 }, { deltaMs: -30_000 }], [{ type: "seek", deltaMs: 3_600_000 }, { deltaMs: 3_600_000 }],
    [{ type: "seek", deltaMs: -3_600_000 }, { deltaMs: -3_600_000 }], [{ type: "seek", positionMs: 0 }, { positionMs: 0 }],
    [{ type: "seek", positionMs: 754_000 }, { positionMs: 754_000 }], [{ type: "message", text: `  ${TEXT}\n` }, { text: TEXT, durationSec: 15 }],
    [{ type: "message", text: "x".repeat(200), durationSec: 3 }, { text: "x".repeat(200), durationSec: 3 }],
    [{ type: "message", text: "Bye", durationSec: 120 }, { text: "Bye", durationSec: 120 }], [{ type: "update" }, { versionCode: 300 }],
  ];
  // `update` needs an APK on offer.
  const apk = new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(Buffer.from("PK\x03\x04 apk", "latin1")), c.close()) });
  await s.srv.ctx.appUpdates.store(apk, "izle-tv-0.3.0.apk", "upload", null, OWNER);
  for (const [body] of good) {
    const r = await send(body);
    assert.deepEqual([r.status, r.json.online, Number.isSafeInteger(r.json.id)], [202, false, true], JSON.stringify(body));
  }
  const stored = s.srv.ctx.store.pendingCommands(tv.deviceId, 0);
  assert.deepEqual(stored.map((c) => [c.type, c.payload]), good.map(([body, payload]) => [(body as Json).type, payload]), "the payload each is replayed with");

  const bad: unknown[] = [
    { type: "play" }, { type: "stop", episodeId: "show.e1" }, { type: "seek" }, { type: "seek", deltaMs: 30_000, positionMs: 10_000 },
    { type: "seek", deltaMs: 3_600_001 }, { type: "seek", deltaMs: -3_600_001 }, { type: "seek", deltaMs: 1.5 }, { type: "seek", positionMs: -1 },
    { type: "seek", positionMs: "10" }, { type: "message" }, { type: "message", text: "" }, { type: "message", text: "   " },
    { type: "message", text: "\n\t" }, { type: "message", text: "x".repeat(201) }, { type: "message", text: 42 },
    { type: "message", text: "Hi", durationSec: 2 }, { type: "message", text: "Hi", durationSec: 121 },
    { type: "message", text: "Hi", durationSec: 10.5 }, { type: "message", text: "Hi", extra: true }, { type: "pause", episodeId: "show.e1" },
    { type: "next", deltaMs: 1000 }, { type: "rewind" }, { type: "PAUSE" }, {}, { type: "update", versionCode: 300 }, { type: "update", text: "x" },
  ];
  for (const body of bad) {
    const r = await send(body);
    assert.deepEqual([r.status, r.json.error], [400, "invalid_request"], JSON.stringify(body));
  }
  assert.equal(s.srv.ctx.store.pendingCommands(tv.deviceId, 0).length, good.length, "nothing was stored for refused bodies");

  const play = (await send({ type: "play", episodeId: "show.e1" })).json.id;
  const other = await s.pair("Other");
  const ack = (id: number, token: string) => s.call("POST", `/api/v1/tv/commands/${id}/ack`, { token }).then((r) => r.status);
  assert.deepEqual([await ack(play, other.token), await ack(9999, tv.token), await ack(play, tv.token)], [404, 404, 200], "only the target TV acks");

  // The log has the type and ids, never a message's text.
  const queued = logged(s, "command queued");
  assert.deepEqual(queued.map((l) => l.type), [...good.map(([body]) => (body as Json).type), "play"]);
  for (const l of queued) assert.deepEqual(Object.keys(l).sort(), ["commandId", "deviceId", "level", "msg", "time", "type"]);
  assert.ok(!s.logs.some((l) => l.includes("Yemek") || l.includes("xxxxxxxx")), "message text never reaches the log");
});

test("catalog: info, search, item detail without upstream URLs", async (t) => {
  const { s } = await setup(t);
  const info = await s.admin("GET", "/catalog");
  assert.deepEqual([info.json.id, info.json.stats.items, info.json.stats.live], ["fixture", 18, 2]);
  assert.match(info.json.server.version, /^\d+\.\d+\.\d+/);
  const search = await s.admin("GET", "/catalog/search?q=sov");
  assert.deepEqual([search.json.items.map((i: Json) => i.id), search.json.total, search.json.offset], [["show"], 1, 0]);
  const [hit] = search.json.items;
  assert.deepEqual([hit.playableCount, hit.firstSeenAt, hit.newEpisodes], [4, null, 0], "the baseline was always there");
  const e4 = (await s.admin("GET", "/catalog/items/show")).json.item.episodes[3];
  assert.deepEqual(e4.sources.map((x: Json) => [x.id, x.needsProxy, x.adapter]), [["needs-proxy", true, undefined], ["via-adapter", undefined, "example"], ["plain", false, undefined]]);
  assert.ok(!JSON.stringify(e4).match(/media\.example\.test|ref-value|Referer/));
  assert.equal((await s.admin("GET", "/catalog/items/ghost")).status, 404);
});

test("diagnostics: the probe reaches upstreams through the server's fetch", async (t) => {
  const asked: Array<[string, Json]> = [];
  const upstream: typeof fetch = async (input, init) => {
    asked.push([String(input), init?.headers]);
    return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n", { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
  };
  const s = await testServer(t, { fetch: upstream });
  const d = await s.admin("POST", "/diagnostics/resolve", { episodeId: "show.e1", sourceId: "tr-dub" });
  assert.equal(d.status, 200);
  const { ms, ...probe } = d.json.sources[0].probe;
  assert.equal(typeof ms, "number");
  assert.deepEqual(probe, {
    ok: true, status: 200, contentType: "application/vnd.apple.mpegurl",
    playlist: { master: true, variants: 1, renditions: 0, segments: 0, endList: false },
  });
  assert.deepEqual(asked, [["https://media.example.test/tr-dub/master.m3u8", {}]], "no Range for a playlist, no upstream headers");
});

test("catalog reload: new build applies, invalid build is refused and the old one stays", async (t) => {
  const { s, tv } = await setup(t);
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["film", "show"] });
  await publishBuild(s.bundleDir, "fixture-2", withoutFilm);
  const v0 = (await s.call("GET", "/api/v1/tv/state", { token: tv.token })).json.version;

  const ok = await s.admin("POST", "/catalog/reload");
  assert.deepEqual([ok.status, ok.json.catalog.buildId], [200, "fixture-2"]);
  const state = (await s.call("GET", "/api/v1/tv/state", { token: tv.token })).json;
  assert.deepEqual([state.version, state.catalog.buildId], [v0 + 1, "fixture-2"]);
  assert.deepEqual(state.home.map((h: Json) => h.item.id), ["show"], "missing items are hidden on the TV");
  const detail = await s.admin("GET", `/devices/${tv.deviceId}`);
  assert.deepEqual(detail.json.home.map((h: Json) => [h.itemId, h.missing]), [["film", true], ["show", false]]);

  await publishBuild(s.bundleDir, "fixture-3", withoutFilm, { formatVersion: 2 });
  const bad = await s.admin("POST", "/catalog/reload");
  assert.deepEqual([bad.status, bad.json.error], [422, "invalid_catalog"]);
  assert.ok(bad.json.issues.some((i: { path: string }) => i.path === "/formatVersion"));
  assert.equal((await s.admin("GET", "/catalog")).json.buildId, "fixture-2");
});

test("catalog reload on SIGHUP: bumps every TV like the route; a reload that throws is logged, never rejected", async (t) => {
  const { s, tv } = await setup(t);
  const es = await openEvents(s.base, tv.token);
  t.after(() => es.close());
  const v0 = JSON.parse((await es.next()).data!).version;
  await publishBuild(s.bundleDir, "fixture-2");
  await reloadOnSignal(s.srv.ctx, "SIGHUP");
  assert.deepEqual(JSON.parse((await es.next()).data!), { version: v0 + 1 }, "the TV hears the new version");
  assert.equal((await s.admin("GET", "/catalog")).json.buildId, "fixture-2");
  es.close();

  // During shutdown the store is closed: the reload throws, and the handler must not turn that into an
  // unhandled rejection (which ends the process).
  await s.close();
  await reloadOnSignal(s.srv.ctx, "SIGHUP");
  const failed = logged(s, "catalog reload failed");
  assert.deepEqual(failed.map(({ level, signal, error }) => ({ level, signal, error })), [{ level: "warn", signal: "SIGHUP", error: "Error" }]);
  assert.ok(!JSON.stringify(failed).includes("not open"), "the class name only, never the message");
});

test("catalog builds: the baseline, then each reload's changes newest first; one build by id; unknown build", async (t) => {
  const { s } = await setup(t);
  const none = { items: { added: [], removed: [] }, episodes: { added: [], removed: [] } };
  const baseline = {
    buildId: "fixture-1", builtAt: "2026-10-10T12:00:00Z", loadedAt: "2026-10-10T12:00:00.000Z", baseline: true, counts: { items: 18, episodes: 20 },
    added: { items: 0, episodes: 0 }, removed: { items: 0, episodes: 0 },
  };
  const first = (await s.admin("GET", "/catalog")).json;
  assert.deepEqual([first.builds, first.changes, first.buildId], [[baseline], null, "fixture-1"], "the baseline changed nothing");

  // Build 2 drops the film.
  s.clock.advance(3_600_000);
  await publishBuild(s.bundleDir, "fixture-2", withoutFilm);
  const reload = await s.admin("POST", "/catalog/reload");
  assert.deepEqual(reload.json.catalog.builds.map((b: Json) => b.buildId), ["fixture-2", "fixture-1"], "the reload answers with the new history");
  const build2 = { ...baseline, buildId: "fixture-2", loadedAt: "2026-10-10T13:00:00.000Z", baseline: false, counts: { items: 17, episodes: 19 }, removed: { items: 1, episodes: 1 } };
  const changes2 = {
    items: { added: [], removed: [{ id: "film", title: "Film" }] },
    episodes: { added: [], removed: [{ id: "film.main", itemId: "film", itemTitle: "Film" }] },
  };
  assert.deepEqual((await s.admin("GET", "/catalog")).json.changes, changes2);

  // Build 3 brings the film back and appends an episode to the show.
  s.clock.advance(3_600_000);
  const extra = { ...fixtureItems().items[0].episodes.at(-1), id: "show.e6", season: 2, number: 4 };
  await publishBuild(s.bundleDir, "fixture-3", (items) => items.map((i) => (i.id === "show" ? { ...i, episodes: [...i.episodes, extra] } : i)));
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 200);
  const third = (await s.admin("GET", "/catalog")).json;
  assert.deepEqual(third.builds.map((b: Json) => [b.buildId, b.added, b.removed]), [
    ["fixture-3", { items: 1, episodes: 1 }, { items: 0, episodes: 0 }],
    ["fixture-2", { items: 0, episodes: 0 }, { items: 1, episodes: 1 }],
    ["fixture-1", { items: 0, episodes: 0 }, { items: 0, episodes: 0 }],
  ]);
  assert.deepEqual(third.changes, {
    items: { added: [{ id: "film", title: "Film", kind: "movie" }], removed: [] },
    episodes: { added: [{ id: "show.e6", itemId: "show", itemTitle: "Şov Dünyası", season: 2, number: 4, label: null, playbackAllowed: true }], removed: [] },
  }, "a returning film counts as an added show, its returning episode not as a new one");
  assert.ok(!JSON.stringify(third).includes("media.example.test"), "no upstream URLs");

  assert.deepEqual((await s.admin("GET", "/catalog/builds/fixture-2")).json, { build: build2, changes: changes2 });
  assert.deepEqual((await s.admin("GET", "/catalog/builds/fixture-1")).json, { build: baseline, changes: none });
  const ghost = await s.admin("GET", "/catalog/builds/ghost");
  assert.deepEqual([ghost.status, ghost.json.error], [404, "unknown_build"]);

  // The list holds the newest builds only; older ones are still readable by id.
  for (let i = 0; i < 50; i++) {
    s.srv.ctx.store.recordCatalogBuild(
      { catalogId: "fixture", buildId: `old-${i}`, builtAt: "2026-10-01T00:00:00Z", loadedAt: s.clock.now() + 1000 + i, baseline: false, items: 18, episodes: 21, itemsAdded: 0, itemsRemoved: 0, episodesAdded: 0, episodesRemoved: 0 },
      none,
    );
  }
  const capped = (await s.admin("GET", "/catalog")).json;
  assert.deepEqual([capped.builds.length, capped.builds[0].buildId, capped.changes], [50, "old-49", none], "newest first, the latest build's changes");
  assert.ok(!capped.builds.some((b: Json) => b.baseline), "the baseline fell off the list");
  assert.equal((await s.admin("GET", "/catalog/builds/fixture-1")).status, 200);
});

/** The fixture with genres and years to browse by: "Drama" and "DRAMA" are one genre. */
const browsable = (items: Json[]) =>
  items.map((i) => {
    const extra: Json = { show: { year: 2024, genres: ["Drama", "Komedi"] }, film: { genres: ["DRAMA"] }, silent: { year: 2005, genres: ["Komedi"] }, "filler-01": { year: 2024 } }[i.id as string];
    return extra ? { ...i, ...extra } : i;
  });

// What each query parameter does is catalog-browse.test.ts's; here: that the route reads each, and refuses bad ones.
test("catalog browsing: facets, every query parameter, not on a Home, new since a build", async (t) => {
  const bundleDir = await writeBundle(await tempDir(), fixtureManifest(), { items: browsable(fixtureItems(12).items) });
  const s = await testServer(t, { bundleDir });
  const search = async (query: string) => (await s.admin("GET", `/catalog/search?${query}`)).json;
  const ids = async (query: string) => (await search(query)).items.map((i: { id: string }) => i.id);

  assert.deepEqual((await s.admin("GET", "/catalog")).json.facets, {
    kinds: { movie: 15, series: 1, live: 2 }, genres: [{ name: "Drama", count: 2 }, { name: "Komedi", count: 2 }], years: { min: 1999, max: 2024 },
  });
  assert.deepEqual(await ids("kind=live"), ["news", "off-air"]);
  assert.deepEqual(await ids("genre=DRAMA,belgesel"), ["film", "show"]);
  assert.deepEqual(await ids("yearFrom=2005&yearTo=2005"), ["silent"]);
  assert.equal((await search("playable=true")).total, 16);
  assert.deepEqual(await ids("sort=year&kind=movie,series&limit=5"), ["filler-01", "show", "silent", "film", "filler-10"]);
  const page = await search("q=fil&limit=5&offset=10");
  assert.deepEqual([page.items.map((i: Json) => i.id), page.total, page.offset], [["filler-08", "filler-09", "film"], 13, 10]);

  for (const bad of ["kind=song", "sort=random", "since=yesterday", "offset=-1", `genre=${"x".repeat(101)}`, "yearFrom=-1", "playable=yes"]) {
    const r = await s.admin("GET", `/catalog/search?${bad}`);
    assert.deepEqual([r.status, r.json.error], [400, "invalid_request"], bad);
  }

  const tv = await s.pair("Salon");
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["show", "news"] });
  assert.deepEqual(await ids(`notOnDevice=${tv.deviceId}&kind=live,series`), ["off-air"]);
  const unknown = await s.admin("GET", "/catalog/search?notOnDevice=nope");
  assert.deepEqual([unknown.status, unknown.json.error], [404, "unknown_device"]);

  // Build 2 brings a new show and a new episode of "show".
  s.clock.advance(3_600_000);
  const silent = fixtureItems().items.find((i: Json) => i.id === "silent");
  const fresh = { id: "fresh", kind: "series", title: "Fresh", poster: null, genres: ["Belgesel"], episodes: [{ ...silent.episodes[0], id: "fresh.e1" }] };
  await publishBuild(s.bundleDir, "fixture-2", (items) =>
    [...browsable(items), fresh].map((i) => (i.id === "show" ? { ...i, episodes: [...i.episodes, { ...i.episodes.at(-1), id: "show.e6", season: 3, number: 1 }] } : i)),
  );
  const reload = (await s.admin("POST", "/catalog/reload")).json;
  assert.deepEqual(reload.catalog.facets.genres.at(-1), { name: "Belgesel", count: 1 }, "the facets follow the reload");
  const loadedAt: string = reload.catalog.builds[0].loadedAt;

  const since = await search(`since=${loadedAt}`);
  assert.deepEqual(since.items.map((i: Json) => [i.id, i.firstSeenAt, i.newEpisodes]), [["fresh", loadedAt, 1], ["show", null, 1]]);
  assert.deepEqual(await ids(`since=${Date.parse(loadedAt) + 1}`), [], "epoch ms; later than the build");
  assert.deepEqual(await ids(`since=${loadedAt.replace(/Z$/, "")}`), ["fresh", "show"], "no offset: UTC, not the server's zone");
  assert.deepEqual(await ids("sort=newest&limit=3"), ["fresh", "show", "filler-01"]);
});

test("channels on the admin side: search hits and item details, playable on the home rows, no cursor", async (t) => {
  const { s, tv } = await setup(t);
  const hit = (await s.admin("GET", "/catalog/search?q=haber")).json.items[0];
  assert.deepEqual(hit, { id: "news", kind: "live", title: "Haber 24", year: null, posterUrl: hit.posterUrl, backdropUrl: null, episodeCount: null, playableCount: null, playable: true, firstSeenAt: null, newEpisodes: null });
  const playable = async (q: string) => (await s.admin("GET", `/catalog/search?q=${q}`)).json.items[0].playable;
  assert.deepEqual([await playable("off"), await playable("sov"), await playable("locked")], [false, true, false]);

  const item = (await s.admin("GET", "/catalog/items/news")).json.item;
  assert.deepEqual(Object.keys(item).sort(), ["backdropUrl", "genres", "id", "kind", "originalTitle", "playbackAllowed", "posterUrl", "sources", "synopsis", "title", "year"]);
  assert.equal(item.playbackAllowed, true);
  assert.deepEqual(item.sources, [
    { id: "hls", type: "direct", label: null, languages: { audio: ["tr"], subtitles: [] }, kind: "hls", needsProxy: false },
    { id: "ts", type: "direct", label: null, languages: { audio: ["tr"], subtitles: [] }, kind: "ts", needsProxy: true },
    { id: "en", type: "direct", label: null, languages: { audio: ["en"], subtitles: [] }, kind: "hls", needsProxy: false },
  ]);
  assert.ok(!JSON.stringify(item).includes("example.test"), "no upstream URLs or headers");
  assert.deepEqual((await s.admin("GET", "/catalog/items/off-air")).json.item.sources, []);

  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["news", "show"] });
  const rows = (await s.admin("GET", `/devices/${tv.deviceId}`)).json.home;
  assert.deepEqual(rows.map((r: Json) => [r.itemId, r.kind, r.playable, r.continue?.episodeId ?? null, r.newEpisodes]), [["news", "live", true, null, 0], ["show", "series", true, "show.e1", 0]]);
  await publishBuild(s.bundleDir, "fixture-2", (items) => items.filter((i) => i.id !== "news"));
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 200);
  const gone = (await s.admin("GET", `/devices/${tv.deviceId}`)).json.home[0];
  assert.deepEqual([gone.itemId, gone.missing, gone.playable, gone.continue], ["news", true, false, null]);
});
