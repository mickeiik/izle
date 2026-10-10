#!/usr/bin/env node
// @ts-check
// A local stand-in for a streaming site, used by the example resolver module and by the server tests. It has the
// traits the resolver contract was designed for:
//   - a JSON API behind an API key that hands out signed, expiring stream URLs (`GET /api/streams/<video>`);
//   - playlists and segments that are only served with the right `Referer` (403 otherwise, and once expired);
//   - the master playlist text inline instead of a URL (`delivery=inline`);
//   - optionally, MPEG-TS segments prefixed with junk bytes (`junk=<n>`), to exercise the proxy's TS alignment;
//   - `/static/<video>/…`: the same files without a signed token (still Referer-bound), for bundle sources
//     with `headers`.
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
 * @typedef {object} UpstreamOptions
 * @property {string} [host]
 * @property {number} [port]
 * @property {string | null} [mediaDir] directory with `<video>/master.m3u8`, `<video>/video.mp4`, …; null = synthetic
 * @property {string} [apiKey]
 * @property {string} [referer] the Referer every media request must carry
 * @property {number} [tokenTtlSec] lifetime of signed stream URLs
 * @property {() => number} [now] clock (ms) used for token expiry
 * @property {(r: UpstreamRequest) => void} [onRequest] called after each answered request
 */

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
    buf[o] = 0x47;
    buf[o + 1] = 0x01;
    buf[o + 2] = 0x00;
    buf[o + 3] = 0x10 | (p & 0x0f);
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
  const buf = Buffer.alloc(n);
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < n; i++) {
    const b = i < png.length ? png[i] : (i * 13 + 5) & 0xff;
    buf[i] = i >= png.length && b === 0x47 ? 0x00 : /** @type {number} */ (b);
  }
  return buf;
}

/** @param {string[]} names @param {number} seconds */
function mediaPlaylist(names, seconds) {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${seconds}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
    ...names.flatMap((n) => [`#EXTINF:${seconds}.000,`, n]),
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

/**
 * In-memory media for the video `demo`: a master playlist with two video variants (one written as an absolute
 * URI), English and Turkish audio renditions, English WebVTT subtitles, and a 256 KiB `video.mp4` pattern.
 * @returns {Map<string, Buffer>}
 */
export function syntheticMedia() {
  const files = new Map();
  const put = (/** @type {string} */ name, /** @type {string | Buffer} */ data) => files.set(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
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
  const mp4 = Buffer.alloc(256 * 1024);
  for (let i = 0; i < mp4.length; i++) mp4[i] = (i * 7 + (i >> 8)) & 0xff;
  put("demo/video.mp4", mp4);
  put("demo/info.json", JSON.stringify({ title: "Demo", languages: { audio: ["en", "tr"], subtitles: ["en"] } }));
  return files;
}

/** @param {string} header @param {number} size */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
    if (n === 0) return "unsatisfiable";
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/**
 * Starts the upstream. Resolves once it listens.
 * @param {UpstreamOptions} [opts]
 */
export async function startUpstream(opts = {}) {
  const apiKey = opts.apiKey ?? DEFAULT_API_KEY;
  const referer = opts.referer ?? DEFAULT_REFERER;
  const tokenTtlSec = opts.tokenTtlSec ?? 600;
  const now = opts.now ?? Date.now;
  const secret = randomBytes(32);
  const memory = opts.mediaDir ? null : syntheticMedia();
  const mediaDir = opts.mediaDir ? path.resolve(opts.mediaDir) : null;
  /** @type {UpstreamRequest[]} */
  const requests = [];

  /** @param {string} video @param {number} exp @param {number} junk */
  const sign = (video, exp, junk) => createHmac("sha256", secret).update(`${video}:${exp}:${junk}`).digest().subarray(0, 16).toString("base64url");

  /** @param {string} token @param {string} video */
  const checkToken = (token, video) => {
    const m = /^(\d{1,12})-(\d{1,7})-([A-Za-z0-9_-]{22})$/.exec(token);
    if (!m) return null;
    const exp = Number(m[1]);
    const junk = Number(m[2]);
    const given = Buffer.from(/** @type {string} */ (m[3]), "base64url");
    const expected = Buffer.from(sign(video, exp, junk), "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    if (now() / 1000 >= exp) return null;
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
    const file = path.join(/** @type {string} */ (mediaDir), name);
    if (!file.startsWith(`${mediaDir}${path.sep}`)) return null;
    try {
      const st = await stat(file);
      if (!st.isFile()) return null;
      return { size: st.size, read: (start = 0, end = st.size - 1) => createReadStream(file, { start, end }) };
    } catch {
      return null;
    }
  };

  /** @param {string} name */
  const readText = async (name) => {
    if (memory) return memory.get(name)?.toString("utf8") ?? null;
    try {
      return await readFile(path.join(/** @type {string} */ (mediaDir), name), "utf8");
    } catch {
      return null;
    }
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
      if (text === null) return send(res, 404, "not found");
      return send(res, 200, text.replaceAll("{{base}}", base), type);
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
    if (req.method === "HEAD") return void res.end();
    if (prefix) res.write(prefix);
    const body = range ? file.read(range.start, range.end) : file.read();
    if (Buffer.isBuffer(body)) res.end(body);
    else body.pipe(res);
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
        if (req.headers["x-api-key"] !== apiKey) return send(res, 401, JSON.stringify({ error: "bad_api_key" }), TYPES.json);
        if (parts[1] === "health" && parts.length === 2) return send(res, 200, JSON.stringify({ ok: true }), TYPES.json);
        if (parts[1] === "streams" && parts.length === 3 && VIDEO_ID.test(parts[2] ?? "")) return await streamsApi(req, res, /** @type {string} */ (parts[2]), url);
        return send(res, 404, JSON.stringify({ error: "not_found" }), TYPES.json);
      }
      if ((parts[0] === "s" && parts.length >= 4) || (parts[0] === "static" && parts.length >= 3)) {
        if (req.headers.referer !== referer) return send(res, 403, "referer required");
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

  /**
   * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
   * @param {string} video @param {URL} url
   */
  async function streamsApi(req, res, video, url) {
    const format = url.searchParams.get("format") === "mp4" ? "mp4" : "hls";
    const inline = url.searchParams.get("delivery") === "inline";
    const junk = Math.min(Math.max(Number(url.searchParams.get("junk") ?? 0) || 0, 0), 65_536);
    const entry = format === "mp4" ? "video.mp4" : "master.m3u8";
    if (!(await lookup(`${video}/${entry}`))) return send(res, 404, JSON.stringify({ error: "not_found" }), TYPES.json);
    const exp = Math.floor(now() / 1000) + tokenTtlSec;
    const base = `${originOf(req)}/s/${exp}-${junk}-${sign(video, exp, junk)}/${video}/`;
    const info = JSON.parse((await readText(`${video}/info.json`)) ?? "{}");
    const answer = { referer, expiresAt: new Date(exp * 1000).toISOString(), ...(info.languages ? { languages: info.languages } : {}) };
    if (inline && format === "hls") {
      const text = /** @type {string} */ (await readText(`${video}/master.m3u8`));
      return send(res, 200, JSON.stringify({ ...answer, playlist: text.replaceAll("{{base}}", base), baseUrl: base }), TYPES.json);
    }
    return send(res, 200, JSON.stringify({ ...answer, url: `${base}${entry}` }), TYPES.json);
  }

  const host = opts.host ?? "127.0.0.1";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8788, host, () => resolve(undefined));
  });
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  return {
    url,
    port: address.port,
    apiKey,
    referer,
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      media: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      "token-ttl": { type: "string" },
      verbose: { type: "boolean" },
    },
  });
  const up = await startUpstream({
    mediaDir: values.media ?? null,
    ...(values.host ? { host: values.host } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values["token-ttl"] ? { tokenTtlSec: Number(values["token-ttl"]) } : {}),
    ...(values.verbose
      ? {
          onRequest: (/** @type {UpstreamRequest} */ r) =>
            void process.stdout.write(`${r.status} ${r.path}${r.range ? ` range=${r.range}` : ""}${r.referer ? "" : " (no referer)"}\n`),
        }
      : {}),
  });
  process.stdout.write(`example upstream on ${up.url} (${values.media ? `media from ${path.resolve(values.media)}` : "synthetic media"})\n`);
  for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) process.once(sig, () => void up.close().then(() => process.exit(0)));
}
