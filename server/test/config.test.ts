import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadAdminToken, newId } from "../src/auth.ts";
import { ConfigError, loadConfig, SAMPLE_CATALOG_DIR } from "../src/config.ts";
import { isId } from "../src/validation.ts";
import { createLogger } from "../src/log.ts";
import { ADMIN_TOKEN, silentLogger, startTestServer, tempDir } from "./helpers.ts";

test("defaults without a config file", () => {
  const c = loadConfig({ cwd: "/srv/izle", env: {} });
  assert.equal(c.configPath, null);
  assert.deepEqual(c.listen, { host: "0.0.0.0", port: 8787 });
  assert.equal(c.dataDir, "/srv/izle/data");
  assert.equal(c.catalog.dir, SAMPLE_CATALOG_DIR);
  assert.equal(c.admin.tokenFile, "/srv/izle/data/admin.token");
  assert.equal(c.admin.token, null);
  assert.equal(c.resolver, null);
  assert.deepEqual(c.proxy, { always: false, sessionTtlSec: 21600, alignTsSegments: false });
  assert.deepEqual(c.defaults, { uiLanguage: null, preferredAudioLanguage: null });
  assert.deepEqual(c.trustedProxies, []);
  assert.deepEqual(c.events, { retentionDays: 7 });
  assert.deepEqual(c.appUpdates, { source: "github", repo: "mickeiik/izle", checkIntervalHours: 24, auto: true });
});

test("relative paths in a config file resolve against the file's directory", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "conf", "izle.json");
  mkdirSync(path.dirname(file));
  writeFileSync(
    file,
    JSON.stringify({
      listen: { host: "127.0.0.1", port: 9000 },
      publicUrl: "https://tv.example.test/",
      trustedProxies: ["127.0.0.1", "::1", "172.16.0.0/12"],
      dataDir: "../var",
      catalog: { dir: "./catalog" },
      resolver: { module: "./resolver/index.js", config: { a: 1 }, deadlineMs: 5000 },
      admin: { tokenFile: "/etc/izle/admin.token" },
      proxy: { always: true, sessionTtlSec: 3600 },
      defaults: { uiLanguage: "tr", preferredAudioLanguage: "tr" },
      log: { level: "warn" },
    }),
  );
  const c = loadConfig({ path: "conf/izle.json", cwd: dir, env: {} });
  assert.equal(c.configPath, file);
  assert.equal(c.publicUrl, "https://tv.example.test");
  assert.deepEqual(c.trustedProxies, ["127.0.0.1", "::1", "172.16.0.0/12"]);
  assert.equal(c.dataDir, path.join(dir, "var"));
  assert.equal(c.catalog.dir, path.join(dir, "conf", "catalog"));
  assert.deepEqual(c.resolver, { module: path.join(dir, "conf", "resolver", "index.js"), config: { a: 1 }, deadlineMs: 5000, budgetMs: 30_000 });
  assert.deepEqual(c.proxy, { always: true, sessionTtlSec: 3600, alignTsSegments: false });
  assert.equal(c.admin.tokenFile, "/etc/izle/admin.token");
  assert.deepEqual(c.defaults, { uiLanguage: "tr", preferredAudioLanguage: "tr" });
  assert.equal(c.log.level, "warn");
});

test("rejects unknown keys, bad values, bad JSON and missing files", async () => {
  const dir = await tempDir();
  const write = (content: string) => {
    const f = path.join(dir, `c${Math.random()}.json`);
    writeFileSync(f, content);
    return f;
  };
  assert.throws(() => loadConfig({ path: write('{"lisen": {}}'), env: {} }), (e: Error) => e instanceof ConfigError && /unknown property "lisen"/.test(e.message));
  assert.equal(loadConfig({ path: write('{"events": {"retentionDays": 90}}'), env: {} }).events.retentionDays, 90);
  assert.throws(() => loadConfig({ path: write('{"events": {"retentionDays": 0}}'), env: {} }), (e: Error) => e instanceof ConfigError && /retentionDays/.test(e.message));
  assert.throws(() => loadConfig({ path: write('{"listen": {"port": 70000}}'), env: {} }), ConfigError);
  assert.deepEqual(loadConfig({ path: write('{"appUpdates": {"source": "manual"}}'), env: {} }).appUpdates, { source: "manual", repo: "mickeiik/izle", checkIntervalHours: 24, auto: true });
  assert.deepEqual(
    loadConfig({ path: write('{"appUpdates": {"repo": "me/izle-fork", "checkIntervalHours": 168, "auto": false}}'), env: {} }).appUpdates,
    { source: "github", repo: "me/izle-fork", checkIntervalHours: 168, auto: false },
  );
  for (const bad of [
    { source: "url" }, { repo: "izle" }, { repo: "a/b/c" }, { repo: "../x" }, { repo: "a/.." }, { repo: "./b" }, { repo: "https://evil.example/a/b" }, { checkIntervalHours: 0 },
    { checkIntervalHours: 169 }, { checkIntervalHours: 1.5 }, { auto: "yes" }, { url: "https://x.example" },
  ]) {
    assert.throws(() => loadConfig({ path: write(JSON.stringify({ appUpdates: bad })), env: {} }), (e: Error) => e instanceof ConfigError && /appUpdates/.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => loadConfig({ path: write('{"defaults": {"uiLanguage": "de"}}'), env: {} }), ConfigError);
  assert.throws(() => loadConfig({ path: write('{"trustedProxies": "127.0.0.1"}'), env: {} }), ConfigError);
  assert.throws(
    () => loadConfig({ path: write('{"trustedProxies": ["127.0.0.1", "localhost"]}'), env: {} }),
    (e: Error) => e instanceof ConfigError && /trustedProxies "localhost" is not an IP address or CIDR range/.test(e.message),
  );
  assert.throws(() => loadConfig({ path: write("{ not json"), env: {} }), /not valid JSON/);
  assert.throws(() => loadConfig({ path: path.join(dir, "missing.json"), env: {} }), /cannot read config file/);
});

test("IZLE_ADMIN_TOKEN overrides the token file and must be long enough", () => {
  const c = loadConfig({ cwd: "/x", env: { IZLE_ADMIN_TOKEN: "  short  " } });
  assert.equal(c.admin.token, "short");
  assert.throws(() => loadAdminToken(c, silentLogger), /shorter than 24/);
  const ok = loadConfig({ cwd: "/x", env: { IZLE_ADMIN_TOKEN: "x".repeat(24) } });
  assert.deepEqual(loadAdminToken(ok, silentLogger), { token: "x".repeat(24), source: "env" });
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

test("--rotate is refused while IZLE_ADMIN_TOKEN is set: it would leave the token in use valid", async () => {
  const dir = await tempDir();
  const c = loadConfig({ cwd: dir, env: { IZLE_ADMIN_TOKEN: "x".repeat(24) } });
  assert.throws(() => loadAdminToken(c, silentLogger, { rotate: true }), (e) => e instanceof ConfigError && /IZLE_ADMIN_TOKEN is set .* change or remove the variable/.test(e.message));
  assert.equal(existsSync(c.admin.tokenFile), false, "no token file was written");
});

test("a token file shadowed by IZLE_ADMIN_TOKEN is warned about at startup, and its token is refused", async (t) => {
  const dir = await tempDir();
  const fileToken = "rotated-without-the-variable-0123456789";
  const tokenFile = path.join(dir, "admin.token");
  writeFileSync(tokenFile, `${fileToken}\n`, { mode: 0o600 });
  const s = await startTestServer({ configFile: { admin: { tokenFile } } });
  t.after(() => s.close());
  const warned = s.logs.map((l) => JSON.parse(l)).filter((l) => l.msg.startsWith("IZLE_ADMIN_TOKEN overrides the admin token file"));
  assert.deepEqual(warned.map((l) => [l.level, l.file]), [["warn", tokenFile]]);
  assert.equal((await s.call("GET", "/api/v1/admin/status", { token: fileToken })).status, 401);
  assert.equal((await s.call("GET", "/api/v1/admin/status", { token: ADMIN_TOKEN })).status, 200);
  assert.ok(!s.logs.some((l) => l.includes(fileToken) || l.includes(ADMIN_TOKEN)), "neither token is logged");

  // Without a token file nothing is said; the CLI (which says so on its own) does not ask for the warning.
  const lines: string[] = [];
  const log = createLogger({ write: (l) => void lines.push(l) });
  const noFile = loadConfig({ cwd: path.join(dir, "none"), env: { IZLE_ADMIN_TOKEN: "x".repeat(24) } });
  loadAdminToken(noFile, log, { warnShadowed: true });
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
