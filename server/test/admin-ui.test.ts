import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  candidateOptions,
  clockOffset,
  companionTarget,
  continueText,
  episodeName,
  episodeStates,
  errorMessage,
  formatClock,
  formatCode,
  formatCountdown,
  formatDrift,
  formatPosition,
  formatRelative,
  isActive,
  languageLabel,
  moveItem,
  parseCandidate,
  percent,
  plural,
  pushSample,
  serverAddress,
  syncDecision,
  tokenFromHash,
  triedText,
  tvPositionAt,
} from "../admin/lib.js";
import { startTestServer } from "./helpers.ts";

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
  const c = { season: 1, number: 2, title: "Two", label: null, index: 1, count: 3, durationMs: 600_000 };
  assert.equal(continueText({ ...c, status: "new", positionMs: 0 }, "series"), "S1 · E2 — Two · new");
  assert.equal(continueText({ ...c, status: "watching", positionMs: 90_000 }, "series"), "S1 · E2 — Two · continues at 1:30 of 10:00");
  assert.equal(continueText({ ...c, status: "watching", positionMs: 17_000 }, "movie"), "starts from the beginning", "the TV resumes from 30 s on");
  assert.equal(continueText({ ...c, status: "finished", positionMs: 0 }, "movie"), "watched — starts over");
  assert.equal(continueText(null, "movie"), "Nothing playable");
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
  for (const [file, type] of [
    ["app.js", "text/javascript; charset=utf-8"],
    ["lib.js", "text/javascript; charset=utf-8"],
    ["companion.js", "text/javascript; charset=utf-8"],
    ["style.css", "text/css; charset=utf-8"],
    ["icon.svg", "image/svg+xml"],
    ["vendor/hls.min.js", "text/javascript; charset=utf-8"],
  ]) {
    const res = await fetch(`${s.base}/admin/${file}`);
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get("content-type"), type);
    assert.equal(await res.text(), await readFile(new URL(`../admin/${file}`, import.meta.url), "utf8"));
  }
  for (const bad of ["tsconfig.json", "index.html", "..%2Fpackage.json", "%2e%2e/src/app.ts", "constructor", "toString", "vendor/README.md", "vendor/LICENSE-hls.js", "vendor/..%2Fapp.js"]) {
    assert.equal((await fetch(`${s.base}/admin/${bad}`)).status, 404, bad);
  }
  for (const file of ["app.js", "companion.js"]) {
    const js = await readFile(new URL(`../admin/${file}`, import.meta.url), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), `${file}: server text is never parsed as HTML`);
  }
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
