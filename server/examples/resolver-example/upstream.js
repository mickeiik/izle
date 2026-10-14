#!/usr/bin/env node
// @ts-check
// A local stand-in for a streaming site (see README.md), used by the example resolver module and by the server tests.
// Media comes from a directory made by make-media.sh (real video, for the emulator) or, without one, is
// synthesized in memory (tests). Playlists may contain `{{base}}`, replaced by the absolute URL of the video's
// directory, so absolute URIs can be tested.
//
//   node upstream.js [--media <dir>] [--host 127.0.0.1] [--port 8788] [--token-ttl <seconds>] [--verbose]

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_API_KEY = "example-api-key";
export const DEFAULT_REFERER = "https://player.example.test/";

const TYPES = /** @type {Record<string, string>} */ ({
  m3u8: "application/vnd.apple.mpegurl",
  ts: "video/mp2t",
  mp4: "video/mp4",
  vtt: "text/vtt; charset=utf-8",
  json: "application/json",
});
const VIDEO_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * @typedef {object} UpstreamRequest
 * @property {string} path the request path with the signed token replaced by `<token>`
 * @property {string | null} referer
 * @property {string | null} range
 * @property {number} status
 */

/**
 * A deterministic MPEG-TS-looking segment: `packets` 188-byte packets, each starting with the 0x47 sync byte.
 * @param {number} seed @param {number} [packets]
 */
export function syntheticTsSegment(seed, packets = 40) {
  const buf = Buffer.alloc(packets * 188);
  for (let p = 0; p < packets; p++) {
    const o = p * 188;
    buf.set([0x47, 0x01, 0x00, 0x10 | (p & 0x0f)], o);
    for (let i = 4; i < 188; i++) {
      const b = (seed * 31 + p * 7 + i) & 0xff;
      buf[o + i] = b === 0x47 ? 0x46 : b;
    }
  }
  return buf;
}

/**
 * `n` junk bytes (a fake PNG signature, then a pattern without 0x47) that some sites put before TS packets.
 * @param {number} n
 */
export function junkBytes(n) {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const byte = (/** @type {number} */ i) => (i * 13 + 5) & 0xff;
  return Buffer.from(Array.from({ length: n }, (_, i) => png[i] ?? (byte(i) === 0x47 ? 0 : byte(i))));
}

/** @param {string[]} names @param {number} seconds */
function mediaPlaylist(names, seconds) {
  const tags = [`#EXT-X-TARGETDURATION:${seconds}`, "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-MEDIA-SEQUENCE:0"];
  const segments = names.flatMap((n) => [`#EXTINF:${seconds}.000,`, n]);
  return ["#EXTM3U", "#EXT-X-VERSION:3", ...tags, ...segments, "#EXT-X-ENDLIST", ""].join("\n");
}

/**
 * In-memory media for the video `demo`: a master playlist with two video variants (one written as an absolute
 * URI), English and Turkish audio renditions, English WebVTT subtitles, and a 256 KiB `video.mp4` pattern.
 * @returns {Map<string, Buffer>}
 */
export function syntheticMedia() {
  const files = new Map();
  const put = (/** @type {string} */ name, /** @type {string | Buffer} */ data) => files.set(name, Buffer.from(data));
  const segs = ["seg000.ts", "seg001.ts", "seg002.ts"];
  put(
    "demo/master.m3u8",
    [
      "#EXTM3U",
      "#EXT-X-VERSION:4",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="en",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en/index.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="tr",NAME="Türkçe",DEFAULT=NO,AUTOSELECT=YES,URI="audio/tr/index.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",DEFAULT=NO,AUTOSELECT=YES,URI="subs/en/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="aud",SUBTITLES="subs"',
      "video/360p/index.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,AUDIO="aud",SUBTITLES="subs"',
      "{{base}}video/180p/index.m3u8",
      "",
    ].join("\n"),
  );
  for (const [dir, seed] of /** @type {const} */ ([["video/360p", 1], ["video/180p", 2], ["audio/en", 3], ["audio/tr", 4]])) {
    put(`demo/${dir}/index.m3u8`, mediaPlaylist(segs, 6));
    segs.forEach((s, i) => put(`demo/${dir}/${s}`, syntheticTsSegment(seed * 10 + i)));
  }
  put("demo/subs/en/index.m3u8", mediaPlaylist(["0.vtt"], 18));
  put("demo/subs/en/0.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nHello from the example upstream\n");
  put("demo/video.mp4", Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => (i * 7 + (i >> 8)) & 0xff)));
  put("demo/info.json", JSON.stringify({ title: "Demo", languages: { audio: ["en", "tr"], subtitles: ["en"] } }));
  return files;
}

/** @param {string} header @param {number} size */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  const suffix = m[1] === "";
  const start = suffix ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = suffix || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if ((suffix && Number(m[2]) === 0) || start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/**
 * Starts the upstream. Resolves once it listens.
 * @param {object} [opts]
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string | null} [opts.mediaDir] directory with `<video>/master.m3u8`, `<video>/video.mp4`, …; null = synthetic
 * @param {number} [opts.tokenTtlSec] lifetime of signed stream URLs
 * @param {() => number} [opts.now] clock (ms) used for token expiry
 * @param {(r: UpstreamRequest) => void} [opts.onRequest] called after each answered request
 */
export async function startUpstream(opts = {}) {
  const tokenTtlSec = opts.tokenTtlSec ?? 600;
  const now = opts.now ?? Date.now;
  const secret = randomBytes(32);
  const memory = opts.mediaDir ? null : syntheticMedia();
  const mediaDir = path.resolve(opts.mediaDir ?? ".");
  /** @type {UpstreamRequest[]} */
  const requests = [];

  /** @param {string} video @param {number} exp @param {number} junk */
  const sign = (video, exp, junk) => createHmac("sha256", secret).update(`${video}:${exp}:${junk}`).digest().subarray(0, 16).toString("base64url");

  /** @param {string} token @param {string} video */
  const checkToken = (token, video) => {
    const m = /^(\d{1,12})-(\d{1,7})-([A-Za-z0-9_-]{22})$/.exec(token);
    if (!m) return null;
    const [exp, junk] = [Number(m[1]), Number(m[2])];
    const given = Buffer.from(/** @type {string} */ (m[3]), "base64url");
    const expected = Buffer.from(sign(video, exp, junk), "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected) || now() / 1000 >= exp) return null;
    return { junk };
  };

  /**
   * @param {string} name path relative to the media root
   * @returns {Promise<{ size: number, read: (start?: number, end?: number) => NodeJS.ReadableStream | Buffer } | null>}
   */
  const lookup = async (name) => {
    if (memory) {
      const data = memory.get(name);
      return data ? { size: data.length, read: (start = 0, end = data.length - 1) => data.subarray(start, end + 1) } : null;
    }
    const file = path.join(mediaDir, name);
    if (!file.startsWith(`${mediaDir}${path.sep}`)) return null;
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) return null;
    return { size: st.size, read: (start = 0, end = st.size - 1) => createReadStream(file, { start, end }) };
  };

  /** @param {string} name */
  const readText = async (name) => {
    if (memory) return memory.get(name)?.toString("utf8") ?? null;
    return readFile(path.join(mediaDir, name), "utf8").catch(() => null);
  };

  /** @param {import("node:http").IncomingMessage} req */
  const originOf = (req) => `http://${req.headers.host ?? "127.0.0.1"}`;

  /**
   * Serves `<video>/<rest>` after the access checks.
   * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
   * @param {string} video @param {string} rest @param {string} base absolute URL of the video directory @param {number} junk
   */
  const serveFile = async (req, res, video, rest, base, junk) => {
    if (rest.split("/").some((p) => p === ".." || p === "" || p === ".")) return send(res, 404, "not found");
    const name = `${video}/${rest}`;
    const ext = path.extname(rest).slice(1).toLowerCase();
    const type = TYPES[ext] ?? "application/octet-stream";
    if (ext === "m3u8") {
      const text = await readText(name);
      return text === null ? send(res, 404, "not found") : send(res, 200, text.replaceAll("{{base}}", base), type);
    }
    const file = await lookup(name);
    if (!file) return send(res, 404, "not found");
    const prefix = ext === "ts" && junk > 0 ? junkBytes(junk) : null;
    const size = file.size + (prefix?.length ?? 0);
    const range = req.headers.range && !prefix ? parseRange(req.headers.range, size) : null;
    if (range === "unsatisfiable") {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return void res.end();
    }
    const headers = { "Content-Type": type, "Accept-Ranges": prefix ? "none" : "bytes" };
    if (range) {
      res.writeHead(206, { ...headers, "Content-Length": range.end - range.start + 1, "Content-Range": `bytes ${range.start}-${range.end}/${size}` });
    } else {
      res.writeHead(200, { ...headers, "Content-Length": size });
    }
    if (prefix) res.write(prefix);
    const body = range ? file.read(range.start, range.end) : file.read();
    if (Buffer.isBuffer(body)) res.end(body);
    else body.pipe(res);
  };

  /**
   * `GET /api/streams/<video>`: a signed, expiring URL (or the master playlist text) and the Referer it needs.
   * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
   * @param {string} video @param {URL} url
   */
  const streamsApi = async (req, res, video, url) => {
    const format = url.searchParams.get("format") === "mp4" ? "mp4" : "hls";
    const junk = Math.min(Math.max(Number(url.searchParams.get("junk") ?? 0) || 0, 0), 65_536);
    const entry = format === "mp4" ? "video.mp4" : "master.m3u8";
    if (!(await lookup(`${video}/${entry}`))) return sendJson(res, 404, { error: "not_found" });
    const exp = Math.floor(now() / 1000) + tokenTtlSec;
    const base = `${originOf(req)}/s/${exp}-${junk}-${sign(video, exp, junk)}/${video}/`;
    const info = JSON.parse((await readText(`${video}/info.json`)) ?? "{}");
    const languages = info.languages ? { languages: info.languages } : {};
    const answer = { referer: DEFAULT_REFERER, expiresAt: new Date(exp * 1000).toISOString(), ...languages };
    if (url.searchParams.get("delivery") === "inline" && format === "hls") {
      const text = /** @type {string} */ (await readText(`${video}/master.m3u8`));
      return sendJson(res, 200, { ...answer, playlist: text.replaceAll("{{base}}", base), baseUrl: base });
    }
    return sendJson(res, 200, { ...answer, url: `${base}${entry}` });
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://upstream");
    const record = /** @type {UpstreamRequest} */ ({
      path: url.pathname.replace(/^\/s\/[^/]+/, "/s/<token>"),
      referer: req.headers.referer ?? null,
      range: req.headers.range ?? null,
      status: 0,
    });
    requests.push(record);
    res.on("finish", () => void (record.status = res.statusCode));
    // "close" also fires when the client stops reading a stream early (players do that all the time).
    res.on("close", () => {
      if (record.status === 0) record.status = res.statusCode;
      opts.onRequest?.(record);
    });
    try {
      const parts = url.pathname.split("/").slice(1);
      if (parts[0] === "api") {
        if (req.headers["x-api-key"] !== DEFAULT_API_KEY) return sendJson(res, 401, { error: "bad_api_key" });
        if (parts[1] === "health" && parts.length === 2) return sendJson(res, 200, { ok: true });
        if (parts[1] === "streams" && parts.length === 3 && VIDEO_ID.test(parts[2] ?? "")) return await streamsApi(req, res, /** @type {string} */ (parts[2]), url);
        return sendJson(res, 404, { error: "not_found" });
      }
      if ((parts[0] === "s" && parts.length >= 4) || (parts[0] === "static" && parts.length >= 3)) {
        if (req.headers.referer !== DEFAULT_REFERER) return send(res, 403, "referer required");
        const signed = parts[0] === "s";
        const video = /** @type {string} */ (signed ? parts[2] : parts[1]);
        if (!VIDEO_ID.test(video)) return send(res, 404, "not found");
        const token = signed ? checkToken(/** @type {string} */ (parts[1]), video) : { junk: 0 };
        if (!token) return send(res, 403, "expired or invalid token");
        const rest = parts.slice(signed ? 3 : 2).join("/");
        const base = `${originOf(req)}/${signed ? `s/${parts[1]}` : "static"}/${video}/`;
        return await serveFile(req, res, video, rest, base, token.junk);
      }
      return send(res, 404, "not found");
    } catch {
      if (!res.headersSent) send(res, 500, "error");
      else res.destroy();
    }
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8788, host, () => resolve(undefined));
  });
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      }),
  };
}

/**
 * @param {import("node:http").ServerResponse} res @param {number} status @param {string} body @param {string} [type]
 */
function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} value */
function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), TYPES.json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [str, bool] = /** @type {const} */ ([{ type: "string" }, { type: "boolean" }]);
  const { values } = parseArgs({ options: { media: str, host: str, port: str, "token-ttl": str, verbose: bool } });
  const up = await startUpstream({
    mediaDir: values.media ?? null,
    host: values.host,
    port: values.port ? Number(values.port) : undefined,
    tokenTtlSec: values["token-ttl"] ? Number(values["token-ttl"]) : undefined,
    onRequest: values.verbose
      ? (r) => void process.stdout.write(`${r.status} ${r.path}${r.range ? ` range=${r.range}` : ""}${r.referer ? "" : " (no referer)"}\n`)
      : undefined,
  });
  process.stdout.write(`example upstream on ${up.url} (${values.media ? `media from ${path.resolve(values.media)}` : "synthetic media"})\n`);
  for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) process.once(sig, () => void up.close().then(() => process.exit(0)));
}
