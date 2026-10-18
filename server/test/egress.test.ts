import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { egressPolicy, EgressDenied, invalidPrivateUpstream, isNonPublicAddress } from "../src/egress.ts";
import { fixtureManifest, listen, startTestServer, tempDir, writeBundle, type Json } from "./helpers.ts";

test("egress policy: non-public addresses and IP literals are refused unless listed", () => {
  for (const a of [
    "127.0.0.1", "127.255.0.9", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.251", "255.255.255.255", "198.18.0.1", "::", "::1", "fe80::1", "fe80::1%eth0", "fd00::1", "ff02::1", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "64:ff9b::1", "not-an-address",
  ]) assert.equal(isNonPublicAddress(a), true, a);
  for (const a of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) assert.equal(isNonPublicAddress(a), false, a);

  const none = egressPolicy();
  const refused = (url: string, policy = none) => assert.throws(() => policy.check(new URL(url)), (e: unknown) => e instanceof EgressDenied, url);
  for (const u of ["http://127.0.0.1/", "http://[::1]:8080/", "http://[::ffff:127.0.0.1]/", "https://169.254.169.254/latest/meta-data/", "http://10.0.0.1:8788/x", "http://0x7f.1/"]) refused(u);
  assert.throws(() => none.check(new URL("ftp://media.example.test/a")), (e: EgressDenied) => e.reason === "scheme");
  assert.throws(() => none.check(new URL("http://user:pw@media.example.test/a")), (e: EgressDenied) => e.reason === "credentials_in_url");
  none.check(new URL("https://media.example.test/a.m3u8")); // a host name is vetted by the connection's lookup
  none.check(new URL("http://93.184.216.34/a.m3u8"));

  const listed = egressPolicy(["127.0.0.1:8788", "nas.lan", "192.168.0.0/16", "[::1]:9000"]);
  listed.check(new URL("http://127.0.0.1:8788/api"));
  refused("http://127.0.0.1:8789/api", listed);
  listed.check(new URL("http://192.168.4.2:5000/x"));
  listed.check(new URL("http://[::1]:9000/x"));
  refused("http://[::1]:9001/x", listed);
  refused("http://10.0.0.1/x", listed);
  assert.equal(listed.allows("nas.lan", 80, "192.168.1.2"), true);
  assert.equal(listed.allows("NAS.lan", 443, "10.9.9.9"), true, "a listed name may resolve to any address");
  assert.equal(listed.allows("other.lan", 80, "10.9.9.9"), false);
  assert.equal(listed.allows("other.lan", 80, "93.184.216.34"), true);

  assert.equal(invalidPrivateUpstream(["127.0.0.1", "localhost", "localhost:8788", "10.0.0.0/8", "::1", "[::1]:80", "nas.lan."]), null);
  for (const bad of ["127.0.0.1:0", "127.0.0.1:70000", "10.0.0.0/33", "http://nas.lan", "nas lan", "10.0.0", "", "a/b"]) assert.equal(invalidPrivateUpstream([bad]), bad, bad);
});

interface Hit {
  path: string;
  headers: IncomingHttpHeaders;
}

/** A loopback server that records every request it gets and answers with a marker body. */
async function startInternal() {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    hits.push({ path: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "Content-Type": "text/html" }).end("INTERNAL-ONLY-MARKER");
  });
  return { ...(await listen(server)), hits };
}

const CREDENTIALS = { Referer: "https://player.example.test/", Authorization: "Bearer dummy-upstream-credential", Cookie: "sess=dummy-cookie", "X-Api-Key": "dummy-key" };

/**
 * The upstream a proxied source points at, authored by an attacker: its playlists name the internal server
 * directly, in an EXT-X-KEY URI attribute and behind redirects; it also has an honest segment, a same-origin
 * redirect, a segment on a second (allowed) origin and an endless redirect.
 */
async function startHostileUpstream(internal: string, other: string) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const p = req.url ?? "";
    hits.push({ path: p, headers: req.headers });
    const playlist = (body: string) => res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" }).end(body);
    if (p === "/master.m3u8") return playlist(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\n/redir-playlist\n`);
    if (p === "/media.m3u8") {
      return playlist(
        [
          "#EXTM3U", "#EXT-X-TARGETDURATION:4", `#EXT-X-KEY:METHOD=AES-128,URI="${internal}/internal/key"`,
          "#EXTINF:4,", `${internal}/internal/direct-segment`,
          "#EXTINF:4,", "/redir-segment",
          "#EXTINF:4,", "/ok-segment.ts",
          "#EXTINF:4,", "/same-origin-redirect",
          "#EXTINF:4,", `${other}/cdn-segment.ts`,
          "#EXTINF:4,", "/loop",
          "#EXT-X-ENDLIST",
        ].join("\n"),
      );
    }
    if (p === "/redir-playlist") return void res.writeHead(302, { Location: `${internal}/internal/playlist-via-redirect` }).end();
    if (p === "/redir-segment") return void res.writeHead(302, { Location: `${internal}/internal/via-redirect` }).end();
    if (p === "/same-origin-redirect") return void res.writeHead(307, { Location: "/ok-segment.ts?moved" }).end();
    if (p === "/loop") return void res.writeHead(302, { Location: "/loop" }).end();
    if (p.startsWith("/ok-segment.ts")) return void res.writeHead(200, { "Content-Type": "video/mp2t" }).end("SEGMENT");
    res.writeHead(404).end();
  });
  return { ...(await listen(server)), hits };
}

/** URIs of a playlist: URI lines and URI="…" attributes. */
const uris = (playlist: string): string[] =>
  playlist.split("\n").flatMap((line) => (line.startsWith("#") ? [...line.matchAll(/URI="([^"]*)"/g)].map((m) => m[1]!) : line.trim() ? [line.trim()] : []));

async function setupHostile(t: { after(fn: () => unknown): void }) {
  const internal = await startInternal();
  t.after(() => internal.close());
  const other = await startInternal();
  t.after(() => other.close());
  const up = await startHostileUpstream(internal.url, other.url);
  t.after(() => up.close());
  const items: Json = {
    items: [
      {
        id: "m", kind: "movie", title: "M", poster: null,
        episodes: [{ id: "m.main", playbackAllowed: true, sources: [{ id: "up", type: "direct", languages: { audio: ["en"], subtitles: [] }, media: { kind: "hls", url: `${up.url}/master.m3u8`, headers: CREDENTIALS } }] }],
      },
    ],
  };
  const bundleDir = await writeBundle(path.join(await tempDir(), "bundle"), { ...fixtureManifest(), adapters: [] }, items);
  // The owner lists the upstream and the CDN by address and port; the internal server, on the same loopback
  // address, is not listed.
  const s = await startTestServer({ bundleDir, configFile: { proxy: { privateUpstreams: [new URL(up.url).host, new URL(other.url).host] } } });
  t.after(() => s.close());
  const tv = await s.pair();
  const r = await s.call("POST", "/api/v1/tv/resolve", { token: tv.token, body: { episodeId: "m.main" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const entry: string = r.json.media.url;
  const dir = entry.slice(0, entry.lastIndexOf("/") + 1);
  const get = async (p: string) => {
    const res = await fetch(`${s.base}${p}`);
    return { status: res.status, body: await res.text() };
  };
  return { s, tv, internal, other, up, entry, dir, get };
}

test("proxy egress: a hostile playlist cannot make the server reach an unlisted loopback server", async (t) => {
  const { s, tv, internal, other, up, entry, dir, get } = await setupHostile(t);
  const master = await get(entry);
  assert.equal(master.status, 200);
  const [mediaRef, redirectedPlaylistRef] = uris(master.body);

  const redirectedPlaylist = await get(`${dir}${redirectedPlaylistRef}`);
  assert.deepEqual([redirectedPlaylist.status, JSON.parse(redirectedPlaylist.body)], [502, { error: "egress_denied" }], "a redirect to loopback is not followed");

  const media = await get(`${dir}${mediaRef}`);
  assert.equal(media.status, 200);
  const refs = uris(media.body);
  assert.equal(refs.length, 7, media.body);
  const answers = [];
  for (const ref of refs) answers.push(await get(`${dir}u/${ref}`)); // relative to the media playlist's own path
  const [key, direct, viaRedirect, ok, sameOrigin, cdn, loop] = answers;
  for (const [name, a] of Object.entries({ key, direct, viaRedirect })) assert.deepEqual([a!.status, JSON.parse(a!.body)], [502, { error: "egress_denied" }], name);
  assert.deepEqual([ok!.status, ok!.body], [200, "SEGMENT"]);
  assert.deepEqual([sameOrigin!.status, sameOrigin!.body], [200, "SEGMENT"], "a redirect within the listed upstream is followed");
  assert.deepEqual([cdn!.status, cdn!.body], [200, "INTERNAL-ONLY-MARKER"], "the listed second origin is reachable");
  assert.deepEqual([loop!.status, JSON.parse(loop!.body).error], [502, "upstream_error"], "redirects are capped");

  assert.deepEqual(internal.hits, [], "no request reached the unlisted server");
  // The session's credentials go to its own origin only; the Referer goes everywhere the session goes.
  const credentialed = up.hits.filter((h) => h.path === "/ok-segment.ts?moved")[0]!;
  assert.equal(credentialed.headers.authorization, CREDENTIALS.Authorization, "same-origin redirect keeps the credentials");
  assert.equal(credentialed.headers.cookie, CREDENTIALS.Cookie);
  assert.equal(other.hits.length, 1);
  const foreign = other.hits[0]!.headers;
  assert.equal(foreign.referer, CREDENTIALS.Referer);
  assert.deepEqual([foreign.authorization, foreign.cookie, foreign["x-api-key"]], [undefined, undefined, undefined], "no credentials for another origin");
  assert.equal(up.hits.filter((h) => h.path === "/loop").length, 6, "the first request and five redirects");

  const problems = s.srv.ctx.store.listProblems(tv.deviceId, 100).filter((p) => p.code === "egress_denied");
  assert.ok(problems.length >= 1, "the owner hears about it");
  assert.match(problems[0]!.detail ?? "", /^(playlist|segment): private address$/);
  const log = s.logs.join("\n");
  const internalPort = new URL(internal.url).port;
  for (const leak of [internal.url, `:${internalPort}`, "/internal/", "dummy-upstream-credential", "dummy-cookie"]) assert.ok(!log.includes(leak), `log leaked ${leak}`);
  assert.match(log, /upstream destination refused/);
});

test("proxy egress: without privateUpstreams a loopback upstream is refused before any request", async (t) => {
  const internal = await startInternal();
  t.after(() => internal.close());
  const items: Json = {
    items: [
      {
        id: "m", kind: "movie", title: "M", poster: null,
        episodes: [{ id: "m.main", playbackAllowed: true, sources: [{ id: "up", type: "direct", languages: { audio: ["en"], subtitles: [] }, media: { kind: "hls", url: `http://localhost:${new URL(internal.url).port}/master.m3u8`, headers: CREDENTIALS } }] }],
      },
    ],
  };
  const bundleDir = await writeBundle(path.join(await tempDir(), "bundle"), { ...fixtureManifest(), adapters: [] }, items);
  const s = await startTestServer({ bundleDir });
  t.after(() => s.close());
  const tv = await s.pair();
  const r = await s.call("POST", "/api/v1/tv/resolve", { token: tv.token, body: { episodeId: "m.main" } });
  assert.equal(r.status, 200);
  const res = await fetch(`${s.base}${r.json.media.url}`);
  assert.deepEqual([res.status, await res.json()], [502, { error: "egress_denied" }], "a host name that resolves to loopback is refused too");
  assert.deepEqual(internal.hits, []);
});
