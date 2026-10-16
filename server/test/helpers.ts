import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type ServerConfig } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { startServer } from "../src/server.ts";

export const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";

/** A logger that discards everything. */
export const silentLogger = createLogger({ write: () => {} });

/** The tests' resolver module: the example module's adapters plus a "test" adapter with hostile behaviours. */
export const TEST_RESOLVER = fileURLToPath(new URL("./fixtures/test-resolver.js", import.meta.url));

const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const TINY_PNG_NAME = `${createHash("sha256").update(TINY_PNG).digest("hex")}.png`;

const lang = (audio: string[] | null, subtitles: string[] | null = []) => ({ audio, subtitles });
const direct = (id: string, audio: string[] | null, extra: Record<string, unknown> = {}) => ({
  id,
  type: "direct",
  languages: lang(audio),
  media: { kind: "hls", url: `https://media.example.test/${id}/master.m3u8` },
  ...extra,
});

// Loosely typed on purpose: tests mutate fixtures into other shapes.
export type Json = any;

/** A synthetic bundle exercising play order, approval, auto-advance boundaries and language ranking. */
export function fixtureItems(): Json {
  return {
    items: [
      {
        id: "show", kind: "series", title: "Şov Dünyası", originalTitle: "Show World", poster: `assets/${TINY_PNG_NAME}`,
        episodes: [
          {
            id: "show.e1", season: 1, number: 1, title: "Pilot", durationMs: 1_200_000, playbackAllowed: true,
            sources: [direct("unknown", null), direct("en-orig", ["en"]), direct("tr-dub", ["tr"]), direct("multi", ["tr-TR", "en"])],
          },
          { id: "show.e2", season: 1, number: 2, title: "Season finale", playbackAllowed: true, autoAdvance: false, sources: [direct("main", ["tr"])] },
          { id: "show.e3", season: 2, number: 1, playbackAllowed: false, sources: [] },
          {
            id: "show.e4", season: 2, number: 2, playbackAllowed: true,
            sources: [
              direct("needs-proxy", ["tr"], { media: { kind: "hls", url: "https://media.example.test/needs-proxy.m3u8", headers: { Referer: "https://site.example.test/" } } }),
              { id: "via-adapter", type: "adapter", adapter: "example", ref: { secret: "ref-value" }, languages: lang(null, null) },
              direct("plain", ["tr"]),
            ],
          },
          { id: "show.e5", season: 2, number: 3, playbackAllowed: true, sources: [direct("main", ["tr"])] },
        ],
      },
      {
        id: "film", kind: "movie", title: "Film", year: 1999, poster: `assets/${TINY_PNG_NAME}`,
        episodes: [
          {
            id: "film.main", durationMs: 5_400_000, playbackAllowed: true,
            sources: [direct("a", ["en"], { subtitleTracks: [{ url: "https://media.example.test/a/tr.vtt", language: "tr", format: "vtt" }] }), direct("b", ["de"])],
          },
        ],
      },
      { id: "locked", kind: "movie", title: "Locked", poster: null, episodes: [{ id: "locked.main", playbackAllowed: false, sources: [] }] },
      { id: "silent", kind: "movie", title: "Silent", poster: null, episodes: [{ id: "silent.main", playbackAllowed: true, sources: [direct("only", [])] }] },
      ...Array.from({ length: 12 }, (_, i) => {
        const id = `filler-${String(i + 1).padStart(2, "0")}`;
        return { id, kind: "movie", title: `Filler ${i + 1}`, poster: null, episodes: [{ id: `${id}.main`, playbackAllowed: true, sources: [direct("only", ["en"])] }] };
      }),
    ],
  };
}

export function fixtureManifest(): Json {
  return {
    format: "izle-bundle", formatVersion: 1, catalogId: "fixture", buildId: "fixture-1", builtAt: "2026-10-10T12:00:00Z", name: "Fixture catalog",
    defaults: { uiLanguage: "tr", preferredAudioLanguage: "tr" }, adapters: ["example"], items: "items.json", assetsDir: "assets",
  };
}

export async function writeBundle(dir: string, manifest: Json = fixtureManifest(), items: Json = fixtureItems()): Promise<string> {
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(path.join(dir, "bundle.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, "items.json"), JSON.stringify(items, null, 2));
  await writeFile(path.join(dir, "assets", TINY_PNG_NAME), TINY_PNG);
  return dir;
}

/** Rewrites the fixture bundle in `dir` as build `buildId`, with its items passed through `edit`. */
export function publishBuild(dir: string, buildId: string, edit = (items: Json[]) => items, manifest: Json = {}) {
  return writeBundle(dir, { ...fixtureManifest(), buildId, ...manifest }, { items: edit(fixtureItems().items) });
}

export async function tempDir(prefix = "izle-test-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Starts a local HTTP server on a free loopback port: its base URL, and a close that ends its connections. */
export async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close };
}

/** A controllable clock. */
export function fakeClock(start = Date.parse("2026-10-10T12:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

type Answer = { status: number; json: Json; headers: Headers };

export interface TestServer {
  srv: Awaited<ReturnType<typeof startServer>>;
  base: string;
  config: ServerConfig;
  bundleDir: string;
  logs: string[];
  clock: ReturnType<typeof fakeClock>;
  call(method: string, route: string, opts?: { token?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> }): Promise<Answer>;
  admin(method: string, route: string, body?: unknown): Promise<Answer>;
  pair(name?: string): Promise<{ deviceId: string; token: string }>;
  close(): Promise<void>;
}

export interface TestServerOptions extends Partial<Omit<Parameters<typeof startServer>[0], "config">> {
  bundleDir?: string;
  configFile?: Json;
}

export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const { bundleDir: givenBundle, configFile, ...startOptions } = opts;
  const root = await tempDir();
  const bundleDir = givenBundle ?? (await writeBundle(path.join(root, "bundle")));
  const configPath = path.join(root, "izle.json");
  // The TV app's updates come from uploads only unless a test says otherwise: no test ever reaches GitHub.
  const file = { listen: { host: "127.0.0.1", port: 0 }, dataDir: "./data", catalog: { dir: bundleDir }, appUpdates: { source: "manual" }, ...configFile };
  await writeFile(configPath, JSON.stringify(file));
  const config = loadConfig({ path: configPath, env: { IZLE_ADMIN_TOKEN: ADMIN_TOKEN } });
  const logs: string[] = [];
  const clock = fakeClock();
  const log = createLogger({ level: "debug", write: (l) => void logs.push(l), now: clock.now });
  const srv = await startServer({ config, log, now: clock.now, ...startOptions });
  const base = srv.url;

  const call: TestServer["call"] = async (method, route, o = {}) => {
    const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    const headers: Record<string, string> = { ...o.headers };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${base}${route}`, { method, headers, body });
    const text = await res.text();
    let json: Json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };
  const admin: TestServer["admin"] = (method, route, body) => call(method, `/api/v1/admin${route}`, { token: ADMIN_TOKEN, body });

  const pair: TestServer["pair"] = async (name = "TV") => {
    const start = await call("POST", "/api/v1/pair/start");
    if (start.status !== 200) throw new Error(`pair/start ${start.status} ${JSON.stringify(start.json)}`);
    const approve = await admin("POST", "/pair/approve", { code: start.json.code, name });
    if (approve.status !== 200) throw new Error(`approve ${approve.status}`);
    const wait = await call("GET", `/api/v1/pair/wait?code=${start.json.code}&wait=0`, { token: start.json.pairToken });
    if (wait.json?.status !== "approved") throw new Error(`wait ${wait.status} ${JSON.stringify(wait.json)}`);
    return { deviceId: wait.json.deviceId, token: wait.json.deviceToken };
  };

  return { srv, base, config, bundleDir, logs, clock, call, admin, pair, close: () => srv.close() };
}

export interface SseMessage {
  event?: string;
  data?: string;
  id?: string;
  retry?: string;
  comment?: string;
}

/** Minimal SSE client over fetch for tests: the TV's stream by default, or `route` (the admin event stream). */
export async function openEvents(base: string, token: string, route = "/api/v1/tv/events", headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(`${base}${route}`, { headers: { Authorization: `Bearer ${token}`, ...headers }, signal: controller.signal });
  if (!res.body) throw new Error(`no body (${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const queue: SseMessage[] = [];
  let waiting = null as (() => void) | null;
  let ended = false;

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const msg: SseMessage = {};
          // The server's events are one line each per field (its data is one line of JSON).
          for (const line of block.split("\n")) {
            const [, key, val] = /^([^:]*):? ?(.*)$/.exec(line)!;
            if (key === "") msg.comment = val!.trim();
            else if (key === "event" || key === "data" || key === "id" || key === "retry") msg[key] = val;
          }
          queue.push(msg);
          waiting?.();
        }
      }
    } catch {
      // aborted
    } finally {
      ended = true;
      waiting?.();
    }
  })();

  return {
    status: res.status,
    headers: res.headers,
    /** Next message matching `filter` (default: any non-comment), or throws after `timeoutMs`. */
    async next(filter: (m: SseMessage) => boolean = (m) => m.comment === undefined, timeoutMs = 3000): Promise<SseMessage> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = queue.findIndex(filter);
        if (i >= 0) return queue.splice(i, 1)[0]!;
        if (ended) throw new Error("stream ended");
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("timed out waiting for SSE message");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left);
          waiting = () => {
            clearTimeout(timer);
            waiting = null;
            resolve();
          };
        });
      }
    },
    close() {
      controller.abort();
    },
  };
}

/** Polls `predicate` until it holds or `timeoutMs` passes. */
export async function eventually(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 10));
  }
}
