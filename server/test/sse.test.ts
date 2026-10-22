import { test } from "node:test";
import assert from "node:assert/strict";
import { eventually, openEvents, startTestServer, testServer } from "./helpers.ts";

test("SSE: initial state, pings, state events on change, commands; no replay after the replay window", async (t) => {
  const s = await testServer(t, { pingMs: 50 });
  const tv = await s.pair("TV");
  assert.equal((await s.call("GET", "/api/v1/tv/events")).status, 401);

  const es = await openEvents(s.base, tv.token);
  t.after(() => es.close());
  assert.equal(es.status, 200);
  assert.match(es.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(es.headers.get("x-accel-buffering"), "no");
  const first = await es.next();
  const v0 = JSON.parse(first.data!).version;
  assert.deepEqual([first.event, first.id, v0], ["state", `s${v0}`, (await s.call("GET", "/api/v1/tv/state", { token: tv.token })).json.version]);
  assert.equal((await es.next((m) => m.comment === "ping")).comment, "ping");
  await eventually(() => s.srv.ctx.events.isOnline(tv.deviceId));
  assert.equal((await s.admin("GET", "/devices")).json.devices[0].online, true);

  await s.admin("PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["show"] });
  const changed = await es.next();
  assert.deepEqual([changed.event, JSON.parse(changed.data!)], ["state", { version: v0 + 1 }]);

  await s.admin("PATCH", `/devices/${tv.deviceId}`, { preferredAudioLanguage: "en" });
  assert.deepEqual(JSON.parse((await es.next()).data!), { version: v0 + 2 });

  const cmd = await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "play", episodeId: "show.e1" });
  const ev = await es.next();
  assert.deepEqual([ev.event, JSON.parse(ev.data!)], ["command", { id: cmd.json.id, type: "play", payload: { itemId: "show", episodeId: "show.e1" } }]);

  // Commands older than the replay window are not sent again, even when unacknowledged.
  es.close();
  await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "stop" });
  s.clock.advance(3 * 60_000);
  const es2 = await openEvents(s.base, tv.token);
  t.after(() => es2.close());
  assert.deepEqual(JSON.parse((await es2.next()).data!), { version: v0 + 2 });
  await assert.rejects(es2.next((m) => m.event === "command", 300), /timed out/);
});

test("SSE: commands reach the TV with their payloads, and come again in order until acknowledged", async (t) => {
  const s = await testServer(t);
  const tv = await s.pair("TV");
  const es = await openEvents(s.base, tv.token);
  t.after(() => es.close());
  const v0 = JSON.parse((await es.next()).data!).version;
  await eventually(() => s.srv.ctx.events.isOnline(tv.deviceId));

  const cases: Array<[{ type: string } & Record<string, unknown>, Record<string, unknown>]> = [
    [{ type: "pause" }, {}], [{ type: "next" }, {}], [{ type: "seek", positionMs: 600_000 }, { positionMs: 600_000 }],
    [{ type: "message", text: " Yemek hazır! " }, { text: "Yemek hazır!", durationSec: 15 }],
  ];
  const ids: number[] = [];
  for (const [body, payload] of cases) {
    const r = await s.admin("POST", `/devices/${tv.deviceId}/commands`, body);
    assert.deepEqual([r.status, r.json.online], [202, true]);
    const ev = await es.next();
    assert.deepEqual([ev.event, ev.id, JSON.parse(ev.data!)], ["command", `c${r.json.id}`, { id: r.json.id, type: body.type, payload }]);
    ids.push(r.json.id);
  }

  // Unacknowledged commands come again, in order and with the same payloads, when the TV reconnects; acked ones not.
  await s.call("POST", `/api/v1/tv/commands/${ids[0]}/ack`, { token: tv.token });
  es.close();
  assert.equal(s.srv.ctx.events.isOnline(tv.deviceId), true, "a closed stream keeps the TV online for a minute, so a reconnect does not flap");
  const again = await openEvents(s.base, tv.token);
  t.after(() => again.close());
  await again.next((m) => m.event === "state");
  const replayed = [];
  for (let i = 1; i < cases.length; i++) replayed.push(JSON.parse((await again.next((m) => m.event === "command")).data!));
  assert.deepEqual(replayed.map((c) => [c.id, c.type, c.payload]), cases.slice(1).map(([body, payload], i) => [ids[i + 1], body.type, payload]));

  // The autoplay setting is part of the TV's state: a change is announced like any other.
  await s.admin("PATCH", `/devices/${tv.deviceId}`, { autoplayOnStart: true });
  assert.deepEqual(JSON.parse((await again.next((m) => m.event === "state")).data!), { version: v0 + 1 });
});

test("SSE: events only reach the addressed device; shutdown ends open streams", async (t) => {
  const s = await testServer(t);
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
