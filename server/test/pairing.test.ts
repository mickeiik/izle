import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { databaseFile } from "../src/config.ts";
import { openEvents, startTestServer, type Json, type TestServer } from "./helpers.ts";

test("pairing: start → pending → approve → token delivered exactly once", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const start = await s.call("POST", "/api/v1/pair/start");
  assert.equal(start.status, 200);
  assert.match(start.json.code, /^[0-9]{6}$/);
  assert.ok(start.json.pairToken.length >= 43);
  assert.equal(Date.parse(start.json.expiresAt) - s.clock.now(), 10 * 60_000);
  const wait = (token = start.json.pairToken, w = 0) => s.call("GET", `/api/v1/pair/wait?code=${start.json.code}&wait=${w}`, { token });

  assert.deepEqual((await wait()).json, { status: "pending" });
  assert.equal((await s.call("GET", `/api/v1/pair/wait?code=${start.json.code}&wait=0`)).status, 401, "pair token required");
  assert.equal((await wait("wrong-token-wrong-token-wrong-token")).status, 404, "a wrong pair token looks like an unknown code");

  const pending = await s.admin("GET", "/pair/pending");
  assert.deepEqual(pending.json.codes.map((c: { code: string }) => c.code), [start.json.code]);

  const approve = await s.admin("POST", "/pair/approve", { code: start.json.code, name: "  Salon TV " });
  assert.equal(approve.status, 200);
  const deviceId = approve.json.deviceId;
  assert.equal((await s.admin("POST", "/pair/approve", { code: start.json.code, name: "again" })).status, 409);

  const devices = await s.admin("GET", "/devices");
  assert.equal(devices.json.devices[0].status, "pending");
  assert.equal(devices.json.devices[0].name, "Salon TV");

  const done = await wait();
  assert.equal(done.status, 200);
  assert.equal(done.json.status, "approved");
  assert.equal(done.json.deviceId, deviceId);
  assert.ok(done.json.deviceToken.length >= 43);
  const again = await wait();
  assert.equal(again.status, 410, "the token is handed out once");
  assert.equal(again.json.status, "expired");

  const state = await s.call("GET", "/api/v1/tv/state", { token: done.json.deviceToken });
  assert.equal(state.status, 200);
  assert.equal(state.json.device.name, "Salon TV");
  assert.equal((await s.admin("GET", "/devices")).json.devices[0].status, "active");
});

test("pairing: a waiting long-poll is woken by the approval", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const start = await s.call("POST", "/api/v1/pair/start");
  const started = Date.now();
  const polling = s.call("GET", `/api/v1/pair/wait?code=${start.json.code}&wait=10`, { token: start.json.pairToken });
  await new Promise((r) => setTimeout(r, 100));
  await s.admin("POST", "/pair/approve", { code: start.json.code, name: "TV" });
  const r = await polling;
  assert.equal(r.json.status, "approved");
  assert.ok(Date.now() - started < 5000);
});

test("pairing: codes expire after 10 minutes", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const start = await s.call("POST", "/api/v1/pair/start");
  s.clock.advance(10 * 60_000 + 1);
  const r = await s.call("GET", `/api/v1/pair/wait?code=${start.json.code}&wait=0`, { token: start.json.pairToken });
  assert.equal(r.status, 410);
  assert.equal((await s.admin("POST", "/pair/approve", { code: start.json.code, name: "TV" })).status, 404);
});

test("pairing: at most two open codes per client, with Retry-After, and pair/start is rate-limited per client", async (t) => {
  const s = await startTestServer({ pairing: { startLimit: { max: 4, windowMs: 60_000 } } });
  t.after(() => s.close());
  assert.equal((await s.call("POST", "/api/v1/pair/start")).status, 200);
  s.clock.advance(30_000);
  assert.equal((await s.call("POST", "/api/v1/pair/start")).status, 200);
  const third = await s.call("POST", "/api/v1/pair/start");
  assert.deepEqual([third.status, third.json.error], [429, "too_many_pending"]);
  assert.equal(third.headers.get("retry-after"), String(10 * 60 - 30), "seconds until this client's first code expires");
  assert.equal((await s.call("POST", "/api/v1/pair/start")).json.error, "too_many_pending");
  const limited = await s.call("POST", "/api/v1/pair/start");
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  s.clock.advance(60_001);
  // Window reset, but the two codes are still open.
  assert.equal((await s.call("POST", "/api/v1/pair/start")).json.error, "too_many_pending");
  s.clock.advance(10 * 60_000);
  assert.equal((await s.call("POST", "/api/v1/pair/start")).status, 200, "expired codes no longer count");
});

test("pairing: one client cannot keep another from getting a code, across expiry cycles; ten open codes at most", async (t) => {
  const s = await startTestServer({ configFile: { trustedProxies: ["127.0.0.1", "::1"] } });
  t.after(() => s.close());
  const start = (client: string) => s.call("POST", "/api/v1/pair/start", { headers: { "X-Forwarded-For": client } });
  for (let cycle = 0; cycle < 4; cycle++) {
    // The flooder starts first and keeps asking, inside its own rate limit.
    const flood = [];
    for (let i = 0; i < 5; i++) flood.push((await start("203.0.113.66")).status);
    assert.deepEqual(flood, [200, 200, 429, 429, 429], `cycle ${cycle}`);
    const tv = await start("198.51.100.10");
    assert.equal(tv.status, 200, `cycle ${cycle}: the TV gets a code`);
    const pending = (await s.admin("GET", "/pair/pending")).json.codes.map((c: Json) => c.code);
    assert.equal(pending.length, 3);
    assert.ok(pending.includes(tv.json.code));
    s.clock.advance(10 * 60_000 + 1_000);
  }

  // The server-wide backstop: ten open codes, then too_many_pending for everybody, with Retry-After.
  for (let i = 0; i < 5; i++) for (const n of [0, 1]) assert.equal((await start(`192.0.2.${i + 1}`)).status, 200, `client ${i} code ${n}`);
  s.clock.advance(5_000);
  const full = await start("198.51.100.10");
  assert.deepEqual([full.status, full.json.error], [429, "too_many_pending"]);
  assert.equal(full.headers.get("retry-after"), String(10 * 60 - 5), "seconds until the earliest open code expires");
});

test("pairing: the owner clears a code nobody should approve; the TV's wait answers 410", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const stranger = await s.call("POST", "/api/v1/pair/start");
  const mine = await s.call("POST", "/api/v1/pair/start");
  const waiting = s.call("GET", `/api/v1/pair/wait?code=${stranger.json.code}&wait=10`, { token: stranger.json.pairToken });
  await new Promise((r) => setTimeout(r, 50));
  const started = Date.now();

  const manage = (await s.admin("POST", "/tokens", { name: "agent", scope: "manage" })).json.secret;
  const refused = await s.call("DELETE", `/api/v1/admin/pair/pending/${stranger.json.code}`, { token: manage });
  assert.deepEqual([refused.status, refused.json.error], [403, "insufficient_scope"], "owner only");

  assert.equal((await s.admin("DELETE", `/pair/pending/${stranger.json.code}`)).status, 204);
  const woken = await waiting;
  assert.deepEqual([woken.status, woken.json.status], [410, "expired"]);
  assert.ok(Date.now() - started < 5000, "the long-poll ends at once");
  assert.deepEqual((await s.admin("GET", "/pair/pending")).json.codes.map((c: Json) => c.code), [mine.json.code]);
  assert.equal((await s.admin("POST", "/pair/approve", { code: stranger.json.code })).status, 404, "a cleared code cannot be approved");
  for (const code of [stranger.json.code, "000000", "12ab"]) {
    const again = await s.admin("DELETE", `/pair/pending/${code}`);
    assert.deepEqual([again.status, again.json.error], [404, "unknown_code"], code);
  }

  // An approved code that was never collected: clearing it removes the device created for it.
  const approved = await s.admin("POST", "/pair/approve", { code: mine.json.code, name: "Wrong" });
  assert.equal((await s.admin("GET", "/devices")).json.devices.length, 1);
  assert.equal((await s.admin("DELETE", `/pair/pending/${mine.json.code}`)).status, 204);
  assert.equal((await s.call("GET", `/api/v1/pair/wait?code=${mine.json.code}&wait=0`, { token: mine.json.pairToken })).status, 410);
  assert.deepEqual((await s.admin("GET", "/devices")).json.devices, [], `${approved.json.deviceId} is gone`);

  // The freed slots count again for the client.
  assert.equal((await s.call("POST", "/api/v1/pair/start")).status, 200);
  const events = (await s.admin("GET", "/events?after=0&types=pairing.cancelled")).json.events;
  assert.deepEqual(events.map((e: Json) => [e.actor, e.data]), [[{ type: "owner" }, { code: stranger.json.code }], [{ type: "owner" }, { code: mine.json.code }]]);
});

test("pairing: behind a trusted reverse proxy the rate limit counts each X-Forwarded-For client", async (t) => {
  const limit = { pairing: { startLimit: { max: 2, windowMs: 60_000 } } };
  const start = (s: TestServer, client: string) =>
    s.call("POST", "/api/v1/pair/start", { headers: { "X-Forwarded-For": client } }).then((r) => r.status);

  const behindProxy = await startTestServer({ ...limit, configFile: { trustedProxies: ["127.0.0.1", "::1"] } });
  t.after(() => behindProxy.close());
  assert.deepEqual([await start(behindProxy, "203.0.113.1"), await start(behindProxy, "203.0.113.1")], [200, 200]);
  assert.equal(await start(behindProxy, "203.0.113.1"), 429);
  assert.equal(await start(behindProxy, "203.0.113.2"), 200, "another TV behind the same proxy has its own limit");
  assert.equal(await start(behindProxy, "198.51.100.7, 203.0.113.1"), 429, "a forged prefix does not escape the limit");

  // Without trustedProxies the header is ignored: every request counts for the socket address.
  const direct = await startTestServer(limit);
  t.after(() => direct.close());
  assert.deepEqual([await start(direct, "203.0.113.1"), await start(direct, "203.0.113.2")], [200, 200]);
  assert.equal(await start(direct, "203.0.113.3"), 429);
});

test("pairing: input validation", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  assert.equal((await s.call("GET", "/api/v1/pair/wait?code=12ab&wait=0", { token: "x" })).status, 400);
  assert.equal((await s.call("GET", "/api/v1/pair/wait?code=123456&wait=99", { token: "x" })).status, 400);
  assert.equal((await s.admin("POST", "/pair/approve", { code: "123456" })).status, 404, "the name is optional");
  assert.equal((await s.admin("POST", "/pair/approve", { code: "123456", name: "   " })).status, 400, "a blank name is a mistake");
  assert.equal((await s.admin("POST", "/pair/approve", { code: "123456", name: "TV" })).status, 404);
});

test("pairing: approving without a name calls the TV \"TV\", then \"TV 2\", …", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const approve = async (name?: string) => {
    const start = await s.call("POST", "/api/v1/pair/start");
    const r = await s.admin("POST", "/pair/approve", { code: start.json.code, ...(name === undefined ? {} : { name }) });
    assert.equal(r.status, 200);
    return r.json as { deviceId: string; name: string };
  };
  assert.equal((await approve()).name, "TV");
  assert.equal((await approve()).name, "TV 2");
  assert.equal((await approve("  Kitchen ")).name, "Kitchen", "a given name is trimmed and kept");
  assert.equal((await approve("tv 3")).name, "tv 3");
  assert.equal((await approve()).name, "TV 4", "taken names are skipped regardless of case");
  const devices = (await s.admin("GET", "/devices")).json.devices.map((d: { name: string }) => d.name).sort();
  assert.deepEqual(devices, ["Kitchen", "TV", "TV 2", "TV 4", "tv 3"]);
});

test("replacing a TV: the new TV takes over the device and everything stored for it; the old token stops working", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const old = await s.pair("Salon");
  const d = old.deviceId;
  await s.admin("PUT", `/devices/${d}/home`, { itemIds: ["show", "film"] });
  const films = (await s.admin("POST", `/devices/${d}/home/sections`, { title: "Films", layout: "row", position: 0 })).json.sectionId;
  await s.admin("PATCH", `/devices/${d}/home/items/film`, { sectionId: films });
  await s.admin("PATCH", `/devices/${d}`, { autoplayOnStart: true });
  await s.call("POST", "/api/v1/tv/progress", { token: old.token, body: { episodeId: "show.e1", positionMs: 60_000, durationMs: 1_200_000, status: "stopped" } });
  const oldStream = await openEvents(s.base, old.token);
  t.after(() => oldStream.close());
  await oldStream.next((m) => m.event === "state");

  const start = await s.call("POST", "/api/v1/pair/start");
  const code = start.json.code;
  const pendingId = (await s.admin("POST", "/pair/approve", { code: (await s.call("POST", "/api/v1/pair/start")).json.code })).json.deviceId;
  for (const replaces of ["ghost", pendingId]) {
    const r = await s.admin("POST", "/pair/approve", { code, replaces });
    assert.deepEqual([r.status, r.json.error], [404, "unknown_device"], `replaces ${replaces}`);
  }
  assert.deepEqual((await s.admin("POST", "/pair/approve", { code, name: "Ignored", replaces: d })).json, { deviceId: d, name: "Salon" });
  assert.equal((await s.call("GET", "/api/v1/tv/state", { token: old.token })).status, 200, "until the code is collected the old TV goes on");

  const done = await s.call("GET", `/api/v1/pair/wait?code=${code}&wait=0`, { token: start.json.pairToken });
  assert.deepEqual([done.json.status, done.json.deviceId], ["approved", d]);
  assert.equal((await s.call("GET", "/api/v1/tv/state", { token: old.token })).status, 401, "the old TV pairs again by itself");
  await assert.rejects(oldStream.next(() => false), /stream ended/, "the old TV's event stream is closed");

  const state = (await s.call("GET", "/api/v1/tv/state", { token: done.json.deviceToken })).json;
  assert.deepEqual([state.device.id, state.device.name, state.device.autoplayOnStart], [d, "Salon", true]);
  assert.deepEqual(state.home.map((h: Json) => [h.item.id, h.continue.positionMs]), [["film", 0], ["show", 60_000]]);
  assert.deepEqual(state.homeSections.map((x: Json) => [x.id, x.title, x.layout, x.itemIds]), [[films, "Films", "row", ["film"]], ["untitled", null, "grid", ["show"]]], "and its sections");
  assert.deepEqual((await s.admin("GET", "/devices")).json.devices.map((x: Json) => x.id).sort(), [d, pendingId].sort(), "no device was created");
  const paired = (await s.admin("GET", "/events?after=0&types=device.paired")).json.events.map((e: Json) => [e.deviceId, e.data]);
  assert.deepEqual(paired, [[d, { name: "Salon", replaced: false }], [d, { name: "Salon", replaced: true }]]);
});

test("replacing a TV: a code that expires uncollected changes nothing, also after the purge", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const old = await s.pair("Salon");
  const start = await s.call("POST", "/api/v1/pair/start");
  assert.equal((await s.admin("POST", "/pair/approve", { code: start.json.code, replaces: old.deviceId })).status, 200);
  s.clock.advance(10 * 60_000 + 1);
  assert.equal((await s.call("GET", `/api/v1/pair/wait?code=${start.json.code}&wait=0`, { token: start.json.pairToken })).status, 410);
  s.clock.advance(60 * 60_000);
  s.srv.ctx.pairing.purge();
  assert.equal(s.srv.ctx.store.getPairCode(start.json.code), null, "the code is purged");
  assert.equal((await s.call("GET", "/api/v1/tv/state", { token: old.token })).json.device.id, old.deviceId, "the device and its token stay");
});

test("replacing a TV: deleting the TV before the new one collects its token deletes the code with it", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const old = await s.pair("Salon");
  const start = await s.call("POST", "/api/v1/pair/start");
  assert.equal((await s.admin("POST", "/pair/approve", { code: start.json.code, replaces: old.deviceId })).status, 200);
  assert.equal((await s.admin("DELETE", `/devices/${old.deviceId}`)).status, 204);
  const r = await s.call("GET", `/api/v1/pair/wait?code=${start.json.code}&wait=0`, { token: start.json.pairToken });
  assert.deepEqual([r.status, r.json.error], [404, "not_found"], "no token is handed out for a device that is gone");
  assert.equal((await s.admin("GET", "/events?after=0&types=device.paired")).json.events.length, 1);
});

test("history adopt: a deleted TV's viewings go to an existing one, under its name", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const gone = await s.pair("Old TV");
  const tv = await s.pair("New TV");
  const db = new DatabaseSync(databaseFile(s.config));
  t.after(() => db.close());
  const insert = db.prepare(`INSERT INTO viewings (device_id, device_name, catalog_id, item_id, episode_id, started_at, trigger, actor_json)
    VALUES (?, ?, 'fixture', 'show', 'show.e1', 0, 'viewer', '{"type":"server"}')`);
  for (const [id, name] of [[gone.deviceId, "Old TV"], [gone.deviceId, "Old TV"], ["elsewhere00", "Third"]]) insert.run(id, name);
  const adopt = (body: unknown, id = tv.deviceId) => s.admin("POST", `/devices/${id}/history/adopt`, body);

  const refused: Array<[unknown, string, number, string]> = [
    [{ fromDeviceId: gone.deviceId }, tv.deviceId, 409, "device_exists"],
    [{ fromDeviceId: tv.deviceId }, tv.deviceId, 409, "device_exists"],
    [{ fromDeviceId: gone.deviceId }, "ghost", 404, "unknown_device"],
    [{}, tv.deviceId, 400, "invalid_request"],
  ];
  for (const [body, id, status, error] of refused) {
    const r = await adopt(body, id);
    assert.deepEqual([r.status, r.json.error], [status, error], `${id} ${JSON.stringify(body)}`);
  }
  await s.admin("DELETE", `/devices/${gone.deviceId}`);
  assert.deepEqual((await adopt({ fromDeviceId: gone.deviceId })).json, { moved: 2 });
  assert.deepEqual((await adopt({ fromDeviceId: gone.deviceId })).json, { moved: 0 });
  const rows = db.prepare("SELECT device_id, device_name FROM viewings ORDER BY id").all().map((r) => [r.device_id, r.device_name]);
  assert.deepEqual(rows, [[tv.deviceId, "New TV"], [tv.deviceId, "New TV"], ["elsewhere00", "Third"]]);
  const events = (await s.admin("GET", "/events?after=0&types=history.changed")).json.events;
  assert.deepEqual(events.map((e: Json) => [e.deviceId, e.actor, e.data]), [[tv.deviceId, { type: "owner" }, { moved: 2 }]], "nothing moved, nothing to announce");
});
