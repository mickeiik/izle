import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadAdminToken } from "../src/auth.ts";
import { ConfigError, loadConfig, SAMPLE_CATALOG_DIR } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { tempDir } from "./helpers.ts";

test("defaults without a config file", () => {
  const c = loadConfig({ cwd: "/srv/izle", env: {} });
  assert.equal(c.configPath, null);
  assert.deepEqual(c.listen, { host: "0.0.0.0", port: 8787 });
  assert.equal(c.dataDir, "/srv/izle/data");
  assert.equal(c.catalog.dir, SAMPLE_CATALOG_DIR);
  assert.equal(c.admin.tokenFile, "/srv/izle/data/admin.token");
  assert.equal(c.admin.token, null);
  assert.equal(c.resolver, null);
  assert.deepEqual(c.proxy, { always: false, sessionTtlSec: 21600 });
  assert.deepEqual(c.defaults, { uiLanguage: null, preferredAudioLanguage: null });
});

test("relative paths in a config file resolve against the file's directory", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "conf", "izle.json");
  await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(file)));
  writeFileSync(
    file,
    JSON.stringify({
      listen: { host: "127.0.0.1", port: 9000 },
      publicUrl: "https://tv.example.test/",
      dataDir: "../var",
      catalog: { dir: "./catalog" },
      resolver: { module: "./resolver/index.js", config: { a: 1 } },
      admin: { tokenFile: "/etc/izle/admin.token" },
      proxy: { always: true, sessionTtlSec: 3600 },
      defaults: { uiLanguage: "tr", preferredAudioLanguage: "tr" },
      log: { level: "warn" },
    }),
  );
  const c = loadConfig({ path: "conf/izle.json", cwd: dir, env: {} });
  assert.equal(c.configPath, file);
  assert.equal(c.publicUrl, "https://tv.example.test");
  assert.equal(c.dataDir, path.join(dir, "var"));
  assert.equal(c.catalog.dir, path.join(dir, "conf", "catalog"));
  assert.deepEqual(c.resolver, { module: path.join(dir, "conf", "resolver", "index.js"), config: { a: 1 } });
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
  assert.throws(() => loadConfig({ path: write('{"listen": {"port": 70000}}'), env: {} }), ConfigError);
  assert.throws(() => loadConfig({ path: write('{"defaults": {"uiLanguage": "de"}}'), env: {} }), ConfigError);
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

test("the admin token file is created 0600 on first use, reused, and rotated on request", async () => {
  const dir = await tempDir();
  const c = loadConfig({ cwd: dir, env: {} });
  const first = loadAdminToken(c, silentLogger);
  assert.equal(first.source, "file");
  assert.ok(first.token.length >= 43);
  assert.equal(statSync(c.admin.tokenFile).mode & 0o777, 0o600);
  assert.equal(loadAdminToken(c, silentLogger).token, first.token);
  const rotated = loadAdminToken(c, silentLogger, { rotate: true });
  assert.notEqual(rotated.token, first.token);
  assert.equal(readFileSync(c.admin.tokenFile, "utf8").trim(), rotated.token);
  writeFileSync(c.admin.tokenFile, "too-short\n");
  assert.throws(() => loadAdminToken(c, silentLogger), ConfigError);
  assert.throws(() => loadAdminToken(loadConfig({ cwd: path.join(dir, "elsewhere"), env: {} }), silentLogger, { create: false }), /does not exist/);
});

test("generated ids are alphanumeric and valid ids", async () => {
  const { newId } = await import("../src/auth.ts");
  const { isId } = await import("../src/validation.ts");
  for (let i = 0; i < 2000; i++) {
    const id = newId();
    assert.match(id, /^[A-Za-z0-9]{12}$/);
    assert.ok(isId(id));
  }
  assert.equal(newId(16).length, 16);
});
