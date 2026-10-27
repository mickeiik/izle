import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { appLink, connectTarget } from "../connect/link.js";
import { CONNECT_FILES } from "../src/admin-files.ts";
import { ADMIN_TOKEN, createToken, logged, openEvents, testServer, type Json, type TestServer } from "./helpers.ts";

const CONNECT_DIR = new URL("../connect/", import.meta.url);

/** A paired TV and its calls: create an invite, poll it. */
async function tvWithInvite(s: TestServer, name = "Salon") {
  const tv = await s.pair(name);
  const invite = () => s.call("POST", "/api/v1/tv/phones/invite", { token: tv.token });
  const poll = (wait = 0) => s.call("GET", `/api/v1/tv/phones/invite?wait=${wait}`, { token: tv.token });
  return { ...tv, invite, poll };
}

const claim = (s: TestServer, body: Json) => s.call("POST", "/api/v1/phones/claim", { body });

/** Connects a phone through `tv`'s new invite; its secret and id. */
async function connectPhone(s: TestServer, tv: Awaited<ReturnType<typeof tvWithInvite>>, name = "Pixel 8") {
  const inv = await tv.invite();
  const r = await claim(s, { invite: inv.json.invite, name });
  if (r.status !== 201) throw new Error(`claim ${r.status} ${JSON.stringify(r.json)}`);
  return { secret: r.json.secret as string, id: r.json.phone.id as string };
}

test("a TV's invite: created, replaced by the next one, open until claimed or 5 minutes; the long-poll's answers", async (t) => {
  const s = await testServer(t);
  const tv = await tvWithInvite(s);
  assert.deepEqual([(await tv.poll()).status, (await tv.poll()).json.error], [404, "not_found"], "no invite yet");
  assert.equal((await s.call("POST", "/api/v1/tv/phones/invite")).status, 401, "a device token is needed");
  for (const wait of ["26", "-1", "x"]) assert.equal((await tv.poll(wait as never)).status, 400, wait);

  const first = await tv.invite();
  assert.equal(first.status, 200);
  assert.match(first.json.code, /^[0-9]{6}$/);
  assert.match(first.json.invite, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.json.expiresAt, "2026-10-10T12:05:00.000Z");
  assert.deepEqual((await tv.poll()).json, { status: "open", code: first.json.code, expiresAt: first.json.expiresAt });

  s.clock.advance(60_000);
  const second = await tv.invite();
  assert.notEqual(second.json.invite, first.json.invite);
  assert.deepEqual((await tv.poll()).json, { status: "open", code: second.json.code, expiresAt: "2026-10-10T12:06:00.000Z" });
  assert.equal((await claim(s, { invite: first.json.invite, name: "Old" })).status, 404, "the replaced invite stops working");

  s.clock.advance(5 * 60_000);
  const expired = await tv.poll();
  assert.deepEqual([expired.status, expired.json], [410, { error: "expired", status: "expired", message: expired.json.message }]);
  assert.equal((await claim(s, { invite: second.json.invite, name: "Late" })).status, 404, "an expired invite does not connect");
  assert.equal((await claim(s, { code: second.json.code, name: "Late" })).status, 404, "nor does its code");

  // Claimed: the long-poll answers at once, until the invite's expiry time.
  const third = await tv.invite();
  const waiting = tv.poll(20);
  await new Promise((r) => setTimeout(r, 50));
  const claimed = await claim(s, { code: third.json.code, name: "  Pixel 8  " });
  assert.equal(claimed.status, 201);
  const { phone, secret, deviceId } = claimed.json;
  assert.equal(deviceId, tv.deviceId);
  assert.match(secret, /^izph_[A-Za-z0-9_-]{43}$/);
  assert.match(phone.id, /^[A-Za-z0-9]{12}$/);
  assert.deepEqual(phone, { id: phone.id, name: "Pixel 8", createdAt: "2026-10-10T12:06:00.000Z", lastUsedAt: null, deviceId: tv.deviceId });
  const answer = { status: "claimed", phone: { id: phone.id, name: "Pixel 8" } };
  assert.deepEqual((await waiting).json, answer, "the waiting long-poll answers with the phone");
  assert.deepEqual((await tv.poll(20)).json, answer, "and so does the next, at once");
  assert.equal((await claim(s, { code: third.json.code, name: "Again" })).status, 404, "single use");
  assert.equal((await claim(s, { invite: third.json.invite, name: "Again" })).status, 404, "by the invite either");
  s.clock.advance(5 * 60_000);
  assert.equal((await tv.poll()).status, 410, "expired after its time even when claimed");
});

test("claims: by invite or code (exactly one), a name of 1 to 60 characters; 10 failed claims lock the address out", async (t) => {
  const s = await testServer(t);
  const tv = await tvWithInvite(s);
  const inv = (await tv.invite()).json;
  for (const body of [
    { invite: inv.invite }, { code: inv.code }, { name: "x" }, { invite: inv.invite, code: inv.code, name: "x" }, { code: "12345", name: "x" },
    { code: inv.code, name: "   " }, { code: inv.code, name: ` ${"x".repeat(61)} ` }, { code: inv.code, name: 7 }, { code: inv.code, name: "x", extra: 1 },
  ]) {
    const r = await claim(s, body);
    assert.deepEqual([r.status, r.json.error], [400, "invalid_request"], JSON.stringify(body));
  }
  assert.equal((await tv.poll()).json.status, "open", "refused bodies leave the invite open");

  for (let i = 0; i < 10; i++) {
    const r = await claim(s, i % 2 ? { code: "000000", name: "guess" } : { invite: "x".repeat(43), name: "guess" });
    assert.deepEqual([r.status, r.json.error], [404, "not_found"]);
  }
  const locked = await claim(s, { code: inv.code, name: "Pixel" });
  assert.deepEqual([locked.status, locked.json.error], [429, "rate_limited"], "even with the right code");
  assert.equal(locked.headers.get("retry-after"), "600");
  s.clock.advance(10 * 60_000);
  const fresh = (await tv.invite()).json;
  assert.equal((await claim(s, { code: fresh.code, name: ` ${"x".repeat(60)} ` })).status, 201, "60 characters after trimming; the lockout ends");
  assert.equal(logged(s, "phone claim failed").length, 10);

  // Successes are not counted; a TV may create 10 invites in 10 minutes.
  for (let i = 0; i < 9; i++) await connectPhone(s, tv, `Phone ${i}`);
  const eleventh = await tv.invite();
  assert.deepEqual([eleventh.status, eleventh.json.error], [429, "rate_limited"]);
  assert.ok(Number(eleventh.headers.get("retry-after")) > 0);
  assert.equal((await s.admin("GET", "/phones")).json.phones.length, 10);
});

test("a TV that leaves its screen cancels the open invite; a claimed one stays for its long-poll", async (t) => {
  const s = await testServer(t);
  const tv = await tvWithInvite(s);
  const cancel = () => s.call("DELETE", "/api/v1/tv/phones/invite", { token: tv.token });
  assert.equal((await s.call("DELETE", "/api/v1/tv/phones/invite")).status, 401, "a device token is needed");
  assert.equal((await cancel()).status, 204, "nothing to cancel is fine");

  const open = (await tv.invite()).json;
  const waiting = tv.poll(20);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await cancel()).status, 204);
  assert.deepEqual([(await waiting).status, (await tv.poll()).status], [404, 404], "the long-poll ends; no invite left");
  assert.equal((await claim(s, { code: open.code, name: "Late" })).status, 404, "its code no longer connects");
  assert.equal((await claim(s, { invite: open.invite, name: "Late" })).status, 404, "nor its invite");
  assert.equal(logged(s, "phone invite cancelled").length, 1);

  await connectPhone(s, tv);
  assert.equal((await cancel()).status, 204);
  assert.equal((await tv.poll()).json.status, "claimed", "a claimed invite stays");
});

test("100 failed claims by code from all addresses together refuse claims by code for 10 minutes; the QR code's invite still works", async (t) => {
  const s = await testServer(t, { configFile: { trustedProxies: ["127.0.0.1", "::1"] } });
  const tv = await tvWithInvite(s);
  const from = (client: string, body: Json) => s.call("POST", "/api/v1/phones/claim", { body, headers: { "X-Forwarded-For": client } });
  for (let i = 0; i < 100; i++) assert.equal((await from(`203.0.${i >> 4}.${i & 15}`, { code: "000000", name: "guess" })).status, 404);
  const inv = (await tv.invite()).json;
  const locked = await from("198.51.100.1", { code: inv.code, name: "Pixel" });
  assert.deepEqual([locked.status, locked.json.error], [429, "rate_limited"], "a fresh address, even with the right code");
  assert.equal(locked.headers.get("retry-after"), "600");
  assert.equal((await from("198.51.100.1", { invite: inv.invite, name: "Pixel" })).status, 201, "the invite is not guessable");
  s.clock.advance(10 * 60_000);
  const fresh = (await tv.invite()).json;
  assert.equal((await from("198.51.100.2", { code: fresh.code, name: "Tablet" })).status, 201, "the lockout ends");
});

test("a phone works at the owner level on every admin route, an access token cannot see the phones, and secrets never reach the log", async (t) => {
  const s = await testServer(t);
  const tv = await tvWithInvite(s);
  const phone = await connectPhone(s, tv);
  const as = (method: string, route: string, body?: unknown) => s.call(method, `/api/v1/admin${route}`, { token: phone.secret, body });

  for (const [method, route, body, status] of [
    ["GET", "/devices", undefined, 200], ["GET", "/tokens", undefined, 200], ["POST", "/tokens", { name: "agent", scope: "read" }, 201],
    ["GET", "/phones", undefined, 200], ["POST", "/pair/approve", { code: "123456" }, 404], ["POST", "/checks", { itemId: "nope" }, 404],
    ["PUT", "/companion/links/show.e1/en-orig", { offsetMs: 0, rate: 1 }, 200], ["DELETE", "/history/viewings/1", undefined, 404],
  ] as const) {
    assert.equal((await as(method, route, body)).status, status, `${method} ${route}`);
  }
  const listed = (await s.admin("GET", "/phones")).json.phones;
  assert.deepEqual(listed, [{ id: phone.id, name: "Pixel 8", createdAt: "2026-10-10T12:00:00.000Z", lastUsedAt: "2026-10-10T12:00:00.000Z", deviceId: tv.deviceId }]);
  assert.ok(!JSON.stringify(listed).includes("izph_"), "the secret is never listed");
  s.clock.advance(30_000);
  await as("GET", "/devices");
  assert.equal((await s.admin("GET", "/phones")).json.phones[0].lastUsedAt, "2026-10-10T12:00:00.000Z", "written at most once a minute");
  s.clock.advance(30_000);
  await as("GET", "/devices");
  assert.equal((await s.admin("GET", "/phones")).json.phones[0].lastUsedAt, "2026-10-10T12:01:00.000Z");

  const manage = await createToken(s, "manager", "manage");
  for (const [method, route] of [["GET", "/phones"], ["DELETE", `/phones/${phone.id}`]]) {
    const r = await s.call(method!, `/api/v1/admin${route}`, { token: manage.secret });
    assert.deepEqual([r.status, r.json.error, r.json.required], [403, "insufficient_scope", "owner"], `${method} ${route}`);
  }
  assert.equal((await s.call("GET", "/api/v1/tv/state", { token: phone.secret })).status, 401, "a phone is no TV");

  // The access log names the phone by its id; the secret, invites and codes are never logged.
  assert.ok(logged(s, "request").some((l) => l.route === "/api/v1/admin/devices" && l.actorId === phone.id));
  assert.deepEqual(logged(s, "phone connected").map((l) => [l.phoneId, l.deviceId]), [[phone.id, tv.deviceId]]);
  const inv = (await tv.invite()).json;
  await claim(s, { invite: inv.invite, name: "Tablet" });
  for (const line of s.logs) {
    for (const leak of [phone.secret, "izph_", inv.invite, inv.code, ADMIN_TOKEN]) assert.ok(!line.includes(leak), `leaked ${leak}: ${line}`);
  }
});

test("a wrong phone secret counts as a failed admin sign-in", async (t) => {
  const s = await testServer(t);
  for (let i = 0; i < 10; i++) assert.equal((await s.call("GET", "/api/v1/admin/devices", { token: `izph_${"A".repeat(43)}` })).status, 401);
  assert.equal((await s.admin("GET", "/devices")).status, 429, "the address is locked out");
  assert.equal(logged(s, "admin auth failed").length, 10);
});

test("disconnecting a phone: 401 from then on, its event stream and long-poll end, events say who; a phone may disconnect itself", async (t) => {
  const s = await testServer(t);
  const tv = await tvWithInvite(s);
  const phone = await connectPhone(s, tv);
  const other = await connectPhone(s, tv, "Tablet");

  const es = await openEvents(s.base, phone.secret, "/api/v1/admin/events/stream?after=0");
  t.after(() => es.close());
  assert.equal(es.status, 200);
  const connected = JSON.parse((await es.next((m) => m.event === "phone.connected")).data!);
  assert.deepEqual([connected.deviceId, connected.actor, connected.data], [tv.deviceId, { type: "phone", phoneId: phone.id, name: "Pixel 8" }, { phoneId: phone.id, name: "Pixel 8", deviceId: tv.deviceId }]);
  const last = (await s.admin("GET", "/events")).json.last;
  const poll = s.call("GET", `/api/v1/admin/events?after=${last}&wait=20`, { token: phone.secret });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal((await s.admin("DELETE", "/phones/nophone00000")).status, 404);
  assert.equal((await s.admin("DELETE", "/phones/not-an-id!")).status, 404);
  assert.equal((await s.call("DELETE", `/api/v1/admin/phones/${phone.id}`, { token: other.secret })).status, 204, "one phone disconnects another");
  await assert.rejects(es.next((m) => m.event === "phone.disconnected"), /stream ended/, "its stream ended");
  assert.equal((await poll).status, 401, "its long-poll answers 401");
  assert.equal((await s.call("GET", "/api/v1/admin/devices", { token: phone.secret })).status, 401);

  assert.equal((await s.call("DELETE", `/api/v1/admin/phones/${other.id}`, { token: other.secret })).status, 204, "and itself");
  assert.equal((await s.call("GET", "/api/v1/admin/devices", { token: other.secret })).status, 401);
  const events = (await s.admin("GET", "/events?after=0&types=phone.")).json.events.map((e: Json) => [e.type, e.deviceId, e.actor, e.data]);
  assert.deepEqual(events, [
    ["phone.connected", tv.deviceId, { type: "phone", phoneId: phone.id, name: "Pixel 8" }, { phoneId: phone.id, name: "Pixel 8", deviceId: tv.deviceId }],
    ["phone.connected", tv.deviceId, { type: "phone", phoneId: other.id, name: "Tablet" }, { phoneId: other.id, name: "Tablet", deviceId: tv.deviceId }],
    ["phone.disconnected", tv.deviceId, { type: "phone", phoneId: other.id, name: "Tablet" }, { phoneId: phone.id, name: "Pixel 8" }],
    ["phone.disconnected", tv.deviceId, { type: "phone", phoneId: other.id, name: "Tablet" }, { phoneId: other.id, name: "Tablet" }],
  ]);
  assert.deepEqual((await s.admin("GET", "/phones")).json.phones, []);
});

test("deleting the TV keeps its phones (deviceId null) and ends its invite", async (t) => {
  const s = await testServer(t);
  const tv = await tvWithInvite(s);
  const phone = await connectPhone(s, tv);
  const open = (await tv.invite()).json;
  assert.equal((await s.admin("DELETE", `/devices/${tv.deviceId}`)).status, 204);
  assert.deepEqual((await s.admin("GET", "/phones")).json.phones.map((p: Json) => [p.id, p.deviceId]), [[phone.id, null]]);
  assert.equal((await s.call("GET", "/api/v1/admin/devices", { token: phone.secret })).status, 200, "the phone still works");
  assert.equal((await claim(s, { code: open.code, name: "x" })).status, 404, "the deleted TV's invite is gone");
  assert.equal((await s.admin("DELETE", `/phones/${phone.id}`)).status, 204);
  const gone = (await s.admin("GET", "/events?after=0&types=phone.disconnected")).json.events[0];
  assert.deepEqual([gone.deviceId, gone.actor], [null, { type: "owner" }]);
});

test("/connect is served without a token under the admin page's CSP; its script reads the invite from the fragment", async (t) => {
  const s = await testServer(t);
  const admin = (await fetch(`${s.base}/admin/`)).headers.get("content-security-policy");
  const page = await fetch(`${s.base}/connect`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(page.headers.get("content-security-policy"), admin);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const html = await page.text();
  assert.match(html, /<script type="module" src="connect\/connect.js"><\/script>/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html) && !/\sstyle=|\son[a-z]+=/i.test(html), "no inline code or styles");
  for (const ref of [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]!)) {
    assert.equal((await fetch(`${s.base}/${ref}`)).status, 200, `${ref} (relative to /connect) is served`);
  }
  for (const [file, type] of Object.entries(CONNECT_FILES)) {
    const res = await fetch(`${s.base}/connect/${file}`);
    assert.deepEqual([res.status, res.headers.get("content-type"), res.headers.get("content-security-policy")], [200, type, admin], file);
    assert.equal(await res.text(), await readFile(new URL(file, CONNECT_DIR), "utf8"));
  }
  for (const bad of ["index.html", "nope.js", "..%2Fpackage.json", "constructor"]) assert.equal((await fetch(`${s.base}/connect/${bad}`)).status, 404, bad);
  const files = await readdir(CONNECT_DIR);
  assert.deepEqual(files.filter((f) => f !== "index.html").sort(), Object.keys(CONNECT_FILES).sort(), "every file of the page is allow-listed");
  for (const file of files.filter((f) => f.endsWith(".js"))) {
    const js = await readFile(new URL(file, CONNECT_DIR), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(js), `${file} parses no HTML and sends nothing`);
  }

  const invite = "AbC-_12345678901234567890123456789012345678";
  assert.equal(connectTarget({ origin: "https://tv.example.test", pathname: "/connect", hash: "" }), null);
  assert.equal(connectTarget({ origin: "https://tv.example.test", pathname: "/connect", hash: "#short" }), null);
  assert.deepEqual(connectTarget({ origin: "https://tv.example.test", pathname: "/connect", hash: `#${invite}` }), { server: "https://tv.example.test", invite });
  const behindPath = connectTarget({ origin: "http://192.168.1.5:8787", pathname: "/izle/connect", hash: `#${invite}` })!;
  assert.deepEqual(behindPath, { server: "http://192.168.1.5:8787/izle", invite });
  assert.equal(
    appLink(behindPath),
    `intent://connect?server=http%3A%2F%2F192.168.1.5%3A8787%2Fizle&invite=${invite}#Intent;scheme=izle-companion;package=io.github.mickeiik.izle.companion;end`,
  );
});
