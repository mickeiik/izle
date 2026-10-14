import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  SEARCH_MAX,
  buildSummary,
  canControlPlayback,
  candidateOptions,
  catalogSearchPath,
  clockOffset,
  companionTarget,
  continueText,
  episodeName,
  episodeStateLabel,
  episodeStates,
  errorMessage,
  errorText,
  formatClock,
  formatCode,
  formatCountdown,
  formatDrift,
  formatPosition,
  formatRelative,
  groupEpisodeChanges,
  isActive,
  issueLine,
  languageLabel,
  moveItem,
  originLabel,
  parseCandidate,
  percent,
  playbackState,
  plural,
  primarySubtag,
  problemContext,
  pushSample,
  resumes,
  sameLanguage,
  searchSummary,
  serverAddress,
  shortId,
  showMeta,
  sourceReport,
  syncDecision,
  tokenFromHash,
  triedText,
  tvPositionAt,
} from "../admin/lib.js";
import { ADMIN_FILES, ADMIN_VENDOR_FILES } from "../src/admin-files.ts";
import { startTestServer } from "./helpers.ts";

const ADMIN_DIR = new URL("../admin/", import.meta.url);
/** The admin page's top-level modules (vendor/ is third-party). */
const adminScripts = async () => (await readdir(ADMIN_DIR)).filter((f) => f.endsWith(".js")).sort();

const NOW = Date.parse("2026-10-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test("admin helpers: clocks, relative times, codes", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(65_000), "1:05");
  assert.equal(formatClock(3_725_000), "1:02:05");
  assert.equal(formatClock(null), "–");
  assert.equal(formatClock(-1), "–");
  assert.equal(formatRelative(ago(10_000), NOW), "just now");
  assert.equal(formatRelative(ago(5 * 60_000), NOW), "5 min ago");
  assert.equal(formatRelative(ago(3 * 3600_000), NOW), "3 h ago");
  assert.equal(formatRelative(ago(26 * 3600_000), NOW), "yesterday");
  assert.equal(formatRelative(ago(4 * 86400_000), NOW), "4 days ago");
  assert.equal(formatRelative(ago(40 * 86400_000), NOW), "2026-08-31");
  assert.equal(formatRelative(null, NOW), "never");
  assert.equal(formatCountdown(new Date(NOW + 125_000).toISOString(), NOW), "2:05");
  assert.equal(formatCountdown(ago(1000), NOW), "0:00");
  assert.equal(formatCode("483920"), "483 920");
});

test("admin helpers: sign-in links and the address to type on the TV", () => {
  assert.equal(tokenFromHash("#token=abc-DEF_123"), "abc-DEF_123");
  assert.equal(tokenFromHash("#token=correct%20horse%20battery"), "correct horse battery", "the link encodes the token");
  assert.equal(tokenFromHash("#/devices"), null);
  assert.equal(tokenFromHash("#token="), null);
  assert.equal(tokenFromHash("#token=%E0%A4%A"), null, "a broken encoding is not a token");
  assert.equal(tokenFromHash(""), null);
  assert.equal(tokenFromHash(undefined), null);
  assert.equal(serverAddress("http://192.168.1.54:8787", "/admin/"), "http://192.168.1.54:8787");
  assert.equal(serverAddress("https://izle.example.org", "/admin/index.html"), "https://izle.example.org");
  assert.equal(serverAddress("https://host.example.org", "/izle/admin/"), "https://host.example.org/izle", "a reverse proxy prefix is kept");
});

test("admin helpers: episode names and what OK does", () => {
  assert.equal(episodeName({ season: 1, number: 2, title: "Gran Dillama" }, "series"), "S1 · E2 — Gran Dillama");
  assert.equal(episodeName({ number: 5, title: null }, "series"), "Episode 5");
  assert.equal(episodeName({ label: "Special", number: 9, title: "Xmas" }, "series"), "Special — Xmas");
  assert.equal(episodeName({ title: null }, "movie"), "Film");
  const c = { episodeId: "show.s1e2", season: 1, number: 2, title: "Two", label: null, durationMs: 600_000 };
  assert.equal(continueText({ ...c, status: "new", positionMs: 0 }, "series"), "S1 · E2 — Two · new");
  assert.equal(continueText({ ...c, status: "watching", positionMs: 90_000 }, "series"), "S1 · E2 — Two · continues at 1:30 of 10:00");
  assert.equal(continueText({ ...c, status: "watching", positionMs: 17_000 }, "movie"), "starts from the beginning", "the TV resumes from 30 s on");
  assert.equal(continueText({ ...c, status: "finished", positionMs: 0 }, "movie"), "watched — starts over");
  assert.equal(continueText(null, "movie"), "Nothing playable");
  assert.equal(resumes({ ...c, status: "watching", positionMs: 30_000 }), true);
  assert.equal(resumes({ ...c, status: "watching", positionMs: 29_999 }), false, "the TV resumes from 30 s on");
  assert.equal(resumes({ ...c, status: "finished", positionMs: 90_000 }), false);
  assert.equal(resumes(null), false);
  assert.equal(percent(30, 120), 25);
  assert.equal(percent(30, null), null);
  assert.equal(percent(500, 100), 100);
});

test("admin helpers: list moves, playback activity, episode states, labels, errors", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 1, -1), ["b", "a", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 1), ["a", "b", "c"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  const n = { state: "playing", updatedAt: ago(20_000), itemTitle: "X", episodeTitle: null, positionMs: 1, durationMs: 2 };
  assert.equal(isActive(n, true, NOW), true);
  assert.equal(isActive(n, false, NOW), false, "an offline TV is not playing");
  assert.equal(isActive({ ...n, updatedAt: ago(5 * 60_000) }, true, NOW), false, "stale reports");
  assert.equal(isActive({ ...n, state: "stopped" }, true, NOW), false);
  const states = episodeStates([{ id: "e1" }, { id: "e2" }, { id: "e3" }], "e2", [
    { episodeId: "e1", status: "finished", positionMs: 10, durationMs: 10 },
    { episodeId: "e2", status: "watching", positionMs: 5, durationMs: 10 },
  ]);
  assert.deepEqual(states.map((s) => [s.episode.id, s.current, s.watched, s.percent]), [
    ["e1", false, true, null],
    ["e2", true, false, 50],
    ["e3", false, false, null],
  ]);
  assert.equal(languageLabel("tr"), "Türkçe (tr)");
  assert.equal(languageLabel("pt-BR"), "Português (pt-BR)");
  assert.equal(languageLabel("xx"), "xx");
  assert.equal(languageLabel(null, "Off"), "Off");
  assert.match(errorMessage("too_many_items"), /at most 12/);
  assert.equal(plural(1, "variant"), "1 variant");
  assert.equal(plural(3, "segment"), "3 segments");
  assert.equal(triedText("empty", null), "the adapter found nothing to play");
  assert.equal(triedText("error", "UpstreamError"), "the adapter failed (UpstreamError)");
  assert.equal(triedText("timeout", "TimeoutError"), "timed out");
  assert.equal(triedText("timeout", "BudgetExhausted"), "skipped: the time budget of the request ran out");
  assert.equal(errorMessage("weird_code"), "The server answered: weird_code.");
});

test("admin helpers: when the remote-control buttons apply, and how a problem reads", () => {
  assert.equal(canControlPlayback(null), false);
  assert.equal(canControlPlayback(undefined), false);
  assert.equal(canControlPlayback({ state: "playing" }), true);
  assert.equal(canControlPlayback({ state: "paused" }), true);
  for (const state of ["starting", "stopped", "finished"]) assert.equal(canControlPlayback({ state }), false, state);

  assert.equal(originLabel("tv"), "TV");
  assert.equal(originLabel("server"), "server");
  const p = {
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
    appVersion: "0.3.0 (300)",
    missing: false,
  };
  assert.equal(problemContext(p), "Şov Dünyası · S1 · E1 — Pilot · source tr-dub · at 12:34 · HTTP 403 · app 0.3.0 (300)");
  const bare = { ...p, sourceId: null, positionMs: null, httpStatus: null, appVersion: null };
  assert.equal(problemContext({ ...bare, itemTitle: "Film", itemKind: "movie", season: null, number: null, episodeTitle: null }), "Film", "films have no episode to name");
  assert.equal(problemContext({ ...bare, positionMs: 3_725_000 }), "Şov Dünyası · S1 · E1 — Pilot · at 1:02:05");
  assert.equal(problemContext({ ...bare, itemTitle: null, itemKind: null, missing: true }), "show (no longer in the catalog)");
  assert.equal(problemContext({ ...bare, itemId: null, itemTitle: null, itemKind: null, episodeId: "gone.e1", missing: true }), "gone.e1 (no longer in the catalog)");
  assert.equal(problemContext({ ...bare, itemId: null, itemTitle: null, itemKind: null, episodeId: null }), "", "nothing known: no context line");
});

test("admin helpers: build summaries and episode changes grouped by show", () => {
  const build = (added: [number, number], removed: [number, number], baseline = false) => ({
    baseline,
    added: { items: added[0], episodes: added[1] },
    removed: { items: removed[0], episodes: removed[1] },
  });
  assert.equal(buildSummary(build([2, 14], [0, 1])), "+2 shows · +14 episodes · −1 episode");
  assert.equal(buildSummary(build([0, 1], [1, 3])), "+1 episode · −1 show · −3 episodes");
  assert.equal(buildSummary(build([1, 1], [0, 0])), "+1 show · +1 episode");
  assert.equal(buildSummary(build([0, 0], [0, 0])), "nothing added or removed", "a new build id with the same shows and episodes");
  assert.equal(buildSummary(build([0, 0], [0, 0], true)), "first load");

  const added = (id: string, itemId: string, itemTitle: string, rest: Record<string, unknown> = {}) => ({
    id,
    itemId,
    itemTitle,
    season: null,
    number: null,
    label: null,
    playbackAllowed: true,
    ...rest,
  });
  assert.deepEqual(
    groupEpisodeChanges([
      added("a.s1e7", "a", "Aşk", { season: 1, number: 7 }),
      added("b.x", "b", "Bahar", { label: "Special" }),
      added("a.s1e8", "a", "Aşk", { season: 1, number: 8 }),
      added("b.e3", "b", "Bahar", { number: 3, label: "Finale" }),
      added("b.e4", "b", "Bahar", { number: 4 }),
      added("b.e5", "b", "Bahar", { season: 2, number: 5, playbackAllowed: false }),
      added("c.bonus", "c", "Cem"),
    ]),
    [
      { itemId: "a", title: "Aşk", episodes: ["S1 E7", "S1 E8"] },
      { itemId: "b", title: "Bahar", episodes: ["Special", "Finale", "E4", "S2 E5 (not allowed)"] },
      { itemId: "c", title: "Cem", episodes: ["c.bonus"] },
    ],
    "shows in the order they first appear; S1 E7, else the label, else E4, else the id",
  );
  assert.deepEqual(
    groupEpisodeChanges([
      { id: "gone.e1", itemId: "gone", itemTitle: null },
      { id: "gone.e2", itemId: "gone", itemTitle: null },
      { id: "a.e1", itemId: "a", itemTitle: "Aşk" },
    ]),
    [
      { itemId: "gone", title: "gone", episodes: ["gone.e1", "gone.e2"] },
      { itemId: "a", title: "Aşk", episodes: ["a.e1"] },
    ],
    "removed episodes: ids only, and the show's id without a title",
  );
  assert.deepEqual(groupEpisodeChanges([]), []);
  assert.equal(errorMessage("unknown_build"), "That build is not in the catalog's history.");
});

test("admin helpers: what the views say (now playing, episode chips, show lines, searches, ids, issues, errors)", () => {
  const n = { state: "playing", updatedAt: ago(20_000), itemTitle: "X", episodeTitle: null, positionMs: 1, durationMs: 2 };
  assert.deepEqual(playbackState(n, true, NOW), { label: "Playing", tone: "ok", active: true });
  assert.deepEqual(playbackState({ ...n, state: "paused" }, true, NOW), { label: "Paused", tone: "", active: true });
  assert.deepEqual(playbackState({ ...n, state: "starting" }, true, NOW), { label: "Starting", tone: "", active: true });
  assert.deepEqual(playbackState({ ...n, state: "stopped" }, true, NOW), { label: "Last played", tone: "", active: false });
  assert.equal(playbackState(n, false, NOW).label, "Last played", "an offline TV is not playing");
  assert.equal(playbackState({ ...n, updatedAt: ago(5 * 60_000) }, true, NOW).label, "Last played", "stale reports");

  const s = (o: { playbackAllowed?: boolean; current?: boolean; watched?: boolean; percent?: number | null }) => ({
    episode: { playbackAllowed: o.playbackAllowed ?? true },
    current: o.current ?? false,
    watched: o.watched ?? false,
    percent: o.percent ?? null,
  });
  assert.equal(episodeStateLabel(s({ playbackAllowed: false, current: true })), "not allowed");
  assert.equal(episodeStateLabel(s({ current: true, percent: 40 })), "next");
  assert.equal(episodeStateLabel(s({ watched: true })), "watched");
  assert.equal(episodeStateLabel(s({ percent: 0 })), "0%");
  assert.equal(episodeStateLabel(s({ percent: 63 })), "63%");
  assert.equal(episodeStateLabel(s({})), "new");

  assert.equal(showMeta({ kind: "movie", year: 2026 }), "Film · 2026");
  assert.equal(showMeta({ kind: "series", year: 2026, episodeCount: 4, playableCount: 3 }), "Series · 4 episodes · 2026");
  assert.equal(showMeta({ kind: "series", year: null, episodeCount: 1 }), "Series · 1 episode");
  assert.equal(showMeta({ kind: "series" }), "Series");
  assert.equal(showMeta({ kind: "series", year: 2026, episodeCount: 4, playableCount: 3 }, { playable: true }), "Series · 4 episodes · 2026 · 3 of 4 playable");
  assert.equal(showMeta({ kind: "movie", year: 2026, episodeCount: 1, playableCount: 0 }, { playable: true }), "Film · 2026 · not playable");
  assert.equal(showMeta({ kind: "movie", episodeCount: 1, playableCount: 1 }, { playable: true }), "Film", "all playable: nothing to say");

  assert.equal(searchSummary(3, " pro "), "3 shows match “pro”.");
  assert.equal(searchSummary(1, "pro"), "1 show matches “pro”.");
  assert.equal(searchSummary(0, "xyz"), "No show matches “xyz”.");
  assert.equal(searchSummary(7, ""), "All 7 shows.");
  assert.equal(searchSummary(1, ""), "The catalog's only show.");
  assert.equal(searchSummary(0, ""), "The catalog has no shows.");
  assert.equal(searchSummary(SEARCH_MAX, ""), "The first 200 shows; type a title to narrow the list.", "the server's cap");
  assert.equal(searchSummary(SEARCH_MAX, "a"), "The first 200 shows that match “a”; type more to narrow the list.");
  assert.equal(catalogSearchPath(" pro "), "/catalog/search?limit=200&q=pro");
  assert.equal(catalogSearchPath("a&b c"), "/catalog/search?limit=200&q=a%26b%20c");
  assert.equal(catalogSearchPath(""), "/catalog/search?limit=200&q=", "an empty box lists the catalog");

  assert.equal(shortId("20261014-6b05c8e7"), "20261014-6b05c8e7");
  assert.equal(shortId("20261014-6b05c8e71a2b3c4d5e6f"), "20261014-6b05c8e71a2…");
  assert.equal(issueLine({ file: "items.json", path: "/items/3/poster", message: "file not found" }), "items.json /items/3/poster: file not found");
  assert.equal(issueLine({ file: "bundle.json", path: null, message: "unknown format" }), "bundle.json: unknown format");

  assert.equal(errorText({ code: "network" }), "The server cannot be reached.", "an ApiError's code");
  assert.equal(errorText({ code: "hls_unsupported" }), "This browser cannot play HLS.", "the companion player's");
  assert.equal(errorText({ code: "weird" }), "The server answered: weird.");
  assert.equal(errorText(new TypeError("x is undefined")), "Something went wrong.", "a bug is not shown as it is");
  assert.equal(errorText({ code: 20, name: "AbortError" }), "Something went wrong.", "a DOMException's numeric code is not one of ours");
  assert.equal(errorText(null), "Something went wrong.");

  assert.equal(primarySubtag("pt-BR"), "pt");
  assert.equal(primarySubtag("EN"), "en");
  assert.equal(sameLanguage("en", "en-GB"), true);
  assert.equal(sameLanguage("TR", "tr"), true);
  assert.equal(sameLanguage("en", "tr"), false);
  assert.equal(sameLanguage(null, "en"), false);
  assert.equal(sameLanguage("en", undefined), false);
});

test("admin helpers: a diagnostics source, line by line", () => {
  const at = (iso: string) => `at ${iso}`;
  assert.deepEqual(sourceReport({ sourceId: "missing", type: "adapter", adapterId: "example", ok: false, code: "empty", ms: 1 }, at), {
    ok: false,
    sourceId: "missing",
    how: "adapter example · 1 ms",
    lines: ["the adapter found nothing to play"],
  });
  const stream = { kind: "hls", inline: false, host: "127.0.0.1:8788", headerNames: ["Referer"], delivery: "proxy", languages: { audio: ["en", "tr"], subtitles: ["en"] }, expiresAt: "2026-10-14T12:00:00Z" };
  const probe = { ok: true, status: 200, ms: 3, playlist: { master: true, variants: 1, renditions: 3, segments: 0 } };
  assert.deepEqual(sourceReport({ sourceId: "signed-hls", type: "adapter", adapterId: "example", ok: true, ms: 2, stream, probe }, at), {
    ok: true,
    sourceId: "signed-hls",
    how: "adapter example · 2 ms",
    lines: [
      "HLS from 127.0.0.1:8788 · through the proxy",
      "upstream headers: Referer",
      "audio en, tr · subtitles en",
      "expires at 2026-10-14T12:00:00Z",
      "probe ok (HTTP 200, 1 variant, 3 renditions, 3 ms)",
    ],
  });
  const direct = { kind: "mp4", inline: true, host: null, headerNames: [], delivery: "direct", languages: { audio: null, subtitles: [] }, expiresAt: null };
  const r = sourceReport({ sourceId: "d", type: "direct", ok: true, ms: 0, stream: direct, probe: { ok: false, status: 403, ms: 5, error: null, name: null } }, at);
  assert.equal(r.ok, false, "a failed probe fails the source");
  assert.equal(r.how, "direct · 0 ms");
  assert.deepEqual(r.lines, ["MP4 (inline playlist) from ? · direct to the TV", "audio unknown · subtitles unknown", "probe failed: HTTP 403"]);
  const media = sourceReport({ sourceId: "m", type: "direct", ok: true, ms: 0, stream: { ...direct, delivery: "unsupported" }, probe: { ok: true, ms: 4, playlist: { master: false, segments: 1 } } }, at);
  assert.deepEqual(media.lines.slice(-1), ["probe ok (1 segment, 4 ms)"]);
  assert.match(media.lines[0]!, /cannot be served$/);
});

test("the admin UI is served from an allow-list with a strict CSP and no inline code", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const page = await fetch(`${s.base}/admin/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.ok(!csp.includes("unsafe-inline"));
  const html = await page.text();
  assert.match(html, /<script type="module" src="app.js"><\/script>/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline scripts");
  assert.ok(!/\sstyle=|\son[a-z]+=/i.test(html), "no inline styles or handlers");
  assert.match(csp, /media-src 'self' blob:(;|$)/, "the Listen along audio element loads proxied media and hls.js object URLs only");
  // Every allow-listed file is served with its type and the CSP; nothing else in the directory is.
  for (const [file, type] of [...Object.entries(ADMIN_FILES), ...Object.entries(ADMIN_VENDOR_FILES).map(([f, t]) => [`vendor/${f}`, t])]) {
    const res = await fetch(`${s.base}/admin/${file}`);
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get("content-type"), type, file);
    assert.equal(res.headers.get("content-security-policy"), csp, file);
    assert.equal(await res.text(), await readFile(new URL(file, ADMIN_DIR), "utf8"), file);
  }
  const unlisted = [
    ...(await readdir(ADMIN_DIR)).filter((f) => f !== "vendor" && !Object.hasOwn(ADMIN_FILES, f)),
    ...(await readdir(new URL("vendor/", ADMIN_DIR))).filter((f) => !Object.hasOwn(ADMIN_VENDOR_FILES, f)).map((f) => `vendor/${f}`),
  ];
  assert.ok(unlisted.includes("index.html") && unlisted.includes("tsconfig.json") && unlisted.includes("vendor/README.md"));
  for (const bad of [...unlisted, "..%2Fpackage.json", "%2e%2e/src/app.ts", "constructor", "toString", "vendor/..%2Fapp.js", "vendor/constructor"]) {
    assert.equal((await fetch(`${s.base}/admin/${bad}`)).status, 404, bad);
  }
});

test("the admin UI's modules never parse text as HTML", async () => {
  const files = await adminScripts();
  assert.ok(files.length >= 10 && files.includes("app.js") && files.includes("companion.js"), "every top-level module is scanned");
  for (const file of files) {
    const js = await readFile(new URL(file, ADMIN_DIR), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|\.style\s*=|setAttribute\(\s*["']style/.test(js), `${file}: server text is never parsed as HTML, and no inline style is set`);
  }
});

test("every module the admin UI imports exists and is allow-listed", async () => {
  // A module missing from ADMIN_FILES is a 404 in production: a blank page while every other test stays green.
  const html = await readFile(new URL("index.html", ADMIN_DIR), "utf8");
  const fromHtml = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(fromHtml.sort(), ["app.js", "icon.svg", "icon.svg", "style.css"]);
  for (const ref of fromHtml) assert.ok(Object.hasOwn(ADMIN_FILES, ref), `index.html: ${ref} is allow-listed`);
  const reached = new Set(["app.js"]);
  for (const file of await adminScripts()) {
    const js = await readFile(new URL(file, ADMIN_DIR), "utf8");
    const imports = [...js.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)|import\("([^"]+)"\)\.\w+/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
    for (const spec of imports) {
      assert.match(spec, /^\.\/[\w-]+\.js$/, `${file}: imports ${spec} as a flat relative module`);
      const target = spec.slice(2);
      assert.ok(Object.hasOwn(ADMIN_FILES, target), `${file}: ${target} is in ADMIN_FILES`);
      await readFile(new URL(target, ADMIN_DIR)); // exists
      reached.add(target);
    }
    for (const m of js.matchAll(/\.src\s*=\s*"([^"]+)"/g)) {
      assert.ok(m[1]!.startsWith("vendor/") && Object.hasOwn(ADMIN_VENDOR_FILES, m[1]!.slice("vendor/".length)), `${file}: ${m[1]} is a vendored, allow-listed file`);
    }
  }
  for (const file of await adminScripts()) assert.ok(reached.has(file), `${file} is imported by some module (or is the entry)`);
});

test("listen along helpers: TV position, companion target, sync decisions, clock offset, candidate options", () => {
  const anchor = { positionMs: 42_000, atMs: NOW, playing: true, rate: 1 };
  assert.equal(tvPositionAt(anchor, NOW + 2_500), 44_500);
  assert.equal(tvPositionAt({ ...anchor, playing: false }, NOW + 2_500), 42_000);
  assert.equal(tvPositionAt(anchor, NOW - 100), 42_000, "never before the anchor");
  assert.equal(tvPositionAt(null, NOW), null);

  assert.equal(companionTarget(600_000, { rate: 1.0427, offsetMs: -1_250 }, 80), 600_000 * 1.0427 - 1_250 + 80);
  assert.equal(companionTarget(0, { rate: 1, offsetMs: 0 }), 0);

  const decide = (errorMs: number, nominalRate = 1, tvPlaying = true) =>
    syncDecision({ targetMs: 100_000, actualMs: 100_000 - errorMs, tvPlaying, nominalRate });
  assert.deepEqual(decide(2_000), { action: "seek", toMs: 100_000, rate: 1, state: "seeking", errorMs: 2_000 });
  assert.equal(decide(-2_000).action, "seek");
  assert.deepEqual(decide(500), { action: "play", rate: 1.05, state: "catching up", errorMs: 500 });
  assert.deepEqual(decide(100), { action: "play", rate: 1.02, state: "catching up", errorMs: 100 });
  assert.deepEqual(decide(20), { action: "play", rate: 1, state: "synced", errorMs: 20 });
  assert.deepEqual(decide(-500), { action: "play", rate: 0.95, state: "holding back", errorMs: -500 });
  assert.equal(decide(500, 1.08).rate, 1.1, "clamped");
  assert.equal(decide(-500, 0.92).rate, 0.9, "clamped");
  assert.equal(decide(20, 1.0427).rate, 1.0427, "the nominal rate within tolerance");
  assert.deepEqual(decide(500, 1, false), { action: "pause", rate: 1, state: "paused", errorMs: 500 });
  assert.equal(syncDecision({ targetMs: -3_000, actualMs: 0, tvPlaying: true, nominalRate: 1 }).state, "waiting");

  const quick = { sentAt: 1_000, receivedAt: 1_040, serverNowMs: 6_020 };
  const slow = { sentAt: 2_000, receivedAt: 2_400, serverNowMs: 7_250 };
  const longPoll = { sentAt: 3_000, receivedAt: 23_000, serverNowMs: 99_000 };
  assert.equal(clockOffset([slow, quick, longPoll]), 6_020 - 1_020);
  assert.equal(clockOffset([longPoll]), null);
  assert.equal(clockOffset([]), null);
  assert.equal(pushSample([quick, slow], longPoll, 2).length, 2);
  assert.deepEqual(pushSample([quick, slow], longPoll, 2)[0], slow);

  const options = candidateOptions([
    { sourceId: "hls-multi-audio", label: "Unified", languages: { audio: ["en", "it"], subtitles: [] }, current: true, supported: true, reason: null },
    { sourceId: "fr-dub", label: null, languages: { audio: ["fr"], subtitles: null }, current: false, supported: true, reason: null },
    { sourceId: "silent", label: null, languages: { audio: [], subtitles: null }, current: false, supported: true, reason: null },
    { sourceId: "mystery", label: null, languages: { audio: null, subtitles: null }, current: false, supported: true, reason: null },
    { sourceId: "dash", label: null, languages: { audio: ["de"], subtitles: [] }, current: false, supported: false, reason: "dash" },
  ]);
  assert.deepEqual(
    options.map((o) => [o.sourceId, o.language, o.disabled, o.label]),
    [
      ["hls-multi-audio", "en", false, "hls-multi-audio — Unified · English (en) · the TV's source"],
      ["hls-multi-audio", "it", false, "hls-multi-audio — Unified · Italiano (it) · the TV's source"],
      ["fr-dub", null, false, "fr-dub · Français (fr)"],
      ["silent", null, false, "silent · no dialogue"],
      ["mystery", null, false, "mystery"],
      ["dash", null, true, "dash · Deutsch (de) · DASH, cannot play on a phone"],
    ],
  );
  assert.deepEqual(parseCandidate(options[1]!.value), { sourceId: "hls-multi-audio", language: "it" });
  assert.deepEqual(parseCandidate(options[2]!.value), { sourceId: "fr-dub", language: null });

  assert.equal(formatDrift(600), "+600 ms");
  assert.equal(formatDrift(-12.4), "−12 ms");
  assert.equal(formatDrift(1_540), "+1.5 s");
  assert.equal(formatDrift(null), "–");
  assert.equal(formatPosition(3_725_450), "1:02:05.4");
  assert.equal(formatPosition(65_000), "1:05.0");
  assert.equal(formatPosition(-1), "–");
});
