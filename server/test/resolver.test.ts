import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BundleValidationError, type Adapter } from "@izle/contract";
import { DEFAULT_API_KEY, startUpstream } from "../examples/resolver-example/upstream.js";
import { createLogger } from "../src/log.ts";
import { healthcheckAll, loadResolver, ResolverLoadError, runAdapter } from "../src/resolver.ts";
import { fixtureItems, fixtureManifest, silentLogger, startTestServer, tempDir, TEST_RESOLVER, writeBundle, type Json } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/izle-server.js", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../examples/resolver-example/index.js", import.meta.url));

async function moduleFile(source: string): Promise<string> {
  const file = path.join(await tempDir("izle-resolver-"), "resolver.mjs");
  await writeFile(file, source);
  return file;
}

const load = async (source: string, dataDir?: string) =>
  loadResolver({ module: await moduleFile(source), config: {}, dataDir: dataDir ?? (await tempDir()), log: silentLogger });

test("loader: API version, exports and adapter list are checked; module messages never surface", async () => {
  const v1 = "export const apiVersion = 1;";
  const adapters = (list: string) => `${v1} export const createAdapters = () => [${list}];`;
  const leaky = "throw new TypeError('key https://secret.example.test/x?k=SECRET');";
  const cases: Array<[string, RegExp]> = [
    ["export const apiVersion = 2;", /declares apiVersion 2; this server implements resolver API 1/],
    ["export const createAdapters = () => [];", /declares apiVersion none/],
    [v1, /does not export createAdapters/],
    [`${v1} export const createAdapters = () => ({});`, /must return an array/],
    [adapters("{ id: 'a b', resolve() {} }"), /needs an id/],
    [adapters("{ id: 'a', resolve: 1 }"), /needs an id/],
    [adapters("{ id: 'a', resolve() {}, healthcheck: 1 }"), /healthcheck that is not a function/],
    [adapters("{ id: 'a', resolve() {} }, { id: 'a', resolve() {} }"), /provides adapter "a" twice/],
    [`${v1} export function createAdapters() { ${leaky} }`, /createAdapters\(\) of .* failed \(TypeError\)$/],
    [`${v1} this is not javascript`, /cannot import resolver module .* \(SyntaxError;/],
  ];
  for (const [source, message] of cases) {
    const refused = (e: Error) => e instanceof ResolverLoadError && message.test(e.message) && !e.message.includes("SECRET");
    await assert.rejects(load(source), refused, source);
  }
  await assert.rejects(
    loadResolver({ module: "/nonexistent/izle-resolver.js", config: {}, dataDir: await tempDir(), log: silentLogger }),
    /cannot read resolver module/,
  );
});

test("loader: default export or namespace, async createAdapters, context, sha256 logged", async () => {
  const dataDir = await tempDir();
  const viaDefault = await load(
    "export default { apiVersion: 1, async createAdapters(ctx) { globalThis.__izleCtx = ctx; return [{ id: 'one', resolve: async () => [] }]; } };",
    dataDir,
  );
  assert.deepEqual([...viaDefault.adapters.keys()], ["one"]);
  const ctx = (globalThis as Json).__izleCtx;
  assert.equal(ctx.dataDir, path.join(dataDir, "resolver"));
  assert.ok((await stat(ctx.dataDir)).isDirectory());
  assert.equal(typeof ctx.fetch, "function");

  const lines: string[] = [];
  const r = await loadResolver({ module: EXAMPLE, config: { apiBase: "http://127.0.0.1:1/", apiKey: "k" }, dataDir, log: createLogger({ write: (l) => void lines.push(l) }) });
  assert.equal(r.sha256, createHash("sha256").update(await readFile(EXAMPLE)).digest("hex"));
  const loaded = JSON.parse(lines.find((l) => l.includes("resolver module loaded"))!);
  assert.equal(loaded.sha256, r.sha256.slice(0, 16));
  assert.deepEqual(loaded.adapters, ["example"]);
  assert.ok(!lines.join("\n").includes('"k"'), "the module config is never logged");
});

test("runAdapter: sync throws, deadlines, outer aborts and invalid results are classified", async () => {
  const req = { catalogId: "c", itemId: "i", episodeId: "e", sourceId: "s", ref: { x: 1 }, preferredAudioLanguage: null };
  const run = (resolve: Adapter["resolve"], opts: { deadlineMs?: number; signal?: AbortSignal } = {}) =>
    runAdapter({ id: "a", resolve }, req, { deadlineMs: 1000, ...opts }).then(({ ms: _ms, ...o }) => o as Json);
  const never = () => new Promise<never>(() => {});
  assert.deepEqual(await run(() => { throw new SyntaxError("nope"); }), { ok: false, code: "error", name: "SyntaxError" });
  assert.deepEqual(await run(never, { deadlineMs: 50 }), { ok: false, code: "timeout", name: "TimeoutError" });
  const outer = new AbortController();
  const pending = run(never, { deadlineMs: 5000, signal: outer.signal });
  outer.abort();
  assert.deepEqual(await pending, { ok: false, code: "abort", name: "AbortError" });
  assert.equal((await run(() => Promise.reject(Object.assign(new Error("x"), { name: "has spaces and https://x" })))).name, "Error");
  assert.equal((await run(() => Promise.reject("https://secret.example.test"))).name, "NonError");
  const mutating = async (r: Json) => {
    r.ref.x = 2;
    return [{ media: { kind: "mp4" as const, url: "https://a.example.test/v.mp4" } }];
  };
  assert.equal((await run(mutating)).ok, true);
  assert.equal(req.ref.x, 1, "adapters get a copy of the ref");
  const playlist = (text: string) => async () => [{ media: { kind: "hls" as const, playlist: text, baseUrl: "https://a.example.test/" } }];
  assert.equal((await run(playlist(`#EXTM3U\n${"#".repeat(2 * 1024 * 1024)}`))).name, "InvalidResult");
  assert.equal((await run(playlist("<html>not a playlist</html>"))).name, "NotAPlaylist");
  assert.deepEqual(await run(async () => []), { ok: false, code: "empty", name: null });
});

test("startup refuses a catalog that needs adapters the module does not provide; so does a reload", async (t) => {
  const root = await tempDir();
  const bundleDir = await writeBundle(path.join(root, "bundle"), { ...fixtureManifest(), adapters: ["example", "test", "missing"] }, fixtureItems());
  await assert.rejects(
    startTestServer({ bundleDir, configFile: { resolver: { module: TEST_RESOLVER, config: { apiBase: "http://127.0.0.1:1/", apiKey: "k" } } } }),
    (e: Error) => e instanceof BundleValidationError && e.issues.some((i) => i.message === 'adapter "missing" is not provided by the resolver module'),
  );

  const ok = await writeBundle(path.join(root, "ok"), { ...fixtureManifest(), adapters: ["example"] }, fixtureItems());
  const s = await startTestServer({ bundleDir: ok, configFile: { resolver: { module: TEST_RESOLVER, config: { apiBase: "http://127.0.0.1:1/", apiKey: "k" } } } });
  t.after(() => s.close());
  await writeFile(path.join(ok, "bundle.json"), JSON.stringify({ ...fixtureManifest(), buildId: "next", adapters: ["example", "other"] }));
  const reload = await s.admin("POST", "/catalog/reload");
  assert.equal(reload.status, 422);
  assert.ok(reload.json.issues.some((i: Json) => i.path === "/adapters"));
  assert.equal((await s.admin("GET", "/catalog")).json.buildId, "fixture-1");
});

test("healthchecks and the check-resolver command", async (t) => {
  const up = await startUpstream({ port: 0 });
  t.after(() => up.close());
  const resolver = await loadResolver({ module: EXAMPLE, config: { apiBase: up.url, apiKey: DEFAULT_API_KEY }, dataDir: await tempDir(), log: silentLogger });
  assert.deepEqual((await healthcheckAll(resolver)).map(({ ms: _ms, ...h }) => h), [{ adapterId: "example", ok: true, skipped: false }]);
  const wrongKey = await loadResolver({ module: EXAMPLE, config: { apiBase: up.url, apiKey: "wrong" }, dataDir: await tempDir(), log: silentLogger });
  assert.deepEqual((await healthcheckAll(wrongKey)).map(({ ms: _ms, ...h }) => h), [{ adapterId: "example", ok: false, code: "error", name: "UpstreamError" }]);

  const root = await tempDir();
  const bundleDir = await writeBundle(path.join(root, "bundle"), { ...fixtureManifest(), adapters: ["example"] }, fixtureItems());
  const run = async (config: Json) => {
    const file = path.join(root, `izle-${Math.random()}.json`);
    await writeFile(file, JSON.stringify({ dataDir: "./data", catalog: { dir: bundleDir }, ...config }));
    const { INIT_CWD: _a, IZLE_ADMIN_TOKEN: _b, ...env } = process.env;
    try {
      const r = await promisify(execFile)(process.execPath, [BIN, "check-resolver", "--config", file], { env });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };
  const good = await run({ resolver: { module: EXAMPLE, config: { apiBase: up.url, apiKey: DEFAULT_API_KEY } } });
  assert.equal(good.code, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /adapters: example/);
  assert.match(good.stdout, /✔ catalog fixture: all 1 declared adapter\(s\) provided/);
  assert.match(good.stdout, /✔ example: healthy/);
  const bad = await run({ resolver: { module: EXAMPLE, config: { apiBase: up.url, apiKey: "wrong" } } });
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /✖ example: healthcheck failed \(error, UpstreamError/);
  const none = await run({});
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no resolver module is configured/);
  const broken = await run({ resolver: { module: "./nope.js" } });
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /cannot read resolver module/);
});
