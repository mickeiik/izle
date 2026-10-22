// "Listen along": the TV's playback anchor, the admin long-poll, companion links and the companion resolve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { fixtureItems, fixtureManifest, listen, logged, publishBuild, tempDir, testServer, writeBundle, type Json } from "./helpers.ts";

const PROXY_MP4 = /^\/p\/([A-Za-z0-9_-]{43})\/video\.mp4$/;
const PROXY_HLS = /^\/p\/([A-Za-z0-9_-]{43})\/index\.m3u8$/;
const REFERER = "https://site.example.test/";

/** A local upstream: a plain MP4 anybody may fetch, and an HLS playlist that needs a Referer. */
function startUpstream() {
  const mp4 = Buffer.alloc(4096, 7);
  const server = createServer((req, res) => {
    if (req.url === "/plain/video.mp4") return void res.writeHead(200, { "Content-Type": "video/mp4" }).end(mp4);
    if (req.url?.startsWith("/ref/") && req.headers.referer !== REFERER) return void res.writeHead(403).end("no referer");
    if (req.url === "/ref/master.m3u8") {
      const playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n";
      return void res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" }).end(playlist);
    }
    res.writeHead(404).end();
  });
  return listen(server);
}

const direct = (id: string, audio: string[], media: Json) => ({ id, type: "direct", languages: { audio, subtitles: [] }, media });

async function setup(t: { after(fn: () => unknown): void }) {
  const up = await startUpstream();
  t.after(() => up.close());
  const items = fixtureItems();
  // A series whose first episode has a TV source (Referer-bound HLS), a plain MP4 in another language and a DASH
  // source; its third has the same TV source and a Referer-bound MPEG-TS one.
  const tvHls = direct("tv-hls", ["tr"], { kind: "hls", url: `${up.url}/ref/master.m3u8`, headers: { Referer: REFERER } });
  const frMp4 = direct("fr-mp4", ["fr"], { kind: "mp4", url: `${up.url}/plain/video.mp4` });
  items.items.push({
    id: "dual", kind: "series", title: "Dual", poster: null,
    episodes: [
      { id: "dual.e1", number: 1, durationMs: 600_000, playbackAllowed: true, sources: [tvHls, frMp4, direct("dash-only", ["de"], { kind: "dash", url: "https://dash.example.test/m.mpd" })] },
      { id: "dual.e2", number: 2, playbackAllowed: false, sources: [frMp4] },
      { id: "dual.e3", number: 3, playbackAllowed: true, sources: [tvHls, direct("tr-ts", ["tr"], { kind: "ts", url: `${up.url}/ref/live.ts`, headers: { Referer: REFERER } })] },
    ],
  });
  const bundleDir = await writeBundle(path.join(await tempDir(), "bundle"), fixtureManifest(), items);
  const s = await testServer(t, { bundleDir, configFile: { proxy: { privateUpstreams: ["127.0.0.1"] } } }); // a loopback upstream
  const tv = await s.pair("Salon");
  const as = (method: string, route: string, body?: unknown) => s.call(method, `/api/v1/tv${route}`, { token: tv.token, body });
  const progress = (body: Json) => as("POST", "/progress", body);
  const now = (query = "") => s.admin("GET", `/devices/${tv.deviceId}/now${query}`);
  const companion = (body: Json) => s.admin("POST", `/devices/${tv.deviceId}/companion/resolve`, body);
  const get = (p: string) => fetch(`${s.base}${p}`);
  return { s, tv, up, as, progress, now, companion, get };
}

test("progress reports anchor the TV's position: playing flag, sample age, sequence numbers", async (t) => {
  const { s, as, progress, now } = await setup(t);
  assert.deepEqual((await now()).json, { online: false, serverNowMs: s.clock.now(), seq: 0, nowPlaying: null, anchor: null });

  const r = await as("POST", "/resolve", { episodeId: "dual.e1", sourceId: "tv-hls" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const started = (await now()).json;
  assert.deepEqual([started.seq, started.nowPlaying.state, started.nowPlaying.playing], [1, "starting", false]);
  assert.deepEqual(started.anchor, { positionMs: 0, atMs: s.clock.now(), playing: false, rate: 1 });

  s.clock.advance(5_000);
  const t0 = s.clock.now();
  const hb = await progress({ sessionId: r.json.sessionId, episodeId: "dual.e1", positionMs: 42_000, durationMs: 600_000, status: "playing" });
  assert.equal(hb.status, 200, JSON.stringify(hb.json));
  let n = await now();
  assert.deepEqual([n.json.seq, n.json.serverNowMs, n.json.nowPlaying.playing], [2, t0, true], "without the field, playing follows the status");
  assert.deepEqual(n.json.anchor, { positionMs: 42_000, atMs: t0, playing: true, rate: 1 });

  // A rebuffer stall: the status stays "playing", the player is not advancing, and the sample is 700 ms old.
  s.clock.advance(3_000);
  await progress({ episodeId: "dual.e1", positionMs: 45_000, durationMs: 600_000, status: "playing", playing: false, ageMs: 700 });
  n = await now();
  assert.deepEqual([n.json.seq, n.json.nowPlaying.state, n.json.nowPlaying.updatedAt], [3, "playing", new Date(s.clock.now()).toISOString()]);
  assert.deepEqual(n.json.anchor, { positionMs: 45_000, atMs: s.clock.now() - 700, playing: false, rate: 1 });

  await progress({ episodeId: "dual.e1", positionMs: 45_000, status: "paused", playing: false });
  assert.equal((await now()).json.anchor.playing, false);

  for (const bad of [{ ageMs: 60_001 }, { ageMs: -1 }, { playing: "yes" }]) {
    assert.equal((await progress({ episodeId: "dual.e1", positionMs: 1, status: "playing", ...bad })).status, 400, JSON.stringify(bad));
  }
});

test("GET /now long-polls on the sequence number", async (t) => {
  const { progress, now } = await setup(t);
  await progress({ episodeId: "dual.e1", positionMs: 1_000, status: "playing" });
  const { seq } = (await now()).json as { seq: number };

  // A write wakes the poll at once.
  const started = Date.now();
  const pending = now(`?seq=${seq}&wait=5`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await progress({ episodeId: "dual.e1", positionMs: 2_000, status: "playing" });
  const woke = await pending;
  assert.equal(woke.json.seq, seq + 1);
  assert.ok(Date.now() - started < 2_000, "answered on the write, not after the wait");

  // Nothing happens: answered after the wait with the same seq.
  const t1 = Date.now();
  const same = await now(`?seq=${seq + 1}&wait=1`);
  assert.equal(same.json.seq, seq + 1);
  assert.ok(Date.now() - t1 >= 900, "waited for the timeout");

  // A stale or absent seq answers at once.
  const t2 = Date.now();
  assert.equal((await now(`?seq=${seq}&wait=5`)).json.seq, seq + 1);
  assert.equal((await now("?wait=5")).json.seq, seq + 1);
  assert.ok(Date.now() - t2 < 1_000);

  for (const bad of ["?seq=1&wait=30", "?seq=-1", "?seq=abc"]) assert.equal((await now(bad)).status, 400, bad);
});

test("companion links: validation, storage per episode and source, copy to the item's other episodes", async (t) => {
  const { s, tv, as } = await setup(t);
  const put = (episodeId: string, sourceId: string, body: Json) => s.admin("PUT", `/companion/links/${episodeId}/${sourceId}`, body);
  const bad = [{ offsetMs: 0, rate: 0.4 }, { offsetMs: 0, rate: 2.1 }, { offsetMs: 21_600_001, rate: 1 }, { offsetMs: 0 }];
  for (const body of [...bad, { offsetMs: 0, rate: 1, language: "not a tag" }]) {
    assert.equal((await put("show.e2", "main", body)).status, 400, JSON.stringify(body));
  }
  for (const [e, src] of [["show.e2", "nope"], ["nope", "main"], ["bad id!", "main"]]) assert.equal((await put(e!, src!, { offsetMs: 0, rate: 1 })).status, 404);
  const noLink = await s.admin("POST", "/companion/links/show.e2/main/copy-to-item");
  assert.deepEqual([noLink.status, noLink.json.error], [404, "no_link"]);

  const saved = await put("show.e2", "main", { offsetMs: -1_250, rate: 1.0427, language: "fr" });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const updatedAt = new Date(s.clock.now()).toISOString();
  const link = { offsetMs: -1250, rate: 1.0427, language: "fr", updatedAt };
  assert.deepEqual(saved.json.link, { episodeId: "show.e2", sourceId: "main", ...link });

  // The candidates of what the TV plays carry the stored links.
  assert.equal((await as("POST", "/resolve", { episodeId: "show.e2" })).status, 200);
  const c = await s.admin("GET", `/devices/${tv.deviceId}/companion`);
  assert.deepEqual([c.json.nowPlaying.episodeId, c.json.nowPlaying.itemKind, c.json.nowPlaying.sourceId], ["show.e2", "series", "main"]);
  assert.deepEqual(
    c.json.candidates.map((x: Json) => [x.sourceId, x.type, x.kind, x.current, x.supported, x.link.offsetMs, x.link.rate, x.link.language]),
    [["main", "direct", "hls", true, true, -1250, 1.0427, "fr"]],
  );

  // "Apply to all episodes": show.e5 has a "main" source, show.e1 does not.
  assert.deepEqual((await s.admin("POST", "/companion/links/show.e2/main/copy-to-item")).json, { updated: 1, episodeIds: ["show.e5"] });
  await as("POST", "/resolve", { episodeId: "show.e5" });
  const e5 = await s.admin("GET", `/devices/${tv.deviceId}/companion`);
  assert.deepEqual(e5.json.candidates[0].link, link);

  // A TV that has not played anything has no candidates.
  const other = await s.pair("Other");
  assert.deepEqual((await s.admin("GET", `/devices/${other.deviceId}/companion`)).json, { nowPlaying: null, candidates: [] });
});

test("companion resolve: forced source, always proxied, own session scope, DASH refused, nothing leaks", async (t) => {
  const { s, tv, up, as, now, companion, get } = await setup(t);

  const tvStream = await as("POST", "/resolve", { episodeId: "dual.e1", sourceId: "tv-hls" });
  const [, tvToken] = PROXY_HLS.exec(tvStream.json.media.url) ?? [];
  assert.ok(tvToken, tvStream.json.media.url);
  const before = (await now()).json;

  const c1 = await companion({ episodeId: "dual.e1", sourceId: "fr-mp4", language: "fr" });
  assert.equal(c1.status, 200, JSON.stringify(c1.json));
  assert.match(c1.json.media.url, PROXY_MP4, "a plain MP4 is proxied for the phone although proxy.always is off");
  const { media, sourceId, episodeId, languages, link } = c1.json;
  assert.deepEqual([media.kind, sourceId, episodeId, languages], ["mp4", "fr-mp4", "dual.e1", { audio: ["fr"], subtitles: [] }]);
  assert.deepEqual(link, { offsetMs: 0, rate: 1, language: null, updatedAt: null });
  assert.ok(!JSON.stringify(c1.json).includes(up.url), "no upstream URL reaches the phone");
  const body = await get(c1.json.media.url);
  assert.deepEqual([body.status, (await body.arrayBuffer()).byteLength], [200, 4096]);

  // The TV's now-playing row is untouched.
  assert.deepEqual((await now()).json, before);

  // The phone has its own two-session bucket: three companion resolves never touch the TV's session.
  await companion({ episodeId: "dual.e1", sourceId: "fr-mp4" });
  const c3 = await companion({ episodeId: "dual.e1", sourceId: "fr-mp4" });
  assert.equal((await get(c1.json.media.url)).status, 410, "the oldest companion session was dropped");
  assert.equal((await get(c3.json.media.url)).status, 200);
  assert.equal((await get(tvStream.json.media.url)).status, 200, "the TV keeps its session");

  // The TV's own source gives the phone a fresh session; DASH is refused; errors.
  const same = await companion({ episodeId: "dual.e1", sourceId: "tv-hls" });
  assert.match(same.json.media.url, PROXY_HLS);
  assert.notEqual(same.json.media.url, tvStream.json.media.url);
  const refused: Array<[Json, number, string]> = [
    [{ episodeId: "dual.e1", sourceId: "dash-only" }, 400, "unsupported_media"],
    [{ episodeId: "dual.e1", sourceId: "nope" }, 404, "unknown_source"],
    [{ episodeId: "nope", sourceId: "fr-mp4" }, 404, "unknown_episode"],
    [{ episodeId: "dual.e2", sourceId: "fr-mp4" }, 403, "not_allowed"],
    [{ episodeId: "dual.e1", sourceId: "fr-mp4", language: "bad tag" }, 400, "invalid_request"],
    [{ episodeId: "dual.e1" }, 400, "invalid_request"],
  ];
  for (const [body, status, error] of refused) {
    const r = await companion(body);
    assert.deepEqual([r.status, r.json.error], [status, error], JSON.stringify(body));
  }

  // Candidates mark the DASH source as unsupported and expose no URLs.
  const cand = await s.admin("GET", `/devices/${tv.deviceId}/companion`);
  assert.deepEqual(
    cand.json.candidates.map((x: Json) => [x.sourceId, x.kind, x.current, x.supported, x.reason]),
    [["tv-hls", "hls", true, true, null], ["fr-mp4", "mp4", false, true, null], ["dash-only", "dash", false, false, "dash"]],
  );
  assert.ok(!JSON.stringify(cand.json).includes(up.url));

  // Nothing secret in the log; companion resolves are marked.
  const logs = s.logs.join("\n");
  for (const leak of [tvToken, PROXY_MP4.exec(c3.json.media.url)![1]!, "http://", "https://", REFERER]) assert.ok(!logs.includes(leak), `log leaked ${leak}`);
  const resolved = logged(s, "resolved");
  assert.ok(resolved.some((l) => l.companion === true && l.delivery === "proxy" && l.sourceId === "fr-mp4"));
  assert.ok(resolved.some((l) => l.companion === undefined && l.sourceId === "tv-hls"));

  // Deleting the TV ends its companion sessions too.
  await s.admin("DELETE", `/devices/${tv.deviceId}`);
  assert.equal((await get(c3.json.media.url)).status, 410);
});

test("a channel playing: named with no candidates; the other routes take episodes only; nothing once it left the catalog", async (t) => {
  const { s, tv, as, progress, companion } = await setup(t);
  const view = async () => (await s.admin("GET", `/devices/${tv.deviceId}/companion`)).json;
  const r = await as("POST", "/resolve", { itemId: "news" });
  assert.equal(r.status, 200);
  const nowPlaying = { itemId: "news", itemKind: "live", episodeId: null, sourceId: "hls", itemTitle: "Haber 24", episodeTitle: null, state: "starting" };
  assert.deepEqual(await view(), { nowPlaying, candidates: [] });
  await progress({ sessionId: r.json.sessionId, itemId: "news", status: "playing" });
  assert.deepEqual(await view(), { nowPlaying: { ...nowPlaying, state: "playing" }, candidates: [] });

  // A channel's item id names no episode.
  const refused = [
    await companion({ episodeId: "news", sourceId: "hls" }),
    await s.admin("PUT", "/companion/links/news/hls", { offsetMs: 0, rate: 1 }),
    await s.admin("POST", "/companion/links/news/hls/copy-to-item"),
  ];
  assert.deepEqual(refused.map((r) => [r.status, r.json.error]), [[404, "unknown_episode"], [404, "unknown_episode"], [404, "unknown_episode"]]);
  assert.equal((await companion({ itemId: "news", sourceId: "hls" })).json.error, "invalid_request");

  await publishBuild(s.bundleDir, "fixture-2", (items) => items.filter((i) => i.id !== "news"));
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 200);
  assert.deepEqual(await view(), { nowPlaying: null, candidates: [] });
});

test("an episode's MPEG-TS source: a candidate marked unsupported (ts), refused for the phone with its kind", async (t) => {
  const { s, tv, up, as, now, companion } = await setup(t);
  assert.equal((await as("POST", "/resolve", { episodeId: "dual.e3", sourceId: "tv-hls" })).status, 200);
  const before = (await now()).json;
  const cand = (await s.admin("GET", `/devices/${tv.deviceId}/companion`)).json;
  assert.equal(cand.nowPlaying.episodeId, "dual.e3");
  assert.deepEqual(
    cand.candidates.map((x: Json) => [x.sourceId, x.type, x.kind, x.current, x.supported, x.reason]),
    [["tv-hls", "direct", "hls", true, true, null], ["tr-ts", "direct", "ts", false, false, "ts"]],
  );

  const ts = await companion({ episodeId: "dual.e3", sourceId: "tr-ts" });
  assert.deepEqual([ts.status, ts.json.error, ts.json.kind], [400, "unsupported_media", "ts"]);
  assert.deepEqual((await now()).json, before, "the TV's now-playing row is untouched");
  assert.ok(!JSON.stringify(cand).includes(up.url) && !JSON.stringify(ts.json).includes(up.url), "no upstream URL reaches the phone");
  const logs = s.logs.join("\n");
  for (const leak of [up.url, "http://", REFERER, "live.ts"]) assert.ok(!logs.includes(leak), `log leaked ${leak}`);
});
