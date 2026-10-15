#!/usr/bin/env node
// @ts-check
// Installs a server package the way the self-hosting guide does (`npm install --global --prefix`, offline: the
// package has no dependencies) into a temporary directory and checks that the installed server works: version,
// catalog validation, admin token and sign-in link, the admin page, pairing (admin API and shell), the home state
// with posters, resolve, a database backup while the server runs, catalog reload on SIGHUP and a clean stop on
// SIGTERM. Only loopback HTTP; nothing is fetched from the network.
//
// Usage: node scripts/smoke-server.mjs [<izle-server-x.y.z.tgz>] [--keep]
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { values: opts, positionals } = parseArgs({ options: { keep: { type: "boolean" } }, allowPositionals: true });
const version = JSON.parse(await readFile(path.join(ROOT, "server", "package.json"), "utf8")).version;
const tarball = path.resolve(positionals[0] ?? path.join(ROOT, "dist", `izle-server-${version}.tgz`));

const run = promisify(execFile);
const work = await mkdtemp(path.join(tmpdir(), "izle-smoke-"));
const prefix = path.join(work, "prefix");
const bin = path.join(prefix, "bin", "izle-server");
const pkgDir = path.join(prefix, "lib", "node_modules", "@izle", "server");
// npm sets INIT_CWD for scripts; the server would resolve relative paths against it.
const { INIT_CWD: _initCwd, ...env } = process.env;

/** @param {boolean} cond @param {string} what @param {string[]} [problems] listed after `what` when not empty */
function check(cond, what, problems = []) {
  const line = problems.length ? `${what} (${problems.join(", ")})` : what;
  if (!cond || problems.length) throw new Error(`✖ ${line}`);
  process.stdout.write(`✔ ${line}\n`);
}

/** @param {string[]} args */
const cli = async (args) => (await run(bin, args, { env, encoding: "utf8" })).stdout;

/** @type {import("node:child_process").ChildProcess | null} */
let server = null;
try {
  await run("npm", ["install", "--global", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", tarball], { encoding: "utf8" });
  check(true, `installed ${path.basename(tarball)} offline into a temporary prefix`);

  check((await cli(["--version"])).trim() === version, `izle-server --version prints ${version}`);
  const deployFiles = ["izle.example.json", "izle.service", "izle-backup.service", "izle-backup.timer", "Caddyfile"];
  const statted = await Promise.all(deployFiles.map((f) => stat(path.join(pkgDir, "deploy", f)).then(() => "", () => f)));
  check(true, "the deploy examples are packaged", statted.filter(Boolean).map((f) => `missing: ${f}`));
  check(/✔|valid/i.test(await cli(["validate-catalog", path.join(pkgDir, "sample-catalog")])), "the packaged sample catalog validates");

  const config = path.join(work, "izle.json");
  await writeFile(config, JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, dataDir: "./data", trustedProxies: ["127.0.0.1"] }));
  const child = (server = spawn(bin, ["--config", config], { env, stdio: ["ignore", "pipe", "pipe"] }));
  /** @type {any[]} */
  const logs = [];
  let stderr = "";
  child.stderr.on("data", (/** @type {Buffer} */ d) => void (stderr += d.toString()));
  createInterface({ input: child.stdout }).on("line", (line) => logs.push(JSON.parse(line)));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  /** Waits until a log line with this message (after `from` lines) shows up. */
  const logged = async (/** @type {string} */ msg, from = 0, ms = 15_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
      const hit = logs.slice(from).find((l) => l.msg === msg);
      if (hit) return hit;
      if (child.exitCode !== null) break;
    }
    throw new Error(`✖ no "${msg}" log line; stderr: ${stderr}`);
  };

  const listening = await logged("listening");
  check(listening.version === version, "the server starts and logs its version");
  check(listening.catalogDir === path.join(pkgDir, "sample-catalog"), "without a catalog in the config it serves the packaged sample catalog");
  const base = `http://127.0.0.1:${listening.port}`;
  const admin = (await cli(["admin-token", "--config", config])).trim();
  check(admin.length >= 24, "izle-server admin-token prints the generated token");

  /** @param {string} method @param {string} route @param {{ token?: string, body?: unknown, headers?: Record<string, string> }} [o]
   *  @returns {Promise<{ res: Response, json: any, text: string }>} */
  const call = async (method, route, o = {}) => {
    /** @type {Record<string, string>} */
    const headers = { ...o.headers };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${base}${route}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const json = (res.headers.get("content-type") ?? "").includes("json");
    return { res, json: json ? await res.json() : null, text: json ? "" : await res.text() };
  };

  check((await call("GET", "/healthz")).json?.ok === true, "GET /healthz");
  const page = await call("GET", "/admin/");
  const csp = page.res.headers.get("content-security-policy") ?? "";
  const pageOk = page.res.status === 200 && page.text.includes("app.js") && /script-src 'self'/.test(csp) && /media-src 'self'/.test(csp);
  check(pageOk, "the admin page is served with its CSP (same-origin scripts and media)");
  // Every module of the page (the packaging script copies the directory's top-level files) and the vendored hls.js:
  // one that is missing from the package or the allow-list would only show as a blank page.
  const adminFiles = [...(await readdir(path.join(ROOT, "server", "admin"))).filter((n) => /\.(js|css|svg)$/.test(n)).sort(), "vendor/hls.min.js"];
  const unserved = [];
  for (const name of adminFiles) if ((await call("GET", `/admin/${name}`)).res.status !== 200) unserved.push(`not served: ${name}`);
  check(adminFiles.includes("app.js"), `the admin page's ${adminFiles.length} files, hls.js included, are served`, unserved);

  const info = await call("GET", "/api/v1/admin/catalog", { token: admin });
  check(info.json?.id === "izle-sample" && info.json.server?.version === version, "the admin API answers with the catalog and server version");

  const viaProxy = { "X-Forwarded-For": "203.0.113.7" };
  const pairStart = () => call("POST", "/api/v1/pair/start", { headers: viaProxy });
  const start = await pairStart();
  check(start.res.status === 200 && /^\d{6}$/.test(start.json.code), "a TV gets a pairing code");
  const approve = await call("POST", "/api/v1/admin/pair/approve", { token: admin, body: { code: start.json.code, name: "Smoke test" } });
  check(approve.res.status === 200, "the owner approves it");
  const wait = await call("GET", `/api/v1/pair/wait?code=${start.json.code}&wait=0`, { token: start.json.pairToken });
  check(wait.json?.status === "approved" && typeof wait.json.deviceToken === "string", "the TV receives its device token");
  const tv = wait.json.deviceToken;

  const second = (await pairStart()).json.code;
  const shell = await cli(["pair", "approve", second, "Kitchen", "TV", "--config", config, "--server", base]);
  check(/^approved: "Kitchen TV" /m.test(shell), "izle-server pair approve approves a code from the shell");
  check((await cli(["pair", "pending", "--config", config, "--server", base])).includes(`${second}  approved`), "izle-server pair pending lists it as approved");
  const unnamed = await call("POST", "/api/v1/admin/pair/approve", { token: admin, body: { code: (await pairStart()).json.code } });
  check(unnamed.res.status === 200 && unnamed.json.name === "TV", "approving without a name calls the TV \"TV\"");
  const link = await cli(["admin-token", "--config", config, "--link", "--base", base]);
  check(link.startsWith(`${base}/admin/#token=${admin}\n`) && /█/.test(link), "izle-server admin-token --link prints the sign-in link and its QR code");

  const home = await call("PUT", `/api/v1/admin/devices/${wait.json.deviceId}/home`, { token: admin, body: { itemIds: ["caminandes", "sintel"] } });
  check(home.res.status === 200, "the owner sets the home list");
  const state = await call("GET", "/api/v1/tv/state", { token: tv });
  check(state.json?.home?.map((/** @type {any} */ h) => h.item.id).join() === "caminandes,sintel", "the TV's home state lists the shows in order");
  const poster = await fetch(new URL(state.json.home[0].item.posterUrl, base));
  check(poster.status === 200 && poster.headers.get("content-type") === "image/jpeg", "posters are served");
  const resolve = await call("POST", "/api/v1/tv/resolve", { token: tv, body: { episodeId: state.json.home[0].continue.episodeId } });
  check(resolve.res.status === 200 && /^https:\/\//.test(resolve.json.media?.url), "resolve returns the episode's stream");

  const backupFile = path.join(work, "izle-backup.db");
  const backup = await cli(["backup", backupFile, "--config", config]);
  const { DatabaseSync } = await import("node:sqlite");
  const copy = new DatabaseSync(backupFile);
  const copied = copy.prepare("SELECT item_id FROM home_entries ORDER BY position").all().map((r) => r.item_id).join();
  copy.close();
  const backupOk = backup.startsWith(`backup written to ${backupFile} (`) && ((await stat(backupFile)).mode & 0o777) === 0o600 && copied === "caminandes,sintel";
  check(backupOk, "izle-server backup copies the running server's database (mode 0600, with the home list)");

  const before = logs.length;
  child.kill("SIGHUP");
  await logged("catalog reloaded", before);
  check(true, "SIGHUP reloads the catalog");

  child.kill("SIGTERM");
  check((await exited) === 0, "SIGTERM stops the server with exit status 0");
  server = null;
  const unexpected = stderr.split("\n").filter((l) => l.trim() && !/ExperimentalWarning: SQLite|--trace-warnings/.test(l));
  check(true, "nothing unexpected on stderr", unexpected);
  const secrets = [admin, tv, start.json.pairToken];
  check(!logs.some((l) => secrets.some((s) => JSON.stringify(l).includes(s))), "no token appears in the log");
  process.stdout.write(`smoke test passed for ${path.basename(tarball)}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  server?.kill("SIGKILL");
  if (opts.keep) process.stdout.write(`kept ${work}\n`);
  else await rm(work, { recursive: true, force: true });
}
