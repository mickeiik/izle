import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { loadConfig, SAMPLE_CATALOG_DIR } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { startServer } from "../src/server.ts";
import { ADMIN_TOKEN, tempDir } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/izle-server.js", import.meta.url));

async function run(args: string[], env: Record<string, string> = {}) {
  const { INIT_CWD: _ignored, IZLE_ADMIN_TOKEN: _token, ...base } = process.env;
  try {
    const r = await promisify(execFile)(process.execPath, [BIN, ...args], { env: { ...base, ...env } });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test("full boot with the shipped sample catalog on an ephemeral port", async (t) => {
  const root = await tempDir();
  const config = loadConfig({ cwd: root, env: { IZLE_ADMIN_TOKEN: ADMIN_TOKEN } });
  config.listen = { host: "127.0.0.1", port: 0 };
  // No scheduled check of the real GitHub, should this process live past its first delay.
  config.appUpdates = { ...config.appUpdates, source: "manual" };
  assert.equal(config.catalog.dir, SAMPLE_CATALOG_DIR);
  const logs: string[] = [];
  const srv = await startServer({ config, log: createLogger({ write: (l) => void logs.push(l) }) });
  t.after(() => srv.close());
  const base = srv.url;
  const json = async (method: string, route: string, token?: string, body?: unknown) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  assert.deepEqual((await json("GET", "/healthz")).body, { ok: true });

  const start = await json("POST", "/api/v1/pair/start");
  await json("POST", "/api/v1/admin/pair/approve", ADMIN_TOKEN, { code: start.body.code, name: "Emulator" });
  const paired = await json("GET", `/api/v1/pair/wait?code=${start.body.code}&wait=1`, start.body.pairToken);
  const token: string = paired.body.deviceToken;

  const search = await json("GET", "/api/v1/admin/catalog/search", ADMIN_TOKEN);
  const ids = search.body.items.map((i: { id: string }) => i.id);
  assert.ok(ids.includes("caminandes") && ids.includes("tears-of-steel"));
  await json("PUT", `/api/v1/admin/devices/${paired.body.deviceId}/home`, ADMIN_TOKEN, { itemIds: ["caminandes", "tears-of-steel", "sintel"] });

  const state = await json("GET", "/api/v1/tv/state", token);
  assert.equal(state.body.catalog.id, "izle-sample");
  assert.deepEqual(state.body.home.map((h: { item: { id: string } }) => h.item.id), ["caminandes", "tears-of-steel", "sintel"]);
  assert.equal(state.body.home[0].continue.episodeId, "caminandes.s01e01");

  // Posters are served content-addressed and immutable.
  const poster = await fetch(`${base}${state.body.home[0].item.posterUrl}`);
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get("content-type"), "image/jpeg");
  assert.match(poster.headers.get("cache-control") ?? "", /immutable/);
  const bytes = Buffer.from(await poster.arrayBuffer());
  assert.equal(`/assets/${createHash("sha256").update(bytes).digest("hex")}.jpg`, state.body.home[0].item.posterUrl);
  assert.equal((await fetch(`${base}/assets/..%2Fbundle.json`)).status, 404);
  assert.equal((await fetch(`${base}/assets/${"0".repeat(64)}.jpg`)).status, 404);

  // Preferred audio "it" picks the Italian-capable stream of Tears of Steel.
  await json("PATCH", `/api/v1/admin/devices/${paired.body.deviceId}`, ADMIN_TOKEN, { preferredAudioLanguage: "it" });
  const tos = await json("POST", "/api/v1/tv/resolve", token, { episodeId: "tears-of-steel.film" });
  assert.equal(tos.body.sourceId, "hls-multi-audio");
  assert.deepEqual(tos.body.alternatives, ["hls-subtitles", "hls-alt"]);
  const cam = await json("POST", "/api/v1/tv/resolve", token, { episodeId: "caminandes.s01e01" });
  assert.equal(cam.body.next.episodeId, "caminandes.s01e02");

  const admin = await fetch(`${base}/admin/`);
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /izle admin/);
  assert.equal(statSync(path.join(root, "data", "izle.db")).isFile(), true);

  // Nothing secret reached the log: no tokens, no stream URLs, no raw token-bearing paths.
  const all = logs.join("\n");
  for (const leak of [token, start.body.pairToken, ADMIN_TOKEN, "https://", "archive.org/download", "unified-streaming"]) {
    assert.ok(!all.includes(leak), `log leaked ${leak.slice(0, 12)}…`);
  }
  assert.ok(logs.some((l) => JSON.parse(l).route === "/api/v1/tv/resolve"));
  assert.equal(JSON.parse(logs.find((l) => l.includes('"msg":"listening"'))!).adminAuth, "env");
});

test("CLI: admin-token creates, reuses and rotates; validate-catalog; bad config exits 1", async () => {
  const dir = await tempDir();
  const cfg = path.join(dir, "izle.json");
  writeFileSync(cfg, JSON.stringify({ dataDir: "./state" }));
  const a = await run(["admin-token", "--config", cfg]);
  assert.equal(a.code, 0, a.stderr);
  const token = a.stdout.trim();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(statSync(path.join(dir, "state", "admin.token")).mode & 0o777, 0o600);
  assert.ok(!a.stderr.includes(token), "the token goes to stdout only");
  assert.equal((await run(["admin-token", "--config", cfg])).stdout.trim(), token);
  const rotated = (await run(["admin-token", "--config", cfg, "--rotate"])).stdout.trim();
  assert.notEqual(rotated, token);

  assert.equal((await run(["validate-catalog", SAMPLE_CATALOG_DIR])).code, 0);
  assert.equal((await run(["validate-catalog", dir])).code, 1);
  writeFileSync(cfg, JSON.stringify({ nope: true }));
  const bad = await run(["--config", cfg]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown property "nope"/);
  assert.equal((await run(["frobnicate"])).code, 2);
  assert.equal((await run(["--help"])).code, 0);
  const version = await run(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout, `${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}\n`);
});

test("CLI: the server starts, answers and stops on SIGTERM", async (t) => {
  const dir = await tempDir();
  const cfg = path.join(dir, "izle.json");
  writeFileSync(cfg, JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, dataDir: "./data", appUpdates: { source: "manual" } }));
  const { INIT_CWD: _ignored, ...env } = process.env;
  const child = spawn(process.execPath, [BIN, "--config", cfg], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      for (const line of out.split("\n")) {
        if (line.includes('"msg":"listening"')) resolve(JSON.parse(line).port);
      }
    });
    child.once("exit", (code) => reject(new Error(`exited ${code}`)));
    setTimeout(() => reject(new Error("no listening line")), 15_000);
  });
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json(), { ok: true });
  child.kill("SIGTERM");
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.equal(code, 0);
});
