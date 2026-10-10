import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  continueText,
  episodeName,
  episodeStates,
  errorMessage,
  formatClock,
  formatCode,
  formatCountdown,
  formatRelative,
  isActive,
  languageLabel,
  moveItem,
  percent,
  plural,
  triedText,
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
  for (const [file, type] of [
    ["app.js", "text/javascript; charset=utf-8"],
    ["lib.js", "text/javascript; charset=utf-8"],
    ["style.css", "text/css; charset=utf-8"],
    ["icon.svg", "image/svg+xml"],
  ]) {
    const res = await fetch(`${s.base}/admin/${file}`);
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get("content-type"), type);
    assert.equal(await res.text(), await readFile(new URL(`../admin/${file}`, import.meta.url), "utf8"));
  }
  for (const bad of ["tsconfig.json", "index.html", "..%2Fpackage.json", "%2e%2e/src/app.ts", "constructor", "toString"]) {
    assert.equal((await fetch(`${s.base}/admin/${bad}`)).status, 404, bad);
  }
  const js = await readFile(new URL("../admin/app.js", import.meta.url), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), "server text is never parsed as HTML");
});
