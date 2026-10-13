import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HOME_MAX_ITEMS } from "../src/tv.ts";
import { startTestServer } from "./helpers.ts";

async function setup(t: { after(fn: () => unknown): void }) {
  const s = await startTestServer();
  t.after(() => s.close());
  const tv = await s.pair("Salon");
  return { s, tv };
}

test("admin auth", async (t) => {
  const { s } = await setup(t);
  assert.equal((await s.call("GET", "/api/v1/admin/devices")).status, 401);
  assert.equal((await s.call("GET", "/api/v1/admin/devices", { token: "wrong-wrong-wrong-wrong-wrong" })).status, 401);
  assert.equal((await s.call("GET", "/api/v1/admin/devices", { token: "short" })).status, 401);
  assert.equal((await s.admin("GET", "/devices")).status, 200);
});

test("devices: list, detail, patch settings, delete", async (t) => {
  const { s, tv } = await setup(t);
  const list = await s.admin("GET", "/devices");
  assert.equal(list.json.devices.length, 1);
  const d = list.json.devices[0];
  assert.equal(d.id, tv.deviceId);
  assert.equal(d.online, false);
  assert.deepEqual(d.settings, { uiLanguage: null, preferredAudioLanguage: null, subtitlesLanguage: null, autoplayOnStart: false });
  assert.deepEqual(d.effective, { uiLanguage: "tr", preferredAudioLanguage: "tr", subtitlesLanguage: null, autoplayOnStart: false });
  assert.deepEqual(d.problems, { recent: 0, lastAt: null });

  const patched = await s.admin("PATCH", `/devices/${tv.deviceId}`, { name: "Yatak odası", uiLanguage: "en", subtitlesLanguage: "tr" });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.device.name, "Yatak odası");
  assert.deepEqual(patched.json.device.effective, { uiLanguage: "en", preferredAudioLanguage: "tr", subtitlesLanguage: "tr", autoplayOnStart: false });
  assert.equal(patched.json.device.stateVersion, d.stateVersion + 1);
  const reset = await s.admin("PATCH", `/devices/${tv.deviceId}`, { uiLanguage: null });
  assert.equal(reset.json.device.effective.uiLanguage, "tr");
  assert.equal((await s.admin("PATCH", `/devices/${tv.deviceId}`, {})).status, 400);
  assert.equal((await s.admin("PATCH", `/devices/${tv.deviceId}`, { uiLanguage: "fr" })).status, 400);
  assert.equal((await s.admin("PATCH", "/devices/nope", { name: "x" })).status, 404);

  const detail = await s.admin("GET", `/devices/${tv.deviceId}`);
  assert.equal(detail.json.homeMax, HOME_MAX_ITEMS);
  assert.equal((await s.admin("DELETE", `/devices/${tv.deviceId}`)).status, 204);
  assert.equal((await s.admin("GET", `/devices/${tv.deviceId}`)).status, 404);
});

test("home list: order kept, capped, validated", async (t) => {
  const { s, tv } = await setup(t);
  const fillers = Array.from({ length: 12 }, (_, i) => `filler-${String(i + 1).padStart(2, "0")}`);
  const ok = await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: fillers });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.home.length, 12);
  const tooMany = await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: [...fillers, "show"] });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json.error, "too_many_items");
  assert.equal(tooMany.json.max, 12);
  assert.equal((await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["show", "show"] })).json.error, "duplicate_item");
  assert.equal((await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["ghost"] })).json.error, "unknown_item");
  assert.equal((await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["locked"] })).json.error, "not_playable");
  const reordered = await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["silent", "show"] });
  assert.deepEqual(reordered.json.home.map((h: { itemId: string }) => h.itemId), ["silent", "show"]);
  assert.deepEqual((await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: [] })).json.home, []);
});

test("cursor override: continue from episode X and forget X's position", async (t) => {
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
  assert.equal((await s.admin("PUT", `/devices/${tv.deviceId}/cursor`, { itemId: "show", episodeId: "film.main" })).json.error, "unknown_episode");
  assert.equal((await s.admin("PUT", `/devices/${tv.deviceId}/cursor`, { itemId: "nope", episodeId: "show.e1" })).status, 404);

  const prog = await s.admin("GET", `/devices/${tv.deviceId}/progress`);
  assert.deepEqual(prog.json.cursors.map((c: { episodeId: string }) => c.episodeId), ["show.e2"]);
  assert.deepEqual(prog.json.progress.map((p: { episodeId: string }) => p.episodeId), ["show.e4"]);
  assert.equal(prog.json.progress[0].itemTitle, "Şov Dünyası");
  assert.equal(prog.json.progress[0].kind, "series");
});

test("now playing follows resolve and heartbeats", async (t) => {
  const { s, tv } = await setup(t);
  const as = (m: string, r: string, b?: unknown) => s.call(m, `/api/v1/tv${r}`, { token: tv.token, body: b });
  assert.equal((await s.admin("GET", `/devices/${tv.deviceId}/now`)).json.nowPlaying, null);
  const r = await as("POST", "/resolve", { episodeId: "film.main" });
  let now = await s.admin("GET", `/devices/${tv.deviceId}/now`);
  assert.equal(now.json.nowPlaying.state, "starting");
  assert.equal(now.json.nowPlaying.sourceId, "a");
  await as("POST", "/progress", { sessionId: r.json.sessionId, episodeId: "film.main", positionMs: 42_000, durationMs: 5_400_000, status: "playing" });
  now = await s.admin("GET", `/devices/${tv.deviceId}/now`);
  assert.deepEqual(
    (({ state, positionMs, sourceId, itemTitle }) => ({ state, positionMs, sourceId, itemTitle }))(now.json.nowPlaying),
    { state: "playing", positionMs: 42_000, sourceId: "a", itemTitle: "Film" },
  );
});

test("commands: validated, stored, acknowledged by the TV", async (t) => {
  const { s, tv } = await setup(t);
  const play = await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "play", episodeId: "show.e1" });
  assert.equal(play.status, 202);
  assert.equal(play.json.online, false);
  assert.equal((await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "play", episodeId: "show.e3" })).json.error, "not_allowed");
  assert.equal((await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "play" })).status, 400);
  assert.equal((await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "stop", episodeId: "show.e1" })).status, 400);
  assert.equal((await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "stop" })).status, 202);
  const ack = await s.call("POST", `/api/v1/tv/commands/${play.json.id}/ack`, { token: tv.token });
  assert.equal(ack.status, 200);
  assert.equal((await s.call("POST", "/api/v1/tv/commands/9999/ack", { token: tv.token })).status, 404);
  const other = await s.pair("Other");
  assert.equal((await s.call("POST", `/api/v1/tv/commands/${play.json.id}/ack`, { token: other.token })).status, 404, "only the target device can ack");
});

test("commands: pause, resume, next, previous, seek and message are validated and stored with their payloads", async (t) => {
  const { s, tv } = await setup(t);
  const send = (body: unknown) => s.admin("POST", `/devices/${tv.deviceId}/commands`, body);
  const TEXT = "Yemek hazır, anneanne!";
  const good: Array<[unknown, Record<string, unknown>]> = [
    [{ type: "pause" }, {}],
    [{ type: "resume" }, {}],
    [{ type: "next" }, {}],
    [{ type: "previous" }, {}],
    [{ type: "seek", deltaMs: -30_000 }, { deltaMs: -30_000 }],
    [{ type: "seek", deltaMs: 3_600_000 }, { deltaMs: 3_600_000 }],
    [{ type: "seek", deltaMs: -3_600_000 }, { deltaMs: -3_600_000 }],
    [{ type: "seek", positionMs: 0 }, { positionMs: 0 }],
    [{ type: "seek", positionMs: 754_000 }, { positionMs: 754_000 }],
    [{ type: "message", text: `  ${TEXT}\n` }, { text: TEXT, durationSec: 15 }],
    [{ type: "message", text: "x".repeat(200), durationSec: 3 }, { text: "x".repeat(200), durationSec: 3 }],
    [{ type: "message", text: "Bye", durationSec: 120 }, { text: "Bye", durationSec: 120 }],
  ];
  for (const [body] of good) {
    const r = await send(body);
    assert.equal(r.status, 202, JSON.stringify(body));
    assert.equal(r.json.online, false);
    assert.ok(Number.isSafeInteger(r.json.id));
  }
  const stored = s.srv.ctx.store.pendingCommands(tv.deviceId, 0);
  assert.deepEqual(
    stored.map((c) => [c.type, c.payload]),
    good.map(([body, payload]) => [(body as { type: string }).type, payload]),
    "the payload each command is replayed with",
  );

  const bad: unknown[] = [
    { type: "seek" },
    { type: "seek", deltaMs: 30_000, positionMs: 10_000 },
    { type: "seek", deltaMs: 3_600_001 },
    { type: "seek", deltaMs: -3_600_001 },
    { type: "seek", deltaMs: 1.5 },
    { type: "seek", positionMs: -1 },
    { type: "seek", positionMs: "10" },
    { type: "message" },
    { type: "message", text: "" },
    { type: "message", text: "   " },
    { type: "message", text: "\n\t" },
    { type: "message", text: "x".repeat(201) },
    { type: "message", text: 42 },
    { type: "message", text: "Hi", durationSec: 2 },
    { type: "message", text: "Hi", durationSec: 121 },
    { type: "message", text: "Hi", durationSec: 10.5 },
    { type: "message", text: "Hi", extra: true },
    { type: "pause", episodeId: "show.e1" },
    { type: "next", deltaMs: 1000 },
    { type: "rewind" },
    { type: "PAUSE" },
    {},
  ];
  for (const body of bad) {
    const r = await send(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error, "invalid_request");
  }
  assert.equal(s.srv.ctx.store.pendingCommands(tv.deviceId, 0).length, good.length, "nothing was stored for refused bodies");

  // The log has the type and ids, never a message's text.
  const queued = s.logs.map((l) => JSON.parse(l)).filter((l) => l.msg === "command queued");
  assert.deepEqual(queued.map((l) => l.type), good.map(([body]) => (body as { type: string }).type));
  for (const l of queued) assert.deepEqual(Object.keys(l).sort(), ["commandId", "deviceId", "level", "msg", "time", "type"]);
  assert.ok(!s.logs.some((l) => l.includes("Yemek") || l.includes("xxxxxxxx")), "message text never reaches the log");
});

test("autoplay on start: off by default, PATCH round-trip, in the TV's state, bumps the version, booleans only", async (t) => {
  const { s, tv } = await setup(t);
  const state = () => s.call("GET", "/api/v1/tv/state", { token: tv.token });
  const before = await state();
  assert.equal(before.json.device.autoplayOnStart, false);

  const on = await s.admin("PATCH", `/devices/${tv.deviceId}`, { autoplayOnStart: true });
  assert.equal(on.status, 200);
  assert.equal(on.json.device.settings.autoplayOnStart, true);
  assert.equal(on.json.device.effective.autoplayOnStart, true);
  assert.equal(on.json.device.stateVersion, before.json.version + 1);
  assert.equal(on.json.device.settings.uiLanguage, null, "other settings are untouched");
  const after = await state();
  assert.equal(after.json.version, before.json.version + 1, "the TV re-reads its state");
  assert.equal(after.json.device.autoplayOnStart, true);
  assert.equal((await s.admin("GET", `/devices/${tv.deviceId}`)).json.device.settings.autoplayOnStart, true);
  assert.equal((await s.admin("GET", "/devices")).json.devices[0].effective.autoplayOnStart, true);

  for (const bad of ["yes", 1, null, "true"]) {
    const r = await s.admin("PATCH", `/devices/${tv.deviceId}`, { autoplayOnStart: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.error, "invalid_request");
  }
  const off = await s.admin("PATCH", `/devices/${tv.deviceId}`, { autoplayOnStart: false, name: "Salon 2" });
  assert.equal(off.json.device.settings.autoplayOnStart, false);
  assert.equal(off.json.device.name, "Salon 2");
  assert.equal((await state()).json.device.autoplayOnStart, false);
  assert.equal((await state()).json.version, before.json.version + 2);
});

test("catalog: info, accent-insensitive search, item detail without upstream URLs", async (t) => {
  const { s } = await setup(t);
  const info = await s.admin("GET", "/catalog");
  assert.equal(info.json.id, "fixture");
  assert.equal(info.json.stats.items, 16);
  assert.match(info.json.server.version, /^\d+\.\d+\.\d+/);
  const search = await s.admin("GET", "/catalog/search?q=sov");
  assert.deepEqual(search.json.items.map((i: { id: string }) => i.id), ["show"]);
  assert.equal(search.json.items[0].playableCount, 4);
  assert.equal((await s.admin("GET", "/catalog/search?q=SHOW world")).json.items[0].id, "show", "matches originalTitle");
  assert.equal((await s.admin("GET", "/catalog/search?limit=3")).json.items.length, 3);
  const item = await s.admin("GET", "/catalog/items/show");
  assert.equal(item.json.item.episodes.length, 5);
  const e4 = item.json.item.episodes[3];
  assert.deepEqual(e4.sources.map((x: { id: string }) => x.id), ["needs-proxy", "via-adapter", "plain"]);
  assert.equal(e4.sources[0].needsProxy, true);
  assert.equal(e4.sources[1].adapter, "example");
  const text = JSON.stringify(item.json);
  assert.ok(!text.includes("media.example.test") && !text.includes("ref-value") && !text.includes("Referer"));
  assert.equal((await s.admin("GET", "/catalog/items/ghost")).status, 404);
});

test("catalog reload: new build applies, invalid build is refused and the old one stays", async (t) => {
  const { s, tv } = await setup(t);
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["film", "show"] });
  const itemsFile = path.join(s.bundleDir, "items.json");
  const manifestFile = path.join(s.bundleDir, "bundle.json");
  const items = JSON.parse(await readFile(itemsFile, "utf8"));
  items.items = items.items.filter((i: { id: string }) => i.id !== "film");
  await writeFile(itemsFile, JSON.stringify(items));
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  await writeFile(manifestFile, JSON.stringify({ ...manifest, buildId: "fixture-2" }));
  const v0 = (await s.call("GET", "/api/v1/tv/state", { token: tv.token })).json.version;

  const ok = await s.admin("POST", "/catalog/reload");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.catalog.buildId, "fixture-2");
  const state = await s.call("GET", "/api/v1/tv/state", { token: tv.token });
  assert.equal(state.json.version, v0 + 1);
  assert.equal(state.json.catalog.buildId, "fixture-2");
  assert.deepEqual(state.json.home.map((h: { item: { id: string } }) => h.item.id), ["show"], "missing items are hidden on the TV");
  const detail = await s.admin("GET", `/devices/${tv.deviceId}`);
  assert.deepEqual(detail.json.home.map((h: { itemId: string; missing: boolean }) => [h.itemId, h.missing]), [["film", true], ["show", false]]);

  await writeFile(manifestFile, JSON.stringify({ ...manifest, formatVersion: 2 }));
  const bad = await s.admin("POST", "/catalog/reload");
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error, "invalid_catalog");
  assert.ok(bad.json.issues.some((i: { path: string }) => i.path === "/formatVersion"));
  assert.equal((await s.admin("GET", "/catalog")).json.buildId, "fixture-2");
});
