import { test } from "node:test";
import assert from "node:assert/strict";
import { logged, openEvents, testServer, type Json } from "./helpers.ts";

test("play: by item it is what OK plays at send time, on the home list or not; both ids must agree; positionMs in the payload", async (t) => {
  const s = await testServer(t);
  const tv = await s.pair("Salon");
  const send = (body: Json) => s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "play", ...body });
  // The pilot finished: OK on the show now plays episode 2.
  await s.call("POST", "/api/v1/tv/progress", { token: tv.token, body: { episodeId: "show.e1", positionMs: 1_200_000, durationMs: 1_200_000, status: "finished" } });

  const good: Array<[Json, Json]> = [
    [{ itemId: "show" }, { itemId: "show", episodeId: "show.e2" }],
    [{ itemId: "film", positionMs: 0 }, { itemId: "film", episodeId: "film.main", positionMs: 0 }],
    [{ itemId: "show", episodeId: "show.e4", positionMs: 754_000 }, { itemId: "show", episodeId: "show.e4", positionMs: 754_000 }],
    [{ episodeId: "show.e1", positionMs: 1e12 }, { itemId: "show", episodeId: "show.e1", positionMs: 1e12 }],
    [{ episodeId: "silent.main" }, { itemId: "silent", episodeId: "silent.main" }],
  ];
  for (const [body] of good) assert.equal((await send(body)).status, 202, JSON.stringify(body));
  assert.deepEqual(s.srv.ctx.store.pendingCommands(tv.deviceId, 0).map((c) => c.payload), good.map(([, payload]) => payload));

  const bad: Array<[Json, number, string]> = [
    [{ itemId: "ghost" }, 404, "unknown_item"],
    [{ itemId: "ghost", episodeId: "show.e1" }, 404, "unknown_item"],
    [{ itemId: "show", episodeId: "film.main" }, 400, "unknown_episode"],
    [{ episodeId: "ghost.e1" }, 400, "unknown_episode"],
    [{ itemId: "locked" }, 400, "not_playable"],
    [{ itemId: "show", episodeId: "show.e3" }, 400, "not_allowed"],
    [{}, 400, "invalid_request"],
    [{ positionMs: 0 }, 400, "invalid_request"],
    [{ itemId: "show", positionMs: -1 }, 400, "invalid_request"],
    [{ itemId: "show", positionMs: 1e12 + 1 }, 400, "invalid_request"],
    [{ itemId: "show", positionMs: 1.5 }, 400, "invalid_request"],
    [{ itemId: "show", deltaMs: 1000 }, 400, "invalid_request"],
  ];
  for (const [body, status, error] of bad) {
    const r = await send(body);
    assert.deepEqual([r.status, r.json.error], [status, error], JSON.stringify(body));
  }
  assert.equal(s.srv.ctx.store.pendingCommands(tv.deviceId, 0).length, good.length, "nothing was stored for refused bodies");
  assert.deepEqual((await s.admin("GET", `/devices/${tv.deviceId}`)).json.home, [], "playing an item does not put it on the home list");
});

test("play: a channel's item id plays it at its live edge (episodeId null, a positionMs left out); what is refused", async (t) => {
  const s = await testServer(t);
  const tv = await s.pair("Salon");
  const send = (body: Json) => s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "play", ...body });
  const es = await openEvents(s.base, tv.token);
  t.after(() => es.close());
  await es.next((m) => m.event === "state");

  const sent = await send({ itemId: "news" });
  assert.deepEqual([sent.status, sent.json.online], [202, true]);
  const event = await es.next((m) => m.event === "command");
  assert.deepEqual(JSON.parse(event.data!), { id: sent.json.id, type: "play", payload: { itemId: "news", episodeId: null } }, "the TV gets episodeId null, not a missing field");
  assert.equal((await send({ itemId: "news", positionMs: 754_000 })).status, 202);
  assert.deepEqual(s.srv.ctx.store.pendingCommands(tv.deviceId, 0).map((c) => c.payload), [
    { itemId: "news", episodeId: null },
    { itemId: "news", episodeId: null },
  ]);

  const bad: Array<[Json, number, string]> = [
    [{ itemId: "off-air" }, 400, "not_playable"],
    [{ itemId: "off-air", positionMs: 0 }, 400, "not_playable"],
    [{ itemId: "news", episodeId: "show.e1" }, 400, "unknown_episode"],
    [{ itemId: "news", episodeId: "news" }, 400, "unknown_episode"],
    [{ episodeId: "news" }, 400, "unknown_episode"], // a channel's id names no episode
  ];
  for (const [body, status, error] of bad) {
    const r = await send(body);
    assert.deepEqual([r.status, r.json.error], [status, error], JSON.stringify(body));
  }
  assert.equal((await send({ itemId: "off-air" })).json.itemId, "off-air", "not_playable names the channel");
  assert.equal(s.srv.ctx.store.pendingCommands(tv.deviceId, 0).length, 2, "nothing was stored for refused bodies");

  // The TV acts on it and says so; the command keeps its payload.
  s.clock.advance(1000);
  await s.call("POST", `/api/v1/tv/commands/${sent.json.id}/ack`, { token: tv.token });
  s.clock.advance(2000);
  assert.equal((await s.call("POST", `/api/v1/tv/commands/${sent.json.id}/result`, { token: tv.token, body: { result: "done" } })).status, 200);
  assert.deepEqual((await s.admin("GET", `/devices/${tv.deviceId}/commands/${sent.json.id}`)).json.command, {
    id: sent.json.id, type: "play", payload: { itemId: "news", episodeId: null }, actor: { type: "owner" }, createdAt: "2026-10-10T12:00:00.000Z",
    deliveredAt: "2026-10-10T12:00:01.000Z", result: "done", reason: null, resultAt: "2026-10-10T12:00:03.000Z",
  });
  const queued = logged(s, "command queued");
  assert.equal(queued.length, 2);
  for (const line of queued) assert.deepEqual(Object.keys(line).sort(), ["commandId", "deviceId", "level", "msg", "time", "type"], "type and ids only");
});

test("results: reported once per command by its TV, with the command.result event; GET shows every field", async (t) => {
  const s = await testServer(t);
  const tv = await s.pair("Salon");
  const other = await s.pair("Other");
  const play = (await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "play", itemId: "film" })).json.id;
  const pause = (await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "pause" })).json.id;
  const report = (id: unknown, body: unknown, token = tv.token) => s.call("POST", `/api/v1/tv/commands/${id}/result`, { token, body });
  const get = (id: unknown, deviceId = tv.deviceId) => s.admin("GET", `/devices/${deviceId}/commands/${id}`);

  const fresh = await get(play);
  assert.deepEqual(fresh.json.command, {
    id: play, type: "play", payload: { itemId: "film", episodeId: "film.main" }, actor: { type: "owner" }, createdAt: "2026-10-10T12:00:00.000Z",
    deliveredAt: null, result: null, reason: null, resultAt: null,
  });

  s.clock.advance(1000);
  await s.call("POST", `/api/v1/tv/commands/${play}/ack`, { token: tv.token });
  s.clock.advance(4000);
  assert.deepEqual((await report(play, { result: "done" })).json, { ok: true });
  assert.deepEqual((await report(pause, { result: "ignored", reason: "not_in_player" })).json, { ok: true });
  const reported = (await get(play)).json.command;
  assert.deepEqual([reported.deliveredAt, reported.result, reported.reason, reported.resultAt], ["2026-10-10T12:00:01.000Z", "done", null, "2026-10-10T12:00:05.000Z"]);
  assert.deepEqual([(await get(pause)).json.command.result, (await get(pause)).json.command.reason], ["ignored", "not_in_player"]);

  const refused: Array<[unknown, unknown, string, number, string]> = [
    [play, { result: "failed" }, tv.token, 409, "already_reported"],
    [play, { result: "done" }, other.token, 404, "unknown_command"],
    [9999, { result: "done" }, tv.token, 404, "unknown_command"],
    ["abc", { result: "done" }, tv.token, 404, "unknown_command"],
    [pause, { result: "ok" }, tv.token, 400, "invalid_request"],
    [pause, { result: "done", reason: "" }, tv.token, 400, "invalid_request"],
    [pause, { result: "done", reason: "x".repeat(65) }, tv.token, 400, "invalid_request"],
    [pause, { result: "done", reason: "has space" }, tv.token, 400, "invalid_request"],
    [pause, {}, tv.token, 400, "invalid_request"],
  ];
  for (const [id, body, token, status, error] of refused) {
    const r = await report(id, body, token);
    assert.deepEqual([r.status, r.json.error], [status, error], `${id} ${JSON.stringify(body)}`);
  }
  assert.equal((await get(play)).json.command.result, "done", "the first report stays");
  for (const [id, deviceId] of [[play, other.deviceId], [9999, tv.deviceId], ["abc", tv.deviceId]] as const) {
    const r = await get(id, deviceId);
    assert.deepEqual([r.status, r.json.error], [404, "unknown_command"], `${deviceId} ${id}`);
  }
  assert.equal((await get(play, "ghost")).json.error, "unknown_device");

  const events = (await s.admin("GET", "/events?after=0&types=command.result")).json.events;
  assert.deepEqual(events.map((e: Json) => [e.deviceId, e.actor, e.data]), [
    [tv.deviceId, { type: "tv", deviceId: tv.deviceId }, { commandId: play, type: "play", result: "done", reason: null }],
    [tv.deviceId, { type: "tv", deviceId: tv.deviceId }, { commandId: pause, type: "pause", result: "ignored", reason: "not_in_player" }],
  ]);
});
