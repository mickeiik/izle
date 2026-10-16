import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, startTestServer, type Json, type TestServer } from "./helpers.ts";

const logged = (s: TestServer, msg: string): Json[] => s.logs.map((l) => JSON.parse(l)).filter((l) => l.msg === msg);

/** Creates an access token through the API and returns its secret and id. */
async function createToken(s: TestServer, name: string, scope: string) {
  const r = await s.admin("POST", "/tokens", { name, scope });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { secret: r.json.secret as string, id: r.json.token.id as string };
}

test("access tokens: create (the secret shown once), list oldest first, lastUsedAt once a minute, revoke; the log never has the secret", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());

  const created = await s.admin("POST", "/tokens", { name: "  Kitchen agent ", scope: "control" });
  assert.equal(created.status, 201);
  assert.match(created.json.secret, /^izat_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(created.json.token, { id: created.json.token.id, name: "Kitchen agent", scope: "control", createdAt: "2026-10-10T12:00:00.000Z", lastUsedAt: null });
  assert.match(created.json.token.id, /^[A-Za-z0-9]{12}$/);
  const secret: string = created.json.secret;
  const id: string = created.json.token.id;

  assert.equal((await s.admin("POST", "/tokens", { name: "Kitchen agent", scope: "read" })).status, 409);
  assert.equal((await s.admin("POST", "/tokens", { name: "Kitchen agent", scope: "read" })).json.error, "duplicate_name");
  for (const body of [{ name: "x", scope: "owner" }, { name: "", scope: "read" }, { name: "x".repeat(61), scope: "read" }, { scope: "read" }, { name: "x" }]) {
    assert.equal((await s.admin("POST", "/tokens", body)).status, 400, JSON.stringify(body));
  }
  s.clock.advance(1000);
  const second = await createToken(s, "Scripts", "read");

  // Use updates lastUsedAt, written at most once a minute.
  const devices = (token: string) => s.call("GET", "/api/v1/admin/devices", { token });
  assert.equal((await devices(secret)).status, 200);
  const listed = (await s.admin("GET", "/tokens")).json.tokens;
  assert.deepEqual(listed.map((x: Json) => [x.name, x.scope, x.lastUsedAt]), [["Kitchen agent", "control", "2026-10-10T12:00:01.000Z"], ["Scripts", "read", null]]);
  assert.ok(!JSON.stringify(listed).includes("secret"), "the secret is never listed");
  s.clock.advance(30_000);
  await devices(secret);
  assert.equal((await s.admin("GET", "/tokens")).json.tokens[0].lastUsedAt, "2026-10-10T12:00:01.000Z", "not written again within the minute");
  s.clock.advance(30_000);
  await devices(secret);
  assert.equal((await s.admin("GET", "/tokens")).json.tokens[0].lastUsedAt, "2026-10-10T12:01:01.000Z");

  // The access log names the token by id (a field that redaction keeps), never the secret.
  const requests = logged(s, "request").filter((l) => l.route === "/api/v1/admin/devices");
  assert.deepEqual(requests.map((l) => l.actorId), [id, id, id]);
  assert.equal(logged(s, "request").find((l) => l.route === "/api/v1/admin/tokens" && l.method === "GET")?.actorId, undefined, "the owner has no actor id");
  assert.deepEqual(logged(s, "access token created").map((l) => [l.actorId, l.scope]), [[id, "control"], [second.id, "read"]]);

  assert.equal((await s.admin("DELETE", `/tokens/${id}`)).status, 204);
  assert.equal((await s.admin("DELETE", `/tokens/${id}`)).status, 404);
  assert.equal((await s.admin("DELETE", "/tokens/not-an-id!")).status, 404);
  assert.deepEqual((await s.admin("GET", "/tokens")).json.tokens.map((x: Json) => x.id), [second.id]);
  assert.equal((await devices(secret)).status, 401, "a revoked token is refused");
  assert.equal((await devices(second.secret)).status, 200);

  for (const line of s.logs) {
    for (const leak of [secret, second.secret, "izat_", ADMIN_TOKEN]) assert.ok(!line.includes(leak), `leaked ${leak}: ${line}`);
  }
});

test("scopes: each level against a representative route of every level; 403 insufficient_scope names what is needed and is not throttled", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const tv = await s.pair("Salon");
  const tokens = { read: await createToken(s, "r", "read"), control: await createToken(s, "c", "control"), manage: await createToken(s, "m", "manage") };

  // [method, route, body, required]: every route an access token may reach and some it may not. Statuses other
  // than 403 are what the route answers once the scope is enough (its own validation may still refuse the body).
  const routes: Array<[string, string, unknown, "read" | "control" | "manage" | "owner"]> = [
    ["GET", "/devices", undefined, "read"],
    ["GET", `/devices/${tv.deviceId}`, undefined, "read"],
    ["GET", `/devices/${tv.deviceId}/problems`, undefined, "read"],
    ["GET", `/devices/${tv.deviceId}/companion`, undefined, "read"],
    ["GET", "/pair/pending", undefined, "read"],
    ["GET", "/catalog", undefined, "read"],
    ["GET", "/status", undefined, "read"],
    ["GET", "/events", undefined, "read"],
    ["POST", `/devices/${tv.deviceId}/commands`, { type: "pause" }, "control"],
    ["GET", `/devices/${tv.deviceId}/commands/1`, undefined, "read"],
    ["PUT", `/devices/${tv.deviceId}/home`, { itemIds: ["show"] }, "manage"],
    ["POST", `/devices/${tv.deviceId}/home/items`, { itemId: "film" }, "manage"],
    ["PATCH", `/devices/${tv.deviceId}/home/items/film`, { position: 0 }, "manage"],
    ["DELETE", `/devices/${tv.deviceId}/home/items/film`, undefined, "manage"],
    ["PUT", `/devices/${tv.deviceId}/cursor`, { itemId: "show", episodeId: "show.e1" }, "manage"],
    ["PATCH", `/devices/${tv.deviceId}`, { name: "Salon" }, "manage"],
    ["DELETE", `/devices/${tv.deviceId}/problems`, undefined, "manage"],
    ["POST", "/catalog/reload", undefined, "manage"],
    ["GET", "/tokens", undefined, "owner"],
    ["POST", "/tokens", { name: "x", scope: "read" }, "owner"],
    ["DELETE", `/tokens/${tokens.read.id}`, undefined, "owner"],
    ["POST", "/pair/approve", { code: "123456" }, "owner"],
    ["DELETE", `/devices/${tv.deviceId}`, undefined, "owner"],
    ["POST", `/devices/${tv.deviceId}/history/adopt`, { fromDeviceId: "gone" }, "owner"],
    ["POST", "/diagnostics/resolve", { episodeId: "show.e1" }, "owner"],
    ["POST", `/devices/${tv.deviceId}/companion/resolve`, { episodeId: "show.e1", sourceId: "en-orig" }, "owner"],
    ["PUT", "/companion/links/show.e1/en-orig", { offsetMs: 0, rate: 1 }, "owner"],
  ];
  const level = { read: 0, control: 1, manage: 2, owner: 3 };
  let refused = 0;
  for (const [method, route, body, required] of routes) {
    for (const scope of ["read", "control", "manage"] as const) {
      const r = await s.call(method, `/api/v1/admin${route}`, { token: tokens[scope].secret, body });
      const label = `${scope} token on ${method} ${route}`;
      if (level[scope] < level[required]) {
        refused++;
        assert.equal(r.status, 403, label);
        assert.deepEqual(r.json, { error: "insufficient_scope", required, message: r.json.message }, label);
      } else {
        assert.notEqual(r.status, 403, label);
        assert.notEqual(r.status, 401, label);
      }
    }
  }
  assert.ok(refused > 10, "the owner-only routes were refused for every token");
  assert.equal((await s.call("GET", "/api/v1/admin/devices", { token: tokens.read.secret })).status, 200, "403s do not count as failed sign-ins");
  assert.equal((await s.call("GET", "/api/v1/admin/nowhere", { token: tokens.read.secret })).status, 404, "an unmatched path is 404 for a token too");
  assert.equal(logged(s, "admin auth failed").length, 0);
});

test("a revoked (or wrong) access token counts as a failed sign-in and locks the address out like a wrong owner token", async (t) => {
  const s = await startTestServer();
  t.after(() => s.close());
  const { secret, id } = await createToken(s, "old app", "read");
  await s.admin("DELETE", `/tokens/${id}`);
  const devices = (token: string) => s.call("GET", "/api/v1/admin/devices", { token });
  for (let i = 0; i < 9; i++) assert.equal((await devices(secret)).status, 401);
  assert.equal((await devices("izat_notevenclose")).status, 401, "the tenth failure");
  assert.equal((await devices(secret)).status, 429);
  assert.equal((await devices(ADMIN_TOKEN)).status, 429, "the owner is locked out from that address too");
  assert.equal(logged(s, "admin auth failed").length, 10);
  assert.deepEqual(new Set(logged(s, "admin auth failed").map((l) => l.reason)), new Set(["wrong token"]));
  assert.ok(!s.logs.some((l) => l.includes(secret) || l.includes("izat_")), "the revoked secret is never logged");
});
