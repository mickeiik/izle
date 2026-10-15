import { test } from "node:test";
import assert from "node:assert/strict";
import { errorMessage } from "../admin/lib.js";
import { RateLimiter } from "../src/ratelimit.ts";
import { ADMIN_TOKEN, startTestServer, type Json, type TestServer } from "./helpers.ts";

// A hostile guess with no run of 20 token characters: the log's string scrubbing would let it through, so only never
// logging the presented token keeps it out of the log.
const GUESS = "hostile.guess/of:the+admin=token~42";

const logged = (s: TestServer, msg: string): Json[] => s.logs.map((l) => JSON.parse(l)).filter((l) => l.msg === msg);

test("admin auth: ten failures lock the address out until the window ends, even with the right token", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const tv = await s.pair("Salon");
  const devices = (token: string | null) => s.call("GET", "/api/v1/admin/devices", { token });

  // Nine failures (wrong tokens on one route, missing ones on another); the right token keeps working in between and
  // is never counted.
  for (let i = 0; i < 9; i++) {
    const r = i % 3 === 2 ? await devices(null) : await s.call("POST", "/api/v1/admin/pair/approve", { token: GUESS, body: { code: "123456" } });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), 'Bearer realm="izle-admin"', "a 401 still signs the admin page out");
    assert.equal((await devices(ADMIN_TOKEN)).status, 200);
  }
  assert.equal((await devices(GUESS)).status, 401, "the tenth failure is an ordinary 401");

  const eleventh = await devices(GUESS);
  assert.equal(eleventh.status, 429);
  assert.equal(eleventh.json.error, "too_many_attempts");
  assert.equal(eleventh.headers.get("retry-after"), "600", "until the window that began with the first failure ends");
  assert.equal(eleventh.headers.get("www-authenticate"), null);
  const right = await devices(ADMIN_TOKEN);
  assert.equal(right.status, 429, "the right token gets the same answer, so the lockout tells a guesser nothing");
  assert.equal(right.json.error, "too_many_attempts");
  assert.equal(right.headers.get("retry-after"), "600");
  assert.equal((await devices(null)).status, 429);
  assert.equal((await s.call("POST", "/api/v1/admin/pair/approve", { token: ADMIN_TOKEN, body: { code: "123456" } })).status, 429, "every admin route");

  assert.equal((await s.call("GET", "/api/v1/tv/state", { token: tv.token })).status, 200, "device tokens are not affected");
  assert.equal((await s.call("POST", "/api/v1/pair/start")).status, 200, "nor is pairing");

  s.clock.advance(4 * 60_000);
  assert.equal((await devices(ADMIN_TOKEN)).headers.get("retry-after"), "360");
  s.clock.advance(6 * 60_000);
  assert.equal((await devices(ADMIN_TOKEN)).status, 200, "access is restored when the window ends");
  assert.equal((await devices(GUESS)).status, 401, "and a new window starts with the next failure");
  assert.equal((await devices(ADMIN_TOKEN)).status, 200);

  const failed = logged(s, "admin auth failed");
  assert.equal(failed.length, 11, "one warning per failure, none for the locked-out requests");
  assert.ok(failed.every((l) => l.level === "warn" && l.client === "127.0.0.1"));
  assert.deepEqual(
    failed.slice(0, 3).map((l) => [l.route, l.reason]),
    [
      ["/api/v1/admin/pair/approve", "wrong token"],
      ["/api/v1/admin/pair/approve", "wrong token"],
      ["/api/v1/admin/devices", "no token"],
    ],
    "the route template and what was wrong",
  );
  const locked = logged(s, "admin auth locked out");
  assert.equal(locked.length, 1, "one warning when the limit trips");
  assert.deepEqual(
    (({ level, client, failures, retryAfterSec }) => ({ level, client, failures, retryAfterSec }))(locked[0]),
    { level: "warn", client: "127.0.0.1", failures: 10, retryAfterSec: 600 },
  );
  for (const line of s.logs) {
    for (const secret of [GUESS, "hostile.guess", "the+admin=token", ADMIN_TOKEN, tv.token]) {
      assert.ok(!line.includes(secret), `leaked ${secret}: ${line}`);
    }
  }
});

test("admin auth: behind a trusted reverse proxy each X-Forwarded-For client is counted on its own", async (t) => {
  const s = await startTestServer({ configFile: { trustedProxies: ["127.0.0.1", "::1"] } });
  t.after(() => s.close());
  const devices = (client: string | null, token: string | null) =>
    s.call("GET", "/api/v1/admin/devices", { token, ...(client ? { headers: { "X-Forwarded-For": client } } : {}) }).then((r) => r.status);

  for (let i = 0; i < 10; i++) assert.equal(await devices("203.0.113.1", GUESS), 401);
  assert.equal(await devices("203.0.113.1", GUESS), 429);
  assert.equal(await devices("203.0.113.1", ADMIN_TOKEN), 429);
  assert.equal(await devices("198.51.100.7, 203.0.113.1", ADMIN_TOKEN), 429, "a forged prefix does not escape the lockout");
  assert.equal(await devices("203.0.113.2", ADMIN_TOKEN), 200, "another client behind the same proxy is not locked out");
  assert.equal(await devices("203.0.113.2", GUESS), 401, "and has a count of its own");
  assert.equal(await devices(null, ADMIN_TOKEN), 200, "nor is the proxy's own address (the shell's loopback calls)");

  assert.deepEqual(
    logged(s, "admin auth failed").map((l) => l.client),
    [...Array<string>(10).fill("203.0.113.1"), "203.0.113.2"],
  );
  assert.deepEqual(logged(s, "admin auth locked out").map((l) => l.client), ["203.0.113.1"]);
  assert.ok(!s.logs.some((l) => l.includes(GUESS) || l.includes(ADMIN_TOKEN)));
});

test("RateLimiter.check reports a used-up key without counting a hit", () => {
  let now = 0;
  const limiter = new RateLimiter(2, 60_000, () => now);
  assert.deepEqual(limiter.check("a"), { ok: true, retryAfterSec: 0 });
  limiter.hit("a");
  for (let i = 0; i < 5; i++) assert.equal(limiter.check("a").ok, true, "checking does not count");
  limiter.hit("a");
  now = 15_000;
  assert.deepEqual(limiter.check("a"), { ok: false, retryAfterSec: 45 });
  assert.equal(limiter.check("b").ok, true, "keys are independent");
  now = 60_000;
  assert.deepEqual(limiter.check("a"), { ok: true, retryAfterSec: 0 }, "the window has ended");
});

test("admin page: the lockout has owner-facing text", () => {
  assert.match(errorMessage("too_many_attempts"), /Too many wrong admin tokens .* Try again in 10 minutes\./);
});
