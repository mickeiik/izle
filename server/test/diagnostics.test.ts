// Admin diagnostics of a channel (`{"itemId"}`): every source tried and probed like an episode's, the errors that
// name what the body got wrong, and nothing secret in the answer or the log. Episodes: proxy.test.ts, admin.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_REFERER, fixtureItems, testServer, TEST_RESOLVER, type Json, type TestServer, type TestServerOptions } from "./helpers.ts";
import { adapterSource, bundleOf, channel } from "./media-helpers.ts";

/** A made-up token-like run (40 base64url characters), never a real secret. */
const RUN = "Zq3v9Kx2LmN8pQ4rT6uW1yA5bC7dE0fGhIjKlMnO"; // gitleaks:allow (made-up hostile fixture)
const LIVE_PLAYLIST = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:812\n#EXTINF:6,\nseg812.ts\n#EXTINF:6,\nseg813.ts\n";

/** The probe's upstream, in memory: a live playlist for HLS, the first KiB of a stream for anything else. */
function fakeUpstream() {
  const asked: Array<[string, Json]> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    asked.push([url, init?.headers]);
    if (url.includes(".m3u8")) return new Response(LIVE_PLAYLIST, { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
    return new Response(new Uint8Array(1024).fill(0x47), { status: 206, headers: { "Content-Type": "video/mp2t" } });
  };
  return { asked, fetch };
}

async function setup(t: { after(fn: () => unknown): void }, opts: TestServerOptions = {}) {
  const up = fakeUpstream();
  const s = await testServer(t, { fetch: up.fetch, ...opts });
  const diagnose = (body: Json) => s.admin("POST", "/diagnostics/resolve", body);
  return { s, up, diagnose };
}

/** Every log line, and the answer, are free of the upstream's URLs and header values. */
function assertNoLeaks(s: TestServer, answer: Json, leaks: string[]) {
  const text = JSON.stringify(answer);
  const logs = s.logs.join("\n");
  for (const leak of leaks) {
    assert.ok(!text.includes(leak), `the answer leaked ${leak}`);
    assert.ok(!logs.includes(leak), `the log leaked ${leak}`);
  }
}

test("a channel by its item id: every source in bundle order, episodeId null, a Referer-bound ts proxied and probed with a Range", async (t) => {
  const { s, up, diagnose } = await setup(t);
  const d = await diagnose({ itemId: "news" });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.deepEqual([d.json.itemId, d.json.episodeId, d.json.playbackAllowed], ["news", null, true]);
  assert.deepEqual(d.json.sources.map((x: Json) => [x.sourceId, x.type, x.ok, x.stream.kind, x.stream.delivery]), [
    ["hls", "direct", true, "hls", "direct"],
    ["ts", "direct", true, "ts", "proxy"],
    ["en", "direct", true, "hls", "direct"],
  ]);
  const [hls, ts] = d.json.sources;
  assert.deepEqual(ts.stream, {
    kind: "ts", inline: false, host: "media.example.test", headerNames: ["Referer"], delivery: "proxy",
    languages: { audio: ["tr"], subtitles: [] }, subtitleTracks: 0, label: null, expiresAt: null,
  });
  assert.deepEqual(ts.probe, { ok: true, ms: ts.probe.ms, status: 206, contentType: "video/mp2t" });
  assert.equal(typeof ts.probe.ms, "number");
  assert.deepEqual(hls.probe.playlist, { master: false, variants: 0, renditions: 0, segments: 2, endList: false }, "a live playlist has no end");

  // The probe sends the source's headers, and a Range for anything but HLS.
  assert.deepEqual(up.asked, [
    ["https://media.example.test/news/live.m3u8", {}],
    ["https://media.example.test/news/live.ts", { Referer: CHANNEL_REFERER, Range: "bytes=0-1023" }],
    ["https://media.example.test/news/en.m3u8", {}],
  ]);
  assertNoLeaks(s, d.json, ["https://", "/news/", "live.ts", "live.m3u8", CHANNEL_REFERER, "site.example.test", "seg812"]);
  const line = s.logs.map((l) => JSON.parse(l)).find((l) => l.msg === "request" && l.route === "/api/v1/admin/diagnostics/resolve");
  assert.deepEqual(Object.keys(line).sort(), ["level", "method", "ms", "msg", "route", "status", "time"], "the access log has the route template only");
});

test("one source of a channel, without a probe; a channel that may not play is diagnosed all the same", async (t) => {
  const { up, diagnose } = await setup(t);
  const d = await diagnose({ itemId: "news", sourceId: "ts", probe: false, preferredAudioLanguage: "en" });
  assert.deepEqual(d.json.sources.map((x: Json) => [x.sourceId, x.ok, x.stream.delivery, x.probe]), [["ts", true, "proxy", undefined]]);
  assert.deepEqual(up.asked, [], "nothing probed");
  assert.deepEqual((await diagnose({ itemId: "off-air" })).json, { itemId: "off-air", episodeId: null, playbackAllowed: false, sources: [] });
});

test("errors: has_episodes for a movie or series, unknown item, source or episode; exactly one of the two ids", async (t) => {
  const { s, up, diagnose } = await setup(t);
  const cases: Array<[Json, number, string]> = [
    [{ itemId: "show" }, 400, "has_episodes"],
    [{ itemId: "film" }, 400, "has_episodes"],
    [{ itemId: "ghost" }, 404, "unknown_item"],
    [{ itemId: "news", sourceId: "nope" }, 404, "unknown_source"],
    [{ itemId: "news", sourceId: "tr-dub" }, 404, "unknown_source"], // an episode's source, not the channel's
    [{ episodeId: "news" }, 404, "unknown_episode"], // a channel's id names no episode
    [{ episodeId: "show.e1", sourceId: "ts" }, 404, "unknown_source"],
    [{ itemId: "news", episodeId: "show.e1" }, 400, "invalid_request"],
    [{}, 400, "invalid_request"],
    [{ itemId: "" }, 400, "invalid_request"],
    [{ itemId: "news", probe: "yes" }, 400, "invalid_request"],
  ];
  for (const [body, status, error] of cases) {
    const r = await diagnose(body);
    assert.deepEqual([r.status, r.json.error], [status, error], JSON.stringify(body));
  }
  assert.equal((await diagnose({ itemId: "show" })).json.itemId, "show", "has_episodes names the item");
  const tv = await s.pair();
  assert.equal((await s.call("POST", "/api/v1/admin/diagnostics/resolve", { token: tv.token, body: { itemId: "news" } })).status, 401);
  assert.deepEqual(up.asked, [], "nothing probed for a refused body");
});

test("a channel's adapter sources: failures as code and name, the results summarized, nothing secret in the answer or the log", async (t) => {
  const results = [
    { media: { kind: "dash", url: `https://dash.example.test/live.mpd?token=${RUN}` }, headers: { Referer: CHANNEL_REFERER } },
    { media: { kind: "ts", url: `https://iptv.example.test/live.ts?token=${RUN}` }, headers: { Referer: CHANNEL_REFERER, Cookie: `s=${RUN}` } },
  ];
  const relay = channel("relay", [
    adapterSource("test", "boom", { behavior: "throw" }),
    adapterSource("test", "none", { behavior: "empty" }),
    adapterSource("test", "iptv", { behavior: "results", results }),
  ]);
  const bundleDir = await bundleOf([...fixtureItems().items, relay], ["example", "test"]);
  const resolver = { module: TEST_RESOLVER, config: { apiBase: "http://127.0.0.1:9/", apiKey: "unused" }, deadlineMs: 1000 };
  const { s, up, diagnose } = await setup(t, { bundleDir, configFile: { resolver } });

  const d = await diagnose({ itemId: "relay" });
  assert.deepEqual([d.status, d.json.episodeId], [200, null]);
  assert.deepEqual(d.json.sources.map((x: Json) => [x.sourceId, x.adapterId, x.ok, x.code ?? null, x.name ?? null]), [
    ["boom", "test", false, "error", "LeakyError"],
    ["none", "test", false, "empty", null],
    ["iptv", "test", true, null, null],
  ]);
  const iptv = d.json.sources[2];
  assert.deepEqual(iptv.results.map((r: Json) => [r.kind, r.host, r.headerNames, r.delivery]), [
    ["dash", "dash.example.test", ["Referer"], "unsupported"],
    ["ts", "iptv.example.test", ["Cookie", "Referer"], "proxy"],
  ]);
  assert.deepEqual([iptv.stream.kind, iptv.stream.delivery, iptv.probe.status], ["ts", "proxy", 206], "the first servable result is the one probed");
  assert.deepEqual(up.asked.map(([url, headers]) => [url, headers.Range]), [[`https://iptv.example.test/live.ts?token=${RUN}`, "bytes=0-1023"]]);
  assertNoLeaks(s, d.json, [RUN, "token=", "https://", "live.ts", CHANNEL_REFERER, "SuperSecret", "signed.secret.example.test", "upstream 500", "behavior"]);
});
