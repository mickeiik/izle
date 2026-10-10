import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, isSecretKey, redact, redactString } from "../src/log.ts";

const DEVICE_TOKEN = "Zq3v9Kx2LmN8pQ4rT6uW1yA5bC7dE0fGhIjKlMnOpQr";

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger({ level: "debug", write: (l) => void lines.push(l), now: () => 0 }) };
}

test("secret-looking keys are dropped whatever their casing", () => {
  for (const k of ["url", "baseUrl", "posterURL", "headers", "Authorization", "set-cookie", "cookie", "deviceToken", "pair_token", "ref", "config", "resolverConfig", "playlist", "password", "body"]) {
    assert.equal(isSecretKey(k), true, k);
  }
  for (const k of ["preferredAudioLanguage", "itemId", "episodeId", "status", "route", "ms", "referenceCount"]) {
    assert.equal(isSecretKey(k), false, k);
  }
});

test("URLs become <url host> and token-like runs become <token>", () => {
  assert.equal(redactString("GET https://cdn.example.test/a/b.ts?sig=abc failed"), "GET <url cdn.example.test> failed");
  assert.equal(redactString(`token ${DEVICE_TOKEN} leaked`), "token <token> leaked");
  assert.equal(redactString("ftp://user:pw@files.example.test/x"), "<url files.example.test>");
  assert.equal(redactString("caminandes.s01e01 / hls-multi-audio"), "caminandes.s01e01 / hls-multi-audio");
});

test("hostile fixture: nothing secret survives a log line", () => {
  const { lines, log } = capture();
  const err = Object.assign(new Error(`upstream 403 for https://signed.example.test/v.m3u8?token=${DEVICE_TOKEN}`), { code: "E_UPSTREAM" });
  const circular: Record<string, unknown> = { name: "loop" };
  circular.self = circular;
  log.error(`resolve failed for https://signed.example.test/master.m3u8?Policy=${DEVICE_TOKEN}`, {
    url: "https://signed.example.test/master.m3u8",
    headers: { Referer: "https://referer.example.test/", Cookie: "session=s3cr3t" },
    Authorization: `Bearer ${DEVICE_TOKEN}`,
    nested: { ref: { slug: "private-slug" }, config: { apiKey: "k-123" }, playlist: "#EXTM3U\n#EXTINF:4,\nseg.ts", deep: { cookie: "a=b" } },
    note: `see https://dashboard.example.test/x?key=${DEVICE_TOKEN}`,
    list: ["https://a.example.test/1", DEVICE_TOKEN, 3],
    error: err,
    circular,
    itemId: "show",
  });
  assert.equal(lines.length, 1);
  const line = lines[0]!;
  const parsed = JSON.parse(line);
  for (const leak of [DEVICE_TOKEN, "signed.example.test/", "referer.example.test", "s3cr3t", "private-slug", "k-123", "#EXTM3U", "a=b", "Policy=", "upstream 403", "dashboard.example.test/x"]) {
    assert.ok(!line.includes(leak), `leaked ${leak}: ${line}`);
  }
  assert.equal(parsed.msg, "resolve failed for <url signed.example.test>");
  assert.equal(parsed.note, "see <url dashboard.example.test>");
  assert.deepEqual(parsed.list, ["<url a.example.test>", "<token>", 3]);
  assert.deepEqual(parsed.error, { name: "Error", code: "E_UPSTREAM" });
  assert.equal(parsed.circular.self, "<circular>");
  assert.equal(parsed.itemId, "show");
  assert.equal(parsed.level, "error");
  assert.deepEqual(Object.keys(parsed.nested), ["deep"]);
});

test("levels filter and child loggers bind fields", () => {
  const lines: string[] = [];
  const log = createLogger({ level: "warn", write: (l) => void lines.push(l) });
  log.info("hidden");
  log.child({ deviceId: "d1" }).warn("shown", { n: 1 });
  assert.equal(lines.length, 1);
  assert.deepEqual(
    (({ level, msg, deviceId, n }) => ({ level, msg, deviceId, n }))(JSON.parse(lines[0]!)),
    { level: "warn", msg: "shown", deviceId: "d1", n: 1 },
  );
});

test("redact copes with odd values", () => {
  assert.deepEqual(redact({ a: undefined, b: () => 1, c: 10n, d: new Date(0), e: new Map(), f: Buffer.from("x") }), {
    c: "10",
    d: "1970-01-01T00:00:00.000Z",
    e: "<Map>",
    f: "<Buffer>",
  });
  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let i = 0; i < 10; i++) deep = (deep.next = {}) as Record<string, unknown>;
  assert.match(JSON.stringify(redact(root)), /<deep>/);
});
