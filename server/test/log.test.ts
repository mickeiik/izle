import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, redact, redactReportText } from "../src/log.ts";

const DEVICE_TOKEN = "Zq3v9Kx2LmN8pQ4rT6uW1yA5bC7dE0fGhIjKlMnOpQr"; // gitleaks:allow (made-up hostile fixture)

function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger({ level: "debug", write: (l) => void lines.push(l), now: () => 0 }) };
}

test("secret-looking keys are dropped whatever their casing", () => {
  const keys = (list: string[]) => Object.fromEntries(list.map((k) => [k, 1]));
  const secret = ["url", "baseUrl", "posterURL", "headers", "Authorization", "set-cookie", "cookie", "deviceToken", "pair_token", "ref", "config"];
  assert.deepEqual(redact(keys([...secret, "resolverConfig", "playlist", "password", "body"])), {});
  const plain = keys(["preferredAudioLanguage", "itemId", "episodeId", "status", "route", "ms", "referenceCount"]);
  assert.equal(Object.keys(redact(plain) as object).length, Object.keys(plain).length, "none dropped (long keys are scrubbed, not dropped)");
});

test("URLs become <url host> and token-like runs become <token>", () => {
  assert.equal(redact("GET https://cdn.example.test/a/b.ts?sig=abc failed"), "GET <url cdn.example.test> failed");
  assert.equal(redact(`token ${DEVICE_TOKEN} leaked`), "token <token> leaked");
  assert.equal(redact("ftp://user:pw@files.example.test/x"), "<url files.example.test>");
  assert.equal(redact("caminandes.s01e01 / hls-multi-audio"), "caminandes.s01e01 / hls-multi-audio");
});

test("problem text from a TV: URLs and tokens go, error names stay; the log itself stays strict", () => {
  const hostile = `ERROR_CODE_IO_BAD_HTTP_STATUS InvalidResponseCodeException: https://cdn.example.test/v.m3u8?token=${DEVICE_TOKEN} ${DEVICE_TOKEN}`;
  assert.equal(redactReportText(hostile), "ERROR_CODE_IO_BAD_HTTP_STATUS InvalidResponseCodeException: <url cdn.example.test> <token>");
  for (const kept of ["UnknownHostException", "io_bad_http_status_403", "ERROR_CODE_DRM_LICENSE_ACQUISITION_FAILED", "onPlayerErrorChangedEvent"]) {
    assert.equal(redactReportText(kept), kept);
  }
  for (const token of [DEVICE_TOKEN, "A1B2C3D4E5F6A7B8C9D0E1", "9f86d081884c7d659a2feaa0c55ad015", "abcdefghijklmnopqrstUVWXYZ", "Tq4_Lm9-Zx2Kp8Rw3Yv6Nb"]) { // gitleaks:allow (made-up hostile fixtures)
    assert.equal(redactReportText(`x ${token} y`), "x <token> y", token);
  }
  assert.equal(redactReportText("ab ".repeat(200)).length, 501, "capped like log strings");
  assert.equal(redact("ERROR_CODE_IO_BAD_HTTP_STATUS"), "<token>", "free text in log lines keeps the strict rule");
});

test("catalog ids and problem codes survive in their own fields; secrets there and ids elsewhere are scrubbed", () => {
  const { lines, log } = capture();
  const ids = {
    catalogId: "home-catalog-2026-a1b2c3d4", buildId: "20261023-78ece5b2deea", itemId: "the-simpsons-1989-1c18970a",
    episodeId: "the-simpsons-1989-1c18970a.s1e1", sourceId: "dub_hls-1080p-78ece5b2deea", adapterId: "example-adapter-v2",
    code: "ERROR_CODE_IO_BAD_HTTP_STATUS",
  };
  log.info("ids", ids);
  assert.deepEqual(JSON.parse(lines[0]!), { time: "1970-01-01T00:00:00.000Z", level: "info", msg: "ids", ...ids });

  const hostile = [
    `izat_${DEVICE_TOKEN}`, DEVICE_TOKEN, "q8Zt-3Rk_v0WmXa9LpYc2NdE7fBhJ4sUo1", "9f86d081884c7d659a2feaa0c55ad015", // gitleaks:allow (made-up hostile fixtures)
    `/p/${DEVICE_TOKEN}/seg.ts`, "https://cdn.example.test/v/master.m3u8", `the-show-1c18970a?sig=${DEVICE_TOKEN}`, "auth.<token>",
  ];
  for (const value of hostile) {
    lines.length = 0;
    log.info("hostile", Object.fromEntries(Object.keys(ids).map((k) => [k, value])));
    const line = JSON.parse(lines[0]!);
    for (const k of Object.keys(ids)) assert.equal(line[k], redact(value), `${k}: ${value}`);
    assert.ok(!lines[0]!.includes(DEVICE_TOKEN) && !lines[0]!.includes("cdn.example.test/"), lines[0]);
  }
  assert.equal(redact(`izat_${DEVICE_TOKEN}`), "<token>");
  assert.equal(redact(`/p/${DEVICE_TOKEN}/seg.ts`), "/p/<token>/seg.ts");

  // The same ids anywhere else are free text: they look like tokens there.
  lines.length = 0;
  log.info(`loaded ${ids.buildId}`, { note: ids.itemId, id: ids.episodeId, list: [ids.code], nested: { buildId: ids.buildId } });
  assert.deepEqual(JSON.parse(lines[0]!), {
    time: "1970-01-01T00:00:00.000Z", level: "info", msg: "loaded <token>", note: "<token>", id: "<token>.s1e1", list: ["<token>"],
    nested: { buildId: ids.buildId },
  });
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
  const { msg, note, list, error, circular: { self }, itemId, level, nested } = parsed;
  assert.deepEqual({ msg, note, list, error, self, itemId, level, nested: Object.keys(nested) }, {
    msg: "resolve failed for <url signed.example.test>", note: "see <url dashboard.example.test>", list: ["<url a.example.test>", "<token>", 3],
    error: { name: "Error", code: "E_UPSTREAM" }, self: "<circular>", itemId: "show", level: "error", nested: ["deep"],
  });
});

test("hostile fixture (resolver audit shapes): protocol-relative URLs, playlist text and odd error names", () => {
  const { lines, log } = capture();
  const named = Object.assign(new Error("boom"), { code: "E_X" });
  named.name = `https://cdn.example.test/x?st=${DEVICE_TOKEN}`;
  const tokenNamed = new Error("boom");
  tokenNamed.name = `Err${DEVICE_TOKEN}`;
  const longNamed = new Error("boom");
  longNamed.name = `E${"x".repeat(80)}`;
  log.info("D1 protocol-relative", { src: "//cdn.example.test/hls/abc/index.m3u8?st=Xy12Ab&e=1700000000" });
  log.info("D1b in text", { note: "fetching //cdn.example.test:8443/hls/index.m3u8?st=Xy12Ab now" });
  log.info("E5 playlist under text", { text: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8?sig=q9Zk2" });
  log.info("E5b with a BOM and leading space", { body2: "\uFEFF  #EXTM3U\n#EXTINF:4,\nseg.ts?sig=q9Zk2" });
  log.info("F2 error names", { a: named, b: tokenNamed, c: longNamed, d: Object.assign(new TypeError("x"), {}) });
  const out = lines.map((l) => JSON.parse(l));
  assert.deepEqual([out[0].src, out[1].note, out[2].text, out[3].body2], ["<url cdn.example.test>", "fetching <url cdn.example.test:8443> now", "<playlist>", "<playlist>"]);
  assert.deepEqual(out[4].a, { name: "Error", code: "E_X" }, "a name that is not an identifier is not kept");
  assert.deepEqual(out[4].b, { name: "<token>" }, "an identifier-shaped name is scrubbed like any string");
  assert.deepEqual(out[4].c, { name: "Error" }, "nor is one longer than 60 characters");
  assert.deepEqual(out[4].d, { name: "TypeError" });
  for (const leak of ["cdn.example.test/", "Xy12Ab", "q9Zk2", "#EXT", DEVICE_TOKEN, "xxxxxxxxxx"]) {
    assert.ok(!lines.some((l) => l.includes(leak)), `leaked ${leak}`);
  }

  // What is not a URL or a playlist stays: file paths, comments, ratios, text that only mentions #EXTM3U.
  for (const kept of ["/opt/izle//lib/resolver.js", "a // b, 1/2 and 3//4", "not a playlist: #EXTM3U is missing"]) assert.equal(redact(kept), kept);
  assert.equal(redact("see https://x.example.test/a and //y.example.test/b"), "see <url x.example.test> and <url y.example.test>");
  assert.equal(redactReportText("#EXTM3U\nseg.ts"), "<playlist>", "TV problem text too");
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
    c: "10", d: "1970-01-01T00:00:00.000Z", e: "<Map>", f: "<Buffer>",
  });
  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let i = 0; i < 10; i++) deep = (deep.next = {}) as Record<string, unknown>;
  assert.match(JSON.stringify(redact(root)), /<deep>/);
});
