import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadAdminToken, newId } from "../src/auth.ts";
import { ConfigError, loadConfig, SAMPLE_CATALOG_DIR } from "../src/config.ts";
import { isId } from "../src/validation.ts";
import { createLogger } from "../src/log.ts";
import { ADMIN_TOKEN, silentLogger, testServer, tempDir } from "./helpers.ts";

test("defaults without a config file", () => {
  const c = loadConfig({ cwd: "/srv/izle", env: {} });
  assert.deepEqual(c, {
    configPath: null, listen: { host: "0.0.0.0", port: 8787 }, publicUrl: null, trustedProxies: [], dataDir: "/srv/izle/data",
    catalog: { dir: SAMPLE_CATALOG_DIR }, resolver: null, admin: { tokenFile: "/srv/izle/data/admin.token", token: null },
    proxy: { always: false, sessionTtlSec: 21600, alignTsSegments: false, privateUpstreams: [] }, defaults: { uiLanguage: null, preferredAudioLanguage: null },
    log: { level: "info" }, events: { retentionDays: 7 }, appUpdates: { source: "github", repo: "mickeiik/izle", checkIntervalHours: 24, auto: true },
  });
});

test("relative paths in a config file resolve against the file's directory", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "conf", "izle.json");
  mkdirSync(path.dirname(file));
  const privateUpstreams = ["127.0.0.1:8788", "nas.lan", "192.168.0.0/16"];
  const appUpdates = { repo: "me/izle-fork", checkIntervalHours: 168, auto: false };
  writeFileSync(file, JSON.stringify({
    listen: { host: "127.0.0.1", port: 9000 }, publicUrl: "https://tv.example.test/", trustedProxies: ["127.0.0.1", "::1", "172.16.0.0/12"],
    dataDir: "../var", catalog: { dir: "./catalog" }, resolver: { module: "./resolver/index.js", config: { a: 1 }, deadlineMs: 5000 },
    admin: { tokenFile: "/etc/izle/admin.token" }, proxy: { always: true, sessionTtlSec: 3600, privateUpstreams },
    defaults: { uiLanguage: "tr", preferredAudioLanguage: "tr" }, log: { level: "warn" }, events: { retentionDays: 90 }, appUpdates,
  }));
  assert.deepEqual(loadConfig({ path: "conf/izle.json", cwd: dir, env: {} }), {
    configPath: file, listen: { host: "127.0.0.1", port: 9000 }, publicUrl: "https://tv.example.test", trustedProxies: ["127.0.0.1", "::1", "172.16.0.0/12"],
    dataDir: path.join(dir, "var"), catalog: { dir: path.join(dir, "conf", "catalog") },
    resolver: { module: path.join(dir, "conf", "resolver", "index.js"), config: { a: 1 }, deadlineMs: 5000, budgetMs: 30_000 },
    admin: { tokenFile: "/etc/izle/admin.token", token: null }, proxy: { always: true, sessionTtlSec: 3600, alignTsSegments: false, privateUpstreams },
    defaults: { uiLanguage: "tr", preferredAudioLanguage: "tr" }, log: { level: "warn" }, events: { retentionDays: 90 }, appUpdates: { source: "github", ...appUpdates },
  });
});

test("rejects unknown keys, bad values, bad JSON and missing files", async () => {
  const dir = await tempDir();
  const load = (content: string) => {
    const f = path.join(dir, `c${Math.random()}.json`);
    writeFileSync(f, content);
    return () => loadConfig({ path: f, env: {} });
  };
  const badAppUpdates = [
    { source: "url" }, { repo: "izle" }, { repo: "a/b/c" }, { repo: "../x" }, { repo: "a/.." }, { repo: "./b" }, { repo: "https://evil.example/a/b" },
    { checkIntervalHours: 0 }, { checkIntervalHours: 169 }, { checkIntervalHours: 1.5 }, { auto: "yes" }, { url: "https://x.example" },
  ];
  // [file, what the error says]
  const refused: Array<[string, RegExp]> = [
    ['{"lisen": {}}', /unknown property "lisen"/], ['{"events": {"retentionDays": 0}}', /retentionDays/], ['{"listen": {"port": 70000}}', /port/],
    ...badAppUpdates.map((bad): [string, RegExp] => [JSON.stringify({ appUpdates: bad }), /appUpdates/]),
    ['{"defaults": {"uiLanguage": "de"}}', /uiLanguage/], ['{"trustedProxies": "127.0.0.1"}', /trustedProxies/],
    ['{"trustedProxies": ["127.0.0.1", "localhost"]}', /trustedProxies "localhost" is not an IP address or CIDR range/],
    ['{"proxy": {"privateUpstreams": ["127.0.0.1:8788", "http://nas.lan/"]}}', /privateUpstreams "http:\/\/nas\.lan\/" is not a host name/],
    ['{"proxy": {"privateUpstreams": "127.0.0.1"}}', /privateUpstreams/], ["{ not json", /not valid JSON/],
  ];
  for (const [content, message] of refused) assert.throws(load(content), (e: Error) => e instanceof ConfigError && message.test(e.message), content);
  assert.throws(() => loadConfig({ path: path.join(dir, "missing.json"), env: {} }), /cannot read config file/);
});

test("IZLE_ADMIN_TOKEN overrides the token file and must be long enough; --rotate is refused while it is set", async () => {
  const c = loadConfig({ cwd: "/x", env: { IZLE_ADMIN_TOKEN: "  short  " } });
  assert.equal(c.admin.token, "short");
  assert.throws(() => loadAdminToken(c, silentLogger), /shorter than 24/);
  const ok = loadConfig({ cwd: await tempDir(), env: { IZLE_ADMIN_TOKEN: "x".repeat(24) } });
  assert.deepEqual(loadAdminToken(ok, silentLogger), { token: "x".repeat(24), source: "env" });
  // It would leave the token in use valid.
  assert.throws(() => loadAdminToken(ok, silentLogger, { rotate: true }), (e) => e instanceof ConfigError && /IZLE_ADMIN_TOKEN is set .* change or remove the variable/.test(e.message));
  assert.equal(existsSync(ok.admin.tokenFile), false, "no token file was written");
});

test("the admin token file: rotated on request, refused when short, needed with `create: false`", async () => {
  const dir = await tempDir();
  const c = loadConfig({ cwd: dir, env: {} });
  const rotated = loadAdminToken(c, silentLogger, { rotate: true });
  assert.deepEqual([rotated.source, readFileSync(c.admin.tokenFile, "utf8").trim()], ["file", rotated.token]);
  writeFileSync(c.admin.tokenFile, "too-short\n");
  assert.throws(() => loadAdminToken(c, silentLogger), ConfigError);
  assert.throws(() => loadAdminToken(loadConfig({ cwd: path.join(dir, "elsewhere"), env: {} }), silentLogger, { create: false }), /does not exist/);
});

test("a token file shadowed by IZLE_ADMIN_TOKEN is warned about at startup, and its token is refused", async (t) => {
  const dir = await tempDir();
  const fileToken = "rotated-without-the-variable-0123456789";
  const tokenFile = path.join(dir, "admin.token");
  writeFileSync(tokenFile, `${fileToken}\n`, { mode: 0o600 });
  const s = await testServer(t, { configFile: { admin: { tokenFile } } });
  const warned = s.logs.map((l) => JSON.parse(l)).filter((l) => l.msg.startsWith("IZLE_ADMIN_TOKEN overrides the admin token file"));
  assert.deepEqual(warned.map((l) => [l.level, l.file]), [["warn", tokenFile]]);
  assert.equal((await s.call("GET", "/api/v1/admin/status", { token: fileToken })).status, 401);
  assert.equal((await s.call("GET", "/api/v1/admin/status", { token: ADMIN_TOKEN })).status, 200);
  assert.ok(!s.logs.some((l) => l.includes(fileToken) || l.includes(ADMIN_TOKEN)), "neither token is logged");

  // Without a token file nothing is said; the CLI (which says so on its own) does not ask for the warning.
  const lines: string[] = [];
  const log = createLogger({ write: (l) => void lines.push(l) });
  loadAdminToken(loadConfig({ cwd: path.join(dir, "none"), env: { IZLE_ADMIN_TOKEN: "x".repeat(24) } }), log, { warnShadowed: true });
  loadAdminToken(loadConfig({ cwd: dir, env: { IZLE_ADMIN_TOKEN: "x".repeat(24) } }), log);
  assert.deepEqual(lines, []);
});

test("generated ids are alphanumeric and valid ids", () => {
  for (let i = 0; i < 2000; i++) {
    const id = newId();
    assert.match(id, /^[A-Za-z0-9]{12}$/);
    assert.ok(isId(id));
  }
  assert.equal(newId(16).length, 16);
});
