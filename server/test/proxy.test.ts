import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { DEFAULT_API_KEY, DEFAULT_REFERER, junkBytes, startUpstream, syntheticMedia, syntheticTsSegment } from "../examples/resolver-example/upstream.js";
import { fixtureManifest, listen, startTestServer, tempDir, TEST_RESOLVER, writeBundle, type Json } from "./helpers.ts";
import { seenSignals } from "./fixtures/test-resolver.js";

const PROXY_URL = /^\/p\/([A-Za-z0-9_-]{43})\/(index\.m3u8|video\.mp4)$/;
const REF = { Referer: DEFAULT_REFERER };

const exampleSource = (id: string, ref: Json) => ({ id, type: "adapter", adapter: "example", ref, languages: { audio: ["en", "tr"], subtitles: ["en"] } });
const testSource = (id: string, ref: Json) => ({ id, type: "adapter", adapter: "test", ref, languages: { audio: null, subtitles: null } });
const direct = (id: string, media: Json) => ({ id, type: "direct", languages: { audio: ["en"], subtitles: [] }, media });
const movie = (id: string, sources: Json[]) => ({ id, kind: "movie", title: id, poster: null, episodes: [{ id: `${id}.main`, playbackAllowed: true, sources }] });

/** A bundle whose sources resolve against the example upstream at `up`. */
function proxyItems(up: string): Json {
  return {
    items: [
      movie("hls", [exampleSource("signed", { video: "demo" })]),
      movie("inline", [exampleSource("inline", { video: "demo", inline: true })]),
      movie("mp4", [exampleSource("mp4", { video: "demo", format: "mp4" })]),
      movie("junk", [exampleSource("junk", { video: "demo", junkBytes: 1000 })]),
      movie("static", [direct("direct-referer", { kind: "hls", url: `${up}/static/demo/master.m3u8`, headers: REF })]),
      movie("fallback", [exampleSource("gone", { video: "gone" }), testSource("broken", { behavior: "throw" }), exampleSource("works", { video: "demo" })]),
      movie("hang", [testSource("hang", { behavior: "hang" }), testSource("hang2", { behavior: "hang-signal" })]),
      movie("hostile", [
        testSource("throw", { behavior: "throw" }), testSource("throw-sync", { behavior: "throw-sync" }),
        testSource("invalid", { behavior: "invalid" }), testSource("not-playlist", { behavior: "not-playlist" }),
        testSource("empty", { behavior: "empty" }),
      ]),
      movie("logger", [testSource("log", { behavior: "log", url: `${up}/static/demo/master.m3u8` })]),
      movie("results", [
        testSource("multi", {
          behavior: "results",
          results: [
            { media: { kind: "dash", url: "https://dash.example.test/m.mpd" }, headers: { Referer: "https://a.example.test/" } },
            {
              media: { kind: "hls", url: "https://plain.example.test/m.m3u8" },
              subtitleTracks: [
                { url: `${up}/static/demo/subs/en/0.vtt`, language: "en", format: "vtt", headers: REF },
                { url: "https://subs.example.test/tr.vtt", language: "tr", format: "vtt", label: "Türkçe" },
              ],
              languages: { audio: ["tr"], subtitles: ["en", "tr"] },
              expiresAt: "2026-10-10T13:00:00Z",
            },
          ],
        }),
      ]),
    ],
  };
}

interface SetupOptions {
  configFile?: Json;
  items?: (up: string) => Json;
  resolver?: Json;
}

async function setupProxy(t: { after(fn: () => unknown): void }, opts: SetupOptions = {}) {
  let upNow = Date.parse("2026-10-10T12:00:00Z");
  const up = await startUpstream({ port: 0, now: () => upNow, tokenTtlSec: 600 });
  t.after(() => up.close());
  const root = await tempDir();
  const bundleDir = await writeBundle(path.join(root, "bundle"), { ...fixtureManifest(), adapters: ["example", "test"] }, (opts.items ?? proxyItems)(up.url));
  const s = await startTestServer({
    bundleDir,
    configFile: {
      resolver: { module: TEST_RESOLVER, config: { apiBase: up.url, apiKey: DEFAULT_API_KEY }, deadlineMs: 2000, budgetMs: 5000, ...opts.resolver },
      ...opts.configFile,
      // The test upstreams listen on loopback, which the proxy refuses unless the owner lists it.
      proxy: { privateUpstreams: ["127.0.0.1"], ...opts.configFile?.proxy },
    },
  });
  t.after(() => s.close());
  const tv = await s.pair();
  const resolve = (episodeId: string, extra: Json = {}) => s.call("POST", "/api/v1/tv/resolve", { token: tv.token, body: { episodeId, ...extra } });
  const get = (p: string, headers: Record<string, string> = {}) => fetch(`${s.base}${p}`, { headers });
  const text = async (p: string) => {
    const res = await get(p);
    return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
  };
  return { s, up, tv, resolve, get, text, advanceUpstream: (ms: number) => void (upNow += ms) };
}

/** URIs of a playlist: URI lines and URI="…" attributes. */
function uris(playlist: string): string[] {
  const out: string[] = [];
  for (const line of playlist.split("\n")) {
    if (line.startsWith("#")) for (const m of line.matchAll(/URI="([^"]*)"/g)) out.push(m[1]!);
    else if (line.trim()) out.push(line.trim());
  }
  return out;
}

test("Referer-bound HLS plays only through the proxy, with every URI rewritten and signed", async (t) => {
  const { s, up, resolve, get, text } = await setupProxy(t);
  const api = (await (await fetch(`${up.url}/api/streams/demo`, { headers: { "X-Api-Key": DEFAULT_API_KEY } })).json()) as { url: string };
  assert.equal((await fetch(api.url)).status, 403, "the upstream refuses requests without the Referer");
  const before = up.requests.length;

  const r = await resolve("hls.main");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const [, token] = PROXY_URL.exec(r.json.media.url) ?? [];
  assert.ok(token, r.json.media.url);
  assert.equal(r.json.media.kind, "hls");
  assert.equal(r.json.expiresAt, "2026-10-10T12:10:00.000Z");
  assert.deepEqual(r.json.languages, { audio: ["en", "tr"], subtitles: ["en"] });
  const visible = JSON.stringify(r.json);
  for (const leak of [up.url, "player.example.test", "Referer", "/s/"]) assert.ok(!visible.includes(leak), `resolve leaked ${leak}`);

  const master = await text(r.json.media.url);
  assert.equal(master.status, 200);
  assert.equal(master.type, "application/vnd.apple.mpegurl");
  const masterUris = uris(master.body);
  assert.equal(masterUris.length, 5, "3 renditions + 2 variants");
  for (const u of masterUris) assert.match(u, /^u\/p\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\.m3u8$/);
  assert.ok(!master.body.includes("http") && !master.body.includes("{{base}}"));

  const dir = `/p/${token}/`;
  const segmentsOf = async (variant: string) => {
    const pl = await text(dir + variant);
    assert.equal(pl.status, 200, variant);
    const segs = uris(pl.body);
    for (const u of segs) assert.match(u, /^r\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\.(ts|vtt)$/, "relative to the u/ directory");
    return segs;
  };
  const media = syntheticMedia();
  // Variant 1 (relative URI), variant 2 (absolute URI in the upstream playlist), an audio rendition, subtitles.
  const v360 = await segmentsOf(masterUris[3]!);
  const seg = await get(`${dir}u/${v360[1]}`);
  assert.equal(seg.status, 200);
  assert.equal(seg.headers.get("content-type"), "video/mp2t");
  assert.deepEqual(Buffer.from(await seg.arrayBuffer()), syntheticTsSegment(11));
  const v180 = await segmentsOf(masterUris[4]!);
  assert.deepEqual(Buffer.from(await (await get(`${dir}u/${v180[0]}`)).arrayBuffer()), media.get("demo/video/180p/seg000.ts"));
  const tr = await segmentsOf(masterUris[1]!);
  assert.deepEqual(Buffer.from(await (await get(`${dir}u/${tr[2]}`)).arrayBuffer()), media.get("demo/audio/tr/seg002.ts"));
  const subs = await segmentsOf(masterUris[2]!);
  const vtt = await text(`${dir}u/${subs[0]}`);
  assert.match(vtt.body, /^WEBVTT/);

  const fetched = up.requests.slice(before).filter((q) => q.path.startsWith("/s/"));
  assert.ok(fetched.length >= 8);
  for (const q of fetched) {
    assert.equal(q.referer, DEFAULT_REFERER, `upstream request ${q.path} without Referer`);
    assert.equal(q.status, 200, q.path);
  }

  // Only URLs the proxy itself wrote are fetchable: tampered or foreign refs are refused.
  const ref = v360[0]!;
  const parts = ref.split(".");
  const forged = Buffer.from(`${up.url}/api/health`).toString("base64url");
  assert.equal((await get(`${dir}u/${parts[0]}.${forged}.${parts[2]}`)).status, 404, "signature does not cover another URL");
  assert.equal((await get(`${dir}u/r.${parts[1]}.${"A".repeat(22)}`)).status, 404, "bad signature");
  assert.equal((await get(`${dir}u/p.${parts[1]}.${parts[2]}`)).status, 404, "kind is signed too");
  const other = await resolve("hls.main");
  const otherToken = PROXY_URL.exec(other.json.media.url)![1];
  assert.equal((await get(`/p/${otherToken}/u/${ref}`)).status, 404, "refs are bound to their session");
  assert.equal((await get(`/p/${"x".repeat(43)}/index.m3u8`)).status, 410, "unknown session: the TV re-resolves");
  assert.equal((await get(`/p/short/index.m3u8`)).status, 404);
  assert.equal((await get(`${dir}video.mp4`)).status, 404, "an HLS session has no MP4 entry");

  const logs = s.logs.join("\n");
  for (const leak of [token!, "player.example.test", "/s/", parts[1]!, DEFAULT_API_KEY]) assert.ok(!logs.includes(leak), `log leaked ${leak.slice(0, 20)}`);
  const access = s.logs.map((l) => JSON.parse(l)).filter((l) => l.msg === "request" && String(l.route).startsWith("/p/"));
  assert.ok(access.length > 0 && access.every((l) => l.route.includes(":token") && l.level === (l.status >= 400 ? "info" : "debug")));
});

test("inline playlists are served as the session's entry; header-bound bundle sources are proxied too", async (t) => {
  const { up, resolve, text, get } = await setupProxy(t);
  const r = await resolve("inline.main");
  assert.equal(r.status, 200);
  const master = await text(r.json.media.url);
  assert.equal(master.status, 200);
  const variants = uris(master.body);
  assert.equal(variants.length, 5);
  const token = PROXY_URL.exec(r.json.media.url)![1];
  const playlist = await text(`/p/${token}/${variants[3]}`);
  const seg = await get(`/p/${token}/u/${uris(playlist.body)[0]}`);
  assert.deepEqual(Buffer.from(await seg.arrayBuffer()), syntheticTsSegment(10));
  assert.equal(up.requests.filter((q) => q.path.endsWith("/master.m3u8")).length, 0, "the master playlist was never fetched");

  const st = await resolve("static.main");
  assert.equal(st.json.sourceId, "direct-referer");
  assert.match(st.json.media.url, PROXY_URL);
  assert.equal((await text(st.json.media.url)).status, 200);
  assert.equal(up.requests.at(-1)!.referer, DEFAULT_REFERER);
});

test("MP4 through the proxy: Range requests pass through", async (t) => {
  const { up, resolve, get } = await setupProxy(t);
  const r = await resolve("mp4.main");
  assert.equal(r.json.media.kind, "mp4");
  assert.match(r.json.media.url, /\/video\.mp4$/);
  const whole = syntheticMedia().get("demo/video.mp4")!;
  const part = await get(r.json.media.url, { Range: "bytes=1000-1999" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 1000-1999/${whole.length}`);
  assert.equal(part.headers.get("content-length"), "1000");
  assert.equal(part.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), whole.subarray(1000, 2000));
  assert.equal(up.requests.at(-1)!.range, "bytes=1000-1999");
  const all = await get(r.json.media.url);
  assert.equal(all.status, 200);
  assert.deepEqual(Buffer.from(await all.arrayBuffer()), whole);
  const beyond = await get(r.json.media.url, { Range: "bytes=999999999-" });
  assert.equal(beyond.status, 416);
  await beyond.arrayBuffer();
});

test("segments stream through without being buffered, and a TV that goes away cancels the upstream", async (t) => {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((r) => (upstreamClosed = r));
  const seen: Array<string | undefined> = [];
  const slow = createServer((req, res) => {
    seen.push(req.headers.referer);
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(2 * 65536) });
    res.write(Buffer.alloc(65536, 1));
    if (req.url === "/hold") {
      res.on("close", () => upstreamClosed());
      return; // never finishes
    }
    void released.then(() => res.end(Buffer.alloc(65536, 2)));
  });
  const { url: slowUrl, close } = await listen(slow);
  t.after(close);
  const mp4 = (id: string, p: string) => direct(id, { kind: "mp4", url: `${slowUrl}${p}`, headers: REF });
  const items = () => ({ items: [movie("slow", [mp4("a", "/slow")]), movie("held", [mp4("b", "/hold")])] });
  const { s, resolve, get } = await setupProxy(t, { items });

  const res = await get((await resolve("slow.main")).json.media.url);
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  let got = 0;
  while (got < 65536) got += (await reader.read()).value!.byteLength; // arrives while the upstream still holds the rest
  release();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
  }
  assert.equal(got, 2 * 65536);
  assert.deepEqual(seen, [DEFAULT_REFERER]);

  const controller = new AbortController();
  const held = await fetch(`${s.base}${(await resolve("held.main")).json.media.url}`, { signal: controller.signal });
  await held.body!.getReader().read();
  controller.abort();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("upstream not cancelled")), 3000))]);
});

test("deadlines: an adapter that never answers is abandoned, signals are aborted, the budget caps the request", async (t) => {
  const { resolve } = await setupProxy(t, { resolver: { deadlineMs: 200, budgetMs: 5000 } });
  let started = performance.now();
  const r = await resolve("hang.main");
  assert.ok(performance.now() - started < 1500, "both sources gave up after their deadline");
  assert.equal(r.status, 502);
  assert.deepEqual(r.json.tried, [
    { sourceId: "hang", code: "timeout", adapterId: "test", name: "TimeoutError" },
    { sourceId: "hang2", code: "timeout", adapterId: "test", name: "TimeoutError" },
  ]);
  assert.equal(seenSignals.at(-1)!.aborted, true, "the adapter's signal fired");

  const budget = await setupProxy(t, { resolver: { deadlineMs: 2000, budgetMs: 300 } });
  started = performance.now();
  const b = await budget.resolve("hang.main");
  assert.ok(performance.now() - started < 1500);
  assert.deepEqual(b.json.tried.map((x: Json) => [x.sourceId, x.code, x.name]), [
    ["hang", "timeout", "TimeoutError"],
    ["hang2", "timeout", "BudgetExhausted"],
  ]);
});

test("an upstream 403 marks the proxy session stale (410) and a new resolve plays again; sessions expire", async (t) => {
  const { s, resolve, text, get, advanceUpstream } = await setupProxy(t);
  const r = await resolve("hls.main");
  const token = PROXY_URL.exec(r.json.media.url)![1];
  const master = await text(r.json.media.url);
  const variant = uris(master.body)[3]!;
  const segs = uris((await text(`/p/${token}/${variant}`)).body);
  assert.equal((await get(`/p/${token}/u/${segs[0]}`)).status, 200);

  advanceUpstream(601_000); // the signed URL expired upstream
  const expired = await get(`/p/${token}/u/${segs[1]}`);
  assert.equal(expired.status, 410);
  assert.deepEqual(await expired.json(), { error: "stale" });
  assert.equal((await get(r.json.media.url)).status, 410, "the whole session is stale now");
  assert.ok(s.logs.some((l) => l.includes("marked stale")));

  const again = await resolve("hls.main", { sourceId: "signed" });
  assert.notEqual(again.json.media.url, r.json.media.url);
  assert.equal((await text(again.json.media.url)).status, 200);

  s.clock.advance(6 * 60 * 60_000 + 1); // sliding TTL (proxy.sessionTtlSec, 6 h by default)
  assert.equal((await get(again.json.media.url)).status, 410);
});

test("a device keeps at most two proxy sessions; deleting the device ends them", async (t) => {
  const { s, tv, resolve, get } = await setupProxy(t);
  const urls = [];
  for (let i = 0; i < 3; i++) urls.push((await resolve("hls.main")).json.media.url);
  assert.equal((await get(urls[0])).status, 410, "the oldest session was dropped");
  assert.equal((await get(urls[1])).status, 200);
  assert.equal((await get(urls[2])).status, 200);
  await s.admin("DELETE", `/devices/${tv.deviceId}`);
  assert.equal((await get(urls[2])).status, 410);
});

test("junk before the first TS packet passes unchanged unless proxy.alignTsSegments is on", async (t) => {
  const firstSegment = async (env: Awaited<ReturnType<typeof setupProxy>>) => {
    const r = await env.resolve("junk.main");
    const token = PROXY_URL.exec(r.json.media.url)![1];
    const master = uris((await env.text(r.json.media.url)).body);
    const segs = uris((await env.text(`/p/${token}/${master[3]}`)).body);
    const subs = uris((await env.text(`/p/${token}/${master[2]}`)).body);
    const seg = await env.get(`/p/${token}/u/${segs[0]}`);
    const vtt = await env.get(`/p/${token}/u/${subs[0]}`);
    return { seg, bytes: Buffer.from(await seg.arrayBuffer()), vtt: await vtt.text() };
  };
  const clean = syntheticTsSegment(10);

  const plain = await firstSegment(await setupProxy(t));
  assert.deepEqual(plain.bytes, Buffer.concat([junkBytes(1000), clean]));

  const aligned = await firstSegment(await setupProxy(t, { configFile: { proxy: { alignTsSegments: true } } }));
  assert.deepEqual(aligned.bytes, clean);
  assert.equal(aligned.seg.headers.get("content-type"), "video/mp2t");
  assert.equal(aligned.seg.headers.get("content-length"), String(clean.length));
  assert.match(aligned.vtt, /^WEBVTT/, "non-TS resources are left alone");
});

test("adapter failures reach the TV and the log only as {adapterId, code, name}; fallback continues server-side", async (t) => {
  const { s, resolve } = await setupProxy(t);
  const r = await resolve("hostile.main");
  assert.equal(r.status, 502);
  assert.deepEqual(r.json.tried, [
    { sourceId: "throw", code: "error", adapterId: "test", name: "LeakyError" },
    { sourceId: "throw-sync", code: "error", adapterId: "test", name: "RangeError" },
    { sourceId: "invalid", code: "error", adapterId: "test", name: "InvalidResult" },
    { sourceId: "not-playlist", code: "error", adapterId: "test", name: "NotAPlaylist" },
    { sourceId: "empty", code: "empty", adapterId: "test" },
  ]);

  const f = await resolve("fallback.main");
  assert.equal(f.status, 200);
  assert.equal(f.json.sourceId, "works", "gone (empty) was tried first; broken (audio unknown) ranks after works");
  assert.deepEqual(f.json.alternatives, ["broken"]);
  const again = await resolve("fallback.main");
  assert.equal(again.json.sourceId, "works", "sources that failed server-side move last for 10 minutes");
  assert.deepEqual(again.json.alternatives, ["broken", "gone"]);

  const logged = await resolve("logger.main");
  assert.equal(logged.status, 200);
  const line = s.logs.map((l) => JSON.parse(l)).find((l) => l.component === "resolver" && l.msg.startsWith("resolving"));
  assert.equal(line.msg, "resolving <url signed.secret.example.test>");
  assert.equal(line.note, "<url signed.secret.example.test>");
  assert.ok(!("url" in line) && !("headers" in line) && !("ref" in line));

  const all = s.logs.join("\n") + JSON.stringify(r.json);
  for (const leak of ["SuperSecret", "master.m3u8?token", "upstream 500", "bad ref", "behavior"]) assert.ok(!all.includes(leak), `leaked ${leak}`);
  const failures = s.logs.map((l) => JSON.parse(l)).filter((l) => l.msg === "adapter failed");
  assert.ok(failures.length >= 5);
  for (const f of failures) {
    const keys = ["adapterId", "code", "deviceId", "episodeId", "ms", ...("name" in f ? ["name"] : []), "sourceId"];
    assert.deepEqual(Object.keys(f).filter((k) => !["time", "level", "msg"].includes(k)).sort(), keys.sort());
  }
});

test("the first servable result wins; header-bound subtitle tracks are proxied; proxy.always proxies everything", async (t) => {
  const { resolve, get } = await setupProxy(t);
  const r = await resolve("results.main");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.media, { kind: "hls", url: "https://plain.example.test/m.m3u8" }, "DASH with headers is skipped, a plain URL goes direct");
  assert.match(r.json.subtitleTracks[0].url, /^\/p\/[A-Za-z0-9_-]{43}\/sub\/0\.vtt$/);
  assert.deepEqual(r.json.subtitleTracks[1], { url: "https://subs.example.test/tr.vtt", language: "tr", format: "vtt", label: "Türkçe" });
  assert.deepEqual(r.json.languages, { audio: ["tr"], subtitles: ["en", "tr"] });
  assert.equal(r.json.expiresAt, "2026-10-10T13:00:00Z");
  const sub = await get(r.json.subtitleTracks[0].url);
  assert.equal(sub.status, 200);
  assert.equal(sub.headers.get("content-type"), "text/vtt; charset=utf-8");
  assert.match(await sub.text(), /Hello from the example upstream/);

  const always = await setupProxy(t, { configFile: { proxy: { always: true } } });
  const a = await always.resolve("results.main");
  assert.match(a.json.media.url, PROXY_URL);
  assert.match(a.json.subtitleTracks[1].url, /\/sub\/1\.vtt$/);
});

test("admin diagnostics: every source tried, hosts and header names only, optional upstream probe", async (t) => {
  const { s, up, tv } = await setupProxy(t);
  const d = await s.admin("POST", "/diagnostics/resolve", { episodeId: "fallback.main" });
  assert.equal(d.status, 200);
  const outcomes = d.json.sources.map((x: Json) => [x.sourceId, x.ok, x.code ?? null, x.name ?? null]);
  assert.deepEqual(outcomes, [["gone", false, "empty", null], ["broken", false, "error", "LeakyError"], ["works", true, null, null]]);
  const works = d.json.sources[2];
  assert.deepEqual(works.stream, {
    kind: "hls", inline: false, host: new URL(up.url).host, headerNames: ["Referer"], delivery: "proxy", subtitleTracks: 0,
    languages: { audio: ["en", "tr"], subtitles: ["en"] }, label: null, expiresAt: "2026-10-10T12:10:00.000Z",
  });
  assert.equal(works.probe.ok, true);
  assert.equal(works.probe.status, 200);
  assert.deepEqual(works.probe.playlist, { master: true, variants: 2, renditions: 3, segments: 0, endList: false });
  const text = JSON.stringify(d.json);
  for (const leak of ["player.example.test", "/s/", "demo", "behavior"]) assert.ok(!text.includes(leak), `diagnostics leaked ${leak}`);

  const inline = await s.admin("POST", "/diagnostics/resolve", { episodeId: "inline.main" });
  assert.equal(inline.json.sources[0].stream.inline, true);
  assert.equal(inline.json.sources[0].probe.playlist.variants, 2);
  const mp4 = await s.admin("POST", "/diagnostics/resolve", { episodeId: "mp4.main", probe: true });
  assert.equal(mp4.json.sources[0].probe.status, 206);
  const noProbe = await s.admin("POST", "/diagnostics/resolve", { episodeId: "mp4.main", probe: false });
  assert.equal(noProbe.json.sources[0].probe, undefined);
  assert.equal((await s.admin("POST", "/diagnostics/resolve", { episodeId: "nope" })).status, 404);
  assert.equal((await s.call("POST", "/api/v1/admin/diagnostics/resolve", { token: tv.token, body: { episodeId: "hls.main" } })).status, 401);
  assert.deepEqual((await s.admin("GET", "/catalog")).json.resolver.adapters, ["example", "test"]);
});
