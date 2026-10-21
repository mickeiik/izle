// What a TV is playing, driven directly (no HTTP): the row, the running viewing and its events, the lost sweep, and
// the long-poll on the row.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { LiveItem } from "@izle/contract";
import { CatalogService, liveRef, playingKey, type EpisodeRef, type PlayableRef } from "../src/catalog.ts";
import { EventLog } from "../src/eventlog.ts";
import { EventHub } from "../src/events.ts";
import type { LiveReportStatus, ProgressReportStatus } from "../src/playback.ts";
import { PlayingService, type Position } from "../src/playing.ts";
import { PlaybackSessions } from "../src/resolve.ts";
import { Store } from "../src/store.ts";
import { fakeClock, silentLogger, tempDir, writeBundle, type Json } from "./helpers.ts";

const MIN = 60_000;

async function setup(t: { after(fn: () => unknown): void }) {
  const root = await tempDir();
  const store = new Store(path.join(root, "izle.db"));
  t.after(() => store.close());
  const clock = fakeClock();
  const catalog = new CatalogService(await writeBundle(path.join(root, "bundle")), silentLogger, clock.now);
  await catalog.load();
  const sessions = new PlaybackSessions(clock.now);
  const eventLog = new EventLog(store, silentLogger, clock.now, 30);
  const events = new EventHub();
  const playing = new PlayingService({ store, catalog, sessions, eventLog, events, log: silentLogger, now: clock.now });
  const device = store.createDevice({ id: "tv1", name: "Salon", tokenHash: null, now: clock.now() });
  const episode = (id: string): EpisodeRef => catalog.episode(id)!;
  const news = liveRef(catalog.item("news") as LiveItem);
  return {
    store, clock, sessions, playing, device, episode, news,
    /** A resolve as TvService makes it: a playback session, then the start. Returns the session id. */
    resolve(ref: PlayableRef, sourceId = "main", start: Position | null = null): string {
      const session = sessions.open({ deviceId: device.id, catalogId: catalog.catalogId, ...playingKey(ref), sourceId });
      playing.started(device, { ref, sourceId }, start, { trigger: "viewer" });
      return session.id;
    },
    report(ref: EpisodeRef, status: ProgressReportStatus, positionMs: number, extra: Json = {}) {
      playing.reported(device, ref, { episodeId: ref.episode.id, status, positionMs, ...extra });
    },
    live(status: LiveReportStatus, extra: Json = {}) {
      playing.reported(device, news, { itemId: "news", status, ...extra });
    },
    /** The playback events since `after`, as `[type, data]`. */
    events(after = 0): Array<[string, Json]> {
      return store.listEvents({ after, limit: 500, types: ["playback.", "episode."] }).map((e) => [e.type, e.data]);
    },
    types(after = 0): string[] {
      return store.listEvents({ after, limit: 500, types: ["playback.", "episode."] }).map((e) => e.type);
    },
    lastEventId: () => store.lastEventId(),
    /** Keeps the TV online, as an open event stream does. */
    online: () => void events.subscribe(device.id, { send() {}, close() {} }),
  };
}

test("pause: the second paused report emits nothing", async (t) => {
  const { clock, episode, resolve, report, types } = await setup(t);
  const e1 = episode("show.e1");
  resolve(e1);
  report(e1, "playing", 0);
  clock.advance(15_000);
  report(e1, "paused", 15_000);
  clock.advance(15_000);
  report(e1, "paused", 15_000);
  assert.deepEqual(types(), ["playback.started", "playback.paused"]);
});

test("stall: playing with playing false stalls, the next advancing report recovers; a stall counts no watched time", async (t) => {
  const { clock, episode, resolve, report, events, playing, device } = await setup(t);
  const e1 = episode("show.e1");
  resolve(e1);
  report(e1, "playing", 0);
  clock.advance(15_000);
  report(e1, "playing", 15_000, { playing: false });
  clock.advance(15_000);
  report(e1, "playing", 15_000);
  const viewingId = playing.running(device.id)!.id;
  assert.deepEqual(events().slice(1), [
    ["playback.stalled", { viewingId, positionMs: 15_000 }],
    ["playback.recovered", { viewingId, positionMs: 15_000 }],
  ]);
  assert.equal(playing.running(device.id)!.watchedMs, 15_000);
});

test("seek: a jump beyond the tolerance is a seek and no range; an advance within it is a range and no seek", async (t) => {
  const { store, clock, episode, resolve, report, events, playing, device, lastEventId } = await setup(t);
  const e1 = episode("show.e1");
  resolve(e1);
  report(e1, "playing", 0);
  clock.advance(15_000);
  const id = playing.running(device.id)!.id;
  report(e1, "playing", 600_000);
  assert.deepEqual(events().slice(1), [["playback.seeked", { viewingId: id, fromMs: 15_000, toMs: 600_000 }]]);
  assert.deepEqual(store.viewingRanges(id), []);
  const after = lastEventId();
  clock.advance(15_000);
  report(e1, "playing", 614_000);
  assert.deepEqual(events(after), []);
  assert.deepEqual(store.viewingRanges(id), [[600_000, 614_000]]);
});

test("resolve: the same episode continues its viewing (the source changes, no event); another replaces it", async (t) => {
  const { clock, episode, resolve, report, events, types, playing, device, lastEventId } = await setup(t);
  const e1 = episode("show.e1");
  resolve(e1, "en-orig");
  report(e1, "playing", 0);
  const first = playing.running(device.id)!;
  const after = lastEventId();
  clock.advance(15_000);
  resolve(e1, "tr-dub");
  assert.deepEqual([playing.running(device.id)!.id, playing.running(device.id)!.sourceId], [first.id, "tr-dub"]);
  assert.deepEqual(types(after), []);
  report(e1, "playing", 15_000);
  resolve(episode("show.e2"));
  const [ended, started] = events(after);
  assert.deepEqual(ended, ["playback.ended", { viewingId: first.id, endReason: "replaced", seen: false, positionMs: 15_000, watchedMs: 15_000, dropped: false }]);
  assert.equal(started![0], "playback.started");
  assert.equal(playing.running(device.id)!.episodeId, "show.e2");
});

test("end: under 10 s watched and not seen is dropped; finished is seen, at the duration", async (t) => {
  const { store, clock, episode, resolve, report, events, playing, device, lastEventId } = await setup(t);
  const e1 = episode("show.e1");
  resolve(e1);
  report(e1, "playing", 0);
  const short = playing.running(device.id)!.id;
  clock.advance(5_000);
  report(e1, "stopped", 5_000);
  assert.deepEqual(events().at(-1), ["playback.ended", { viewingId: short, endReason: "stopped", seen: false, positionMs: 5_000, watchedMs: 5_000, dropped: true }]);
  assert.equal(store.getViewing(short), null);

  const after = lastEventId();
  resolve(e1, "main", { positionMs: 1_000_000, durationMs: null });
  report(e1, "playing", 1_000_000);
  const id = playing.running(device.id)!.id;
  clock.advance(5_000);
  report(e1, "finished", 1_005_000, { durationMs: 1_200_000 });
  assert.deepEqual(events(after).slice(1).map(([type, data]) => [type, data.seen, data.dropped, data.positionMs ?? null]), [
    ["playback.ended", true, false, 1_200_000],
    ["episode.seen", undefined, undefined, null],
  ]);
  const v = store.getViewing(id)!;
  assert.deepEqual([v.endReason, v.seen, v.endPositionMs, v.watchedMs], ["finished", true, 1_200_000, 5_000]);
});

test("channel: a row with no positions, watched time from heartbeats, never seen, ended by stopped", async (t) => {
  const { store, clock, news, resolve, live, events, playing, device } = await setup(t);
  const session = resolve(news, "hls");
  assert.deepEqual(playing.current(device.id), {
    ...playing.current(device.id), itemId: "news", episodeId: null, sourceId: "hls", positionMs: null, durationMs: null, state: "starting", playing: false,
  });
  live("playing", { sessionId: session });
  const id = playing.running(device.id)!.id;
  clock.advance(15_000);
  live("playing", { sessionId: session });
  clock.advance(15_000);
  live("stopped", { sessionId: session });
  const row = playing.current(device.id)!;
  assert.deepEqual([row.state, row.positionMs, row.durationMs, row.sourceId, row.viewingId], ["stopped", null, null, "hls", null]);
  const v = store.getViewing(id)!;
  assert.deepEqual([v.endReason, v.seen, v.watchedMs, v.endPositionMs, v.startPositionMs, v.durationMs], ["stopped", false, 30_000, null, null, null]);
  assert.deepEqual(events().map(([type]) => type), ["playback.started", "playback.ended"]);
});

test("lost sweep: silence while playing, an offline TV, and a paused online TV that keeps its viewing", async (t) => {
  const cases: Array<{ name: string; online: boolean; status: ProgressReportStatus; lost: boolean }> = [
    { name: "silent while playing", online: true, status: "playing", lost: true },
    { name: "offline while paused", online: false, status: "paused", lost: true },
    { name: "paused and online", online: true, status: "paused", lost: false },
  ];
  for (const c of cases) {
    const { clock, episode, resolve, report, playing, device, online } = await setup(t);
    if (c.online) online();
    else playing.onOnline(device.id, false);
    const e1 = episode("show.e1");
    resolve(e1);
    report(e1, "playing", 0);
    clock.advance(15_000);
    report(e1, c.status, 15_000);
    clock.advance(MIN);
    playing.sweep();
    assert.notEqual(playing.running(device.id), null, `${c.name}: not yet`);
    clock.advance(MIN);
    playing.sweep();
    assert.equal(playing.running(device.id) === null, c.lost, c.name);
  }
});

test("current: the row with its viewing id while the viewing runs, null once it ended; the source from the named session", async (t) => {
  const { clock, episode, resolve, report, playing, device } = await setup(t);
  assert.equal(playing.current(device.id), null, "never played");
  const e1 = episode("show.e1");
  const session = resolve(e1, "tr-dub");
  const id = playing.running(device.id)!.id;
  assert.deepEqual([playing.current(device.id)!.viewingId, playing.current(device.id)!.positionMs, playing.current(device.id)!.state], [id, 0, "starting"]);
  report(e1, "playing", 0, { sessionId: session });
  assert.equal(playing.current(device.id)!.sourceId, "tr-dub");
  report(e1, "playing", 0);
  assert.equal(playing.current(device.id)!.sourceId, null, "no session named");
  clock.advance(15_000);
  report(e1, "stopped", 15_000, { sessionId: session });
  const after = playing.current(device.id)!;
  assert.deepEqual([after.state, after.positionMs, after.viewingId], ["stopped", 15_000, null]);
});

test("waitCurrent: wakes on the next report once it committed, answers at once for a stale seq", async (t) => {
  const { store, episode, resolve, report, playing, device } = await setup(t);
  const e1 = episode("show.e1");
  resolve(e1);
  const seq = playing.current(device.id)!.seq;
  const stale = await playing.waitCurrent(device.id, seq - 1, 25_000);
  assert.equal(stale!.seq, seq);

  const waiting = playing.waitCurrent(device.id, seq, 25_000);
  report(e1, "playing", 0);
  assert.equal((await waiting)!.seq, seq + 1);

  // A report whose transaction rolls back wakes nobody.
  const pending = playing.waitCurrent(device.id, seq + 1, 25_000);
  assert.throws(() => store.transaction(() => {
    report(e1, "playing", 1_000);
    throw new Error("rolled back");
  }));
  const winner = await Promise.race([pending.then(() => "woken"), new Promise((r) => setTimeout(() => r("waiting"), 30))]);
  assert.equal(winner, "waiting");
  report(e1, "playing", 2_000);
  assert.equal((await pending)!.seq, seq + 2);
});
