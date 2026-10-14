// Problem reports: a TV's own reports (validation, redaction, rate limit, retention), the admin list, and the
// problems the server records for a TV (failed resolves, failed sources, proxy sessions whose upstream fails).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DEFAULT_API_KEY, startUpstream } from "../examples/resolver-example/upstream.js";
import { noPlayableDetail, triedDetail } from "../src/problems.ts";
import { fixtureItems, fixtureManifest, publishBuild, startTestServer, tempDir, TEST_RESOLVER, writeBundle, type Json, type TestServer } from "./helpers.ts";

/** A made-up token-like run (40 base64url characters), never a real secret. */
const RUN = "Zq3v9Kx2LmN8pQ4rT6uW1yA5bC7dE0fGhIjKlMnO"; // gitleaks:allow (made-up hostile fixture)
const REFERER = "https://site.example.test/";
const PROXY_URL = /^\/p\/([A-Za-z0-9_-]{43})\/(index\.m3u8|video\.mp4)$/;

async function setup(t: { after(fn: () => unknown): void }, s?: TestServer) {
  const server = s ?? (await startTestServer());
  t.after(() => server.close());
  const tv = await server.pair("Salon");
  const as = (method: string, route: string, body?: unknown) => server.call(method, `/api/v1/tv${route}`, { token: tv.token, body });
  const report = (body: Json) => as("POST", "/problems", body);
  const list = (query = "") => server.admin("GET", `/devices/${tv.deviceId}/problems${query}`);
  return { s: server, tv, as, report, list };
}

test("a TV's report is stored with its time, episode and source, and listed for the owner with titles", async (t) => {
  const { s, tv, report, list } = await setup(t);
  const r = await report({
    kind: "playback",
    code: "ERROR_CODE_IO_BAD_HTTP_STATUS",
    ageMs: 90_000,
    episodeId: "show.e1",
    sourceId: "tr-dub",
    positionMs: 754_000,
    httpStatus: 403,
    detail: "InvalidResponseCodeException: Response code: 403",
    appVersion: "0.3.0 (300)",
  });
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { ok: true });
  const l = await list();
  assert.equal(l.status, 200);
  assert.deepEqual(l.json.problems, [
    {
      id: l.json.problems[0].id,
      at: new Date(s.clock.now() - 90_000).toISOString(),
      origin: "tv",
      kind: "playback",
      code: "ERROR_CODE_IO_BAD_HTTP_STATUS",
      itemId: "show",
      itemTitle: "Şov Dünyası",
      itemKind: "series",
      episodeId: "show.e1",
      episodeTitle: "Pilot",
      season: 1,
      number: 1,
      sourceId: "tr-dub",
      positionMs: 754_000,
      httpStatus: 403,
      detail: "InvalidResponseCodeException: Response code: 403",
      appVersion: "0.3.0 (300)",
      missing: false,
    },
  ]);
  const [row] = s.srv.ctx.store.listProblems(tv.deviceId, 10);
  assert.equal(row!.at, s.clock.now() - 90_000, "at = receipt − ageMs");
  assert.deepEqual([row!.catalogId, row!.itemId], ["fixture", "show"], "the catalog's item is stored with the episode");

  // Newest first by when it happened; reports without an episode, or with one the catalog does not have.
  await report({ kind: "network", code: "server_unreachable", ageMs: 30_000 });
  await report({ kind: "other", code: "x", ageMs: 120_000, episodeId: "gone.e1" });
  const all = (await list()).json.problems;
  assert.deepEqual(all.map((p: Json) => p.code), ["server_unreachable", "ERROR_CODE_IO_BAD_HTTP_STATUS", "x"]);
  assert.deepEqual(
    [all[0].itemId, all[0].itemTitle, all[0].episodeId, all[0].missing, all[0].detail, all[0].appVersion, all[0].positionMs],
    [null, null, null, false, null, null, null],
  );
  assert.deepEqual([all[2].itemId, all[2].itemTitle, all[2].episodeTitle, all[2].missing], [null, null, null, true]);
  assert.equal((await list("?limit=2")).json.problems.length, 2);
});

test("a hostile detail is stored and logged redacted; identifiers survive; the detail is never logged", async (t) => {
  const { s, tv, report, list } = await setup(t);
  const detail = `Unable to connect to https://cdn.example.test/v/master.m3u8?token=${RUN}&sig=abc, cookie ${RUN} (UnknownHostException)`;
  const r = await report({ kind: "playback", code: `auth.${RUN}`, detail, appVersion: RUN });
  assert.equal(r.status, 202);
  const [row] = s.srv.ctx.store.listProblems(tv.deviceId, 10);
  assert.equal(row!.detail, "Unable to connect to <url cdn.example.test> cookie <token> (UnknownHostException)");
  assert.equal(row!.code, "auth.<token>");
  assert.equal(row!.appVersion, "<token>");
  const listed = JSON.stringify((await list()).json);
  const logs = s.logs.join("\n");
  for (const leak of [RUN, "cdn.example.test/", "token=", "sig=", "master.m3u8"]) {
    assert.ok(!JSON.stringify(row).includes(leak), `stored row leaked ${leak}`);
    assert.ok(!listed.includes(leak), `admin list leaked ${leak}`);
    assert.ok(!logs.includes(leak), `log leaked ${leak}`);
  }
  assert.ok(!logs.includes("Unable to connect") && !logs.includes("UnknownHostException"), "the detail is never logged");
  const line = s.logs.map((l) => JSON.parse(l)).find((l) => l.msg === "problem reported");
  assert.deepEqual(Object.keys(line).sort(), ["code", "deviceId", "kind", "level", "msg", "time"]);
  assert.deepEqual([line.deviceId, line.kind, line.code], [tv.deviceId, "playback", "auth.<token>"]);
});

test("report validation", async (t) => {
  const { s, report } = await setup(t);
  assert.equal((await s.call("POST", "/api/v1/tv/problems", { body: { kind: "other", code: "x" } })).status, 401);
  for (const bad of [
    {},
    { kind: "playback" },
    { code: "x" },
    { kind: "proxy", code: "x" },
    { kind: "crash", code: "x" },
    { kind: "playback", code: "" },
    { kind: "playback", code: "has space" },
    { kind: "playback", code: "https://cdn.example.test/x" },
    { kind: "playback", code: "x".repeat(65) },
    { kind: "playback", code: "x", ageMs: -1 },
    { kind: "playback", code: "x", ageMs: 86_400_001 },
    { kind: "playback", code: "x", episodeId: "bad id" },
    { kind: "playback", code: "x", sourceId: "" },
    { kind: "playback", code: "x", sessionId: "s".repeat(65) },
    { kind: "playback", code: "x", positionMs: -1 },
    { kind: "playback", code: "x", positionMs: 1.5 },
    { kind: "playback", code: "x", httpStatus: 99 },
    { kind: "playback", code: "x", httpStatus: 600 },
    { kind: "playback", code: "x", detail: "d".repeat(501) },
    { kind: "playback", code: "x", appVersion: "v".repeat(41) },
    { kind: "playback", code: "x", episodeId: null },
    { kind: "playback", code: "x", extra: 1 },
  ]) {
    const r = await report(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.error, "invalid_request");
  }
  const edge = await report({ kind: "resolve", code: "a.B_c:d-9", ageMs: 86_400_000, httpStatus: 599, detail: "d".repeat(500), appVersion: "v".repeat(40), positionMs: 0 });
  assert.equal(edge.status, 202);
});

test("a report naming the TV's playback session gets the episode and source from it", async (t) => {
  const { s, tv, as, report } = await setup(t);
  const played = await as("POST", "/resolve", { episodeId: "show.e1" });
  assert.equal(played.json.sourceId, "tr-dub");
  await report({ kind: "playback", code: "decoder", sessionId: played.json.sessionId, positionMs: 5_000 });
  const other = await s.pair("Other");
  await s.call("POST", "/api/v1/tv/problems", { token: other.token, body: { kind: "playback", code: "foreign", sessionId: played.json.sessionId } });
  await report({ kind: "playback", code: "mismatch", sessionId: played.json.sessionId, episodeId: "film.main" });
  const rows = s.srv.ctx.store.listProblems(tv.deviceId, 10);
  assert.deepEqual(rows.map((p) => [p.code, p.episodeId, p.sourceId]), [
    ["mismatch", "film.main", null],
    ["decoder", "show.e1", "tr-dub"],
  ]);
  assert.deepEqual(
    s.srv.ctx.store.listProblems(other.deviceId, 10).map((p) => [p.code, p.episodeId, p.sourceId]),
    [["foreign", null, null]],
    "another TV's session is not used",
  );
});

test("more than 30 reports in 10 minutes answer 429 with Retry-After", async (t) => {
  const { s, report } = await setup(t);
  for (let i = 0; i < 30; i++) assert.equal((await report({ kind: "playback", code: `c${i}` })).status, 202);
  const refused = await report({ kind: "playback", code: "c30" });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error, "too_many_problems");
  assert.equal(refused.headers.get("retry-after"), "600");
  s.clock.advance(10 * 60_000);
  assert.equal((await report({ kind: "playback", code: "c31" })).status, 202);
  assert.equal(s.srv.ctx.store.listProblems((await s.admin("GET", "/devices")).json.devices[0].id, 100).length, 31);
});

test("retention: a device keeps its newest 100 problems; older than 30 days are purged", async (t) => {
  const { s, tv, report, list } = await setup(t);
  for (let i = 0; i <= 100; i++) {
    s.clock.advance(21_000); // stays below the report rate limit
    assert.equal((await report({ kind: "playback", code: `c${i}` })).status, 202);
  }
  const rows = s.srv.ctx.store.listProblems(tv.deviceId, 1000);
  assert.equal(rows.length, 100);
  assert.equal(rows.at(-1)!.code, "c1", "the 101st report dropped the oldest");
  assert.equal(rows[0]!.code, "c100");
  assert.equal((await list()).json.problems.length, 50, "50 by default");
  assert.equal((await list("?limit=100")).json.problems.length, 100);
  assert.equal((await list("?limit=500")).json.problems.length, 100, "at most 100");

  s.clock.advance(30 * 24 * 60 * 60_000 - 100 * 21_000 + 21_000 * 50);
  s.srv.ctx.problems.purge();
  const kept = s.srv.ctx.store.listProblems(tv.deviceId, 1000);
  assert.ok(kept.length > 0 && kept.length < 100, `${kept.length}`);
  assert.ok(kept.every((p) => p.at >= s.clock.now() - 30 * 24 * 60 * 60_000));
});

test("Device.problems counts the last 24 hours; DELETE clears; unknown devices are 404", async (t) => {
  const { s, tv, report, list } = await setup(t);
  const stats = async () => (await s.admin("GET", `/devices/${tv.deviceId}`)).json.device.problems;
  assert.deepEqual(await stats(), { recent: 0, lastAt: null });
  await report({ kind: "playback", code: "a", ageMs: 60_000 });
  await report({ kind: "playback", code: "b" });
  const lastAt = new Date(s.clock.now()).toISOString();
  assert.deepEqual(await stats(), { recent: 2, lastAt });
  assert.deepEqual((await s.admin("GET", "/devices")).json.devices[0].problems, { recent: 2, lastAt }, "on the TV list too");
  s.clock.advance(24 * 60 * 60_000 - 30_000);
  assert.deepEqual(await stats(), { recent: 1, lastAt });
  s.clock.advance(60_000);
  assert.deepEqual(await stats(), { recent: 0, lastAt }, "older problems still show when the last one happened");

  assert.equal((await s.admin("DELETE", `/devices/${tv.deviceId}/problems`)).status, 204);
  assert.deepEqual((await list()).json.problems, []);
  assert.deepEqual(await stats(), { recent: 0, lastAt: null });
  assert.equal((await s.admin("GET", "/devices/nope0000nope/problems")).status, 404);
  assert.equal((await s.admin("DELETE", "/devices/nope0000nope/problems")).status, 404);
  assert.equal((await s.call("GET", `/api/v1/admin/devices/${tv.deviceId}/problems`, { token: tv.token })).status, 401);
});

test("problems of an episode that left the catalog are listed as missing", async (t) => {
  const { s, report, list } = await setup(t);
  await report({ kind: "playback", code: "a", episodeId: "film.main" });
  assert.equal((await list()).json.problems[0].itemTitle, "Film");
  await publishBuild(s.bundleDir, "fixture-2", (items) => items.filter((i) => i.id !== "film"));
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 200);
  const [p] = (await list()).json.problems;
  assert.deepEqual([p.itemId, p.itemTitle, p.itemKind, p.episodeId, p.episodeTitle, p.missing], ["film", null, null, "film.main", null, true]);
});

test("detail helpers: failed sources in a few words", () => {
  assert.equal(triedDetail({ sourceId: "a", code: "timeout", adapterId: "x", name: "TimeoutError" }), "timeout");
  assert.equal(triedDetail({ sourceId: "a", code: "timeout", adapterId: "x", name: "BudgetExhausted" }), "timeout BudgetExhausted");
  assert.equal(triedDetail({ sourceId: "a", code: "error", adapterId: "x", name: "InvalidResult" }), "error InvalidResult");
  assert.equal(triedDetail({ sourceId: "a", code: "empty", adapterId: "x" }), "empty");
  assert.equal(
    noPlayableDetail([
      { sourceId: "src-a", code: "timeout", name: "TimeoutError" },
      { sourceId: "src-b", code: "error", name: "InvalidResult" },
    ]),
    "src-a: timeout; src-b: error InvalidResult",
  );
  assert.equal(noPlayableDetail([], ["a", "b"]), "excluded by the TV: a, b");
  assert.equal(noPlayableDetail([{ sourceId: "c", code: "adapter_unavailable" }], ["a"]), "c: adapter_unavailable; excluded by the TV: a");
  assert.equal(noPlayableDetail([]), "the episode has no source to try");
  assert.equal(noPlayableDetail(Array.from({ length: 64 }, (_, i) => ({ sourceId: `source-${i}`, code: "empty" as const }))).length, 500);
});

// --- server-origin problems -----------------------------------------------------------------------------------

const tr = { audio: ["tr"], subtitles: [] };
const testSource = (id: string, ref: Json) => ({ id, type: "adapter", adapter: "test", ref, languages: tr });
const movie = (id: string, sources: Json[]) => ({ id, kind: "movie", title: `Movie ${id}`, poster: null, episodes: [{ id: `${id}.main`, playbackAllowed: true, sources }] });
const hls = (id: string, url: string) => ({ id, type: "direct", languages: tr, media: { kind: "hls", url, headers: { Referer: REFERER } } });

/** An upstream that needs the Referer and then fails as told: 503, or an HTML page instead of a playlist. */
async function startFlaky() {
  let mode: "503" | "html" = "503";
  const server = createServer((req, res) => {
    if (req.headers.referer !== REFERER) {
      res.writeHead(403);
      return res.end();
    }
    if (mode === "html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<html><body>Are you a robot?</body></html>");
    }
    res.writeHead(503);
    res.end("unavailable");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    set: (m: "503" | "html") => void (mode = m),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A loopback port nothing listens on (connections are refused). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function setupServerOrigin(t: { after(fn: () => unknown): void }) {
  let upNow = Date.parse("2026-10-10T12:00:00Z");
  const up = await startUpstream({ port: 0, now: () => upNow, tokenTtlSec: 600 });
  t.after(() => up.close());
  const flaky = await startFlaky();
  t.after(() => flaky.close());
  const items = fixtureItems();
  items.items.push(
    movie("mixed", [testSource("bad", { behavior: "throw" }), testSource("none", { behavior: "empty" }), { id: "plain", type: "direct", languages: tr, media: { kind: "hls", url: "https://media.example.test/plain/master.m3u8" } }]),
    movie("broken", [testSource("bad", { behavior: "throw" }), testSource("slow", { behavior: "hang-signal" }), testSource("invalid", { behavior: "invalid" })]),
    movie("signed", [{ id: "signed", type: "adapter", adapter: "example", ref: { video: "demo" }, languages: tr }]),
    movie("flaky", [hls("flaky-hls", `${flaky.url}/master.m3u8`)]),
    movie("away", [hls("away-hls", `http://127.0.0.1:${await closedPort()}/master.m3u8`)]),
  );
  const bundleDir = await writeBundle(path.join(await tempDir(), "bundle"), { ...fixtureManifest(), adapters: ["example", "test"] }, items);
  const s = await startTestServer({
    bundleDir,
    configFile: { resolver: { module: TEST_RESOLVER, config: { apiBase: up.url, apiKey: DEFAULT_API_KEY }, deadlineMs: 200, budgetMs: 5000 } },
  });
  const env = await setup(t, s);
  const rows = (code?: string) => env.s.srv.ctx.store.listProblems(env.tv.deviceId, 100).filter((p) => code === undefined || p.code === code);
  const get = (p: string) => fetch(`${env.s.base}${p}`);
  return { ...env, up, flaky, rows, get, advanceUpstream: (ms: number) => void (upNow += ms) };
}

test("server-origin: a TV resolve with nothing playable, and sources the server fell back past", async (t) => {
  const { s, as, rows, list } = await setupServerOrigin(t);
  const none = await as("POST", "/resolve", { episodeId: "broken.main" });
  assert.equal(none.status, 502);
  assert.deepEqual(
    rows().map((p) => [p.origin, p.kind, p.code, p.episodeId, p.itemId, p.sourceId, p.httpStatus, p.detail]),
    [["server", "resolve", "no_playable_source", "broken.main", "broken", null, null, "bad: error LeakyError; slow: timeout; invalid: error InvalidResult"]],
  );

  const ok = await as("POST", "/resolve", { episodeId: "mixed.main" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.sourceId, "plain");
  assert.deepEqual(
    rows("source_failed").map((p) => [p.kind, p.sourceId, p.detail, p.episodeId]).sort(),
    [
      ["resolve", "bad", "error LeakyError", "mixed.main"],
      ["resolve", "none", "empty", "mixed.main"],
    ],
  );
  // The failed sources now go last for 10 minutes: the next resolve plays at once and records nothing new.
  assert.equal((await as("POST", "/resolve", { episodeId: "mixed.main" })).json.sourceId, "plain");
  assert.equal(rows().length, 3);

  // The TV excluded what failed on it; the server says so.
  await as("POST", "/resolve", { episodeId: "mixed.main", exclude: ["plain", "bad", "none"] });
  assert.equal(rows("no_playable_source")[0]!.detail, "excluded by the TV: plain, bad, none");

  // Companion resolves are not the TV's problems.
  const companion = await s.admin("POST", `/devices/${(await s.admin("GET", "/devices")).json.devices[0].id}/companion/resolve`, { episodeId: "broken.main", sourceId: "bad" });
  assert.equal(companion.status, 502);
  assert.equal(rows().length, 4);

  const listed = (await list()).json.problems;
  assert.equal(listed[0].origin, "server");
  assert.equal(listed[0].itemTitle, "Movie mixed");
  const logs = s.logs.join("\n");
  for (const leak of ["SuperSecret", "signed.secret.example.test", "behavior"]) assert.ok(!logs.includes(leak) && !JSON.stringify(listed).includes(leak), `leaked ${leak}`);
});

test("server-origin: an upstream 403 that makes a proxy session stale; companion sessions are not recorded", async (t) => {
  const { s, tv, as, rows, get, advanceUpstream } = await setupServerOrigin(t);
  const segmentsOf = async (entry: string) => {
    const token = PROXY_URL.exec(entry)![1];
    const master = await (await get(entry)).text();
    const variant = master.split("\n").filter((l) => l && !l.startsWith("#"))[0]!;
    const playlist = await (await get(`/p/${token}/${variant}`)).text();
    return playlist
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((seg) => `/p/${token}/u/${seg}`);
  };
  const tvStream = await as("POST", "/resolve", { episodeId: "signed.main" });
  assert.match(tvStream.json.media.url, PROXY_URL);
  const tvSegments = await segmentsOf(tvStream.json.media.url);
  assert.equal((await get(tvSegments[0]!)).status, 200);
  const phone = await s.admin("POST", `/devices/${tv.deviceId}/companion/resolve`, { episodeId: "signed.main", sourceId: "signed" });
  const phoneSegments = await segmentsOf(phone.json.media.url);

  advanceUpstream(601_000); // the signed URLs expired upstream: 403
  assert.equal((await get(phoneSegments[1]!)).status, 410);
  assert.deepEqual(rows(), [], "the phone's session going stale is not the TV's problem");
  assert.equal((await get(tvSegments[1]!)).status, 410);
  assert.equal((await get(tvSegments[2]!)).status, 410, "stale from now on, without asking the upstream again");
  assert.deepEqual(
    rows().map((p) => [p.origin, p.kind, p.code, p.httpStatus, p.detail, p.episodeId, p.sourceId, p.itemId]),
    [["server", "proxy", "upstream_403", 403, "segment", "signed.main", "signed", "signed"]],
  );
  const logs = s.logs.join("\n");
  for (const leak of [PROXY_URL.exec(tvStream.json.media.url)![1]!, "/s/", "player.example.test", DEFAULT_API_KEY]) assert.ok(!logs.includes(leak), `log leaked ${leak}`);
});

test("server-origin: upstream 5xx, a page instead of a playlist, an unreachable upstream; one per device and code a minute", async (t) => {
  const { s, as, rows, get, flaky } = await setupServerOrigin(t);
  const entry = (await as("POST", "/resolve", { episodeId: "flaky.main" })).json.media.url;
  assert.equal((await get(entry)).status, 502);
  assert.equal((await get(entry)).status, 502);
  assert.deepEqual(
    rows().map((p) => [p.kind, p.code, p.httpStatus, p.detail, p.episodeId, p.sourceId]),
    [["proxy", "upstream_error", 503, "playlist", "flaky.main", "flaky-hls"]],
    "the second failure within a minute is not recorded again",
  );
  flaky.set("html");
  assert.equal((await get(entry)).status, 502);
  assert.deepEqual(rows("not_a_playlist").map((p) => [p.httpStatus, p.detail]), [[200, "playlist: text/html"]]);
  s.clock.advance(60_001);
  flaky.set("503");
  assert.equal((await get(entry)).status, 502);
  assert.equal(rows("upstream_error").length, 2, "recorded again a minute later");

  const away = (await as("POST", "/resolve", { episodeId: "away.main" })).json.media.url;
  assert.equal((await get(away)).status, 502);
  assert.deepEqual(rows("upstream_unreachable").map((p) => [p.kind, p.httpStatus, p.detail, p.sourceId]), [["proxy", null, "playlist: ECONNREFUSED", "away-hls"]]);
  for (const p of rows()) assert.ok(!(p.detail ?? "").includes("127.0.0.1"), "no upstream address in a problem");
});
