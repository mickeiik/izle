// Admin checks of one episode or channel (`POST /admin/diagnostics/resolve`): every source tried and deep-checked
// along the TV's path, the errors that name what the body got wrong, what hostile upstreams make of the report, and
// nothing secret in the answer, the stored rows or the log. Runs of many: checks.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { syntheticTsSegment } from "../examples/resolver-example/upstream.js";
import { sniffContainer } from "../src/diagnostics.ts";
import { assertNoLeaks, CHANNEL_REFERER, fixtureItems, logged, testServer, TEST_RESOLVER, type Json, type TestServerOptions } from "./helpers.ts";
import { adapterSource, bundleOf, channel, direct, movie, upstream } from "./media-helpers.ts";

/** A made-up token-like run (40 base64url characters), never a real secret. */
const RUN = "Zq3v9Kx2LmN8pQ4rT6uW1yA5bC7dE0fGhIjKlMnO"; // gitleaks:allow (made-up hostile fixture)
const LIVE_PLAYLIST = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:812\n#EXTINF:6,\nseg812.ts\n#EXTINF:6,\nseg813.ts\n";

/** The upstream, in memory: a live playlist for HLS, the first KiB of a stream for anything else. */
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

test("a channel by its item id: every source in bundle order, episodeId null, a Referer-bound ts proxied and read", async (t) => {
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
  assert.deepEqual(ts.steps, [{ what: "file", host: "media.example.test", ok: true, status: 206, ms: ts.steps[0].ms, bytes: 1024, container: "ts" }]);
  assert.equal(typeof ts.steps[0].ms, "number");
  assert.deepEqual(hls.steps.map((x: Json) => [x.what, x.ok, x.container]), [["playlist", true, "m3u8"], ["segment", true, "ts"]]);
  assert.deepEqual([d.json.verdict, hls.verdict, ts.verdict, hls.codecs, hls.warnings], ["ok", "ok", "ok", [], []]);
  assert.match(d.json.checkedAt, /^2026-10-10T12:00:00/);

  // A live playlist's last segment (where a TV starts); the endless stream without a Range, through the proxy with
  // the source's header; the direct ones without any.
  assert.deepEqual(up.asked, [
    ["https://media.example.test/news/live.m3u8", {}],
    ["https://media.example.test/news/seg813.ts", {}],
    ["https://media.example.test/news/live.ts", { Referer: CHANNEL_REFERER, "Accept-Encoding": "identity" }],
    ["https://media.example.test/news/en.m3u8", {}],
    ["https://media.example.test/news/seg813.ts", {}],
  ]);
  assertNoLeaks(s, d.json, ["https://", "/news/", "live.ts", "live.m3u8", CHANNEL_REFERER, "site.example.test", "seg812"]);
  const line = s.logs.map((l) => JSON.parse(l)).find((l) => l.msg === "request" && l.route === "/api/v1/admin/diagnostics/resolve");
  assert.deepEqual(Object.keys(line).sort(), ["level", "method", "ms", "msg", "route", "status", "time"], "the access log has the route template only");
});

test("one source of a channel: only it is checked and stored; a channel that may not play is checked all the same", async (t) => {
  const { s, up, diagnose } = await setup(t);
  const d = await diagnose({ itemId: "news", sourceId: "ts", preferredAudioLanguage: "en" });
  assert.deepEqual(d.json.sources.map((x: Json) => [x.sourceId, x.ok, x.stream.delivery, x.verdict]), [["ts", true, "proxy", "ok"]]);
  assert.equal(up.asked.length, 1);
  const stored = s.srv.ctx.store.getSourceChecks("fixture", "news", "news");
  assert.deepEqual(stored.map((r) => [r.sourceId, r.verdict, r.report.sourceId]), [["ts", "ok", "ts"]]);
  const off = (await diagnose({ itemId: "off-air" })).json;
  assert.deepEqual(off, { itemId: "off-air", episodeId: null, playbackAllowed: false, verdict: "fail", checkedAt: off.checkedAt, sources: [] }, "nothing to play from");
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
    [{ itemId: "news", probe: true }, 400, "invalid_request"], // gone (pre-release): every check goes deep
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
  assert.deepEqual([iptv.stream.kind, iptv.stream.delivery, iptv.steps[0].status], ["ts", "proxy", 206], "the first servable result is the one checked");
  assert.deepEqual(d.json.sources.map((x: Json) => [x.verdict, x.steps.length, typeof x.checkMs]), [["fail", 0, "number"], ["fail", 0, "number"], ["ok", 1, "number"]]);
  assert.equal(d.json.verdict, "warn", "two of three sources fail");
  assert.deepEqual(up.asked.map(([url, headers]) => [url, headers.Cookie]), [[`https://iptv.example.test/live.ts?token=${RUN}`, `s=${RUN}`]]);
  assertNoLeaks(s, d.json, [RUN, "token=", "https://", "live.ts", CHANNEL_REFERER, "SuperSecret", "signed.secret.example.test", "upstream 500", "behavior"]);
});

// --- hostile upstreams -----------------------------------------------------------------------------------------

const box = (type: string, size = 64) => Buffer.concat([Buffer.from([0, 0, 0, size]), Buffer.from(type, "latin1"), Buffer.alloc(size - 8, 1)]);
const TS = syntheticTsSegment(7);
const SECRET_REFERER = "https://secret-player.example.test/";
const HTML = "<!doctype html><html><body>Video not found</body></html>";
const vod = (...lines: string[]) => ["#EXTM3U", "#EXT-X-TARGETDURATION:6", ...lines, "#EXT-X-ENDLIST", ""].join("\n");
const master = (...variants: string[]) => ["#EXTM3U", ...variants, ""].join("\n");

type Reply = (res: ServerResponse, range: string | undefined) => void;
const playlist = (text: string): Reply => (res) => void res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" }).end(text);
const bytes = (body: Buffer | string, type = "application/octet-stream"): Reply => (res) => void res.writeHead(200, { "Content-Type": type }).end(body);
const status = (code: number, headers: Record<string, string> = {}): Reply => (res) => void res.writeHead(code, headers).end("no");

/** The hostile upstream's files: every path carries a token-like run that must never show up anywhere. */
const FILES: Record<string, Reply> = {
  "/dead/master.m3u8": playlist(master("#EXT-X-STREAM-INF:BANDWIDTH=900000", "good.m3u8", "#EXT-X-STREAM-INF:BANDWIDTH=300000", "gone.m3u8")),
  "/dead/good.m3u8": playlist(vod("#EXTINF:6,", "s0.ts")),
  "/dead/s0.ts": bytes(TS, "video/mp2t"),
  "/html/index.m3u8": playlist(vod("#EXTINF:6,", "s0.ts")),
  "/html/s0.ts": bytes(HTML, "text/html"),
  // A plain-text refusal that starts with the MPEG-TS sync byte ("G") and is one packet long.
  "/geo/index.m3u8": playlist(vod("#EXTINF:6,", "s0.ts")),
  "/geo/s0.ts": bytes(`Geo-blocked: ${"this video is not available in your country. ".repeat(5)}`, "text/plain"),
  "/bad-uri/master.m3u8": playlist(master("#EXT-X-STREAM-INF:BANDWIDTH=900000", "ftp://files.example.test/v.m3u8")),
  "/key/index.m3u8": playlist(vod('#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x0', "#EXTINF:6,", "s0.ts")),
  "/key/s0.ts": bytes(Buffer.alloc(4096, 0x9c)),
  "/short-key/index.m3u8": playlist(vod('#EXT-X-KEY:METHOD=AES-128,URI="k.bin"', "#EXTINF:6,", "s0.ts")),
  "/short-key/k.bin": bytes(Buffer.alloc(8, 1)),
  "/short-key/s0.ts": bytes(Buffer.alloc(4096, 0x9c)),
  "/sample-aes/index.m3u8": playlist(vod('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"', "#EXTINF:6,", "s0.ts")),
  "/sample-aes/s0.ts": bytes(TS, "video/mp2t"),
  "/fmp4/index.m3u8": playlist(vod('#EXT-X-MAP:URI="init.mp4"', "#EXTINF:6,", "s0.m4s")),
  "/fmp4/init.mp4": bytes(box("ftyp")),
  "/fmp4/s0.m4s": bytes(box("moof")),
  "/norange/video.mp4": bytes(Buffer.concat([box("ftyp"), Buffer.alloc(100_000, 2)]), "video/mp4"),
  "/range/video.mp4": (res, range) => {
    if (range !== "bytes=0-65535") return void res.writeHead(400).end();
    res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": "bytes 0-65535/1000000" }).end(Buffer.concat([box("ftyp"), Buffer.alloc(65536 - 64, 2)]));
  },
  "/hevc/master.m3u8": playlist(master(
    '#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160,CODECS="hvc1.2.4.L153.B0,ec-3"', "uhd.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"', "hd.m3u8",
  )),
  "/hevc/uhd.m3u8": playlist(vod("#EXTINF:6,", "s0.ts")),
  "/hevc/hd.m3u8": playlist(vod("#EXTINF:6,", "s0.ts")),
  "/hevc/s0.ts": bytes(TS, "video/mp2t"),
  "/live/index.m3u8": playlist(["#EXTM3U", "#EXT-X-TARGETDURATION:6", "#EXT-X-MEDIA-SEQUENCE:40", ...[40, 41, 42].flatMap((n) => ["#EXTINF:6,", `s${n}.ts`]), ""].join("\n")),
  "/live/s40.ts": bytes(TS, "video/mp2t"),
  "/live/s41.ts": bytes(TS, "video/mp2t"),
  "/live/s42.ts": bytes(TS, "video/mp2t"),
  // A channel as one endless MPEG-TS response that sends a little, then nothing for a while.
  "/trickle/stream.ts": (res) => void res.writeHead(200, { "Content-Type": "video/mp2t" }).write(TS),
  "/subs/index.m3u8": playlist(vod("#EXTINF:6,", "s0.ts")),
  "/subs/s0.ts": bytes(TS, "video/mp2t"),
  "/subs/tr.vtt": bytes(HTML, "text/html"),
  "/dash/manifest.mpd": bytes('<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>', "application/dash+xml"),
  "/refused/index.m3u8": playlist(vod("#EXTINF:6,", "s0.ts")),
  "/refused/s0.ts": status(403),
  "/egress/index.m3u8": playlist(vod("#EXTINF:6,", "s0.ts", "#EXTINF:6,", "s1.ts")),
  "/egress/s0.ts": status(302, { Location: "http://10.11.12.13/internal/s0.ts" }),
};

/** Paths under `/hdr/` need the secret Referer, like a site's player would send. */
async function hostile(t: { after(fn: () => unknown): void }) {
  const up = await upstream(t, (req, res) => {
    const u = new URL(req.url ?? "/", "http://up");
    const path = u.pathname.replace(/^\/hdr\//, "/");
    if (u.pathname.startsWith("/hdr/") && req.headers.referer !== SECRET_REFERER) return void res.writeHead(403).end("referer");
    const reply = FILES[path];
    if (!reply) return void res.writeHead(404).end("not found");
    reply(res, req.headers.range);
  });
  const at = (path: string, kind = "hls", extra: Json = {}) => ({ kind, url: `${up.url}${path}?token=${RUN}`, ...extra });
  const one = (id: string, media: Json, more: Json = {}) => movie(id, [{ ...direct("src", media), ...more }]);
  const items = [
    one("dead", at("/dead/master.m3u8")),
    one("html", at("/html/index.m3u8")),
    one("geo", at("/geo/index.m3u8")),
    one("bad-uri", at("/bad-uri/master.m3u8")),
    one("key", at("/key/index.m3u8")),
    one("short-key", at("/short-key/index.m3u8")),
    one("sample-aes", at("/sample-aes/index.m3u8")),
    one("fmp4", at("/fmp4/index.m3u8")),
    one("norange", at("/norange/video.mp4", "mp4")),
    one("range", at("/range/video.mp4", "mp4")),
    one("hevc", at("/hevc/master.m3u8")),
    one("live", at("/live/index.m3u8")),
    one("trickle", at("/trickle/stream.ts", "ts")),
    one("subs", at("/subs/index.m3u8"), { subtitleTracks: [{ url: `${up.url}/subs/tr.vtt?token=${RUN}`, language: "tr", format: "vtt" }] }),
    one("dash", at("/dash/manifest.mpd", "dash")),
    one("header", at("/hdr/fmp4/index.m3u8", "hls", { headers: { Referer: SECRET_REFERER } })),
    one("refused", at("/hdr/refused/index.m3u8", "hls", { headers: { Referer: SECRET_REFERER } })),
    one("egress", at("/hdr/egress/index.m3u8", "hls", { headers: { Referer: SECRET_REFERER } })),
  ];
  // The upstream listens on loopback, which the proxy refuses unless the owner lists it.
  const s = await testServer(t, { bundleDir: await bundleOf(items), configFile: { proxy: { privateUpstreams: ["127.0.0.1"] } } });
  const check = async (id: string) => {
    const r = await s.admin("POST", "/diagnostics/resolve", { episodeId: `${id}.main` });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { answer: r.json, source: r.json.sources[0] as Json };
  };
  const leaks = [RUN, "token=", SECRET_REFERER, "secret-player", "http://", "/hdr/", ".m3u8", "s0.ts", "k.bin", "10.11.12.13", "internal", "Video not found"];
  return { s, up, check, leaks };
}

/** A source's steps as `[what, index, ok, status, error, container]`. */
const stepsOf = (source: Json) => source.steps.map((x: Json) => [x.what, x.index ?? null, x.ok, x.status ?? null, x.error ?? null, x.container ?? null]);

test("deep check: a dead variant, an error page for a segment, a missing or short AES key fail the source; nothing leaks", async (t) => {
  const { s, check, leaks } = await hostile(t);
  const dead = await check("dead");
  assert.deepEqual(stepsOf(dead.source), [
    ["playlist", null, true, 200, null, "m3u8"], ["variant", 0, true, 200, null, "m3u8"], ["variant", 1, false, 404, "http", null], ["segment", 0, true, 200, null, "ts"],
  ]);
  assert.deepEqual([dead.source.verdict, dead.answer.verdict, dead.source.stream.delivery], ["fail", "fail", "direct"]);

  const html = await check("html");
  assert.deepEqual(stepsOf(html.source).at(-1), ["segment", null, false, 200, "not_media", null], "an HTML page that answered 200 is not media");
  const geo = await check("geo");
  assert.deepEqual(stepsOf(geo.source).at(-1), ["segment", null, false, 200, "not_media", null], "short text that starts with a G is not MPEG-TS");
  const badUri = await check("bad-uri");
  assert.deepEqual([stepsOf(badUri.source), badUri.source.verdict], [[["playlist", null, true, 200, null, "m3u8"], ["variant", 0, false, null, "bad_uri", null]], "fail"],
    "a variant that cannot be fetched fails, it is not skipped");
  const key = await check("key");
  assert.deepEqual(stepsOf(key.source).slice(1), [["key", null, false, 404, "http", null], ["segment", null, true, 200, null, null]], "encrypted bytes have no signature");
  const short = await check("short-key");
  assert.deepEqual([short.source.steps[1].what, short.source.steps[1].error, short.source.steps[1].bytes, short.source.verdict], ["key", "bad_key", 8, "fail"]);
  for (const r of [dead, html, geo, badUri, key, short]) assertNoLeaks(s, r.answer, leaks);
});

test("deep check: fMP4 init and segment, SAMPLE-AES, an MP4 without Range, HEVC/4K codecs and a failing subtitle track warn", async (t) => {
  const { s, check, leaks } = await hostile(t);
  const fmp4 = await check("fmp4");
  assert.deepEqual(stepsOf(fmp4.source), [["playlist", null, true, 200, null, "m3u8"], ["init", null, true, 200, null, "mp4"], ["segment", null, true, 200, null, "fmp4"]]);
  assert.equal(fmp4.source.verdict, "ok");

  const sample = await check("sample-aes");
  assert.deepEqual([sample.source.verdict, sample.source.warnings, sample.source.steps.length], ["warn", ["sample_aes"], 2], "the skd: key is not fetched");
  const norange = await check("norange");
  assert.deepEqual([stepsOf(norange.source), norange.source.steps[0].bytes, norange.source.warnings, norange.answer.verdict], [
    [["file", null, true, 200, null, "mp4"]], 65536, ["no_range"], "warn",
  ]);
  const range = await check("range");
  assert.deepEqual([stepsOf(range.source), range.source.warnings, range.source.verdict], [[["file", null, true, 206, null, "mp4"]], [], "ok"]);

  const hevc = await check("hevc");
  assert.deepEqual(hevc.source.codecs, [
    { codecs: "hvc1.2.4.L153.B0,ec-3", resolution: "3840x2160", bandwidth: 12000000 }, { codecs: "avc1.64001f,mp4a.40.2", resolution: "1280x720", bandwidth: 2000000 },
  ]);
  assert.deepEqual([hevc.source.warnings.sort(), hevc.source.verdict], [["high_resolution", "risky_codec"], "warn"], "a codec risk warns, never fails");
  assert.deepEqual(hevc.source.steps.map((x: Json) => [x.what, x.index ?? null, x.of ?? null]), [
    ["playlist", null, null], ["variant", 0, null], ["variant", 1, null], ["segment", 0, "variant"],
  ], "a segment names the playlist it came from");

  const subs = await check("subs");
  assert.deepEqual(stepsOf(subs.source).at(-1), ["subtitle", 0, false, 200, "not_subtitles", null]);
  assert.deepEqual([subs.source.warnings, subs.source.verdict], [["subtitle_failed"], "warn"], "the picture plays without subtitles");
  const dash = await check("dash");
  assert.deepEqual([stepsOf(dash.source), dash.source.warnings, dash.source.verdict], [[["manifest", null, true, 200, null, "mpd"]], ["manifest_only"], "warn"]);
  for (const r of [fmp4, sample, norange, hevc, subs, dash]) assertNoLeaks(s, r.answer, leaks);
});

test("deep check: a live playlist's last segment, not its first", async (t) => {
  const { up, check } = await hostile(t);
  const live = await check("live");
  assert.deepEqual(stepsOf(live.source), [["playlist", null, true, 200, null, "m3u8"], ["segment", null, true, 200, null, "ts"]]);
  assert.deepEqual(up.hits.map((h) => new URL(h.path, "http://up").pathname), ["/live/index.m3u8", "/live/s42.ts"]);
});

test("deep check: an endless MPEG-TS stream that stalls after its first bytes is judged on what came", async (t) => {
  const { check } = await hostile(t);
  const trickle = await check("trickle");
  assert.deepEqual(stepsOf(trickle.source), [["file", null, true, 200, null, "ts"]]);
  assert.ok(trickle.source.checkMs < 5000, "it does not wait for the request timeout");
});

test("deep check through the proxy: the upstream header reaches every request, a refusal names its status, a redirect to a private address is refused", async (t) => {
  const { s, up, check, leaks } = await hostile(t);
  const header = await check("header");
  assert.deepEqual([header.source.stream.delivery, header.source.verdict], ["proxy", "ok"]);
  assert.deepEqual(stepsOf(header.source), [["playlist", null, true, 200, null, "m3u8"], ["init", null, true, 200, null, "mp4"], ["segment", null, true, 200, null, "fmp4"]]);
  assert.ok(header.source.steps.every((x: Json) => x.host === new URL(up.url).host), "the upstream's host, not the server's");
  assert.deepEqual(up.hits.map((h) => h.headers.referer), [SECRET_REFERER, SECRET_REFERER, SECRET_REFERER]);

  const refused = await check("refused");
  assert.deepEqual(stepsOf(refused.source).at(-1), ["segment", null, false, 403, "http", null], "the upstream's 403 behind the proxy's 410");
  const egress = await check("egress");
  assert.deepEqual(stepsOf(egress.source).at(-1), ["segment", null, false, null, "egress_denied", null]);
  assert.equal(egress.source.verdict, "fail");
  assert.deepEqual([logged(s, "problem recorded"), logged(s, "problem not recorded")], [[], []], "a check's proxy problems are no TV's");
  assert.equal(s.srv.ctx.store.sourceCheckKeys().length, 3);
  for (const r of [header, refused, egress]) assertNoLeaks(s, r.answer, leaks);
});

test("container signatures: TS (aligned or behind junk), MP4 boxes, ADTS, ID3; text is never media", () => {
  assert.equal(sniffContainer(TS), "ts");
  assert.equal(sniffContainer(Buffer.concat([Buffer.alloc(100, 0x11), TS])), "ts");
  assert.deepEqual([sniffContainer(box("ftyp")), sniffContainer(box("styp")), sniffContainer(box("moof"))], ["mp4", "fmp4", "fmp4"]);
  assert.equal(sniffContainer(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc])), "aac");
  assert.equal(sniffContainer(Buffer.from("ID3\u0004\u0000")), "id3");
  assert.deepEqual([sniffContainer(Buffer.from("\uFEFFWEBVTT\n\n")), sniffContainer(Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nhi\n"))], ["webvtt", "srt"]);
  assert.deepEqual([sniffContainer(Buffer.from('<?xml version="1.0"?><tt xmlns="x">')), sniffContainer(Buffer.from("<MPD>"))], ["ttml", "mpd"]);
  assert.deepEqual([sniffContainer(Buffer.from(HTML)), sniffContainer(Buffer.from('{"error":"gone"}')), sniffContainer(Buffer.from("Gone"))], [null, null, null]);
  assert.equal(sniffContainer(Buffer.from(`G${"o".repeat(200)}`)), null, "one packet's worth of text is not MPEG-TS");
  assert.equal(sniffContainer(Buffer.alloc(64, 0x9c)), null, "unknown bytes: no container, but not text either");
});
