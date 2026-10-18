import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  APK_MAX_BYTES, androidText, apkVersion, appCheckReasonText, appCheckText, appUpdateChip, capabilityText, checkResultText,
  formatBytes, installNowBlocked, newApkText,
  actorLabel, buildSummary, candidateOptions, catalogSearchPath, clockOffset, commandResultText, companionTarget,
  continueText, episodeHistoryLine, episodeName, episodeStateLabel, episodeStates, errorText, formatClock, formatCode,
  formatCountdown, formatDrift, formatDuration, formatPosition, formatRelative, groupEpisodeChanges, isActive, issueLine,
  languageLabel, moveItem, parseCandidate, parseSse, percent, playbackState, plural, problemContext, resumes,
  sameLanguage, scopeLabel, searchSummary, serverAddress, shortId, showMeta, sourceReport, syncDecision, titleLine,
  titleStatusLabel, tokenFromHash, triggerLabel, tvPositionAt, viewingEnd,
} from "../admin/lib.js";
import { ADMIN_FILES, ADMIN_VENDOR_FILES } from "../src/admin-files.ts";
import { startTestServer } from "./helpers.ts";

const ADMIN_DIR = new URL("../admin/", import.meta.url);
/** The admin page's top-level modules (vendor/ is third-party). */
const adminScripts = async () => (await readdir(ADMIN_DIR)).filter((f) => f.endsWith(".js")).sort();

const NOW = Date.parse("2026-10-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** Asserts each `[actual, expected, why?]` (deep equality). */
const cases = (list: Array<[unknown, unknown, string?]>) =>
  list.forEach(([actual, expected, why], i) => assert.deepEqual(actual, expected, why ?? `case ${i}`));

test("admin helpers: clocks, relative times, codes, sign-in links and the address to type on the TV", () => {
  cases([
    [formatClock(0), "0:00"], [formatClock(65_000), "1:05"], [formatClock(3_725_000), "1:02:05"],
    [formatClock(null), "–"], [formatClock(-1), "–"],
    [formatRelative(ago(10_000), NOW), "just now"], [formatRelative(ago(5 * 60_000), NOW), "5 min ago"],
    [formatRelative(ago(3 * 3600_000), NOW), "3 h ago"], [formatRelative(ago(26 * 3600_000), NOW), "yesterday"],
    [formatRelative(ago(4 * 86400_000), NOW), "4 days ago"], [formatRelative(ago(40 * 86400_000), NOW), "2026-08-31"],
    [formatRelative(null, NOW), "never"],
    [formatCountdown(new Date(NOW + 125_000).toISOString(), NOW), "2:05"], [formatCountdown(ago(1000), NOW), "0:00"],
    [formatCode("483920"), "483 920"],
    [tokenFromHash("#token=abc-DEF_123"), "abc-DEF_123"],
    [tokenFromHash("#token=correct%20horse%20battery"), "correct horse battery", "the link encodes the token"],
    [tokenFromHash("#token=%E0%A4%A"), null, "a broken encoding is not a token"],
    [tokenFromHash("#/devices"), null], [tokenFromHash("#token="), null],
    [tokenFromHash(""), null], [tokenFromHash(undefined), null],
    [serverAddress("http://192.168.1.54:8787", "/admin/"), "http://192.168.1.54:8787"],
    [serverAddress("https://izle.example.org", "/admin/index.html"), "https://izle.example.org"],
    [serverAddress("https://host.example.org", "/izle/admin/"), "https://host.example.org/izle", "a reverse proxy prefix is kept"],
  ]);
});

test("admin helpers: episode names, what OK does, list moves and episode states", () => {
  const c = { episodeId: "show.s1e2", season: 1, number: 2, title: "Two", label: null, durationMs: 600_000 };
  cases([
    [episodeName({ season: 1, number: 2, title: "Gran Dillama" }, "series"), "S1 · E2 — Gran Dillama"],
    [episodeName({ number: 5, title: null }, "series"), "Episode 5"],
    [episodeName({ label: "Special", number: 9, title: "Xmas" }, "series"), "Special — Xmas"],
    [episodeName({ title: null }, "movie"), "Film"],
    [continueText({ ...c, status: "new", positionMs: 0 }, "series"), "S1 · E2 — Two · new"],
    [continueText({ ...c, status: "watching", positionMs: 90_000 }, "series"), "S1 · E2 — Two · continues at 1:30 of 10:00"],
    [continueText({ ...c, status: "watching", positionMs: 17_000 }, "movie"), "starts from the beginning", "the TV resumes from 30 s on"],
    [continueText({ ...c, status: "finished", positionMs: 0 }, "movie"), "watched — starts over"],
    [continueText(null, "movie"), "Nothing playable"],
    [resumes({ ...c, status: "watching", positionMs: 30_000 }), true],
    [resumes({ ...c, status: "watching", positionMs: 29_999 }), false, "the TV resumes from 30 s on"],
    [resumes({ ...c, status: "finished", positionMs: 90_000 }), false], [resumes(null), false],
    [percent(30, 120), 25], [percent(30, null), null], [percent(500, 100), 100],
    [moveItem(["a", "b", "c"], 1, -1), ["b", "a", "c"]], [moveItem(["a", "b", "c"], 2, 1), ["a", "b", "c"]],
    [moveItem(["a", "b", "c"], 0, 2), ["b", "c", "a"]],
  ]);
  const states = episodeStates([{ id: "e1" }, { id: "e2" }, { id: "e3" }], "e2", [
    { episodeId: "e1", status: "finished", positionMs: 10, durationMs: 10 },
    { episodeId: "e2", status: "watching", positionMs: 5, durationMs: 10 },
  ]);
  assert.deepEqual(states.map((s) => [s.episode.id, s.current, s.watched, s.percent]),
    [["e1", false, true, null], ["e2", true, false, 50], ["e3", false, false, null]]);
  const s = ({ playbackAllowed = true, current = false, watched = false, percent = null as number | null }) =>
    ({ episode: { playbackAllowed }, current, watched, percent });
  cases([
    [episodeStateLabel(s({ playbackAllowed: false, current: true })), "not allowed"],
    [episodeStateLabel(s({ current: true, percent: 40 })), "next"],
    [episodeStateLabel(s({ watched: true })), "watched"],
    [episodeStateLabel(s({ percent: 0 })), "0%"], [episodeStateLabel(s({ percent: 63 })), "63%"],
    [episodeStateLabel(s({})), "new"],
  ]);
});

test("admin helpers: what the TV plays and how a problem reads", () => {
  const n = { state: "playing", updatedAt: ago(20_000) };
  cases([
    [isActive(n, true, NOW), true],
    [isActive(n, false, NOW), false, "an offline TV is not playing"],
    [isActive({ ...n, updatedAt: ago(5 * 60_000) }, true, NOW), false, "stale reports"],
    [isActive({ ...n, state: "stopped" }, true, NOW), false],
    [playbackState(n, true, NOW), { label: "Playing", tone: "ok", active: true }],
    [playbackState({ ...n, state: "paused" }, true, NOW), { label: "Paused", tone: "", active: true }],
    [playbackState({ ...n, state: "starting" }, true, NOW), { label: "Starting", tone: "", active: true }],
    [playbackState({ ...n, state: "stopped" }, true, NOW), { label: "Last played", tone: "", active: false }],
  ]);
  const p = { itemId: "show", itemTitle: "Şov Dünyası", itemKind: "series", episodeId: "show.e1", episodeTitle: "Pilot", season: 1, number: 1,
    sourceId: "tr-dub", positionMs: 754_000, httpStatus: 403, appVersion: "0.3.0 (300)", missing: false };
  const bare = { ...p, sourceId: null, positionMs: null, httpStatus: null, appVersion: null };
  cases([
    [problemContext(p), "Şov Dünyası · S1 · E1 — Pilot · source tr-dub · at 12:34 · HTTP 403 · app 0.3.0 (300)"],
    [problemContext({ ...bare, itemTitle: "Film", itemKind: "movie", season: null, number: null, episodeTitle: null }), "Film", "films have no episode to name"],
    [problemContext({ ...bare, positionMs: 3_725_000 }), "Şov Dünyası · S1 · E1 — Pilot · at 1:02:05"],
    [problemContext({ ...bare, itemTitle: null, itemKind: null, missing: true }), "show (no longer in the catalog)"],
    [problemContext({ ...bare, itemId: null, itemTitle: null, itemKind: null, episodeId: "gone.e1", missing: true }), "gone.e1 (no longer in the catalog)"],
    [problemContext({ ...bare, itemId: null, itemTitle: null, itemKind: null, episodeId: null }), "", "nothing known: no context line"],
  ]);
});

test("admin helpers: build summaries and episode changes grouped by show", () => {
  const build = ([ai, ae]: [number, number], [ri, re]: [number, number], baseline = false) =>
    ({ baseline, added: { items: ai, episodes: ae }, removed: { items: ri, episodes: re } });
  cases([
    [buildSummary(build([2, 14], [0, 1])), "+2 shows · +14 episodes · −1 episode"],
    [buildSummary(build([0, 1], [1, 3])), "+1 episode · −1 show · −3 episodes"],
    [buildSummary(build([1, 1], [0, 0])), "+1 show · +1 episode"],
    [buildSummary(build([0, 0], [0, 0])), "nothing added or removed", "a new build id with the same shows and episodes"],
    [buildSummary(build([0, 0], [0, 0], true)), "first load"],
  ]);
  const added = (id: string, itemId: string, itemTitle: string, rest: Record<string, unknown> = {}) =>
    ({ id, itemId, itemTitle, season: null, number: null, label: null, playbackAllowed: true, ...rest });
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
});

test("admin helpers: show lines, searches, ids, issues, error texts and languages", () => {
  cases([
    [showMeta({ kind: "movie", year: 2026 }), "Film · 2026"],
    [showMeta({ kind: "series", year: 2026, episodeCount: 4, playableCount: 3 }), "Series · 4 episodes · 2026"],
    [showMeta({ kind: "series", year: null, episodeCount: 1 }), "Series · 1 episode"],
    [showMeta({ kind: "series" }), "Series"],
    [showMeta({ kind: "series", year: 2026, episodeCount: 4, playableCount: 3 }, { playable: true }), "Series · 4 episodes · 2026 · 3 of 4 playable"],
    [showMeta({ kind: "movie", year: 2026, episodeCount: 1, playableCount: 0 }, { playable: true }), "Film · 2026 · not playable"],
    [showMeta({ kind: "movie", episodeCount: 1, playableCount: 1 }, { playable: true }), "Film", "all playable: nothing to say"],
    [searchSummary(3, " pro "), "3 shows match “pro”."], [searchSummary(1, "pro"), "1 show matches “pro”."],
    [searchSummary(0, "xyz"), "No show matches “xyz”."], [searchSummary(7, ""), "All 7 shows."],
    [searchSummary(1, ""), "The catalog's only show."], [searchSummary(0, ""), "The catalog has no shows."],
    [searchSummary(200, ""), "The first 200 shows; type a title to narrow the list.", "the server's cap"],
    [searchSummary(200, "a"), "The first 200 shows that match “a”; type more to narrow the list."],
    [catalogSearchPath(" pro "), "/catalog/search?limit=200&q=pro"],
    [catalogSearchPath("a&b c"), "/catalog/search?limit=200&q=a%26b%20c"],
    [catalogSearchPath(""), "/catalog/search?limit=200&q=", "an empty box lists the catalog"],
    [shortId("20261014-6b05c8e7"), "20261014-6b05c8e7"],
    [shortId("20261014-6b05c8e71a2b3c4d5e6f"), "20261014-6b05c8e71a2…"],
    [issueLine({ file: "items.json", path: "/items/3/poster", message: "file not found" }), "items.json /items/3/poster: file not found"],
    [issueLine({ file: "bundle.json", path: null, message: "unknown format" }), "bundle.json: unknown format"],
    [errorText({ code: "too_many_items" }), "A home screen holds at most 12 shows."],
    [errorText({ code: "network" }), "The server cannot be reached.", "an ApiError's code"],
    [errorText({ code: "hls_unsupported" }), "This browser cannot play HLS.", "the companion player's"],
    [errorText({ code: "weird" }), "The server answered: weird."],
    [errorText(new TypeError("x is undefined")), "Something went wrong.", "a bug is not shown as it is"],
    [errorText({ code: 20, name: "AbortError" }), "Something went wrong.", "a DOMException's numeric code is not one of ours"],
    [errorText(null), "Something went wrong."],
    [plural(1, "variant"), "1 variant"], [plural(3, "segment"), "3 segments"],
    [languageLabel("tr"), "Türkçe (tr)"], [languageLabel("pt-BR"), "Português (pt-BR)"], [languageLabel("xx"), "xx"],
    [languageLabel(null, "Off"), "Off"],
    [sameLanguage("en", "en-GB"), true], [sameLanguage("TR", "tr"), true], [sameLanguage("en", "tr"), false],
    [sameLanguage(null, "en"), false], [sameLanguage("en", undefined), false],
  ]);
});

test("admin helpers: a diagnostics source, line by line", () => {
  const at = (iso: string) => `at ${iso}`;
  const failed = (code: string, name: string | null) => sourceReport({ sourceId: "s", type: "direct", ok: false, code, name, ms: 0 }, at).lines;
  cases([
    [failed("error", "UpstreamError"), ["the adapter failed (UpstreamError)"]],
    [failed("timeout", "TimeoutError"), ["timed out"]],
    [failed("timeout", "BudgetExhausted"), ["skipped: the time budget of the request ran out"]],
  ]);
  assert.deepEqual(sourceReport({ sourceId: "missing", type: "adapter", adapterId: "example", ok: false, code: "empty", ms: 1 }, at),
    { ok: false, sourceId: "missing", how: "adapter example · 1 ms", lines: ["the adapter found nothing to play"] });
  const stream = { kind: "hls", inline: false, host: "127.0.0.1:8788", headerNames: ["Referer"], delivery: "proxy", languages: { audio: ["en", "tr"], subtitles: ["en"] }, expiresAt: "2026-10-14T12:00:00Z" };
  const probe = { ok: true, status: 200, ms: 3, playlist: { master: true, variants: 1, renditions: 3, segments: 0 } };
  assert.deepEqual(sourceReport({ sourceId: "signed-hls", type: "adapter", adapterId: "example", ok: true, ms: 2, stream, probe }, at), {
    ok: true, sourceId: "signed-hls", how: "adapter example · 2 ms",
    lines: ["HLS from 127.0.0.1:8788 · through the proxy", "upstream headers: Referer", "audio en, tr · subtitles en",
      "expires at 2026-10-14T12:00:00Z", "probe ok (HTTP 200, 1 variant, 3 renditions, 3 ms)"],
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

test("admin helpers: the event stream, durations, viewings, titles, episodes, command results and scopes", () => {
  const stream = "retry: 5000\n: ping\n\nid: 7\nevent: playback.started\ndata: {\"id\":7}\n\nid: 8\nevent: gap\ndata: {\"oldest\":9}\n\ndata: part";
  assert.deepEqual(parseSse(stream), {
    events: [{ id: "7", event: "playback.started", data: '{"id":7}' }, { id: "8", event: "gap", data: '{"oldest":9}' }],
    rest: "data: part",
  }, "comments and retry are skipped; the unfinished message stays for the next chunk");
  assert.deepEqual(parseSse("data: a\r\ndata: b\r\n\r\n"), { events: [{ id: null, event: "message", data: "a\nb" }], rest: "" });
  const ended = { endedAt: ago(1000), endPositionMs: 754_000, seen: false, imported: false };
  cases([
    [formatDuration(0), "under a minute"], [formatDuration(45 * 60_000), "45 min"], [formatDuration(2 * 3_600_000 + 5 * 60_000), "2 h 05 min"],
    [formatDuration(null), "–"],
    [actorLabel({ type: "owner" }), "the owner"], [actorLabel({ type: "token", name: "Home assistant" }), "token “Home assistant”"],
    [actorLabel({ type: "tv" }), "the TV"], [actorLabel({ type: "server" }), "the server"], [actorLabel(null), ""],
    [triggerLabel({ trigger: "viewer" }), "the viewer"], [triggerLabel({ trigger: "autoplay" }), "autoplay"], [triggerLabel({ trigger: "next" }), "auto-next"],
    [triggerLabel({ trigger: "command", actor: { type: "token", name: "Bot" } }), "token “Bot”"], [triggerLabel({ trigger: "unknown" }), ""],
    [viewingEnd({ ...ended, endedAt: null, endReason: null }), "playing now"],
    [viewingEnd({ ...ended, endReason: "finished" }), "watched to the end"],
    [viewingEnd({ ...ended, endReason: "stopped" }), "stopped at 12:34"],
    [viewingEnd({ ...ended, endReason: "replaced", seen: true }), "switched away at 12:34 · seen", "the 90 % rule"],
    [viewingEnd({ ...ended, endReason: "lost" }), "lost at 12:34"],
    [viewingEnd({ ...ended, endReason: "stopped", imported: true }), "stopped", "an imported viewing has no position worth a time"],
    [titleStatusLabel("finished"), { label: "Finished", tone: "ok" }], [titleStatusLabel("new_episodes"), { label: "New episodes", tone: "info" }],
    [titleStatusLabel("watching"), { label: "Watching", tone: "" }], [titleStatusLabel("idle"), { label: "Idle", tone: "" }],
    [titleLine({ kind: "series", inCatalog: true, episodes: { total: 12, seen: 5 }, lastWatchedAt: ago(2 * 86400_000), watchedMs: 12_000_000 }, NOW), "Series · 5 of 12 episodes seen · last watched 2 days ago · 3 h 20 min"],
    [titleLine({ kind: "movie", inCatalog: false, episodes: { total: 1, seen: 1 }, lastWatchedAt: null, watchedMs: 0 }, NOW), "Film · seen · no longer in the catalog"],
    [episodeHistoryLine({ seen: true, seenAt: "2026-10-10T20:00:00Z", coveredFraction: 0.85, viewings: 3, watchedMs: 4_200_000, lastPositionMs: 1000, mark: null }), "seen 2026-10-10 · 85% played · 3 viewings · 1 h 10 min"],
    [episodeHistoryLine({ seen: false, seenAt: null, coveredFraction: null, viewings: 1, watchedMs: 600_000, lastPositionMs: 754_000, mark: false }), "not seen · marked not seen · 1 viewing · 10 min · last at 12:34"],
    [episodeHistoryLine({ seen: false, seenAt: null, coveredFraction: null, viewings: 0, watchedMs: 0, lastPositionMs: null, mark: null }), "never played"],
    [commandResultText({ type: "play", result: "done", reason: null }), "Play: done"],
    [commandResultText({ type: "pause", result: "ignored", reason: "not_in_player" }), "Pause: ignored (nothing is playing)"],
    [commandResultText({ type: "play", result: "failed", reason: "odd_reason" }), "Play: failed (odd reason)", "a reason the page does not know"],
    [scopeLabel("manage"), "Manage"], [scopeLabel("x"), "x"],
    [errorText({ code: "insufficient_scope" }), "This token may not do that; the admin page needs the owner token."],
  ]);
});

test("admin helpers: TV app sizes, APK names, update chips, Android versions and how a TV updates", () => {
  cases([
    [formatBytes(0), "0 B"], [formatBytes(999), "999 B"], [formatBytes(1000), "1.0 kB"], [formatBytes(12_345), "12.3 kB"],
    [formatBytes(12_300_000), "12.3 MB"], [formatBytes(164_400_000), "164 MB"], [formatBytes(999_999), "1.0 MB", "rounds up a unit"],
    [formatBytes(2_500_000_000), "2.5 GB"], [formatBytes(null), "–"], [formatBytes(-1), "–"], [formatBytes(Number.NaN), "–"],
    [APK_MAX_BYTES, 64 * 1024 * 1024],
    [apkVersion("izle-tv-0.3.0.apk"), "0.3.0"], [apkVersion("izle-tv-1.12.99.apk"), "1.12.99"],
    [apkVersion("izle-tv-0.3.0-rc.1.apk"), "0.3.0-rc.1", "a pre-release suffix is part of the version"],
    [apkVersion("izle-tv-0.3.0.APK"), null], [apkVersion("app-release.apk"), null], [apkVersion("izle-tv-0.3.apk"), null],
    [apkVersion("izle-tv-01.3.0.apk"), null, "no leading zeros"], [apkVersion("izle-tv-0.03.0.apk"), null],
    [apkVersion("izle-tv-0.100.0.apk"), null, "minor and patch below 100, as the server's versionCode needs"],
    [apkVersion("izle-tv-0.3.0.apk.zip"), null], [apkVersion("x/izle-tv-0.3.0.apk"), null], [apkVersion(""), null],
    [appUpdateChip({ update: "up_to_date" }), { text: "Up to date", tone: "ok" }],
    [appUpdateChip({ update: "pending" }), { text: "Update available", tone: "info" }],
    [appUpdateChip({ update: "needs_install_now" }), { text: "Needs Install now", tone: "warn" }],
    [appUpdateChip({ update: "unknown" }), { text: "Unknown", tone: "" }],
    [appUpdateChip({ update: null }), { text: "Unknown", tone: "" }, "an older app"],
    [appUpdateChip(undefined), { text: "Unknown", tone: "" }, "an older server"],
    [androidText(28), "Android 9 (API 28)"], [androidText(31), "Android 12 (API 31)"], [androidText(32), "Android 12L (API 32)"],
    [androidText(99), "API 99"], [androidText(null), "unknown"], [androidText(undefined), "unknown"],
    [capabilityText({ capability: "silent", androidSdk: 34 }), "Installs updates by itself while nobody is watching."],
    [capabilityText({ capability: "silent", androidSdk: 34 }, true), "Installs updates by itself while nobody is watching."],
    [capabilityText({ capability: "silent", androidSdk: 34 }, false), "Can install updates by itself, but automatic installs are off on this server: an update needs Install now here.", "appUpdates.auto off"],
    [capabilityText({ capability: "guided", androidSdk: 28 }, false), "On Android 11 or older, an update needs Install now here, and someone at the TV pressing OK when the screen appears.", "auto does not change guided TVs"],
    [capabilityText({ capability: "guided", androidSdk: 28 }), "On Android 11 or older, an update needs Install now here, and someone at the TV pressing OK when the screen appears."],
    [capabilityText({ capability: "guided", androidSdk: 33 }), "The TV lacks the one-time permission to install apps, so an update needs Install now here, and someone at the TV pressing OK when the screen appears.", "Android 12+ without the grant"],
    [capabilityText({ capability: null }), "Unknown: the TV has not said how it installs updates (an older app)."],
    [capabilityText(undefined), "Unknown: the TV has not said how it installs updates (an older app)."],
  ]);
  const active = { status: "active", online: true };
  cases([
    [installNowBlocked({ ...active, app: { update: "pending" } }, true), null],
    [installNowBlocked({ ...active, app: { update: "needs_install_now" } }, true), null],
    [installNowBlocked({ ...active }, true), null, "an older app: the TV answers for itself"],
    [installNowBlocked({ ...active, app: { update: "pending" } }, false), "No TV app is stored on the server."],
    [installNowBlocked({ ...active, online: false, app: { update: "pending" } }, true), "The TV is offline."],
    [installNowBlocked({ status: "pending", online: false }, true), "The TV is not set up yet."],
    [installNowBlocked({ ...active, app: { update: "up_to_date" } }, true), "The TV is up to date."],
  ]);
});

test("admin helpers: TV app checks, their reasons and the update command's results", () => {
  const reasons: Array<[string | null, string]> = [
    ["network", "GitHub could not be reached"], ["http_502", "GitHub answered HTTP 502"],
    ["rate_limited", "GitHub's rate limit was reached; a later check tries again"],
    ["no_release", "the repository has no release yet"],
    ["prerelease", "the latest release is a pre-release, which is not offered to TVs"],
    ["bad_tag", "the latest release's tag is not a version (vX.Y.Z)"], ["no_apk_asset", "the latest release has no izle-tv APK"],
    ["no_checksums", "the latest release has no checksum file"], ["checksums_too_large", "the release's checksum file is too large"],
    ["checksum_missing", "the checksum file does not list the APK"], ["checksum_mismatch", "the downloaded APK does not match its checksum"],
    ["too_large", "the APK is larger than 64 MiB"], ["not_an_apk", "the download is not an APK"],
    ["new_reason", "new reason"], [null, "for an unknown reason"],
  ];
  for (const [reason, text] of reasons) assert.equal(appCheckReasonText(reason), text, String(reason));
  const check = (o: Record<string, unknown>) => ({ lastAt: null, nextAt: null, result: null, reason: null, running: false, ...o });
  const later = (ms: number) => new Date(NOW + ms).toISOString();
  cases([
    [appCheckText(check({ lastAt: ago(2 * 3600_000), result: "up_to_date", nextAt: later(4 * 3600_000) }), "github", NOW), "Last check 2 h ago: up to date · next check in 4 h"],
    [appCheckText(check({ lastAt: ago(5_000), result: "failed", reason: "network", nextAt: later(30 * 60_000) }), "github", NOW), "Last check failed just now: GitHub could not be reached · next check in 30 min"],
    [appCheckText(check({ lastAt: ago(60_000), result: "fetched", nextAt: later(26 * 3600_000) }), "github", NOW), "Last check 1 min ago: fetched a new version · next check in 1 day"],
    [appCheckText(check({ lastAt: ago(60_000), result: "fetched", nextAt: later(10_000) }), "github", NOW), "Last check 1 min ago: fetched a new version · next check soon"],
    [appCheckText(check({ running: true, lastAt: ago(60_000), nextAt: later(60_000) }), "github", NOW), "Checking now…"],
    [appCheckText(check({ nextAt: later(5 * 60_000) }), "github", NOW), "Not checked yet · next check in 5 min"],
    [appCheckText(check({ lastAt: ago(60_000), result: "up_to_date" }), "github", NOW), "Last check 1 min ago: up to date", "no automatic checks: no next one"],
    [appCheckText(check({}), "manual", NOW), "Checks disabled (manual source): the server offers the APK uploaded here."],
    [appCheckText(null, "github", NOW), ""],
    [checkResultText({ result: "fetched", reason: null, apk: { versionName: "0.3.0" } }, true), { text: "Fetched 0.3.0 from GitHub. TVs that install by themselves update when idle; the others need Install now.", kind: "ok" }],
    [checkResultText({ result: "fetched", reason: null, apk: { versionName: "0.3.0" } }, false), { text: "Fetched 0.3.0 from GitHub. Automatic installs are off: every TV needs Install now.", kind: "ok" }, "appUpdates.auto off"],
    [checkResultText({ result: "fetched", reason: null, apk: null }, true), { text: "Fetched a new version from GitHub. TVs that install by themselves update when idle; the others need Install now.", kind: "ok" }],
    [checkResultText({ result: "up_to_date", reason: null, apk: { versionName: "0.3.0" } }, true), { text: "Up to date: 0.3.0 is the latest release.", kind: "info" }],
    [checkResultText({ result: "up_to_date", reason: null, apk: { versionName: "0.3.0" } }, false), { text: "Up to date: 0.3.0 is the latest release.", kind: "info" }],
    [checkResultText({ result: "failed", reason: "checksum_mismatch", apk: null }, false), { text: "The check failed: the downloaded APK does not match its checksum.", kind: "error" }],
    [newApkText(true), "TVs that install by themselves update when idle; the others need Install now."],
    [newApkText(false), "Automatic installs are off: every TV needs Install now."],
  ]);
  const update = (result: string, reason: string | null) => commandResultText({ type: "update", result, reason });
  cases([
    [update("done", "installing"), "Update: the TV is installing"],
    [update("done", "prompted"), "Update: the TV shows the install screen; someone has to press OK"],
    [update("done", null), "Update: done"],
    [update("ignored", "up_to_date"), "Update: ignored, the TV is up to date"],
    [update("ignored", "not_newer"), "Update: ignored, the TV has this version or a newer one"],
    [update("ignored", "busy"), "Update: ignored, the TV is playing", "not the generic “busy”"],
    [update("ignored", "not_ready"), "Update: ignored, the TV is not set up"],
    [update("ignored", "declined"), "Update: declined on the TV (Back was pressed)"],
    [update("ignored", "timeout"), "Update: nobody pressed OK on the TV within 60 s"],
    [update("failed", "download"), "Update failed: the TV could not download the APK"],
    [update("failed", "too_large"), "Update failed: the APK is too large for the TV"],
    [update("failed", "verify"), "Update failed: the download did not match its checksum"],
    [update("failed", "wrong_package"), "Update failed: the APK is not the izle TV app"],
    [update("failed", "bad_archive"), "Update failed: the APK is damaged"],
    [update("failed", "install_failure_incompatible"), "Update failed: different signing key (only a release APK installs over a release install)"],
    [update("failed", "install_failure_storage"), "Update failed: the TV's installer refused (failure storage)"],
    [update("failed", "odd_thing"), "Update failed (odd thing)"],
    [update("ignored", "odd_thing"), "Update: ignored (odd thing)"],
    [commandResultText({ type: "play", result: "ignored", reason: "busy" }), "Play: ignored (the TV was busy)", "other commands keep their words"],
    [errorText({ code: "no_apk" }), "No TV app is stored on the server yet: fetch or upload one on the TV app page."],
    [errorText({ code: "invalid_filename" }), "Name the file izle-tv-X.Y.Z.apk, as on the releases page."],
    [errorText({ code: "apk_too_large" }), "That APK is larger than 64 MiB, the server's limit."],
    [errorText({ code: "github_disabled" }), "Checks are off: this server is set to uploaded APKs only."],
  ]);
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
  assert.match(csp, /media-src 'self' blob:(;|$)/, "the Listen along audio element loads proxied media and hls.js object URLs only");
  const html = await page.text();
  assert.match(html, /<script type="module" src="app.js"><\/script>/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline scripts");
  assert.ok(!/\sstyle=|\son[a-z]+=/i.test(html), "no inline styles or handlers");
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
  const decide = (errorMs: number, nominalRate = 1, tvPlaying = true) =>
    syncDecision({ targetMs: 100_000, actualMs: 100_000 - errorMs, tvPlaying, nominalRate });
  const quick = { sentAt: 1_000, receivedAt: 1_040, serverNowMs: 6_020 };
  const slow = { sentAt: 2_000, receivedAt: 2_400, serverNowMs: 7_250 };
  const longPoll = { sentAt: 3_000, receivedAt: 23_000, serverNowMs: 99_000 };
  cases([
    [tvPositionAt(anchor, NOW + 2_500), 44_500],
    [tvPositionAt({ ...anchor, playing: false }, NOW + 2_500), 42_000],
    [tvPositionAt(anchor, NOW - 100), 42_000, "never before the anchor"],
    [tvPositionAt(null, NOW), null],
    [companionTarget(600_000, { rate: 1.0427, offsetMs: -1_250 }, 80), 600_000 * 1.0427 - 1_250 + 80],
    [companionTarget(0, { rate: 1, offsetMs: 0 }), 0],
    [decide(2_000), { action: "seek", toMs: 100_000, rate: 1, state: "seeking", errorMs: 2_000 }],
    [decide(-2_000).action, "seek"],
    [decide(500), { action: "play", rate: 1.05, state: "catching up", errorMs: 500 }],
    [decide(100), { action: "play", rate: 1.02, state: "catching up", errorMs: 100 }],
    [decide(20), { action: "play", rate: 1, state: "synced", errorMs: 20 }],
    [decide(-500), { action: "play", rate: 0.95, state: "holding back", errorMs: -500 }],
    [decide(500, 1.08).rate, 1.1, "clamped"], [decide(-500, 0.92).rate, 0.9, "clamped"],
    [decide(20, 1.0427).rate, 1.0427, "the nominal rate within tolerance"],
    [decide(500, 1, false), { action: "pause", rate: 1, state: "paused", errorMs: 500 }],
    [syncDecision({ targetMs: -3_000, actualMs: 0, tvPlaying: true, nominalRate: 1 }).state, "waiting"],
    [clockOffset([slow, quick, longPoll]), 6_020 - 1_020], [clockOffset([longPoll]), null], [clockOffset([]), null],
    [formatDrift(600), "+600 ms"], [formatDrift(-12.4), "−12 ms"], [formatDrift(1_540), "+1.5 s"],
    [formatDrift(null), "–"],
    [formatPosition(3_725_450), "1:02:05.4"], [formatPosition(65_000), "1:05.0"], [formatPosition(-1), "–"],
  ]);
  const source = (sourceId: string, audio: string[] | null, more = {}) =>
    ({ sourceId, label: null, languages: { audio, subtitles: null }, current: false, supported: true, reason: null, ...more });
  const options = candidateOptions([source("hls-multi-audio", ["en", "it"], { label: "Unified", current: true }), source("fr-dub", ["fr"]),
    source("silent", []), source("mystery", null), source("dash", ["de"], { supported: false, reason: "dash" })]);
  assert.deepEqual(options.map((o) => [o.sourceId, o.language, o.disabled, o.label]), [
    ["hls-multi-audio", "en", false, "hls-multi-audio — Unified · English (en) · the TV's source"],
    ["hls-multi-audio", "it", false, "hls-multi-audio — Unified · Italiano (it) · the TV's source"],
    ["fr-dub", null, false, "fr-dub · Français (fr)"], ["silent", null, false, "silent · no dialogue"], ["mystery", null, false, "mystery"],
    ["dash", null, true, "dash · Deutsch (de) · DASH, cannot play on a phone"],
  ]);
  assert.deepEqual(parseCandidate(options[1]!.value), { sourceId: "hls-multi-audio", language: "it" });
  assert.deepEqual(parseCandidate(options[2]!.value), { sourceId: "fr-dub", language: null });
});
