// What a TV is playing, driven directly (no HTTP). The row, the viewing and its events are covered through the API
// in viewings.test.ts, companion.test.ts and tv.test.ts; this covers what the API cannot reach.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { CatalogService } from "../src/catalog.ts";
import { EventLog } from "../src/eventlog.ts";
import { EventHub } from "../src/events.ts";
import { PlayingService } from "../src/playing.ts";
import { PlaybackSessions } from "../src/resolve.ts";
import { Store } from "../src/store.ts";
import { fakeClock, silentLogger, tempDir, writeBundle } from "./helpers.ts";

test("waitCurrent: wakes on the next report once it committed, never for one that rolled back; a stale seq answers at once", async (t) => {
  const root = await tempDir();
  const store = new Store(path.join(root, "izle.db"));
  t.after(() => store.close());
  const clock = fakeClock();
  const catalog = new CatalogService(await writeBundle(path.join(root, "bundle")), silentLogger, clock.now);
  await catalog.load();
  const eventLog = new EventLog(store, silentLogger, clock.now, 30);
  const sessions = new PlaybackSessions(clock.now);
  const playing = new PlayingService({ store, catalog, sessions, eventLog, events: new EventHub(), log: silentLogger, now: clock.now });
  const device = store.createDevice({ id: "tv1", name: "Salon", tokenHash: null, now: clock.now() });
  const e1 = catalog.episode("show.e1")!;
  const report = (positionMs: number) => playing.reported(device, e1, { episodeId: e1.episode.id, status: "playing", positionMs });
  playing.started(device, { ref: e1, sourceId: "main" }, { positionMs: 0, durationMs: null }, { trigger: "viewer" });
  const seq = playing.current(device.id)!.seq;
  assert.equal((await playing.waitCurrent(device.id, seq - 1, 25_000))!.seq, seq);

  const waiting = playing.waitCurrent(device.id, seq, 25_000);
  report(0);
  assert.equal((await waiting)!.seq, seq + 1);

  const pending = playing.waitCurrent(device.id, seq + 1, 25_000);
  assert.throws(() => store.transaction(() => {
    report(1_000);
    throw new Error("rolled back");
  }));
  const winner = await Promise.race([pending.then(() => "woken"), new Promise((r) => setTimeout(() => r("waiting"), 30))]);
  assert.equal(winner, "waiting");
  report(2_000);
  assert.equal((await pending)!.seq, seq + 2);
});
