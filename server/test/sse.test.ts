import { test } from "node:test";
import assert from "node:assert/strict";
import { eventually, openEvents, startTestServer } from "./helpers.ts";

test("SSE: initial state, pings, state events on change, commands with replay until acked", async (t) => {
  const s = await startTestServer({ pingMs: 50 });
  t.after(() => s.close());
  const tv = await s.pair("TV");
  assert.equal((await s.call("GET", "/api/v1/tv/events")).status, 401);

  const es = await openEvents(s.base, tv.token);
  t.after(() => es.close());
  assert.equal(es.status, 200);
  assert.match(es.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(es.headers.get("x-accel-buffering"), "no");
  const first = await es.next();
  assert.equal(first.event, "state");
  const v0 = JSON.parse(first.data!).version;
  assert.equal(first.id, `s${v0}`);
  assert.equal(v0, (await s.call("GET", "/api/v1/tv/state", { token: tv.token })).json.version);

  const ping = await es.next((m) => m.comment === "ping");
  assert.equal(ping.comment, "ping");
  await eventually(() => s.srv.ctx.events.isOnline(tv.deviceId));
  assert.equal((await s.admin("GET", "/devices")).json.devices[0].online, true);

  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["show"] });
  const changed = await es.next();
  assert.deepEqual([changed.event, JSON.parse(changed.data!)], ["state", { version: v0 + 1 }]);

  await s.admin("PATCH", `/devices/${tv.deviceId}`, { preferredAudioLanguage: "en" });
  assert.deepEqual(JSON.parse((await es.next()).data!), { version: v0 + 2 });

  const cmd = await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "play", episodeId: "show.e1" });
  assert.equal(cmd.json.online, true);
  const ev = await es.next();
  assert.equal(ev.event, "command");
  assert.deepEqual(JSON.parse(ev.data!), { id: cmd.json.id, type: "play", payload: { itemId: "show", episodeId: "show.e1" } });

  // Reconnect: current version first, then the unacknowledged command again.
  es.close();
  await eventually(() => !s.srv.ctx.events.isOnline(tv.deviceId));
  const es2 = await openEvents(s.base, tv.token);
  t.after(() => es2.close());
  assert.deepEqual(JSON.parse((await es2.next()).data!), { version: v0 + 2 });
  const replayed = await es2.next();
  assert.equal(replayed.event, "command");
  assert.equal(JSON.parse(replayed.data!).id, cmd.json.id);
  es2.close();

  await s.call("POST", `/api/v1/tv/commands/${cmd.json.id}/ack`, { token: tv.token });
  const es3 = await openEvents(s.base, tv.token);
  t.after(() => es3.close());
  await es3.next((m) => m.event === "state");
  await assert.rejects(es3.next((m) => m.event === "command", 300), /timed out/, "acked commands are not replayed");

  // Commands older than the replay window are dropped even when unacknowledged.
  es3.close();
  await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "stop" });
  s.clock.advance(3 * 60_000);
  const es4 = await openEvents(s.base, tv.token);
  t.after(() => es4.close());
  await es4.next((m) => m.event === "state");
  await assert.rejects(es4.next((m) => m.event === "command", 300), /timed out/);
});

test("SSE: pause, resume, next, previous, seek and message commands reach the TV with their payloads", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const tv = await s.pair("TV");
  const es = await openEvents(s.base, tv.token);
  t.after(() => es.close());
  const v0 = JSON.parse((await es.next()).data!).version;
  await eventually(() => s.srv.ctx.events.isOnline(tv.deviceId));

  const cases: Array<[{ type: string } & Record<string, unknown>, Record<string, unknown>]> = [
    [{ type: "pause" }, {}],
    [{ type: "resume" }, {}],
    [{ type: "next" }, {}],
    [{ type: "previous" }, {}],
    [{ type: "seek", deltaMs: -30_000 }, { deltaMs: -30_000 }],
    [{ type: "seek", positionMs: 600_000 }, { positionMs: 600_000 }],
    [{ type: "message", text: " Yemek hazır! " }, { text: "Yemek hazır!", durationSec: 15 }],
    [{ type: "message", text: "Good night", durationSec: 30 }, { text: "Good night", durationSec: 30 }],
  ];
  const ids: number[] = [];
  for (const [body, payload] of cases) {
    const r = await s.admin("POST", `/devices/${tv.deviceId}/commands`, body);
    assert.equal(r.status, 202);
    assert.equal(r.json.online, true);
    const ev = await es.next();
    assert.equal(ev.event, "command");
    assert.equal(ev.id, `c${r.json.id}`);
    assert.deepEqual(JSON.parse(ev.data!), { id: r.json.id, type: body.type, payload });
    ids.push(r.json.id);
  }

  // Unacknowledged commands come again, in order and with the same payloads, when the TV reconnects.
  await s.call("POST", `/api/v1/tv/commands/${ids[0]}/ack`, { token: tv.token });
  es.close();
  await eventually(() => !s.srv.ctx.events.isOnline(tv.deviceId));
  const again = await openEvents(s.base, tv.token);
  t.after(() => again.close());
  await again.next((m) => m.event === "state");
  const replayed = [];
  for (let i = 1; i < cases.length; i++) replayed.push(JSON.parse((await again.next((m) => m.event === "command")).data!));
  assert.deepEqual(
    replayed.map((c) => [c.id, c.type, c.payload]),
    cases.slice(1).map(([body, payload], i) => [ids[i + 1], body.type, payload]),
  );

  // The autoplay setting is part of the TV's state: a change is announced like any other.
  await s.admin("PATCH", `/devices/${tv.deviceId}`, { autoplayOnStart: true });
  assert.deepEqual(JSON.parse((await again.next((m) => m.event === "state")).data!), { version: v0 + 1 });
});

test("SSE: deleting a device ends its stream", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const tv = await s.pair("TV");
  const es = await openEvents(s.base, tv.token);
  t.after(() => es.close());
  await es.next();
  await s.admin("DELETE", `/devices/${tv.deviceId}`);
  await assert.rejects(es.next(undefined, 2000), /stream ended/);
  assert.equal((await s.call("GET", "/api/v1/tv/events", { token: tv.token })).status, 401);
});

test("SSE: events only reach the addressed device; shutdown ends open streams", async (t) => {
  const s = await startTestServer();
  const a = await s.pair("A");
  const b = await s.pair("B");
  const esA = await openEvents(s.base, a.token);
  const esB = await openEvents(s.base, b.token);
  await esA.next();
  await esB.next();
  await s.admin("PUT", `/devices/${a.deviceId}/home`, { itemIds: ["film"] });
  assert.equal((await esA.next()).event, "state");
  await assert.rejects(esB.next(undefined, 300), /timed out/);
  await s.close();
  await assert.rejects(esA.next(undefined, 2000), /stream ended/);
  t.after(() => {
    esA.close();
    esB.close();
  });
});
