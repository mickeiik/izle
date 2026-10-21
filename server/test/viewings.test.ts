// The viewing history: the lifecycle of a viewing (start, continue, replace, stop, finish, lost, drop), watched
// time and played ranges, the titles, episodes and day counts, marks, deletions, scopes, and the log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, fixtureItems, fixtureManifest, openEvents, publishBuild, startTestServer, writeBundle, type Json, type TestServer, type TestServerOptions } from "./helpers.ts";

const MIN = 60_000;
const RUN = "Zq3v9Kx2LmN8pQ4rT6uW1yA5bC7dE0fGhIjKlMnO"; // gitleaks:allow (made-up hostile fixture)

async function setup(t: { after(fn: () => unknown): void }, opts: TestServerOptions = {}, name = "Salon") {
  const s = await startTestServer(opts);
  t.after(() => s.close());
  const h = helpers(s, await s.pair(name));
  return { s, ...h };
}

function helpers(s: TestServer, tv: { deviceId: string; token: string }) {
  const as = (method: string, route: string, body?: unknown) => s.call(method, `/api/v1/tv${route}`, { token: tv.token, body });
  return {
    tv, as,
    resolve: (episodeId: string, extra: Json = {}) => as("POST", "/resolve", { episodeId, ...extra }),
    report: (episodeId: string, status: string, positionMs: number, extra: Json = {}) => as("POST", "/progress", { episodeId, positionMs, status, ...extra }),
    /** The TV's running viewing (as stored), or null. */
    running: () => s.srv.ctx.playing.running(tv.deviceId),
  };
}

const viewings = async (s: TestServer, query = "") => (await s.admin("GET", `/history/viewings${query}`)).json;
const viewing = async (s: TestServer, id: number) => (await s.admin("GET", `/history/viewings/${id}`)).json;
const events = async (s: TestServer, types: string, after = 0) => (await s.admin("GET", `/events?after=${after}&limit=500&types=${types}`)).json.events as Json[];
const ended = (v: Json) => ({ endReason: v.endReason, seen: v.seen, watchedMs: v.watchedMs, startPositionMs: v.startPositionMs, endPositionMs: v.endPositionMs, endedAt: v.endedAt });
const at = (s: TestServer) => new Date(s.clock.now()).toISOString();

test("lifecycle: how a viewing ends, by stop, finish, replace, silence and the owner's rules", async (t) => {
  type H = Awaited<ReturnType<typeof setup>>;
  const rows: Array<{ name: string; online?: boolean; run: (h: H) => Promise<Json>; expect: Json | "dropped" | "running" }> = [
    {
      name: "stopped",
      run: async ({ s, resolve, report }) => {
        await resolve("show.e1");
        await report("show.e1", "playing", 0);
        s.clock.advance(30_000);
        await report("show.e1", "playing", 30_000);
        s.clock.advance(30_000);
        await report("show.e1", "stopped", 60_000);
        return { endedAt: at(s) };
      },
      expect: { endReason: "stopped", seen: false, watchedMs: 60_000, startPositionMs: 0, endPositionMs: 60_000 },
    },
    {
      name: "finished: the end position is the duration",
      run: async ({ s, resolve, report }) => {
        await resolve("show.e1");
        await report("show.e1", "playing", 1_000_000, { durationMs: 1_200_000 });
        s.clock.advance(20_000);
        await report("show.e1", "finished", 1_019_000, { durationMs: 1_200_000 });
        return { endedAt: at(s) };
      },
      expect: { endReason: "finished", seen: true, watchedMs: 20_000, startPositionMs: 1_000_000, endPositionMs: 1_200_000 },
    },
    {
      name: "replaced by a resolve of another episode",
      run: async ({ s, resolve, report }) => {
        await resolve("show.e1");
        await report("show.e1", "playing", 0);
        s.clock.advance(30_000);
        await report("show.e1", "playing", 30_000);
        s.clock.advance(15_000);
        await resolve("show.e2");
        return { endedAt: at(s) };
      },
      expect: { endReason: "replaced", seen: false, watchedMs: 30_000, startPositionMs: 0, endPositionMs: 30_000 },
    },
    {
      name: "a re-resolve of the same episode continues it (the source may change), then a stop",
      run: async ({ s, resolve, report, running }) => {
        const first = (await resolve("show.e1")).json;
        await report("show.e1", "playing", 0);
        const before = running()!;
        s.clock.advance(30_000);
        const again = (await resolve("show.e1", { sourceId: "multi", exclude: [first.sourceId] })).json;
        assert.equal(again.sourceId, "multi");
        assert.deepEqual([running()!.id, running()!.sourceId], [before.id, "multi"]);
        await report("show.e1", "stopped", 30_000);
        return { endedAt: at(s) };
      },
      expect: { endReason: "stopped", seen: false, watchedMs: 30_000, startPositionMs: 0, endPositionMs: 30_000 },
    },
    {
      name: "lost while playing: ends at its last report",
      online: true,
      run: async ({ s, resolve, report }) => {
        await resolve("show.e1");
        await report("show.e1", "playing", 0);
        s.clock.advance(MIN);
        await report("show.e1", "playing", MIN);
        const endedAt = at(s);
        s.clock.advance(2 * MIN - 1);
        s.srv.ctx.playing.sweep();
        assert.equal((await viewings(s)).viewings[0].endReason, null, "not yet");
        s.clock.advance(1);
        s.srv.ctx.playing.sweep();
        return { endedAt };
      },
      expect: { endReason: "lost", seen: false, watchedMs: MIN, startPositionMs: 0, endPositionMs: MIN },
    },
    {
      name: "lost before any report: nothing watched, so it is dropped",
      run: async ({ s, resolve }) => {
        await resolve("show.e1");
        s.clock.advance(2 * MIN);
        s.srv.ctx.playing.sweep();
        return {};
      },
      expect: "dropped",
    },
    {
      name: "paused and online: survives 10 minutes of silence",
      online: true,
      run: async ({ s, resolve, report }) => {
        await resolve("show.e1");
        await report("show.e1", "playing", 0);
        s.clock.advance(30_000);
        await report("show.e1", "paused", 30_000);
        s.clock.advance(10 * MIN);
        s.srv.ctx.playing.sweep();
        return {};
      },
      expect: "running",
    },
    {
      name: "paused but offline for 2 minutes: lost",
      run: async ({ s, resolve, report }) => {
        await resolve("show.e1");
        await report("show.e1", "playing", 0);
        s.clock.advance(30_000);
        await report("show.e1", "paused", 30_000);
        const endedAt = at(s);
        s.clock.advance(2 * MIN);
        s.srv.ctx.playing.sweep();
        return { endedAt };
      },
      expect: { endReason: "lost", seen: false, watchedMs: 30_000, startPositionMs: 0, endPositionMs: 30_000 },
    },
    {
      name: "a mis-press: under 10 s watched and not seen is dropped",
      run: async ({ s, resolve, report }) => {
        await resolve("show.e1");
        await report("show.e1", "playing", 0);
        s.clock.advance(5_000);
        await report("show.e1", "stopped", 5_000);
        return {};
      },
      expect: "dropped",
    },
    {
      name: "seen at 90 % without a finished report",
      run: async ({ s, resolve, report }) => {
        await resolve("show.e1");
        await report("show.e1", "playing", 1_070_000);
        s.clock.advance(15_000);
        await report("show.e1", "stopped", 1_085_000);
        return { endedAt: at(s) };
      },
      expect: { endReason: "stopped", seen: true, watchedMs: 15_000, startPositionMs: 1_070_000, endPositionMs: 1_085_000 },
    },
  ];
  for (const row of rows) {
    const h = await setup(t);
    if (row.online) {
      const es = await openEvents(h.s.base, h.tv.token);
      t.after(() => es.close());
      await es.next();
    }
    const started = (await events(h.s, "playback.started")).length;
    const extra = await row.run(h);
    const started2 = await events(h.s, "playback.started");
    const first = started2[started]!;
    const ends = (await events(h.s, "playback.ended")).filter((e) => e.data.viewingId === first.data.viewingId);
    const stored = (await viewing(h.s, first.data.viewingId)).viewing;
    if (row.expect === "running") {
      assert.deepEqual([ends.length, stored.endReason, stored.endedAt], [0, null, null], row.name);
      assert.equal(h.running()!.id, first.data.viewingId, row.name);
    } else if (row.expect === "dropped") {
      assert.equal(ends.length, 1, row.name);
      assert.equal(ends[0].data.dropped, true, row.name);
      assert.equal((await h.s.admin("GET", `/history/viewings/${first.data.viewingId}`)).status, 404, `${row.name}: its id is gone`);
      assert.equal(h.running(), null, row.name);
    } else {
      assert.deepEqual(ended(stored), { ...row.expect, ...extra }, row.name);
      assert.equal(ends.length, 1, row.name);
      assert.deepEqual(ends[0].data, { viewingId: first.data.viewingId, endReason: row.expect.endReason, seen: row.expect.seen, positionMs: row.expect.endPositionMs, watchedMs: row.expect.watchedMs, dropped: false }, row.name);
      assert.equal(ends[0].actor.type, row.expect.endReason === "lost" ? "server" : "tv", row.name);
      // Once ended, a report or a resolve never reopens it.
      await h.report("show.e1", "playing", 70_000);
      assert.equal((await viewing(h.s, first.data.viewingId)).viewing.endReason, row.expect.endReason, row.name);
    }
  }
});

test("watched time, played ranges, seeks, stalls and pauses, with their events and the covered fraction", async (t) => {
  const { s, resolve, report } = await setup(t);
  const step = async (ms: number, status: string, positionMs: number, extra: Json = {}) => {
    s.clock.advance(ms);
    assert.equal((await report("film.main", status, positionMs, extra)).status, 200);
  };
  await resolve("film.main");
  await report("film.main", "playing", 0, { durationMs: 5_400_000 });
  await step(15_000, "playing", 15_000);
  await step(15_000, "playing", 30_000, { playing: false }); // a stall
  await step(10_000, "playing", 30_000); // recovered where it was
  await step(15_000, "playing", 45_000);
  await step(5_000, "playing", 300_000); // a seek: playback should be at 50 s
  await step(15_000, "playing", 315_000);
  await step(15_000, "paused", 330_000, { ageMs: 5_000 }); // sampled 5 s before it was sent
  await step(5 * MIN, "paused", 330_000); // a second paused report (no event, nothing watched)
  await step(10_000, "playing", 330_000); // resumed
  await step(90_000, "playing", 420_000); // a late report: at most 60 s count
  await step(15_000, "stopped", 435_000);
  const id = (await events(s, "playback.started"))[0].data.viewingId;
  const { viewing: v, ranges } = await viewing(s, id);
  assert.deepEqual(ended(v), { endReason: "stopped", seen: false, watchedMs: 150_000, startPositionMs: 0, endPositionMs: 435_000, endedAt: at(s) });
  assert.equal(v.durationMs, 5_400_000);
  assert.deepEqual(ranges, [[0, 45_000], [300_000, 435_000]]);
  const seq = (await events(s, "playback.")).map((e: Json) => [e.type, e.data.positionMs ?? e.data.toMs]);
  assert.deepEqual(seq, [
    ["playback.started", 0], ["playback.stalled", 30_000], ["playback.recovered", 30_000], ["playback.seeked", 300_000], ["playback.paused", 330_000],
    ["playback.resumed", 330_000], ["playback.ended", 435_000],
  ]);
  const seeked = (await events(s, "playback.seeked"))[0];
  assert.deepEqual(seeked.data, { viewingId: id, fromMs: 50_000, toMs: 300_000 });
  const film = (await s.admin("GET", "/history/titles/film")).json;
  assert.equal(film.episodes[0].coveredFraction, 0.03, "180 s of 5400 s, two decimals");
  assert.deepEqual([film.title.status, film.title.episodes, film.title.shortViewings], ["watching", { total: 1, seen: 0, started: 1 }, 1]);
});

test("titles and episodes: seen by viewing or mark (a mark wins), imported viewings, status and sort", async (t) => {
  const { s, resolve, report } = await setup(t);
  const store = s.srv.ctx.store;
  /** Plays from `from` to `to` with a report every 15 s (the TV's cadence), then the final report. */
  const play = async (episodeId: string, status: string, from: number, to: number, durationMs?: number) => {
    await resolve(episodeId);
    for (let p = from; p < to; p += 15_000) {
      await report(episodeId, "playing", p, { durationMs });
      s.clock.advance(Math.min(15_000, to - p));
    }
    await report(episodeId, status, to, { durationMs });
    s.clock.advance(1_000);
  };
  await play("show.e1", "finished", 0, 1_200_000);
  const e1SeenAt = new Date(s.clock.now() - 1_000).toISOString();
  await play("show.e2", "stopped", 0, 30_000);
  await play("film.main", "stopped", 0, 2_700_000, 5_400_000);
  // Imported at the upgrade: a saved position of a TV that is long gone, with no ranges and no watched time.
  const imported = { catalogId: "fixture", itemKind: "movie", itemTitle: "Silent", episodeTitle: null, season: null, number: null, sourceId: null, startPositionMs: null, watchedMs: null, commandId: null, imported: true, trigger: "unknown" as const, lastReportAt: null, lastPositionMs: null, lastPlaying: false, lastAnchorAt: null, lastState: null };
  const old = Date.parse("2026-09-01T20:00:00Z");
  store.insertViewing({ ...imported, deviceId: "oldtv0000001", deviceName: "Old TV", itemId: "silent", episodeId: "silent.main", startedAt: old, endedAt: old, endPositionMs: 3_000_000, durationMs: 3_000_000, endReason: "finished", seen: true, actor: { type: "tv", deviceId: "oldtv0000001" } });
  // A mark on an episode nobody watched, and one that says the finished episode was not seen after all.
  s.clock.advance(1_000);
  assert.deepEqual((await s.admin("POST", "/history/marks", { episodeIds: ["show.e4", "show.e1"], seen: false })).json, { updated: 2 });

  let titles = (await s.admin("GET", "/history/titles")).json.titles;
  assert.deepEqual(titles.map((x: Json) => [x.itemId, x.status, x.inCatalog, x.episodes]), [
    ["film", "watching", true, { total: 1, seen: 0, started: 1 }],
    ["show", "watching", true, { total: 4, seen: 0, started: 2 }],
    ["silent", "finished", true, { total: 1, seen: 1, started: 1 }],
  ], "recent first; show.e1 is not seen while the mark says so");
  const show = titles[1];
  assert.deepEqual([show.title, show.kind, show.viewings, show.watchedMs, show.rewatches, show.shortViewings], ["Şov Dünyası", "series", 2, 1_230_000, 0, 1]);
  assert.deepEqual(show.seasons, [{ season: 1, total: 2, seen: 0, started: 2 }, { season: 2, total: 2, seen: 0, started: 0 }]);
  assert.equal(show.firstWatchedAt, "2026-10-10T12:00:00.000Z");
  assert.deepEqual(titles[2].watchedMs, 0, "imported viewings have no watched time");

  let detail = (await s.admin("GET", "/history/titles/show")).json;
  assert.deepEqual(detail.episodes.map((e: Json) => [e.episodeId, e.seen, e.mark, e.seenAt, e.viewings, e.coveredFraction, e.lastPositionMs]), [
    ["show.e1", false, false, null, 1, 1, 1_200_000],
    ["show.e2", false, null, null, 1, null, 30_000],
    ["show.e3", false, null, null, 0, null, null],
    ["show.e4", false, false, null, 0, null, null],
    ["show.e5", false, null, null, 0, null, null],
  ], "play order, every catalog episode; show.e2 has no duration");
  // Removing the marks: the viewing's word again; a true mark gives a seenAt of its own.
  assert.deepEqual((await s.admin("POST", "/history/marks", { episodeIds: ["show.e4", "show.e1"], seen: null })).json, { updated: 2 });
  assert.deepEqual((await s.admin("POST", "/history/marks", { episodeIds: ["show.e2"], seen: true })).json, { updated: 1 });
  detail = (await s.admin("GET", "/history/titles/show")).json;
  assert.deepEqual(detail.episodes.slice(0, 2).map((e: Json) => [e.episodeId, e.seen, e.mark, e.seenAt]), [["show.e1", true, null, e1SeenAt], ["show.e2", true, true, at(s)]]);
  assert.deepEqual(detail.title.episodes, { total: 4, seen: 2, started: 2 });
  assert.deepEqual((await events(s, "history.changed")).map((e: Json) => [e.actor.type, e.data]), [
    ["owner", { episodeIds: ["show.e4", "show.e1"], seen: false }], ["owner", { episodeIds: ["show.e4", "show.e1"], seen: null }], ["owner", { episodeIds: ["show.e2"], seen: true }],
  ]);
  const silent = (await s.admin("GET", "/history/titles/silent")).json;
  assert.deepEqual([silent.episodes[0].coveredFraction, silent.episodes[0].seenAt, silent.episodes[0].lastPositionMs], [null, "2026-09-01T20:00:00.000Z", 3_000_000], "only imported viewings: no covered fraction");

  // The marks need an episode the catalog or the history knows; `device` narrows the counts, not seen.
  const bad = await s.admin("POST", "/history/marks", { episodeIds: ["show.e5", "nope"], seen: true });
  assert.deepEqual([bad.status, bad.json.error, bad.json.episodeId], [400, "unknown_episode", "nope"]);
  assert.equal((await s.admin("POST", "/history/marks", { episodeIds: [], seen: true })).status, 400);
  const other = (await s.admin("GET", "/history/titles?device=oldtv0000001")).json.titles;
  assert.deepEqual(other.map((x: Json) => [x.itemId, x.viewings, x.episodes.seen]), [["silent", 1, 1], ["show", 0, 2]], "the marked show stays listed, without that TV's viewings");

  // Sorting and status filters; a show whose remaining episodes all came with a later build has new episodes.
  const sorted = async (q: string) => (await s.admin("GET", `/history/titles?${q}`)).json.titles.map((x: Json) => x.itemId);
  assert.deepEqual(await sorted("sort=title"), ["film", "silent", "show"]);
  assert.deepEqual(await sorted("sort=watched"), ["film", "show", "silent"]);
  assert.deepEqual(await sorted("status=finished,watching&sort=title"), ["film", "silent", "show"]);
  assert.deepEqual(await sorted("status=finished"), ["silent"]);
  assert.deepEqual(await sorted("status=idle&limit=1"), []);
  assert.equal((await s.admin("GET", "/history/titles?status=done")).status, 400);
  assert.equal((await s.admin("GET", "/history/titles?sort=recent,title")).status, 400);
  await s.admin("POST", "/history/marks", { episodeIds: ["show.e4", "show.e5"], seen: true });
  assert.deepEqual(await sorted("status=finished&sort=title"), ["silent", "show"]);
  s.clock.advance(MIN);
  const items = fixtureItems();
  items.items[0].episodes.push({ ...items.items[0].episodes[4], id: "show.e6", season: 3, number: 1 });
  await writeBundle(s.bundleDir, { ...fixtureManifest(), buildId: "fixture-2" }, items);
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 200);
  assert.deepEqual(await sorted("status=new_episodes"), ["show"]);
  s.clock.advance(31 * 24 * 60 * MIN);
  assert.deepEqual(await sorted("status=idle"), ["film"], "nothing watched for 30 days");
  assert.deepEqual(await sorted("status=new_episodes"), ["show"], "new episodes are not idle");
  assert.equal((await s.admin("GET", "/history/titles/nope")).status, 404);
});

test("days: a viewing counts on the day it started in the zone asked for; invalid zones and spans", async (t) => {
  const { s, resolve, report } = await setup(t);
  const watch = async (episodeId: string, ms: number) => {
    await resolve(episodeId);
    await report(episodeId, "playing", 0);
    s.clock.advance(ms);
    await report(episodeId, "stopped", ms);
  };
  await watch("show.e1", 30_000); // 2026-10-10 12:00Z
  s.clock.advance(9 * 60 * MIN);
  await watch("film.main", 45_000); // 21:30Z: already 2026-10-11 in Istanbul
  await watch("show.e2", 15_000);
  const days = async (q: string) => (await s.admin("GET", `/history/days${q}`)).json.days;
  assert.deepEqual(await days("?tz=Europe/Istanbul"), [
    { date: "2026-10-10", watchedMs: 30_000, viewings: 1, items: [{ itemId: "show", title: "Şov Dünyası", watchedMs: 30_000 }] },
    { date: "2026-10-11", watchedMs: 60_000, viewings: 2, items: [{ itemId: "film", title: "Film", watchedMs: 45_000 }, { itemId: "show", title: "Şov Dünyası", watchedMs: 15_000 }] },
  ]);
  assert.deepEqual((await days("?tz=UTC")).map((d: Json) => [d.date, d.viewings]), [["2026-10-10", 3]]);
  assert.deepEqual((await days("?tz=Europe/Istanbul&from=2026-10-11&to=2026-10-11")).map((d: Json) => d.date), ["2026-10-11"]);
  assert.deepEqual((await days("?tz=UTC&from=2026-09-01&to=2026-10-09")), []);
  assert.equal((await days("")).length > 0, true, "the server's zone by default");
  for (const bad of ["?tz=Mars/Olympus", "?from=2026-13-01", "?from=2026-10-11&to=2026-10-10", "?from=2025-01-01&to=2026-10-10", "?device=no!"]) {
    assert.equal((await s.admin("GET", `/history/days${bad}`)).status, 400, bad);
  }
});

test("viewings: filters and paging, newest first; they outlive the TV and the catalog", async (t) => {
  const { s, resolve, report, tv } = await setup(t);
  const kitchen = helpers(s, await s.pair("Mutfak"));
  const watch = async (h: { resolve: typeof resolve; report: typeof report }, episodeId: string) => {
    await h.resolve(episodeId);
    await h.report(episodeId, "playing", 0);
    s.clock.advance(20_000);
    await h.report(episodeId, "stopped", 20_000);
    s.clock.advance(MIN);
  };
  await watch({ resolve, report }, "show.e1");
  await watch(kitchen, "film.main");
  await watch({ resolve, report }, "show.e2");
  await watch(kitchen, "show.e1");
  await resolve("film.main"); // running
  const ids = (list: Json) => list.viewings.map((v: Json) => v.episodeId);
  const all = await viewings(s);
  assert.deepEqual(ids(all), ["film.main", "show.e1", "show.e2", "film.main", "show.e1"]);
  assert.equal(all.next, null);
  const runningOne = all.viewings[0];
  assert.deepEqual([runningOne.endedAt, runningOne.endReason, runningOne.seen, runningOne.deviceName, runningOne.trigger, runningOne.actor, runningOne.commandId, runningOne.imported],
    [null, null, false, "Salon", "unknown", { type: "tv", deviceId: tv.deviceId }, null, false]);
  const page1 = await viewings(s, "?limit=2");
  assert.deepEqual([ids(page1), page1.next], [["film.main", "show.e1"], page1.viewings[1].id]);
  const page2 = await viewings(s, `?limit=2&before=${page1.next}`);
  assert.deepEqual([ids(page2), page2.next], [["show.e2", "film.main"], page2.viewings[1].id]);
  const page3 = await viewings(s, `?limit=2&before=${page2.next}`);
  assert.deepEqual([ids(page3), page3.next], [["show.e1"], null]);
  assert.deepEqual(ids(await viewings(s, `?device=${kitchen.tv.deviceId}`)), ["show.e1", "film.main"]);
  assert.deepEqual(ids(await viewings(s, "?item=show")), ["show.e1", "show.e2", "show.e1"]);
  assert.deepEqual(ids(await viewings(s, "?episode=film.main")), ["film.main", "film.main"]);
  assert.deepEqual(ids(await viewings(s, "?from=2026-10-10T12:01:00Z&to=2026-10-10T12:02:40Z")), ["show.e2", "film.main"], "from/to bound startedAt, inclusive");
  for (const bad of ["?device=x!", "?item=x!", "?from=yesterday", "?before=0", "?before=abc"]) assert.equal((await s.admin("GET", `/history/viewings${bad}`)).status, 400, bad);
  assert.equal((await s.admin("GET", "/history/viewings/999")).status, 404);
  assert.equal((await s.admin("GET", "/history/viewings/abc")).status, 404);

  await s.admin("DELETE", `/devices/${kitchen.tv.deviceId}`);
  const kept = await viewings(s, `?device=${kitchen.tv.deviceId}`);
  assert.deepEqual(kept.viewings.map((v: Json) => [v.episodeId, v.deviceName]), [["show.e1", "Mutfak"], ["film.main", "Mutfak"]], "deleting the TV keeps its viewings");
  await publishBuild(s.bundleDir, "fixture-2", (items) => items.filter((i) => i.id !== "film"));
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 200);
  assert.deepEqual((await viewings(s, "?item=film")).viewings.map((v: Json) => v.itemTitle), ["Film", "Film"], "the titles were copied at the start");
  const film = (await s.admin("GET", "/history/titles/film")).json;
  assert.deepEqual([film.title.inCatalog, film.title.title, film.title.kind, film.title.episodes, film.title.status], [false, "Film", "movie", { total: 1, seen: 0, started: 1 }, "watching"]);
  assert.deepEqual(film.episodes.map((e: Json) => [e.episodeId, e.inCatalog, e.viewings]), [["film.main", false, 2]]);
});

test("events: ended before started on a replace, episode.seen after its ended; the trigger, command and actor behind a viewing", async (t) => {
  const { s, resolve, report, tv } = await setup(t);
  const agent = (await s.admin("POST", "/tokens", { name: "agent", scope: "control" })).json;
  await resolve("show.e1");
  await report("show.e1", "playing", 1_170_000, { durationMs: 1_200_000 });
  s.clock.advance(15_000);
  const cmd = (await s.call("POST", `/api/v1/admin/devices/${tv.deviceId}/commands`, { token: agent.secret, body: { type: "play", episodeId: "show.e2" } })).json;
  await resolve("show.e2", { trigger: "command", commandId: cmd.id });
  const seq = (await events(s, "playback.,episode.")).map((e: Json) => [e.type, e.data.viewingId, e.actor.type]);
  const [first, second] = [seq[0][1], seq[3][1]];
  assert.deepEqual(seq, [["playback.started", first, "tv"], ["playback.ended", first, "token"], ["episode.seen", first, "token"], ["playback.started", second, "token"]]);
  const seen = (await events(s, "episode.seen"))[0];
  assert.deepEqual(seen.data, { viewingId: first, itemId: "show", episodeId: "show.e1", firstTime: true, itemFinished: false });
  const started = (await events(s, "playback.started"))[1];
  assert.deepEqual(started.data, {
    viewingId: second, itemId: "show", itemKind: "series", itemTitle: "Şov Dünyası", episodeId: "show.e2", episodeTitle: "Season finale", season: 1, number: 2,
    sourceId: "main", positionMs: 0, trigger: "command",
  });
  const v = (await viewing(s, second)).viewing;
  assert.deepEqual([v.trigger, v.commandId, v.actor], ["command", cmd.id, { type: "token", tokenId: agent.token.id, name: "agent" }]);

  // A commandId that is not this TV's play/next/previous command is ignored; other triggers are the TV's doing.
  const keep = async (episodeId: string) => {
    await report(episodeId, "playing", 0);
    s.clock.advance(15_000);
    await report(episodeId, "playing", 15_000);
  };
  await keep("show.e2");
  const pause = (await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "pause" })).json;
  await resolve("show.e4", { trigger: "command", commandId: pause.id });
  await keep("show.e4");
  await resolve("show.e5", { trigger: "next" });
  const [e4, e5] = (await viewings(s, "?limit=2")).viewings.reverse();
  assert.deepEqual([e4.trigger, e4.commandId, e4.actor, e5.trigger, e5.commandId, e5.actor], ["command", null, { type: "tv", deviceId: tv.deviceId }, "next", null, { type: "tv", deviceId: tv.deviceId }]);
  for (const bad of [{ trigger: "remote" }, { commandId: 0 }, { trigger: "command", commandId: "1" }]) assert.equal((await resolve("show.e5", bad)).status, 400, JSON.stringify(bad));

  // The second TV seeing the episode is not a first time; a mark counts as seen before too; the item is finished once every playable episode is.
  const kitchen = helpers(s, await s.pair("Mutfak"));
  await s.admin("POST", "/history/marks", { episodeIds: ["show.e2", "show.e4"], seen: true });
  await kitchen.resolve("show.e1");
  await kitchen.report("show.e1", "playing", 0, { durationMs: 1_200_000 });
  s.clock.advance(15_000);
  await kitchen.report("show.e1", "finished", 1_200_000, { durationMs: 1_200_000 });
  await kitchen.resolve("show.e5");
  await kitchen.report("show.e5", "playing", 0, { durationMs: 1_000 });
  s.clock.advance(15_000);
  await kitchen.report("show.e5", "finished", 1_000, { durationMs: 1_000 });
  const seenEvents = (await events(s, "episode.seen")).map((e: Json) => [e.data.episodeId, e.data.firstTime, e.data.itemFinished]);
  assert.deepEqual(seenEvents, [["show.e1", true, false], ["show.e1", false, false], ["show.e5", true, true]]);

  // Status and now: nowPlaying carries the running viewing's id, and goes once it ended.
  await kitchen.resolve("film.main");
  const running = s.srv.ctx.playing.running(kitchen.tv.deviceId)!;
  const st = (await s.admin("GET", "/status")).json.devices.find((d: Json) => d.id === kitchen.tv.deviceId);
  assert.deepEqual([st.nowPlaying.episodeId, st.nowPlaying.viewingId], ["film.main", running.id]);
  assert.equal((await s.admin("GET", `/devices/${kitchen.tv.deviceId}/now`)).json.nowPlaying.viewingId, running.id);
  await kitchen.report("film.main", "stopped", 0);
  assert.equal((await s.admin("GET", "/status")).json.devices.find((d: Json) => d.id === kitchen.tv.deviceId).nowPlaying, null);
  assert.equal((await s.admin("GET", `/devices/${kitchen.tv.deviceId}/now`)).json.nowPlaying.viewingId, null);
});

test("deletions: one viewing, a TV's, older than a date, everything; a deleted running viewing stays gone", async (t) => {
  const { s, resolve, report, tv } = await setup(t);
  const kitchen = helpers(s, await s.pair("Mutfak"));
  const watch = async (h: { resolve: typeof resolve; report: typeof report }, episodeId: string) => {
    await h.resolve(episodeId);
    await h.report(episodeId, "playing", 0);
    s.clock.advance(20_000);
    await h.report(episodeId, "stopped", 20_000);
    s.clock.advance(MIN);
  };
  await watch({ resolve, report }, "show.e1");
  await watch(kitchen, "show.e1");
  const cut = at(s);
  await watch({ resolve, report }, "show.e2");
  await watch(kitchen, "show.e2");
  await resolve("film.main");
  const count = async (q = "") => (await viewings(s, q)).viewings.length;
  assert.equal(await count(), 5);
  const one = (await viewings(s, "?episode=show.e2")).viewings[0].id;
  assert.equal((await s.admin("DELETE", `/history/viewings/${one}`)).status, 204);
  assert.equal((await s.admin("DELETE", `/history/viewings/${one}`)).status, 404);
  assert.equal((await s.admin("DELETE", "/history/viewings/x")).status, 404);
  assert.equal(await count(), 4);
  assert.deepEqual((await s.admin("DELETE", `/history?device=${kitchen.tv.deviceId}&olderThan=${cut}`)).json, { deleted: 1 });
  assert.deepEqual((await s.admin("DELETE", `/history?olderThan=${cut}`)).json, { deleted: 1 });
  assert.equal(await count(), 2);
  assert.deepEqual((await s.admin("DELETE", "/history")).json, { deleted: 2 }, "the running one too");
  assert.equal(s.srv.ctx.playing.running(tv.deviceId), null);
  await report("film.main", "playing", 30_000);
  assert.equal(await count(), 0, "reports for a deleted viewing do not bring it back");
  await resolve("film.main");
  assert.equal(await count(), 1, "the next resolve starts a new one");
  assert.deepEqual((await events(s, "history.changed")).map((e: Json) => [e.deviceId, e.data]), [
    [kitchen.tv.deviceId, { deleted: 1 }], [kitchen.tv.deviceId, { deleted: 1 }], [null, { deleted: 1 }], [null, { deleted: 2 }],
  ]);
  assert.equal((await s.admin("DELETE", "/history?olderThan=soon")).status, 400);
});

test("scopes: reads with read, marks with manage, deletions with the owner token only", async (t) => {
  const { s } = await setup(t);
  const token = async (scope: string) => (await s.admin("POST", "/tokens", { name: scope, scope })).json.secret;
  const read = await token("read");
  const manage = await token("manage");
  const call = (tok: string, method: string, route: string, body?: unknown) => s.call(method, `/api/v1/admin/history${route}`, { token: tok, body });
  for (const route of ["/viewings", "/viewings/1", "/titles", "/titles/show", "/days"]) {
    assert.notEqual((await call(read, "GET", route)).status, 403, route);
  }
  const marks = { episodeIds: ["show.e1"], seen: true };
  assert.deepEqual((await call(read, "POST", "/marks", marks)).json, { error: "insufficient_scope", required: "manage", message: "this route needs the manage scope" });
  assert.equal((await call(manage, "POST", "/marks", marks)).status, 200);
  assert.deepEqual([(await call(manage, "DELETE", "")).json.required, (await call(manage, "DELETE", "/viewings/1")).json.required], ["owner", "owner"]);
  assert.equal((await s.admin("DELETE", "/history")).status, 200);
});

test("hostile fixture: titles and names with URLs and tokens never reach the log; log lines carry ids only", async (t) => {
  const items = fixtureItems();
  items.items[0].title = `Şov https://evil.example.test/show?sig=${RUN}`;
  items.items[0].episodes[0].title = `Pilot ${RUN}`;
  const s = await startTestServer({ bundleDir: await writeBundle(`${await (await import("./helpers.ts")).tempDir()}/bundle`, fixtureManifest(), items) });
  t.after(() => s.close());
  const h = helpers(s, await s.pair(`TV https://evil.example.test/tv?t=${RUN.slice(0, 24)}`));
  const from = s.logs.length;
  await h.resolve("show.e1");
  await h.report("show.e1", "playing", 0);
  s.clock.advance(15_000);
  await h.report("show.e1", "stopped", 15_000);
  await s.admin("POST", "/history/marks", { episodeIds: ["show.e1"], seen: true });
  await s.admin("GET", "/history/titles/show");
  const v = (await viewings(s)).viewings[0];
  assert.deepEqual([v.deviceName.includes(RUN.slice(0, 24)), v.itemTitle.includes("evil.example.test"), v.episodeTitle], [true, true, `Pilot ${RUN}`], "stored as given");
  const lines = s.logs.slice(from);
  const mine = lines.filter((l) => l.includes('"msg":"viewing'));
  assert.equal(mine.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(mine[0]!)).sort(), ["deviceId", "episodeId", "itemId", "level", "msg", "time", "trigger", "viewingId"]);
  assert.deepEqual(Object.keys(JSON.parse(mine[1]!)).sort(), ["deviceId", "dropped", "endReason", "level", "msg", "seen", "time", "viewingId", "watchedMs"]);
  for (const leak of [RUN, RUN.slice(0, 24), "evil.example.test", "Pilot", "Şov", ADMIN_TOKEN, h.tv.token]) assert.ok(!lines.join("\n").includes(leak), `leaked ${leak}`);
});

test("channels: a viewing without episode or positions, watched time from heartbeats, stalls, never seen; drop, lost and replace", async (t) => {
  const { s, as, resolve, report, running } = await setup(t);
  const live = (status: string, extra: Json = {}) => as("POST", "/progress", { itemId: "news", status, ...extra });
  const channel = (extra: Json = {}) => as("POST", "/resolve", { itemId: "news", ...extra });
  assert.equal((await channel()).status, 200);
  const started = (await events(s, "playback.started"))[0];
  const id = started.data.viewingId;
  assert.deepEqual(started.data, {
    viewingId: id, itemId: "news", itemKind: "live", itemTitle: "Haber 24", episodeId: null, episodeTitle: null, season: null, number: null, sourceId: "hls",
    positionMs: null, trigger: "unknown",
  });
  await live("playing");
  s.clock.advance(15_000);
  await live("playing", { playing: false }); // a stall: the 15 s before it count
  s.clock.advance(10_000);
  await live("playing"); // recovered: the stall does not count
  s.clock.advance(15_000);
  const again = await channel({ sourceId: "en" }); // a re-resolve (another source) continues the viewing
  assert.deepEqual([again.status, running()!.id, running()!.sourceId], [200, id, "en"]);
  s.clock.advance(15_000);
  await live("playing"); // 30 s since the last report while playing
  s.clock.advance(5_000);
  await live("stopped");
  const { viewing: v, ranges } = await viewing(s, id);
  assert.deepEqual(ended(v), { endReason: "stopped", seen: false, watchedMs: 50_000, startPositionMs: null, endPositionMs: null, endedAt: at(s) });
  assert.deepEqual([v.itemKind, v.episodeId, v.episodeTitle, v.season, v.number, v.durationMs, v.sourceId], ["live", null, null, null, null, null, "en"]);
  assert.deepEqual(ranges, [], "a channel has no played ranges");
  assert.equal(running(), null);
  const seq = (await events(s, "playback.,episode.")).map((e: Json) => [e.type, e.data.positionMs]);
  assert.deepEqual(seq, [["playback.started", null], ["playback.stalled", null], ["playback.recovered", null], ["playback.ended", null]], "no episode.seen for a channel");
  assert.deepEqual((await events(s, "playback.ended"))[0].data, { viewingId: id, endReason: "stopped", seen: false, positionMs: null, watchedMs: 50_000, dropped: false });

  // A mis-press is dropped; a channel that falls silent is lost (at its last report, no position).
  await channel();
  await live("playing");
  s.clock.advance(5_000);
  await live("stopped");
  const dropped = (await events(s, "playback.ended")).at(-1)!;
  assert.deepEqual([dropped.data.dropped, (await viewings(s, "?item=news")).viewings.length], [true, 1]);
  await channel();
  await live("playing");
  s.clock.advance(MIN);
  await live("playing");
  const lostAt = at(s);
  s.clock.advance(2 * MIN);
  s.srv.ctx.playing.sweep();
  const lost = (await viewings(s, "?item=news")).viewings[0];
  assert.deepEqual(ended(lost), { endReason: "lost", seen: false, watchedMs: MIN, startPositionMs: null, endPositionMs: null, endedAt: lostAt });

  // Resolving an episode replaces a channel's viewing, and a channel replaces an episode's; the reports of one are
  // not applied to the other.
  await channel();
  await live("playing");
  s.clock.advance(20_000);
  await live("playing");
  await resolve("show.e1");
  const replaced = (await viewings(s, "?item=news")).viewings[0];
  assert.deepEqual([replaced.endReason, replaced.watchedMs], ["replaced", 20_000]);
  await report("show.e1", "playing", 0);
  await live("playing"); // ignored by the history: the running viewing is the episode's
  s.clock.advance(20_000);
  await report("show.e1", "playing", 20_000);
  await channel();
  const show = (await viewings(s, "?item=show")).viewings[0];
  assert.deepEqual([show.endReason, show.watchedMs, show.endPositionMs], ["replaced", 20_000, 20_000]);
  assert.equal(running()!.episodeId, null);

  // Listing and the title summary; a channel is never marked.
  const list = (await viewings(s, "?item=news")).viewings;
  assert.ok(list.length >= 3 && list.every((x: Json) => x.episodeId === null && x.itemKind === "live"));
  const title = (await s.admin("GET", "/history/titles/news")).json;
  assert.deepEqual([title.title.kind, title.title.status, title.title.episodes, title.title.seasons, title.title.rewatches, title.episodes], ["live", "watching", null, [], 0, []]);
  const summary = (await s.admin("GET", "/history/titles?sort=title")).json.titles.find((x: Json) => x.itemId === "news");
  assert.deepEqual([summary.kind, summary.episodes, summary.viewings], ["live", null, list.length]);
  const marks = await s.admin("POST", "/history/marks", { episodeIds: ["news"], seen: true });
  assert.deepEqual([marks.status, marks.json.error], [400, "unknown_episode"]);
  const days = (await s.admin("GET", "/history/days?tz=UTC")).json.days[0];
  assert.ok(days.items.some((i: Json) => i.itemId === "news" && i.title === "Haber 24"), "a channel's watched time counts on its day");
});
