import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_REPLAY_MAX } from "../src/eventlog.ts";
import { frameWriter, MAX_ADMIN_STREAMS } from "../src/http/routes/admin-events.ts";
import { ADMIN_TOKEN, eventually, openEvents, publishBuild, startTestServer, type Json, type TestServer } from "./helpers.ts";

const types = (events: Json[]) => events.map((e) => e.type);
const admin = (s: TestServer, query: string) => s.admin("GET", `/events${query}`);
/** Opens the admin event stream; `after` goes in the query, `lastEventId` in the `Last-Event-ID` header. */
const openAdminStream = (s: TestServer, query = "", lastEventId?: number) =>
  openEvents(s.base, ADMIN_TOKEN, `/api/v1/admin/events/stream${query}`, lastEventId === undefined ? {} : { "Last-Event-ID": String(lastEventId) });

test("events: every change appends one, in order, with its actor and data; nothing secret in them", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const tv = await s.pair("Salon");
  const token = (await s.admin("POST", "/tokens", { name: "agent", scope: "manage" })).json;
  const asAgent = (method: string, route: string, body?: unknown) => s.call(method, `/api/v1/admin${route}`, { token: token.secret, body });

  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["show", "film"] });
  await asAgent("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["film", "silent"] });
  await s.admin("PATCH", `/devices/${tv.deviceId}`, { name: "Living room", autoplayOnStart: true });
  await asAgent("PUT", `/devices/${tv.deviceId}/cursor`, { itemId: "show", episodeId: "show.e2" });
  const cmd = await asAgent("POST", `/devices/${tv.deviceId}/commands`, { type: "message", text: "Dinner is ready, the secret word is sesame" });
  await s.call("POST", `/api/v1/tv/commands/${cmd.json.id}/ack`, { token: tv.token });
  await s.call("POST", "/api/v1/tv/problems", { token: tv.token, body: { kind: "playback", code: "ERROR_CODE_IO", episodeId: "show.e1", detail: "https://cdn.example.test/secret" } });
  await publishBuild(s.bundleDir, "fixture-2", (items) => items.filter((i) => i.id !== "film"));
  await asAgent("POST", "/catalog/reload");
  await publishBuild(s.bundleDir, "fixture-3", (items) => items, { formatVersion: 2 });
  assert.equal((await s.admin("POST", "/catalog/reload")).status, 422);
  await s.admin("DELETE", `/devices/${tv.deviceId}`);

  const all = (await admin(s, "?after=0&limit=500")).json;
  assert.equal(all.gap, false);
  assert.deepEqual(types(all.events), [
    "server.started", "pairing.pending", "device.paired", "home.changed", "home.changed", "device.updated", "cursor.changed", "command.sent",
    "command.delivered", "problem.recorded", "catalog.reloaded", "catalog.reload_failed", "device.removed",
  ]);
  assert.deepEqual(all.events.map((e: Json) => e.id), all.events.map((_: Json, i: number) => i + 1), "ids increase strictly from 1");
  assert.equal(all.last, all.events.length);
  const [started, pending, paired, home1, home2, updated, cursor, sent, delivered, problem, reloaded, failed, removed] = all.events;
  const d = tv.deviceId;
  const agent = { type: "token", tokenId: token.token.id, name: "agent" };
  assert.deepEqual([started.deviceId, started.actor, started.data], [null, { type: "server" }, { version: started.data.version }]);
  assert.match(started.data.version, /^\d+\.\d+\.\d+/);
  assert.equal(started.at, "2026-10-10T12:00:00.000Z");
  assert.deepEqual([pending.deviceId, pending.actor, pending.data.expiresAt], [null, { type: "server" }, "2026-10-10T12:10:00.000Z"]);
  assert.match(pending.data.code, /^\d{6}$/);
  assert.deepEqual([paired.deviceId, paired.actor, paired.data], [d, { type: "tv", deviceId: d }, { name: "Salon", replaced: false }]);
  assert.deepEqual([home1.actor, home1.data], [{ type: "owner" }, { itemIds: ["show", "film"], added: ["show", "film"], removed: [] }]);
  assert.deepEqual([home2.actor, home2.data], [agent, { itemIds: ["film", "silent"], added: ["silent"], removed: ["show"] }]);
  assert.deepEqual([updated.deviceId, updated.actor, updated.data], [d, { type: "owner" }, { fields: ["name", "autoplayOnStart"] }]);
  assert.deepEqual([cursor.actor, cursor.data], [agent, { itemId: "show", episodeId: "show.e2" }]);
  assert.deepEqual([sent.actor, sent.data], [agent, { commandId: cmd.json.id, type: "message", online: false }]);
  assert.deepEqual([delivered.actor, delivered.data], [{ type: "tv", deviceId: d }, { commandId: cmd.json.id }]);
  assert.deepEqual([problem.actor, problem.data], [{ type: "tv", deviceId: d }, { problemId: problem.data.problemId, origin: "tv", kind: "playback", code: "ERROR_CODE_IO", itemId: "show", episodeId: "show.e1" }]);
  assert.deepEqual([reloaded.deviceId, reloaded.actor, reloaded.data], [null, agent, { buildId: "fixture-2", added: { items: 0, episodes: 0 }, removed: { items: 1, episodes: 1 } }]);
  assert.deepEqual([failed.actor, failed.data.issues > 0], [{ type: "owner" }, true]);
  assert.deepEqual([removed.deviceId, removed.actor, removed.data], [d, { type: "owner" }, { name: "Living room" }]);
  const text = JSON.stringify(all);
  for (const leak of ["sesame", "cdn.example.test", "izat_", ADMIN_TOKEN, tv.token]) assert.ok(!text.includes(leak), `leaked ${leak}`);

  // Server-origin problems and SIGHUP reloads are the server's doing.
  await s.call("POST", "/api/v1/tv/resolve", { token: (await s.pair("Other")).token, body: { episodeId: "locked.main" } });
  const tail = (await admin(s, `?after=${all.last}`)).json.events;
  const recorded = tail.find((e: Json) => e.type === "problem.recorded");
  assert.ok(recorded === undefined || recorded.actor.type === "server");
});

test("long-poll: after/limit/last, device and type filters (prefixes), gap after a purge, and waking on a new event", async (t) => {
  const s = await startTestServer({ configFile: { events: { retentionDays: 1 } } });
  t.after(() => s.close());
  const a = await s.pair("A");
  const b = await s.pair("B");
  await s.admin("PUT", `/devices/${a.deviceId}/home`, { itemIds: ["show"] });
  await s.admin("PUT", `/devices/${b.deviceId}/home`, { itemIds: ["film"] });
  await s.admin("POST", `/devices/${a.deviceId}/commands`, { type: "pause" });

  // Without `after`: nothing, and where to start following from.
  const start = (await admin(s, "")).json;
  assert.deepEqual(start, { events: [], last: 8, gap: false });
  const page1 = (await admin(s, "?after=0&limit=3")).json;
  assert.deepEqual([types(page1.events), page1.last, page1.gap], [["server.started", "pairing.pending", "device.paired"], 3, false]);
  const page2 = (await admin(s, `?after=${page1.last}&limit=3`)).json;
  assert.deepEqual([types(page2.events), page2.last], [["pairing.pending", "device.paired", "home.changed"], 6]);
  assert.deepEqual((await admin(s, "?after=8")).json, { events: [], last: 8, gap: false }, "nothing new: last is after");
  assert.equal((await admin(s, "?after=0&limit=9999")).json.events.length, 8, "limit is capped, not refused");

  const onlyA = (await admin(s, `?after=0&devices=${a.deviceId}`)).json.events;
  assert.deepEqual(onlyA.map((e: Json) => [e.type, e.deviceId]), [
    ["server.started", null], ["pairing.pending", null], ["device.paired", a.deviceId], ["pairing.pending", null], ["home.changed", a.deviceId], ["command.sent", a.deviceId],
  ], "events without a device pass a device filter");
  assert.deepEqual(types((await admin(s, "?after=0&types=home.changed,command.")).json.events), ["home.changed", "home.changed", "command.sent"]);
  assert.deepEqual(types((await admin(s, `?after=0&types=device.&devices=${b.deviceId}`)).json.events), ["device.paired"]);
  for (const bad of ["?after=-1", "?after=x", "?wait=30", "?after=0&types=Home.Changed", "?after=0&devices=not-an-id!", "?after=0&types=%25"]) {
    assert.equal((await admin(s, bad)).status, 400, bad);
  }

  // A long-poll with nothing new waits for the next matching event; one for another device keeps waiting.
  const waiting = admin(s, `?after=8&wait=5&devices=${b.deviceId}`);
  await new Promise((r) => setTimeout(r, 50));
  await s.admin("PATCH", `/devices/${a.deviceId}`, { name: "A2" });
  const woken = admin(s, "?after=9&wait=5");
  await new Promise((r) => setTimeout(r, 50));
  await s.admin("PATCH", `/devices/${b.deviceId}`, { name: "B2" });
  assert.deepEqual(types((await waiting).json.events), ["device.updated"]);
  assert.equal((await waiting).json.events[0].deviceId, b.deviceId);
  assert.deepEqual((await woken).json.events.map((e: Json) => e.id), [10]);

  // Retention: housekeeping drops events older than the configured days; a consumer behind them sees the gap.
  s.clock.advance(2 * 24 * 60 * 60_000);
  await s.admin("PATCH", `/devices/${a.deviceId}`, { name: "A3" });
  s.srv.ctx.eventLog.purge();
  const afterPurge = (await admin(s, "?after=0")).json;
  assert.deepEqual([afterPurge.events.map((e: Json) => e.id), afterPurge.gap, afterPurge.last], [[11], true, 11]);
  assert.deepEqual((await admin(s, "?after=10")).json.gap, false, "nothing between 10 and the oldest kept (11) is missing");
  assert.deepEqual((await admin(s, "?after=11")).json, { events: [], last: 11, gap: false });
  assert.equal((await admin(s, "")).json.last, 11);
  s.clock.advance(2 * 24 * 60 * 60_000);
  s.srv.ctx.eventLog.purge();
  assert.deepEqual((await admin(s, "?after=5")).json, { events: [], last: 5, gap: true }, "everything gone: still a gap, and the newest id is remembered");
  assert.deepEqual((await admin(s, "")).json, { events: [], last: 11, gap: false });
});

test("stream: retry, replay from after or Last-Event-ID (gap first), then live events in order; filters; pings", async (t) => {
  const s = await startTestServer({ pingMs: 50 });
  t.after(() => s.close());
  const a = await s.pair("A");
  await s.admin("PUT", `/devices/${a.deviceId}/home`, { itemIds: ["show"] });
  assert.equal((await s.call("GET", "/api/v1/admin/events/stream")).status, 401);

  const es = await openAdminStream(s, "?after=2");
  t.after(() => es.close());
  assert.equal(es.status, 200);
  assert.match(es.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal((await es.next()).retry, "5000");
  const replayed = [await es.next(), await es.next()];
  assert.deepEqual(replayed.map((m) => [m.id, m.event, JSON.parse(m.data!).type]), [["3", "device.paired", "device.paired"], ["4", "home.changed", "home.changed"]]);
  assert.equal((await es.next((m) => m.comment === "ping")).comment, "ping");
  await s.admin("PATCH", `/devices/${a.deviceId}`, { name: "A2" });
  const live = await es.next();
  assert.deepEqual([live.id, live.event, JSON.parse(live.data!).data], ["5", "device.updated", { fields: ["name"] }]);

  // Last-Event-ID (a browser's reconnect) replays the same way; the query wins when both are given.
  const byHeader = await openAdminStream(s, "", 3);
  t.after(() => byHeader.close());
  await byHeader.next();
  assert.deepEqual([(await byHeader.next()).id, (await byHeader.next()).id], ["4", "5"]);
  const both = await openAdminStream(s, "?after=4", 1);
  t.after(() => both.close());
  await both.next();
  assert.equal((await both.next()).id, "5");

  // Without either: live events only, filtered.
  const liveOnly = await openAdminStream(s, "?types=command.");
  t.after(() => liveOnly.close());
  await liveOnly.next();
  await s.admin("PATCH", `/devices/${a.deviceId}`, { name: "A3" });
  const cmd = await s.admin("POST", `/devices/${a.deviceId}/commands`, { type: "pause" });
  const first = await liveOnly.next();
  assert.deepEqual([first.event, JSON.parse(first.data!).data.commandId], ["command.sent", cmd.json.id]);

  // A consumer behind the oldest kept event hears about the gap before the kept events.
  s.clock.advance(10 * 24 * 60 * 60_000);
  await s.admin("PATCH", `/devices/${a.deviceId}`, { name: "A4" });
  s.srv.ctx.eventLog.purge();
  const behind = await openAdminStream(s, "?after=2");
  t.after(() => behind.close());
  await behind.next();
  const gap = await behind.next();
  assert.deepEqual([gap.event, JSON.parse(gap.data!)], ["gap", { oldest: 8 }]);
  assert.equal((await behind.next()).id, "8");
});

test("stream: a replay sends at most the newest 500 events, after a gap naming where it starts", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const { store } = s.srv.ctx;
  store.transaction(() => {
    for (let i = 0; i < 3 * EVENT_REPLAY_MAX; i++) store.insertEvent({ at: s.clock.now(), type: "device.updated", deviceId: null, actor: { type: "server" }, data: { fields: ["name"] } });
  });
  const last = (await admin(s, "")).json.last as number;

  const es = await openAdminStream(s, "?after=0");
  t.after(() => es.close());
  assert.equal((await es.next()).retry, "5000");
  const gap = await es.next();
  assert.deepEqual([gap.event, JSON.parse(gap.data!)], ["gap", { oldest: last - EVENT_REPLAY_MAX + 1 }]);
  const ids: number[] = [];
  for (let i = 0; i < EVENT_REPLAY_MAX; i++) ids.push(Number((await es.next()).id));
  assert.deepEqual(ids, Array.from({ length: EVENT_REPLAY_MAX }, (_, i) => last - EVENT_REPLAY_MAX + 1 + i), "the newest ones, oldest first");
  await s.admin("POST", "/catalog/reload");
  assert.equal(Number((await es.next()).id), last + 1, "then the live ones");

  // Exactly the cap: everything, no gap.
  const exact = await openAdminStream(s, `?after=${last + 1 - EVENT_REPLAY_MAX}`);
  t.after(() => exact.close());
  await exact.next();
  assert.equal((await exact.next()).id, String(last + 2 - EVENT_REPLAY_MAX), "no gap first");
});

test("stream: a writer closes the stream once more frames wait than it may queue", async () => {
  const stalled = { aborted: false, aborts: 0, abort() { this.aborts++; this.aborted = true; } };
  const write = frameWriter(stalled, 3);
  let started = 0;
  // The reader never reads: the first frame never completes, the rest wait behind it.
  for (let i = 0; i < 10; i++) write(() => (started++, new Promise(() => {})));
  await new Promise((r) => setImmediate(r));
  assert.equal(stalled.aborts, 1, "aborted when the fourth frame was queued, once");
  assert.equal(started, 1, "frames run one at a time");

  const flowing = { aborted: false, aborts: 0, abort() { this.aborts++; this.aborted = true; } };
  const writeFlowing = frameWriter(flowing, 3);
  let written = 0;
  for (let round = 0; round < 50; round++) {
    for (let i = 0; i < 3; i++) writeFlowing(async () => void written++);
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual([flowing.aborts, written], [0, 150], "a reader that keeps up is never cut off");
});

test("stream: at most 10 open per access token and per client address for the owner token", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const token = (await s.admin("POST", "/tokens", { name: "agent", scope: "read" })).json;
  const route = "/api/v1/admin/events/stream";
  const streams = [];
  for (let i = 0; i < MAX_ADMIN_STREAMS; i++) {
    const es = await openEvents(s.base, token.secret, route);
    t.after(() => es.close());
    assert.equal(es.status, 200);
    await es.next();
    streams.push(es);
  }
  const refused = await s.call("GET", route, { token: token.secret });
  assert.deepEqual([refused.status, refused.json.error, refused.headers.get("retry-after")], [429, "too_many_streams", "5"]);
  const other = (await s.admin("POST", "/tokens", { name: "other", scope: "read" })).json;
  const otherStream = await openEvents(s.base, other.secret, route);
  t.after(() => otherStream.close());
  assert.equal(otherStream.status, 200, "another token has its own count");
  const ownerStream = await openEvents(s.base, ADMIN_TOKEN, route);
  t.after(() => ownerStream.close());
  assert.equal(ownerStream.status, 200, "and so does the owner");

  streams.pop()!.close();
  await eventually(() => s.srv.ctx.eventLog["subscribers"].size === MAX_ADMIN_STREAMS + 1, 2000);
  const again = await openEvents(s.base, token.secret, route);
  t.after(() => again.close());
  assert.equal(again.status, 200, "a closed stream frees its place");

  for (let i = 1; i < MAX_ADMIN_STREAMS; i++) {
    const es = await openEvents(s.base, ADMIN_TOKEN, route);
    t.after(() => es.close());
    assert.equal(es.status, 200);
  }
  assert.equal((await s.call("GET", route, { token: ADMIN_TOKEN })).status, 429, "the owner token is counted per address");
});

test("online: a TV is online while a stream is open and for the grace period after; a reconnect does not flap; events say so", async (t) => {
  const s = await startTestServer({ offlineGraceMs: 200 });
  t.after(() => s.close());
  const tv = await s.pair("TV");
  const online = () => s.srv.ctx.events.isOnline(tv.deviceId);
  const onlineEvents = async () => types((await admin(s, "?after=0&types=device.online,device.offline")).json.events);
  assert.equal(online(), false, "offline until it connects");

  const es = await openEvents(s.base, tv.token);
  await es.next();
  assert.equal(online(), true);
  assert.deepEqual(await onlineEvents(), ["device.online"]);
  assert.equal((await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "pause" })).json.online, true);

  es.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(online(), true, "still online within the grace period");
  const again = await openEvents(s.base, tv.token);
  await again.next();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(online(), true);
  assert.deepEqual(await onlineEvents(), ["device.online"], "the reconnect produced no offline/online pair");

  again.close();
  await eventually(() => !online(), 2000);
  assert.deepEqual(await onlineEvents(), ["device.online", "device.offline"]);
  assert.equal((await s.admin("GET", `/devices/${tv.deviceId}`)).json.device.online, false);
  assert.equal((await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "pause" })).json.online, false);

  // A deleted TV's stream is closed without an offline event.
  const third = await openEvents(s.base, tv.token);
  await third.next();
  await s.admin("DELETE", `/devices/${tv.deviceId}`);
  // (The unacknowledged pause commands are replayed first.)
  await assert.rejects(third.next((m) => m.event === "state", 2000), /stream ended/);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await onlineEvents(), ["device.online", "device.offline", "device.online"]);
  assert.equal(online(), false);
});

test("status: every active TV in one call with lastEventId read first; nowPlaying while a viewing runs, with its id", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const tv = await s.pair("Salon");
  await s.call("POST", "/api/v1/pair/start");
  const approvedOnly = await s.call("POST", "/api/v1/pair/start");
  await s.admin("POST", "/pair/approve", { code: approvedOnly.json.code });

  let st = (await s.admin("GET", "/status")).json;
  assert.deepEqual(st, {
    serverNowMs: s.clock.now(), server: { version: st.server.version }, catalog: { id: "fixture", buildId: "fixture-1" }, pairing: { pending: 2 },
    devices: [{ id: tv.deviceId, name: "Salon", online: false, lastSeenAt: "2026-10-10T12:00:00.000Z", nowPlaying: null }],
    lastEventId: (await admin(s, "")).json.last,
  });
  assert.equal(st.devices.length, 1, "the approved but uncollected TV is not active yet");

  await s.call("POST", "/api/v1/tv/resolve", { token: tv.token, body: { episodeId: "show.e1" } });
  st = (await s.admin("GET", "/status")).json;
  assert.deepEqual(
    (({ itemId, episodeId, itemTitle, episodeTitle, state, positionMs }) => ({ itemId, episodeId, itemTitle, episodeTitle, state, positionMs }))(st.devices[0].nowPlaying),
    { itemId: "show", episodeId: "show.e1", itemTitle: "Şov Dünyası", episodeTitle: "Pilot", state: "starting", positionMs: 0 },
  );
  assert.equal(st.devices[0].nowPlaying.viewingId, s.srv.ctx.viewings.running(tv.deviceId)!.id);
  await s.call("POST", "/api/v1/tv/progress", { token: tv.token, body: { episodeId: "show.e1", positionMs: 5000, durationMs: 1_200_000, status: "paused" } });
  assert.equal((await s.admin("GET", "/status")).json.devices[0].nowPlaying.state, "paused");
  await s.call("POST", "/api/v1/tv/progress", { token: tv.token, body: { episodeId: "show.e1", positionMs: 6000, durationMs: 1_200_000, status: "stopped" } });
  assert.equal((await s.admin("GET", "/status")).json.devices[0].nowPlaying, null);
  assert.ok((await s.admin("GET", `/devices/${tv.deviceId}/now`)).json.nowPlaying, "the now route keeps answering the last report");
});
