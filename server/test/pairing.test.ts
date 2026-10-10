import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers.ts";

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

test("pairing: at most five open codes, and pair/start is rate-limited per client", async (t) => {
  const s = await startTestServer({ pairing: { startLimit: { max: 7, windowMs: 60_000 } } });
  t.after(() => s.close());
  for (let i = 0; i < 5; i++) assert.equal((await s.call("POST", "/api/v1/pair/start")).status, 200);
  const sixth = await s.call("POST", "/api/v1/pair/start");
  assert.equal(sixth.status, 429);
  assert.equal(sixth.json.error, "too_many_pending");
  assert.equal((await s.call("POST", "/api/v1/pair/start")).json.error, "too_many_pending");
  const limited = await s.call("POST", "/api/v1/pair/start");
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  s.clock.advance(60_001);
  // Window reset, but the five codes are still open.
  assert.equal((await s.call("POST", "/api/v1/pair/start")).json.error, "too_many_pending");
  s.clock.advance(10 * 60_000);
  assert.equal((await s.call("POST", "/api/v1/pair/start")).status, 200, "expired codes no longer count");
});

test("pairing: input validation", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  assert.equal((await s.call("GET", "/api/v1/pair/wait?code=12ab&wait=0", { token: "x" })).status, 400);
  assert.equal((await s.call("GET", "/api/v1/pair/wait?code=123456&wait=99", { token: "x" })).status, 400);
  assert.equal((await s.admin("POST", "/pair/approve", { code: "123456" })).status, 400);
  assert.equal((await s.admin("POST", "/pair/approve", { code: "123456", name: "TV" })).status, 404);
});
