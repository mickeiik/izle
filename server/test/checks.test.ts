// Catalog check runs (`/admin/checks`): what a show, a channel or a TV's Home checks (quick and full), one run at a
// time, cancelling, long-polling its progress, its two events, and the stored summaries in the item and TV answers
// (stale once the catalog changes a source).
import { test } from "node:test";
import assert from "node:assert/strict";
import { syntheticTsSegment } from "../examples/resolver-example/upstream.js";
import { assertNoLeaks, eventually, publishBuild, testServer, untitled, type Json, type TestServer } from "./helpers.ts";

const MEDIA = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\ns0.ts\n#EXT-X-ENDLIST\n";

/** An in-memory upstream where every source works; requests whose URL contains `hold` wait for `release()`. */
function fakeUpstream() {
  let open: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  let hold: string | null = null;
  const asked: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    asked.push(url);
    if (hold !== null && url.includes(hold)) {
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    if (url.includes(".m3u8")) return new Response(MEDIA, { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
    if (url.endsWith(".vtt")) return new Response("WEBVTT\n\n", { status: 200 });
    return new Response(syntheticTsSegment(1), { status: 200, headers: { "Content-Type": "video/mp2t" } });
  };
  return {
    fetch, asked,
    holdOn(part: string) {
      hold = part;
      gate = new Promise((resolve) => (open = resolve));
    },
    release: () => open(),
  };
}

async function setup(t: { after(fn: () => unknown): void }) {
  const up = fakeUpstream();
  const s = await testServer(t, { fetch: up.fetch });
  const tv = await s.pair("Salon");
  const start = (body: Json) => s.admin("POST", "/checks", body);
  const poll = (id: string, seq?: number, waitMs?: number) => s.admin("GET", `/checks/${id}${seq === undefined ? "" : `?seq=${seq}&wait=${waitMs ?? 0}`}`);
  /** Long-polls the run until it ended. */
  const finished = async (id: string): Promise<Json> => {
    for (let seq = 0; ;) {
      const r = (await poll(id, seq, 2000)).json.run;
      if (r.state !== "running") return r;
      seq = r.seq;
    }
  };
  return { s, up, tv, start, poll, finished };
}

const resultsOf = (run: Json) => run.results.map((r: Json) => [r.playableId, r.verdict]).sort();

test("a show, a channel, a TV's Home quick and full: what each checks, what is skipped, and the errors", async (t) => {
  const { s, tv, start, finished } = await setup(t);
  // A Home with an item that left the catalog and a channel that may not play (set as a reload would leave them).
  s.srv.ctx.store.setHome(tv.deviceId, "fixture", untitled(["show", "film", "news", "off-air", "ghost"]), 0);

  const show = await start({ itemId: "show" });
  assert.equal(show.status, 202, JSON.stringify(show.json));
  assert.deepEqual([show.json.run.target, show.json.run.title, show.json.run.state, show.json.run.total], [{ itemId: "show" }, "Şov Dünyası", "running", 4]);
  const showRun = await finished(show.json.run.id);
  // e3 may not play; e4's adapter source has no resolver module here, so e4 works with a warning.
  assert.deepEqual(resultsOf(showRun), [["show.e1", "ok"], ["show.e2", "ok"], ["show.e4", "warn"], ["show.e5", "ok"]]);
  assert.deepEqual([showRun.state, showRun.done, showRun.failed, showRun.warned, showRun.skipped], ["done", 4, 0, 1, []]);
  const e1 = showRun.results.find((r: Json) => r.playableId === "show.e1");
  assert.deepEqual(e1, { playableId: "show.e1", itemId: "show", episodeId: "show.e1", title: "Şov Dünyası", label: "S1 E1 · Pilot", verdict: "ok" });
  assert.match(showRun.finishedAt, /^2026-10-10T12:00/);

  const quick = await finished((await start({ deviceId: tv.deviceId, mode: "quick" })).json.run.id);
  assert.deepEqual([quick.title, quick.target, quick.total], ["Salon", { deviceId: tv.deviceId, mode: "quick" }, 3]);
  assert.deepEqual(resultsOf(quick), [["film.main", "ok"], ["news", "ok"], ["show.e1", "ok"]], "what OK plays on each entry");
  assert.deepEqual(quick.results.find((r: Json) => r.playableId === "news"), { playableId: "news", itemId: "news", episodeId: null, title: "Haber 24", label: null, verdict: "ok" });
  assert.deepEqual(quick.skipped, [{ itemId: "off-air", title: "Off air", reason: "not_playable" }, { itemId: "ghost", title: null, reason: "missing" }]);

  const full = await finished((await start({ deviceId: tv.deviceId, mode: "full" })).json.run.id);
  assert.deepEqual(resultsOf(full).map((r: string[]) => r[0]), ["film.main", "news", "show.e1", "show.e2", "show.e4", "show.e5"], "every allowed episode");

  const errors: Array<[Json, number, string]> = [
    [{ itemId: "off-air" }, 400, "nothing_to_check"],
    [{ itemId: "locked" }, 400, "nothing_to_check"],
    [{ itemId: "ghost" }, 404, "unknown_item"],
    [{ deviceId: "nope", mode: "quick" }, 404, "unknown_device"],
    [{ deviceId: tv.deviceId, mode: "slow" }, 400, "invalid_request"],
    [{ deviceId: tv.deviceId }, 400, "invalid_request"],
    [{ itemId: "show", deviceId: tv.deviceId, mode: "full" }, 400, "invalid_request"],
  ];
  for (const [body, status, error] of errors) {
    const r = await start(body);
    assert.deepEqual([r.status, r.json.error], [status, error], JSON.stringify(body));
  }
  s.srv.ctx.store.setHome(tv.deviceId, "fixture", untitled(["off-air"]), 0);
  assert.deepEqual((await start({ deviceId: tv.deviceId, mode: "full" })).json.error, "nothing_to_check");
  assert.equal((await s.admin("GET", "/checks/current")).json.run.id, full.id, "the last run that ended");
  assert.equal((await s.admin("GET", `/checks/${show.json.run.id}`)).status, 404, "only the last run is kept");
});

test("one run at a time: 409 while one runs, long-poll progress, cancel, and the run's two events", async (t) => {
  const { s, up, start, poll } = await setup(t);
  assert.deepEqual((await s.admin("GET", "/checks/current")).json, { run: null });
  up.holdOn("/unknown/"); // show.e1's first source
  const run = (await start({ itemId: "show" })).json.run;
  const busy = await start({ itemId: "news" });
  assert.deepEqual([busy.status, busy.json.error, busy.json.runId], [409, "check_running", run.id]);
  assert.equal((await s.admin("GET", "/checks/current")).json.run.id, run.id);

  // e2 and then e4 and e5 pass e1, which waits.
  await eventually(() => s.srv.ctx.checks.current()!.done === 3);
  const now = (await poll(run.id)).json.run;
  assert.deepEqual([now.state, now.done, now.total], ["running", 3, 4]);
  const waiting = poll(run.id, now.seq, 5000);
  await new Promise((r) => setTimeout(r, 50));
  const cancelled = await s.admin("DELETE", `/checks/${run.id}`);
  assert.deepEqual([cancelled.status, cancelled.json.run.state, cancelled.json.run.done], [200, "cancelled", 3]);
  const woken = (await waiting).json.run;
  assert.deepEqual([woken.state, woken.seq > now.seq], ["cancelled", true], "the long-poll answers the change");
  up.release();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([(await poll(run.id)).json.run.done, (await s.admin("DELETE", `/checks/${run.id}`)).json.run.state], [3, "cancelled"], "nothing after the cancel");
  assert.equal(s.srv.ctx.store.getSourceChecks("fixture", "show", "show.e1").length, 0, "the cancelled episode's check is not stored");
  assert.equal((await poll("nope")).status, 404);

  const events = (await s.admin("GET", "/events?after=0&types=check.")).json.events;
  assert.deepEqual(events.map((e: Json) => [e.type, e.deviceId, e.actor.type, e.data]), [
    ["check.started", null, "owner", { runId: run.id, total: 4 }],
    ["check.finished", null, "owner", { runId: run.id, total: 4, failed: 0, warned: 1, state: "cancelled" }],
  ]);
  const next = await start({ itemId: "news" });
  assert.equal(next.status, 202, "a new run once the last one ended");
});

test("a Home run's events name the TV; a run still going when the server stops is cancelled", async (t) => {
  const { s, up, tv, start } = await setup(t);
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["film"] });
  up.holdOn("/a/master.m3u8");
  const run = (await start({ deviceId: tv.deviceId, mode: "quick" })).json.run;
  const events = (await s.admin("GET", "/events?after=0&types=check.")).json.events;
  assert.deepEqual(events.map((e: Json) => [e.type, e.deviceId, e.data]), [["check.started", tv.deviceId, { runId: run.id, total: 1 }]]);
  await s.close();
  assert.equal(s.srv.ctx.checks.current()!.state, "cancelled");
});

/** The stored summary of a catalog item's episode (or the channel's). */
async function summaryOf(s: TestServer, itemId: string, episodeId?: string) {
  const item = (await s.admin("GET", `/catalog/items/${itemId}`)).json.item;
  return episodeId ? item.episodes.find((e: Json) => e.id === episodeId).check : item.check;
}

test("summaries: in the item and TV answers, stale once a source changes, gone with the source; the stored reports", async (t) => {
  const { s, tv, start, finished } = await setup(t);
  assert.equal(await summaryOf(s, "film", "film.main"), null, "never checked");
  const d = await s.admin("POST", "/diagnostics/resolve", { episodeId: "film.main" });
  assert.deepEqual([d.json.verdict, d.json.sources.map((x: Json) => x.steps.map((st: Json) => st.what))], ["ok", [["playlist", "segment", "subtitle"], ["playlist", "segment"]]]);
  const at = "2026-10-10T12:00:00.000Z";
  assert.deepEqual(await summaryOf(s, "film", "film.main"), { verdict: "ok", checkedAt: at, working: 2, total: 2, stale: false });

  await finished((await start({ itemId: "news" })).json.run.id);
  assert.deepEqual(await summaryOf(s, "news"), { verdict: "ok", checkedAt: at, working: 3, total: 3, stale: false });
  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["show", "news", "film"] });
  await finished((await start({ itemId: "show" })).json.run.id);
  const home = (await s.admin("GET", `/devices/${tv.deviceId}`)).json.home;
  assert.deepEqual(home.map((e: Json) => [e.itemId, e.check?.verdict ?? null]), [["show", "ok"], ["news", "ok"], ["film", "ok"]]);
  assert.deepEqual(home[0].checkAll, { verdict: "warn", checked: 4, total: 4, failed: 0, warned: 1, oldestCheckedAt: at });
  assert.deepEqual([home[1].checkAll, home[2].checkAll], [null, { verdict: "ok", checked: 1, total: 1, failed: 0, warned: 0, oldestCheckedAt: at }]);

  // A new build changes film's source "b": it reads as not checked; "a" still counts.
  s.clock.advance(60_000);
  const changeB = (items: Json[]) => items.map((i) => (i.id !== "film" ? i : {
    ...i, episodes: [{ ...i.episodes[0], sources: [i.episodes[0].sources[0], { ...i.episodes[0].sources[1], media: { kind: "hls", url: "https://media.example.test/b2/master.m3u8" } }] }],
  }));
  await publishBuild(s.bundleDir, "fixture-2", changeB);
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 200);
  assert.deepEqual(await summaryOf(s, "film", "film.main"), { verdict: "ok", checkedAt: at, working: 1, total: 2, stale: true });
  const stored = (await s.admin("GET", "/checks/playables/film.main")).json;
  assert.deepEqual([stored.itemId, stored.episodeId, stored.check.stale], ["film", "film.main", true]);
  assert.deepEqual(stored.sources.map((x: Json) => [x.sourceId, x.verdict, x.checkedAt, x.stale, x.steps.length]), [["a", "ok", at, false, 3], ["b", "ok", at, true, 2]]);
  assert.deepEqual((await s.admin("GET", "/checks/playables/news")).json.sources.map((x: Json) => x.sourceId), ["hls", "ts", "en"], "a channel by its item id");
  const lookups: Array<[string, number, string]> = [["ghost", 404, "unknown_item"], ["show", 400, "has_episodes"]];
  for (const [id, status, error] of lookups) assert.deepEqual([(await s.admin("GET", `/checks/playables/${id}`)).status, (await s.admin("GET", `/checks/playables/${id}`)).json.error], [status, error]);

  // Checked again, the summary is the newest; a film whose sources all left reads as not checked, its rows purged.
  await s.admin("POST", "/diagnostics/resolve", { episodeId: "film.main", sourceId: "b" });
  assert.deepEqual(await summaryOf(s, "film", "film.main"), { verdict: "ok", checkedAt: at, working: 2, total: 2, stale: false }, "the oldest of the current rows");
  await publishBuild(s.bundleDir, "fixture-3", (items) => changeB(items).filter((i) => i.id !== "news"));
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 200);
  const before = s.srv.ctx.store.sourceCheckKeys().length;
  s.srv.ctx.checker.purge();
  const after = s.srv.ctx.store.sourceCheckKeys();
  assert.deepEqual([before - after.length, after.some((k) => k.itemId === "news")], [3, false], "the channel's three rows");
  assertNoLeaks(s, stored, ["https://", "media.example.test/", "master.m3u8", "s0.ts"]);
});
