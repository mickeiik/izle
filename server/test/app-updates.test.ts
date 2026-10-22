import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APK_MEDIA_TYPE, ApkRejected, checksumFor, parseApkName, parseTvUserAgent, versionCodeOf } from "../src/app-updates.ts";
import { OWNER, SERVER } from "../src/actor.ts";
import { VERSION } from "../src/version.ts";
import { ADMIN_TOKEN, createToken, eventually, logged, openEvents, startTestServer, testServer, type Json, type TestServer, type TestServerOptions } from "./helpers.ts";
import { heads, upstream } from "./media-helpers.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** Bytes that pass for an APK on the server: the zip magic, then noise. */
const fakeApk = (size = 100 * 1024) => Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), randomBytes(size - 4)]);
const UA = (version: string, sdk: number, code: number, cap: string) => `izle-tv/${version} (Android ${sdk}; ${code}; ${cap})`;

/** A body without a Content-Length: `first`, then `n` chunks of `size` random bytes, `delayMs` apart. */
const chunked = (first: Buffer, n: number, size: number, delayMs = 0) => {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (i > 0 && i <= n && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (i > n) c.close();
      else c.enqueue(new Uint8Array(i === 0 ? first : randomBytes(size)));
      i++;
    },
  });
};

/** PUT /admin/app/apk with the owner token (or `token`), the APK media type and the name in the header. */
async function upload(s: TestServer, body: Buffer | ReadableStream<Uint8Array> | null, name: string | null, o: { token?: string; type?: string; query?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${o.token ?? ADMIN_TOKEN}`, "Content-Type": o.type ?? APK_MEDIA_TYPE, ...o.headers };
  if (name !== null) headers["X-Izle-Filename"] = name;
  const init: RequestInit & { duplex?: "half" } = { method: "PUT", headers, body };
  if (body instanceof ReadableStream) init.duplex = "half";
  const res = await fetch(`${s.base}/api/v1/admin/app/apk${o.query ?? ""}`, init);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const appDir = (s: TestServer) => path.join(s.config.dataDir, "app");
const appFiles = (s: TestServer) => (existsSync(appDir(s)) ? readdirSync(appDir(s)).sort() : []);
const appEvents = async (s: TestServer) => (await s.admin("GET", "/events?after=0&types=app.,device.app_version&limit=500")).json.events as Json[];

test("versions: versionCode as the app's Gradle build has it; file names and User-Agents parsed strictly", () => {
  assert.equal(versionCodeOf("0.3.0"), 300);
  assert.equal(versionCodeOf("1.2.3-rc.1"), 10203);
  assert.deepEqual(parseApkName("izle-tv-0.3.0.apk"), { versionName: "0.3.0", versionCode: 300 });
  assert.deepEqual(parseApkName("izle-tv-12.34.56-beta.2.apk"), { versionName: "12.34.56-beta.2", versionCode: 123456 });
  for (const bad of ["x.apk", "izle-tv-0.3.apk", "../izle-tv-0.3.0.apk", "izle-tv-0.3.0.apk/", "izle-tv-0.100.0.apk", "izle-tv-01.3.0.apk", "izle-tv-0.3.0.APK",
    "izle-tv-0.3.0-debug.apk ", `izle-tv-0.3.0-${"a".repeat(300)}.apk`, "izle-tv-999999.0.0.apk", "https://x.example/izle-tv-0.3.0.apk"]) {
    assert.equal(parseApkName(bad), null, bad);
  }
  assert.deepEqual(parseTvUserAgent("izle-tv/0.2.0 (Android 25; 200; guided)"), { version: "0.2.0", androidSdk: 25, versionCode: 200, capability: "guided" });
  assert.deepEqual(parseTvUserAgent("izle-tv/1.0.0-rc.1 (Android 34; 10000; silent)"), { version: "1.0.0-rc.1", androidSdk: 34, versionCode: 10000, capability: "silent" });
  for (const bad of [undefined, "", "okhttp/4.12.0", "izle-tv/0.2.0 (Android 25; 200; loud)", "izle-tv/0.2.0 (Android 25; 200; guided) x", "izle-tv/0.2 (Android 25; 200; guided)",
    `izle-tv/0.2.0-${"a".repeat(200)} (Android 25; 200; guided)`, "izle-tv/https://evil.example/ (Android 25; 200; guided)", "izle-tv/0.2.0 (Android 1234; 200; guided)"]) {
    assert.equal(parseTvUserAgent(bad), null, String(bad));
  }
  assert.equal(checksumFor(`${"a".repeat(64)}  izle-tv-0.3.0-debug.apk\n${"B".repeat(64)}  izle-tv-0.3.0.apk\n`, "izle-tv-0.3.0.apk"), "b".repeat(64));
  assert.equal(checksumFor(`${"c".repeat(64)} *izle-tv-0.3.0.apk\r\n`, "izle-tv-0.3.0.apk"), "c".repeat(64));
  assert.equal(checksumFor(`${"c".repeat(63)}  izle-tv-0.3.0.apk`, "izle-tv-0.3.0.apk"), null);
});

test("upload: stored by its content address, offered to the TVs, replaced and removed; a large body passes on this route only", async (t) => {
  const s = await testServer(t);
  const tv = await s.pair("Salon");
  const before = await s.admin("GET", "/app");
  assert.deepEqual(before.json, {
    apk: null, source: "manual", repo: "mickeiik/izle", auto: true, checkIntervalHours: 24, check: { lastAt: null, nextAt: null, result: null, reason: null, running: false },
  });
  assert.equal((await s.call("GET", "/api/v1/tv/app", { token: tv.token })).status, 204);
  assert.deepEqual((await s.call("GET", "/api/v1/tv/app/apk", { token: tv.token })).json, { error: "no_apk" });

  const bytes = fakeApk(200 * 1024);
  const up = await upload(s, bytes, "izle-tv-0.3.0.apk");
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.deepEqual(up.json.apk, { versionName: "0.3.0", versionCode: 300, sha256: sha(bytes), size: bytes.length, source: "upload", releaseTag: null, storedAt: "2026-10-10T12:00:00.000Z" });
  assert.deepEqual(appFiles(s), [`${sha(bytes)}.apk`]);
  assert.equal(statSync(appDir(s)).mode & 0o777, 0o700);
  assert.deepEqual((await s.admin("GET", "/app")).json.apk, up.json.apk);

  // Every other API route keeps the 64 KiB limit.
  const big = await s.admin("POST", `/devices/${tv.deviceId}/commands`, { type: "message", text: "x", pad: "y".repeat(70 * 1024) });
  assert.deepEqual([big.status, big.json], [413, { error: "body_too_large" }]);
  const bigPost = await fetch(`${s.base}/api/v1/admin/app/apk`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": APK_MEDIA_TYPE }, body: bytes });
  assert.equal(bigPost.status, 413, "only PUT on the upload route is exempt");

  const info = await s.call("GET", "/api/v1/tv/app", { token: tv.token });
  assert.deepEqual([info.status, info.json], [200, { versionName: "0.3.0", versionCode: 300, sha256: sha(bytes), size: bytes.length, auto: true }]);
  const apk = (method = "GET") => fetch(`${s.base}/api/v1/tv/app/apk`, { method, headers: { Authorization: `Bearer ${tv.token}` } });
  const res = await apk();
  const served = [200, APK_MEDIA_TYPE, String(bytes.length), `"${sha(bytes)}"`, "no-store"];
  assert.deepEqual(heads(res, "content-type", "content-length", "etag", "cache-control"), served);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes));
  assert.deepEqual(heads(await apk("HEAD"), "content-type", "content-length", "etag", "cache-control"), served);
  assert.equal((await s.call("GET", "/api/v1/tv/app/apk")).status, 401, "device auth");
  assert.equal((await s.call("GET", "/api/v1/tv/app", { token: ADMIN_TOKEN })).status, 401, "the admin token is not a device token");

  // The name may come in the query; a new APK replaces the file of the old one; the same bytes again keep it.
  const next = fakeApk(1000);
  const up2 = await upload(s, next, null, { query: "?name=izle-tv-0.3.1-rc.1.apk" });
  assert.deepEqual([up2.status, up2.json.apk.versionName, up2.json.apk.versionCode], [200, "0.3.1-rc.1", 301]);
  assert.deepEqual(appFiles(s), [`${sha(next)}.apk`]);
  assert.equal((await upload(s, next, "izle-tv-0.3.1-rc.1.apk")).status, 200);
  assert.deepEqual(appFiles(s), [`${sha(next)}.apk`]);

  assert.equal((await s.admin("DELETE", "/app/apk")).status, 204);
  assert.deepEqual((await s.admin("DELETE", "/app/apk")).json, { error: "no_apk" });
  assert.equal((await s.call("GET", "/api/v1/tv/app", { token: tv.token })).status, 204);
  const gone = await s.call("GET", "/api/v1/tv/app/apk", { token: tv.token });
  assert.deepEqual([gone.status, gone.json], [404, { error: "no_apk" }]);
  assert.deepEqual(appFiles(s), [], "the file is gone once the removal answered");

  const events = await appEvents(s);
  assert.deepEqual(events.map((e) => [e.type, e.actor, e.deviceId, e.data]), [
    ["app.uploaded", OWNER, null, { versionName: "0.3.0", versionCode: 300, source: "upload" }],
    ["app.uploaded", OWNER, null, { versionName: "0.3.1-rc.1", versionCode: 301, source: "upload" }],
    ["app.uploaded", OWNER, null, { versionName: "0.3.1-rc.1", versionCode: 301, source: "upload" }],
    ["app.removed", OWNER, null, { versionName: "0.3.1-rc.1" }],
  ]);
  // The log has the version and a prefix of the digest, never the whole digest.
  const stored = logged(s, "apk stored");
  assert.deepEqual(stored[0], { ...stored[0], versionName: "0.3.0", versionCode: 300, size: bytes.length, source: "upload", sha256Prefix: sha(bytes).slice(0, 12) });
  assert.deepEqual(Object.keys(stored[0]).sort(), ["level", "msg", "sha256Prefix", "size", "source", "time", "versionCode", "versionName"]);
  assert.ok(!s.logs.some((l) => /[0-9a-f]{64}/.test(l)));
});

test("upload: refused names, media types and bodies; the cap, also for a streamed body, leaves no file behind", async (t) => {
  const s = await testServer(t, { appUpdates: { maxBytes: 4096 } });
  const apk = fakeApk(1000);
  const refused = async (error: string, body: Buffer, name: string | null, o: Parameters<typeof upload>[3] = {}) => {
    const r = await upload(s, body, name, o);
    assert.deepEqual([r.status, r.json.error], [400, error], `${name} ${JSON.stringify(o)} ${body.toString("latin1")}`);
  };
  for (const name of ["x.apk", "izle-tv-0.3.apk", "../izle-tv-0.3.0.apk", `izle-tv-0.3.0-${"a".repeat(280)}.apk`, "izle-tv-0.3.0-debug.apk/../x", ""]) {
    await refused("invalid_filename", apk, name);
  }
  for (const query of ["", `?name=${encodeURIComponent("https://evil.example/izle-tv-0.3.0.apk")}`, "?name=izle-tv-0.3.0.apk%00"]) {
    await refused("invalid_filename", apk, null, { query });
  }
  for (const type of ["application/octet-stream", "application/json", "application/zip"]) await refused("unsupported_media_type", apk, "izle-tv-0.3.0.apk", { type });
  assert.equal((await upload(s, apk, "izle-tv-0.3.0.apk", { type: `${APK_MEDIA_TYPE}; charset=binary` })).status, 200, "parameters are ignored");
  assert.equal((await s.admin("DELETE", "/app/apk")).status, 204);

  for (const body of [Buffer.from("MZ\x90\x00 not a zip"), Buffer.from("PK\x05\x06"), Buffer.from("PK"), Buffer.alloc(0)]) await refused("not_an_apk", body, "izle-tv-0.3.0.apk");
  const over = await upload(s, fakeApk(4097), "izle-tv-0.3.0.apk");
  assert.deepEqual([over.status, over.json], [413, { error: "apk_too_large", message: over.json.message, maxBytes: 4096 }]);
  assert.equal((await upload(s, fakeApk(4096), "izle-tv-0.3.0.apk")).status, 200, "exactly the cap is fine");

  // Without a Content-Length the cap ends the stream; nothing is left in the app directory but the stored APK.
  const streamed = await upload(s, chunked(fakeApk(1000), 4, 1000), "izle-tv-0.4.0.apk");
  assert.deepEqual([streamed.status, streamed.json.error], [413, "apk_too_large"]);
  const store = (body: ReadableStream<Uint8Array>, sha?: string) => s.srv.ctx.appUpdates.store(body, "izle-tv-0.4.0.apk", "upload", null, OWNER, sha);
  await assert.rejects(store(chunked(fakeApk(1000), 9, 1000)), (e) => e instanceof ApkRejected && e.reason === "too_large");
  await assert.rejects(store(chunked(fakeApk(100), 0, 0), "0".repeat(64)), (e) => e instanceof ApkRejected && e.reason === "checksum_mismatch");
  const kept = (await s.admin("GET", "/app")).json.apk;
  assert.equal(kept.versionName, "0.3.0");
  assert.deepEqual(appFiles(s), [`${kept.sha256}.apk`]);
  assert.deepEqual((await appEvents(s)).map((e) => e.type), ["app.uploaded", "app.removed", "app.uploaded"]);
});

test("upload: a streamed body refused part-way still gets its answer, not a dropped connection", async (t) => {
  const s = await testServer(t);
  const notApk = await upload(s, chunked(Buffer.from("MZ\x90\x00 not a zip"), 10, 30 * 1024, 30), "izle-tv-0.3.0.apk");
  assert.deepEqual([notApk.status, notApk.json.error], [400, "not_an_apk"]);

  const small = await testServer(t, { appUpdates: { maxBytes: 64 * 1024 } });
  const over = await upload(small, chunked(fakeApk(10 * 1024), 9, 10 * 1024, 30), "izle-tv-0.3.0.apk");
  assert.deepEqual([over.status, over.json], [413, { error: "apk_too_large", message: over.json.message, maxBytes: 64 * 1024 }]);
  for (const x of [s, small]) {
    assert.deepEqual(appFiles(x), []);
    assert.equal((await upload(x, fakeApk(1000), "izle-tv-0.3.0.apk")).status, 200, "the server still takes uploads");
  }
});

test("store and remove: concurrent commits never leave the current APK without its file", async (t) => {
  const s = await testServer(t);
  const svc = s.srv.ctx.appUpdates;
  const body = (b: Buffer) => new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new Uint8Array(b)), c.close()) });
  const p = fakeApk(20 * 1024);
  const a = fakeApk(20 * 1024);
  const storeP = () => svc.store(body(p), "izle-tv-0.3.0.apk", "upload", null, OWNER);
  const storeA = () => svc.store(body(a), "izle-tv-0.3.1.apk", "github", "v0.3.1", SERVER);
  const onDisk = (what: string) => {
    const current = svc.current();
    assert.deepEqual(appFiles(s), current ? [`${current.sha256}.apk`] : [], what);
  };
  for (let i = 0; i < 20; i++) {
    await storeP();
    // The owner uploads P again while a GitHub check stores A.
    await Promise.all([storeA(), storeP()]);
    onDisk(`A and P again, round ${i}`);
    await Promise.all([storeP(), storeA()]);
    onDisk(`P again and A, round ${i}`);
    // A removal racing a re-upload of the APK it removes.
    const again = svc.current()!.sha256 === sha(p) ? storeP : storeA;
    await Promise.all([svc.remove(OWNER), again()]);
    onDisk(`remove and re-upload, round ${i}`);
    await Promise.all([again(), svc.remove(OWNER)]);
    onDisk(`re-upload and remove, round ${i}`);
  }
});

test("upload scopes: reading needs read, uploading, removing and checking need manage", async (t) => {
  const s = await testServer(t);
  const { secret: read } = await createToken(s, "r", "read");
  const { secret: control } = await createToken(s, "c", "control");
  const { secret: manage } = await createToken(s, "m", "manage");
  for (const token of [read, control]) {
    assert.deepEqual((await upload(s, fakeApk(1000), "izle-tv-0.3.0.apk", { token })).json, { error: "insufficient_scope", required: "manage", message: "this route needs the manage scope" });
    assert.equal((await s.call("DELETE", "/api/v1/admin/app/apk", { token })).status, 403);
    assert.equal((await s.call("POST", "/api/v1/admin/app/check", { token })).status, 403);
  }
  assert.equal((await s.call("GET", "/api/v1/admin/app", { token: read })).status, 200);
  const up = await upload(s, fakeApk(1000), "izle-tv-0.3.0.apk", { token: manage });
  assert.equal(up.status, 200);
  const ev = (await appEvents(s))[0];
  assert.equal(ev.actor.type, "token");
  assert.equal((await s.call("POST", "/api/v1/admin/app/check", { token: manage })).json.error, "github_disabled");
  assert.equal((await s.call("DELETE", "/api/v1/admin/app/apk", { token: manage })).status, 204);
  // Without a token: 401, before any body is read.
  const anon = await fetch(`${s.base}/api/v1/admin/app/apk`, { method: "PUT", headers: { "Content-Type": APK_MEDIA_TYPE, "X-Izle-Filename": "izle-tv-0.3.0.apk" }, body: fakeApk(1000) });
  assert.equal(anon.status, 401);
  assert.deepEqual(appFiles(s), []);
});

test("SSE: event app reaches every open TV stream when an APK is stored, and comes on connect after state", async (t) => {
  const s = await testServer(t);
  const a = await s.pair("A");
  const b = await s.pair("B");
  /** A TV's event stream, its first message (the state) read. */
  const connect = async (token: string) => {
    const es = await openEvents(s.base, token);
    t.after(() => es.close());
    assert.equal((await es.next()).event, "state");
    return es;
  };
  const esA = await connect(a.token);
  const esB = await connect(b.token);
  await assert.rejects(esA.next((m) => m.event === "app", 200), /timed out/, "nothing stored: no app event");

  assert.equal((await upload(s, fakeApk(1000), "izle-tv-0.3.0.apk")).status, 200);
  for (const es of [esA, esB]) {
    const ev = await es.next();
    assert.deepEqual([ev.event, ev.id, JSON.parse(ev.data!)], ["app", "a300", { versionCode: 300 }]);
  }

  const again = await connect(a.token);
  const onConnect = await again.next();
  assert.deepEqual([onConnect.event, onConnect.id, JSON.parse(onConnect.data!)], ["app", "a300", { versionCode: 300 }]);

  // A removal: versionCode 0, nothing on offer; a TV connecting afterwards hears nothing.
  assert.equal((await s.admin("DELETE", "/app/apk")).status, 204);
  for (const es of [esA, esB, again]) {
    const ev = await es.next((m) => m.event === "app");
    assert.deepEqual([ev.id, JSON.parse(ev.data!)], ["a0", { versionCode: 0 }]);
  }
  assert.equal((await s.call("GET", "/api/v1/tv/app", { token: a.token })).status, 204);
  await assert.rejects((await connect(b.token)).next((m) => m.event === "app", 200), /timed out/);
});

test("User-Agent: the TV's app version is recorded once per change; anything else is ignored", async (t) => {
  const s = await testServer(t);
  const tv = await s.pair("Salon");
  const other = await s.pair("Kitchen");
  const state = (ua: string, token = tv.token) => s.call("GET", "/api/v1/tv/state", { token, headers: { "User-Agent": ua } });
  const appOf = async (id = tv.deviceId) => (await s.admin("GET", `/devices/${id}`)).json.device.app;
  assert.deepEqual(await appOf(), { version: null, versionCode: null, androidSdk: null, capability: null, reportedAt: null, update: "unknown" });

  for (let i = 0; i < 3; i++) assert.equal((await state(UA("0.2.0", 25, 200, "guided"))).status, 200);
  assert.deepEqual(await appOf(), { version: "0.2.0", versionCode: 200, androidSdk: 25, capability: "guided", reportedAt: "2026-10-10T12:00:00.000Z", update: "unknown" });
  for (const ua of ["okhttp/4.12.0", `${UA("0.9.0", 25, 900, "guided")}${"x".repeat(5 * 1024)}`, "izle-tv/https://evil.example/a (Android 25; 900; guided)", `${UA("0.9.0", 25, 900, "guided")} okhttp/4.12.0`, `x ${UA("0.9.0", 25, 900, "guided")}`]) {
    assert.equal((await state(ua)).status, 200);
  }
  assert.equal((await appOf()).version, "0.2.0", "hostile User-Agents change nothing");
  // A wrong device token records nothing.
  assert.equal((await state(UA("0.9.0", 25, 900, "guided"), "wrong")).status, 401);

  assert.equal((await upload(s, fakeApk(1000), "izle-tv-0.3.0.apk")).status, 200);
  assert.equal((await appOf()).update, "needs_install_now", "guided: the owner starts the install");
  assert.equal((await appOf(other.deviceId)).update, "unknown", "never reported");
  s.clock.advance(60_000);
  await state(UA("0.3.0", 31, 300, "silent"));
  assert.deepEqual(await appOf(), { version: "0.3.0", versionCode: 300, androidSdk: 31, capability: "silent", reportedAt: "2026-10-10T12:01:00.000Z", update: "up_to_date" });
  assert.equal((await upload(s, fakeApk(1000), "izle-tv-0.3.1.apk")).status, 200);
  const rows = (await s.admin("GET", "/devices")).json.devices;
  assert.deepEqual(rows.map((d: Json) => [d.name, d.app.update]).sort(), [["Kitchen", "unknown"], ["Salon", "pending"]]);

  const events = (await appEvents(s)).filter((e) => e.type === "device.app_version");
  assert.deepEqual(events.map((e) => [e.deviceId, e.actor, e.data]), [
    [tv.deviceId, { type: "tv", deviceId: tv.deviceId }, { from: null, to: "0.2.0", versionCode: 200, androidSdk: 25, capability: "guided" }],
    [tv.deviceId, { type: "tv", deviceId: tv.deviceId }, { from: "0.2.0", to: "0.3.0", versionCode: 300, androidSdk: 31, capability: "silent" }],
  ]);
  const lines = logged(s, "device app version");
  assert.deepEqual(lines.map((l) => [l.deviceId, l.appVersion, l.versionCode, l.androidSdk, l.capability]), [[tv.deviceId, "0.2.0", 200, 25, "guided"], [tv.deviceId, "0.3.0", 300, 31, "silent"]]);
  for (const l of lines) assert.deepEqual(Object.keys(l).sort(), ["androidSdk", "appVersion", "capability", "deviceId", "level", "msg", "time", "versionCode"]);
  assert.ok(!s.logs.some((l) => l.includes("evil") || l.includes("xxxxxxxx")));
});

test("User-Agent: with automatic updates off, a silent TV behind the APK needs an install too", async (t) => {
  const s = await testServer(t, { configFile: { appUpdates: { source: "manual", auto: false } } });
  const tv = await s.pair("Salon");
  await s.call("GET", "/api/v1/tv/state", { token: tv.token, headers: { "User-Agent": UA("0.2.0", 33, 200, "silent") } });
  assert.equal((await upload(s, fakeApk(1000), "izle-tv-0.3.0.apk")).status, 200);
  assert.equal((await s.admin("GET", `/devices/${tv.deviceId}`)).json.device.app.update, "needs_install_now");
  assert.equal((await s.call("GET", "/api/v1/tv/app", { token: tv.token })).json.auto, false);
  assert.equal((await s.admin("GET", "/app")).json.auto, false);
});

test("update command: needs a stored APK, carries its versionCode, reaches the TV and takes the TV's results", async (t) => {
  const s = await testServer(t);
  const tv = await s.pair("Salon");
  const send = (body: unknown) => s.admin("POST", `/devices/${tv.deviceId}/commands`, body);
  const none = await send({ type: "update" });
  assert.deepEqual([none.status, none.json.error], [409, "no_apk"]);
  assert.equal(s.srv.ctx.store.pendingCommands(tv.deviceId, 0).length, 0);

  assert.equal((await upload(s, fakeApk(1000), "izle-tv-0.3.0.apk")).status, 200);
  const es = await openEvents(s.base, tv.token);
  t.after(() => es.close());
  await es.next((m) => m.event === "app");
  const { secret: control } = await createToken(s, "c", "control");
  const r = await s.call("POST", `/api/v1/admin/devices/${tv.deviceId}/commands`, { token: control, body: { type: "update" } });
  const ev = await es.next((m) => m.event === "command");
  assert.deepEqual([ev.id, JSON.parse(ev.data!)], [`c${r.json.id}`, { id: r.json.id, type: "update", payload: { versionCode: 300 } }]);
  assert.equal((await s.call("POST", `/api/v1/tv/commands/${r.json.id}/ack`, { token: tv.token })).status, 200);

  const results: Array<[string, string]> = [
    ["done", "installing"], ["done", "prompted"], ["ignored", "up_to_date"], ["ignored", "not_newer"], ["ignored", "busy"], ["ignored", "not_ready"],
    ["ignored", "declined"], ["ignored", "timeout"], ["failed", "download"], ["failed", "too_large"], ["failed", "verify"], ["failed", "wrong_package"],
    ["failed", "bad_archive"], ["failed", "install_failure_incompatible"],
  ];
  for (const [i, [result, reason]] of results.entries()) {
    const id = i === 0 ? r.json.id : (await send({ type: "update" })).json.id;
    const rep = await s.call("POST", `/api/v1/tv/commands/${id}/result`, { token: tv.token, body: { result, reason } });
    assert.equal(rep.status, 200, `${result} ${reason}`);
    const cmd = (await s.admin("GET", `/devices/${tv.deviceId}/commands/${id}`)).json.command;
    assert.deepEqual([cmd.type, cmd.payload, cmd.result, cmd.reason], ["update", { versionCode: 300 }, result, reason]);
  }
  const resultEvents = (await s.admin("GET", "/events?after=0&types=command.result&limit=500")).json.events;
  assert.deepEqual(resultEvents.map((e: Json) => [e.data.type, e.data.result, e.data.reason]), results.map(([result, reason]) => ["update", result, reason]));
});

test("reconcile: an APK whose file is gone is forgotten; leftovers of interrupted stores are deleted", async (t) => {
  const s = await testServer(t);
  const tv = await s.pair("Salon");
  const bytes = fakeApk(1000);
  assert.equal((await upload(s, bytes, "izle-tv-0.3.0.apk")).status, 200);
  const stray = path.join(appDir(s), `${"a".repeat(64)}.apk`);
  const temp = path.join(appDir(s), ".upload-0123456789abcdef.tmp");
  const foreign = path.join(appDir(s), "notes.txt");
  for (const f of [stray, temp, foreign]) writeFileSync(f, "x");
  s.srv.ctx.appUpdates.reconcile();
  assert.deepEqual(appFiles(s), [`${sha(bytes)}.apk`, "notes.txt"], "only what the store wrote is cleaned up");

  // The file disappears (a restored backup has the row only).
  unlinkSync(path.join(appDir(s), `${sha(bytes)}.apk`));
  assert.equal((await s.call("GET", "/api/v1/tv/app/apk", { token: tv.token })).status, 404);
  s.srv.ctx.appUpdates.reconcile();
  assert.equal((await s.admin("GET", "/app")).json.apk, null);
  assert.equal((await s.call("GET", "/api/v1/tv/app", { token: tv.token })).status, 204);
  assert.deepEqual(logged(s, "apk missing").map((l) => l.versionName), ["0.3.0"]);
});

// --- GitHub ---------------------------------------------------------------------------------------------------

const LATEST = "/repos/mickeiik/izle/releases/latest";

/** An in-process stand-in for GitHub's API and its release downloads. */
async function fakeGithub(t: { after(fn: () => unknown): void }) {
  // `release`: the release JSON, or a raw body.
  const state = { status: 200, headers: {} as Record<string, string>, release: null as Json, sums: "", apk: fakeApk(50 * 1024), hang: false };
  const gh = await upstream(t, (req, res) => {
    const p = req.url ?? "";
    if (state.hang) return; // never answers
    const json = typeof state.release === "string" ? state.release : JSON.stringify(state.release);
    if (p === LATEST) res.writeHead(state.status, { "Content-Type": "application/json", ...state.headers }).end(json);
    else if (p === "/dl/SHA256SUMS") res.writeHead(200, { "Content-Type": "text/plain" }).end(state.sums);
    else if (/^\/dl\/izle-tv-[^/]+\.apk$/.test(p)) res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(state.apk);
    else res.writeHead(404).end();
  });
  const asset = (name: string, size: number) => ({ name, size, browser_download_url: `${gh.url}/dl/${name}` });
  /** Serves `version`: the APK and a SHA256SUMS that lists it (with `sumOf`'s digest). */
  const publish = (version: string, apk = fakeApk(50 * 1024), sumOf = apk) => Object.assign(state, {
    apk, status: 200, headers: {}, hang: false,
    release: {
      tag_name: `v${version}`, name: `izle ${version}`, prerelease: false, draft: false, body: "notes with https://example.test/link",
      assets: [asset(`izle-tv-${version}-debug.apk`, 10), asset(`izle-tv-${version}.apk`, apk.length), asset("SHA256SUMS", 200), asset(`izle-server-${version}.tgz`, 10)],
    },
    sums: `${"0".repeat(64)}  izle-tv-${version}-debug.apk\n${sha(sumOf)}  izle-tv-${version}.apk\n${"1".repeat(64)}  izle-server-${version}.tgz\n`,
  });
  return { url: gh.url, state, publish, hits: gh.hits, count: (p: string) => gh.hits.filter((h) => h.path === p).length };
}
const github = (gh: { url: string }, extra: TestServerOptions = {}): TestServerOptions => ({
  ...extra, configFile: { appUpdates: { source: "github", repo: "mickeiik/izle" } }, githubApiBase: gh.url, appUpdates: { firstCheckDelayMs: 3_600_000, ...extra.appUpdates },
});

/** The log and events never carry the fake's address, URLs or a digest. */
async function assertNothingLeaked(s: TestServer, gh: { url: string }) {
  const events = JSON.stringify((await s.admin("GET", "/events?after=0&limit=500")).json.events);
  const port = new URL(gh.url).port;
  for (const [what, text] of [["log", s.logs.join("\n")], ["events", events]] as const) {
    assert.ok(!text.includes("://"), `${what}: no URL`);
    assert.ok(!text.includes("<url"), `${what}: no redacted URL either`);
    assert.ok(!text.includes(`127.0.0.1:${port}`), `${what}: not the fake's address`);
    assert.ok(!/api\.github|githubusercontent|browser_download/.test(text), `${what}: no GitHub hosts or fields`);
    assert.ok(!/[0-9a-f]{64}/.test(text), `${what}: no full digest`);
  }
}

test("GitHub: the latest release's APK is fetched, verified and offered; a second check is up to date without a download", async (t) => {
  const gh = await fakeGithub(t);
  const apk = fakeApk(80 * 1024);
  gh.publish("0.3.0", apk);
  const s = await testServer(t, github(gh));
  const tv = await s.pair("Salon");
  const es = await openEvents(s.base, tv.token);
  t.after(() => es.close());
  await es.next();
  assert.match((await s.admin("GET", "/app")).json.check.nextAt, /^2026-10-10T13:00:00/, "the first check is scheduled");

  const r = await s.admin("POST", "/app/check");
  assert.deepEqual(r.json, {
    result: "fetched", reason: null,
    apk: { versionName: "0.3.0", versionCode: 300, sha256: sha(apk), size: apk.length, source: "github", releaseTag: "v0.3.0", storedAt: "2026-10-10T12:00:00.000Z" },
  });
  assert.deepEqual([gh.count(LATEST), gh.count("/dl/SHA256SUMS"), gh.count("/dl/izle-tv-0.3.0.apk"), gh.count("/dl/izle-tv-0.3.0-debug.apk")], [1, 1, 1, 0]);
  const api = gh.hits[0]!.headers;
  assert.deepEqual([api["user-agent"], api.accept, api["x-github-api-version"], api.authorization], [`izle-server/${VERSION}`, "application/vnd.github+json", "2022-11-28", undefined]);
  assert.ok(gh.hits.every((h) => h.headers["user-agent"] === `izle-server/${VERSION}`));
  const ev = await es.next();
  assert.deepEqual([ev.event, JSON.parse(ev.data!)], ["app", { versionCode: 300 }]);
  const dl = await fetch(`${s.base}/api/v1/tv/app/apk`, { headers: { Authorization: `Bearer ${tv.token}` } });
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(apk));

  const again = await s.admin("POST", "/app/check");
  assert.deepEqual([again.json.result, again.json.reason, again.json.apk.sha256], ["up_to_date", null, sha(apk)]);
  assert.deepEqual([gh.count(LATEST), gh.count("/dl/SHA256SUMS"), gh.count("/dl/izle-tv-0.3.0.apk")], [2, 2, 1], "no second download");
  const status = (await s.admin("GET", "/app")).json;
  assert.deepEqual([status.source, status.check.result, status.check.reason, status.check.running, status.check.lastAt], ["github", "up_to_date", null, false, "2026-10-10T12:00:00.000Z"]);

  // An owner's upload newer than the release is kept.
  assert.equal((await upload(s, fakeApk(1000), "izle-tv-0.4.0.apk")).status, 200);
  assert.equal((await s.admin("POST", "/app/check")).json.result, "up_to_date");
  assert.equal((await s.admin("GET", "/app")).json.apk.versionName, "0.4.0");
  assert.equal(gh.count("/dl/izle-tv-0.3.0.apk"), 1);

  const events = await appEvents(s);
  assert.deepEqual(events.map((e) => [e.type, e.actor, e.data]), [
    ["app.fetched", OWNER, { versionName: "0.3.0", versionCode: 300, source: "github", releaseTag: "v0.3.0" }],
    ["app.uploaded", OWNER, { versionName: "0.4.0", versionCode: 400, source: "upload" }],
  ]);
  assert.deepEqual(logged(s, "app check: up to date").map((l) => l.level), ["debug", "debug"]);
  await assertNothingLeaked(s, gh);
});

test("GitHub: the owner's upload of the release's version is kept; a re-published release asset is fetched again", async (t) => {
  const gh = await fakeGithub(t);
  gh.publish("0.3.0");
  const s = await testServer(t, github(gh));
  assert.equal((await s.admin("POST", "/app/check")).json.result, "fetched");

  // Same version, other bytes: a fetched APK is replaced.
  const republished = fakeApk(60 * 1024);
  gh.publish("0.3.0", republished);
  const r = await s.admin("POST", "/app/check");
  assert.deepEqual([r.json.result, r.json.apk.source, r.json.apk.sha256], ["fetched", "github", sha(republished)]);

  // A patched build of the release's version (the suffix leaves versionCode 300 alone) stays.
  const patched = fakeApk(1000);
  assert.equal((await upload(s, patched, "izle-tv-0.3.0-patched.apk")).status, 200);
  const kept = await s.admin("POST", "/app/check");
  assert.deepEqual([kept.json.result, kept.json.apk.versionName, kept.json.apk.versionCode, kept.json.apk.sha256], ["up_to_date", "0.3.0-patched", 300, sha(patched)]);
  assert.equal(gh.count("/dl/izle-tv-0.3.0.apk"), 2);

  // An older upload gives way to the release.
  assert.equal((await upload(s, fakeApk(1000), "izle-tv-0.2.9.apk")).status, 200);
  const replaced = await s.admin("POST", "/app/check");
  assert.deepEqual([replaced.json.result, replaced.json.apk.sha256], ["fetched", sha(republished)]);
  assert.deepEqual(appFiles(s), [`${sha(republished)}.apk`]);
});

test("GitHub: hostile releases fail with a reason and leave the stored APK untouched", async (t) => {
  const gh = await fakeGithub(t);
  const good = fakeApk(10 * 1024);
  gh.publish("0.3.0", good);
  const s = await testServer(t, github(gh, { appUpdates: { maxBytes: 64 * 1024, timeouts: { apiMs: 300, downloadMs: 300 } } }));
  assert.equal((await s.admin("POST", "/app/check")).json.result, "fetched");

  // Each case changes release 0.3.1 as published, or publishes it otherwise.
  const assets = (keep: (a: Json) => boolean) => (gh.state.release.assets = gh.state.release.assets.filter(keep));
  const cases: Array<[string, () => unknown]> = [
    ["checksum_mismatch", () => gh.publish("0.3.1", fakeApk(1000), fakeApk(1000))],
    ["no_apk_asset", () => assets((a) => a.name !== "izle-tv-0.3.1.apk")],
    // Only the debug build: never taken instead.
    ["no_apk_asset", () => assets((a) => a.name === "izle-tv-0.3.1-debug.apk" || a.name === "SHA256SUMS")],
    ["no_apk_asset", () => (gh.state.release.assets[1].browser_download_url = "file:///etc/passwd")],
    ["no_checksums", () => assets((a) => a.name !== "SHA256SUMS")],
    ["checksum_missing", () => (gh.state.sums = `${"0".repeat(64)}  izle-tv-0.3.1-debug.apk\n`)],
    ["checksums_too_large", () => (gh.state.sums = `${"0".repeat(64)}  x\n`.repeat(300))],
    ["prerelease", () => (gh.state.release.prerelease = true)],
    ["bad_tag", () => (gh.state.release.tag_name = "../../x")],
    ["bad_tag", () => (gh.state.release.tag_name = "v0.3.1-rc.1")],
    ["too_large", () => gh.publish("0.3.1", fakeApk(64 * 1024 + 1))],
    ["too_large", () => {
      // The asset's size understates it: the download's cap still holds.
      gh.publish("0.3.1", fakeApk(64 * 1024 + 1));
      gh.state.release.assets[1].size = 10;
    }],
    ["not_an_apk", () => gh.publish("0.3.1", Buffer.from("<html>not a zip</html>"))],
    ["http_500", () => (gh.state.status = 500)],
    ["rate_limited", () => Object.assign(gh.state, { status: 403, headers: { "x-ratelimit-remaining": "0" } })],
    ["rate_limited", () => (gh.state.status = 429)],
    ["no_release", () => (gh.state.status = 404)],
    ["bad_release", () => (gh.state.release = "{ not json")],
    ["network", () => (gh.state.hang = true)],
  ];
  for (const [reason, arrange] of cases) {
    gh.publish("0.3.1");
    arrange();
    const r = await s.admin("POST", "/app/check");
    assert.deepEqual([r.status, r.json.result, r.json.reason, r.json.apk?.sha256], [200, "failed", reason, sha(good)], reason);
  }
  assert.equal((await s.admin("GET", "/app")).json.apk.versionName, "0.3.0");
  assert.deepEqual(appFiles(s), [`${sha(good)}.apk`], "no temp file or rejected APK left");
  const failed = (await appEvents(s)).filter((e) => e.type === "app.check_failed");
  assert.deepEqual(failed.map((e) => e.data), cases.map(([reason]) => ({ reason })));
  assert.deepEqual(logged(s, "app check failed").map((l) => [l.level, l.reason, l.repo]), cases.map(([reason]) => ["warn", reason, "mickeiik/izle"]));
  assert.equal((await s.admin("GET", "/app")).json.check.reason, "network");
  await assertNothingLeaked(s, gh);
});

test("GitHub: one check at a time; checks need manage; a stopping server ends a running check", async (t) => {
  const gh = await fakeGithub(t);
  gh.publish("0.3.0");
  gh.state.hang = true;
  const s = await startTestServer(github(gh, { appUpdates: { timeouts: { apiMs: 60_000 } } }));
  let closed = false;
  t.after(() => (closed ? undefined : s.close()));
  const { secret: control } = await createToken(s, "c", "control");
  assert.equal((await s.call("POST", "/api/v1/admin/app/check", { token: control })).status, 403);

  const first = s.admin("POST", "/app/check").catch(() => null);
  await eventually(() => gh.count(LATEST) === 1);
  assert.equal((await s.admin("GET", "/app")).json.check.running, true);
  const second = await s.admin("POST", "/app/check");
  assert.deepEqual([second.status, second.json.error], [409, "check_running"]);
  const started = Date.now();
  await s.close();
  closed = true;
  assert.ok(Date.now() - started < 2000, "close does not wait for the hanging request");
  await first;
});

test("GitHub: the scheduled check runs by itself after the first delay, as the server", async (t) => {
  const gh = await fakeGithub(t);
  gh.publish("0.3.0");
  const s = await testServer(t, github(gh, { appUpdates: { firstCheckDelayMs: 20 } }));
  await eventually(() => gh.count("/dl/izle-tv-0.3.0.apk") === 1);
  await eventually(() => s.logs.some((l) => l.includes('"apk stored"')));
  assert.deepEqual((await appEvents(s)).find((e) => e.type === "app.fetched").actor, { type: "server" });
  const check = (await s.admin("GET", "/app")).json.check;
  assert.deepEqual([check.result, check.nextAt], ["fetched", "2026-10-11T12:00:00.000Z"]);
});

test("GitHub: with the manual source nothing is ever requested", async (t) => {
  const gh = await fakeGithub(t);
  gh.publish("0.3.0");
  const s = await testServer(t, { githubApiBase: gh.url, appUpdates: { firstCheckDelayMs: 10 } });
  await new Promise((r) => setTimeout(r, 150));
  const r = await s.admin("POST", "/app/check");
  assert.deepEqual([r.status, r.json.error, gh.hits.length], [409, "github_disabled", 0]);
  assert.equal((await s.admin("GET", "/app")).json.check.nextAt, null);
});
