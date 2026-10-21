#!/usr/bin/env node
// @ts-check
// A local stand-in for a streaming site (see README.md), used by the example resolver module and by the server tests.
// Media comes from a directory made by make-media.sh (real video, for the emulator) or, without one, is
// synthesized in memory (tests). Playlists may contain `{{base}}`, replaced by the absolute URL of the video's
// directory, so absolute URIs can be tested. Each video also has a channel view, `live.m3u8` and `stream.ts`: the
// video played in a loop as if it were broadcast, its clock taken from `now`.
//
//   node upstream.js [--media <dir>] [--port 8788] [--token-ttl <seconds>] [--verbose]   (listens on 127.0.0.1)

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

/** Channel view: segments last 6 s and are numbered from the epoch, so every view of a channel agrees on "now". */
const LIVE_SEGMENT_MS = 6000;
/** Segments a live playlist lists. A raw stream starts with all of them at once: the player's buffer. */
const LIVE_WINDOW = 5;
/** MPEG-TS clocks (PCR base, PTS, DTS) count 90 kHz ticks modulo 2^33. */
const TS_CLOCK = 2 ** 33;
/** The channel view's paths under a video: its live playlist, a segment of it (the number), the raw stream. */
const LIVE_PATH = /^(?:live\.m3u8|stream\.ts|live\/seg(\d{1,15})\.ts)$/;

/**
 * The live window at `nowMs`: the first and the last segment a live playlist lists. Segment `n` covers
 * [n × 6 s, (n + 1) × 6 s) since the epoch and is listed once it is complete.
 * @param {number} nowMs
 */
export function liveWindow(nowMs) {
  const last = Math.floor(nowMs / LIVE_SEGMENT_MS) - 1;
  return { first: last - LIVE_WINDOW + 1, last };
}

/**
 * The channel view of a video.
 * @typedef {object} LiveSource
 * @property {(n: number) => number} seconds the duration of live segment `n`
 * @property {(n: number) => Promise<Buffer>} read the bytes of live segment `n`, as the video has them
 * @property {{ segments: number, ticks: number } | null} loop the looped video's segment count and length (90 kHz
 *   ticks); null for synthetic media, whose segments never repeat
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

/**
 * The segments of a VOD media playlist, in order: durations and plain file names in the playlist's directory.
 * @param {string} text
 */
function vodSegments(text) {
  /** @type {Array<{ seconds: number, name: string }>} */
  const out = [];
  /** @type {number | null} */
  let seconds = null;
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    const inf = /^#EXTINF:([\d.]+)/.exec(line);
    if (inf) seconds = Number(inf[1]);
    else if (line !== "" && !line.startsWith("#")) {
      if (seconds && /^[\w-]+\.ts$/.test(line)) out.push({ seconds, name: line });
      seconds = null;
    }
  }
  return out;
}

/**
 * A sliding live media playlist: the window at `nowMs`, segments `live/seg<n>.ts`, no end and no playlist type. A
 * looped video starts over behind an `#EXT-X-DISCONTINUITY` (its timestamps go back), counted by
 * `#EXT-X-DISCONTINUITY-SEQUENCE` once the window slid past it.
 * @param {LiveSource} src @param {number} nowMs
 */
function livePlaylist(src, nowMs) {
  const { first, last } = liveWindow(nowMs);
  const numbers = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const target = Math.ceil(Math.max(...numbers.map(src.seconds)));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${first}`];
  if (src.loop) lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / src.loop.segments)}`);
  for (const n of numbers) {
    if (src.loop && n !== first && n % src.loop.segments === 0) lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXTINF:${src.seconds(n).toFixed(3)},`, `live/seg${n}.ts`);
  }
  return [...lines, ""].join("\n");
}

/**
 * Joins the MPEG-TS segments of a looped video into one stream that a player takes for a single broadcast: each
 * round's PCR, PTS and DTS move on by the loop's length (modulo 2^33, as broadcast clocks wrap), and continuity
 * counters run on across the joins (a repeated counter reads as a duplicate packet, a jump as lost ones). HLS has
 * `#EXT-X-DISCONTINUITY` for this; a raw stream has nothing but its bytes.
 * @param {number} loopTicks the video's length in 90 kHz ticks
 * @returns {(segment: Buffer, round: number) => Buffer}
 */
function tsJoiner(loopTicks) {
  /** @type {Map<number, number>} */
  const counters = new Map();
  return (segment, round) => {
    const out = Buffer.from(segment);
    const shift = (round * loopTicks) % TS_CLOCK;
    for (let o = 0; o + 188 <= out.length; o += 188) {
      if (out[o] !== 0x47) continue;
      const end = o + 188;
      const pid = ((out[o + 1] & 0x1f) << 8) | out[o + 2];
      const control = (out[o + 3] >> 4) & 3; // bit 1: adaptation field, bit 0: payload
      const prev = counters.get(pid);
      // The counter goes up with every packet that carries a payload and stays with one that does not.
      const cc = prev === undefined ? out[o + 3] & 0x0f : control & 1 ? (prev + 1) & 0x0f : prev;
      counters.set(pid, cc);
      out[o + 3] = (out[o + 3] & 0xf0) | cc;
      let p = o + 4;
      if (control & 2) {
        if (out[p] >= 7 && out[p + 1] & 0x10) shiftPcr(out, p + 2, shift);
        p += 1 + out[p];
      }
      // A PES header at the start of a payload: its flags say whether a PTS, or a PTS and a DTS, follow.
      if (!(control & 1) || !(out[o + 1] & 0x40) || p + 9 > end || out[p] !== 0 || out[p + 1] !== 0 || out[p + 2] !== 1) continue;
      if ((out[p + 6] & 0xc0) !== 0x80) continue;
      const flags = out[p + 7] >> 6;
      if (flags & 2 && p + 14 <= end) shiftTimestamp(out, p + 9, shift);
      if (flags === 3 && p + 19 <= end) shiftTimestamp(out, p + 14, shift);
    }
    return out;
  };
}

/**
 * Moves the PES timestamp (PTS or DTS: 33 bits in 5 bytes, with marker bits) written at `i` by `shift` ticks.
 * @param {Buffer} b @param {number} i @param {number} shift
 */
function shiftTimestamp(b, i, shift) {
  const old = ((b[i] >> 1) & 7) * 2 ** 30 + ((b[i + 1] << 7) | (b[i + 2] >> 1)) * 2 ** 15 + ((b[i + 3] << 7) | (b[i + 4] >> 1));
  const v = (old + shift) % TS_CLOCK;
  const [high, mid, low] = [Math.floor(v / 2 ** 30), Math.floor(v / 2 ** 15) % 2 ** 15, v % 2 ** 15];
  b[i] = (b[i] & 0xf1) | (high << 1);
  b[i + 1] = mid >> 7;
  b[i + 2] = ((mid & 0x7f) << 1) | 1;
  b[i + 3] = low >> 7;
  b[i + 4] = ((low & 0x7f) << 1) | 1;
}

/**
 * Moves the PCR base (33 bits; then 6 reserved bits and a 9-bit extension, 6 bytes in all) written at `i` by
 * `shift` ticks.
 * @param {Buffer} b @param {number} i @param {number} shift
 */
function shiftPcr(b, i, shift) {
  const old = b[i] * 2 ** 25 + b[i + 1] * 2 ** 17 + b[i + 2] * 2 ** 9 + b[i + 3] * 2 + (b[i + 4] >> 7);
  const v = (old + shift) % TS_CLOCK;
  b[i] = Math.floor(v / 2 ** 25);
  b[i + 1] = Math.floor(v / 2 ** 17) & 0xff;
  b[i + 2] = Math.floor(v / 2 ** 9) & 0xff;
  b[i + 3] = Math.floor(v / 2) & 0xff;
  b[i + 4] = ((v % 2) << 7) | (b[i + 4] & 0x7f);
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
 * @param {number} [opts.port]
 * @param {string | null} [opts.mediaDir] directory with `<video>/master.m3u8`, `<video>/video.mp4`, …; null = synthetic
 * @param {number} [opts.tokenTtlSec] lifetime of signed stream URLs
 * @param {() => number} [opts.now] clock (ms) used for token expiry and for the channel view's live window
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
   * The channel view of `video`: its `video/360p` rendition in a loop (real media), or one synthetic segment per
   * number (tests). Null when the video has no such rendition.
   * @param {string} video @returns {Promise<LiveSource | null>}
   */
  const liveSource = async (video) => {
    const text = await readText(`${video}/video/360p/index.m3u8`);
    if (text === null) return null;
    if (memory) return { seconds: () => LIVE_SEGMENT_MS / 1000, read: async (n) => syntheticTsSegment(n), loop: null };
    const segments = vodSegments(text);
    if (segments.length === 0) return null;
    const at = (/** @type {number} */ n) => segments[n % segments.length];
    return {
      seconds: (n) => at(n).seconds,
      read: (n) => readFile(path.join(mediaDir, video, "video", "360p", at(n).name)),
      loop: { segments: segments.length, ticks: Math.round(segments.reduce((sum, s) => sum + s.seconds, 0) * 90_000) },
    };
  };

  /**
   * `stream.ts`: the channel as one endless MPEG-TS response. It starts with the whole live window at once (the
   * player's buffer), then sends one segment per its duration, so a TV stays a few segments ahead instead of reading
   * the loop as fast as it can. It stops when the client goes away. `Range` is ignored (200): an endless stream has no
   * byte positions to go back to.
   * @param {import("node:http").ServerResponse} res @param {LiveSource} src @param {number} nowMs
   */
  const streamLive = async (res, src, nowMs) => {
    let closed = false;
    let wake = () => {};
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    res.on("close", () => {
      closed = true;
      clearTimeout(timer);
      wake();
    });
    /** Waits for what `start` sets up, or for the client to go away. @param {(done: () => void) => void} start */
    const until = (start) =>
      closed
        ? Promise.resolve()
        : new Promise((resolve) => {
            wake = () => resolve(undefined);
            start(wake);
          });
    res.writeHead(200, { "Content-Type": TYPES.ts, "Accept-Ranges": "none", "Cache-Control": "no-store" });
    const join = src.loop ? tsJoiner(src.loop.ticks) : null;
    const { first } = liveWindow(nowMs);
    const started = performance.now();
    let paced = 0; // seconds of media sent after the window
    for (let n = first; !closed; n++) {
      const raw = await src.read(n);
      if (closed) break;
      const bytes = join && src.loop ? join(raw, Math.floor(n / src.loop.segments)) : raw;
      if (!res.write(bytes)) await until((done) => res.once("drain", done));
      if (n - first + 1 < LIVE_WINDOW) continue;
      paced += src.seconds(n);
      await until((done) => (timer = setTimeout(done, started + paced * 1000 - performance.now())));
    }
  };

  /**
   * The channel view of `video`: `live.m3u8`, a segment of it (`segment`: its number) or `stream.ts`.
   * @param {import("node:http").ServerResponse} res
   * @param {string} video @param {string} rest @param {string | undefined} segment @param {number} junk
   */
  const serveLive = async (res, video, rest, segment, junk) => {
    const src = await liveSource(video);
    if (!src) return send(res, 404, "not found");
    const t = now();
    if (rest === "live.m3u8") return send(res, 200, livePlaylist(src, t), TYPES.m3u8);
    if (rest === "stream.ts") return await streamLive(res, src, t);
    const n = Number(segment);
    if (n > liveWindow(t).last) return send(res, 404, "not found"); // not broadcast yet
    const bytes = await src.read(n);
    const body = junk > 0 ? Buffer.concat([junkBytes(junk), bytes]) : bytes;
    res.writeHead(200, { "Content-Type": TYPES.ts, "Content-Length": body.length, "Accept-Ranges": "none" });
    res.end(body);
  };

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
    if (range === "unsatisfiable") return void res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    const headers = { "Content-Type": type, "Accept-Ranges": prefix ? "none" : "bytes" };
    if (range) res.writeHead(206, { ...headers, "Content-Length": range.end - range.start + 1, "Content-Range": `bytes ${range.start}-${range.end}/${size}` });
    else res.writeHead(200, { ...headers, "Content-Length": size });
    if (prefix) res.write(prefix);
    const body = range ? file.read(range.start, range.end) : file.read();
    if (Buffer.isBuffer(body)) res.end(body);
    else body.pipe(res);
  };

  /**
   * `GET /api/streams/<video>`: a signed, expiring URL (or the master playlist text) and the Referer it needs.
   * `?live=1` names the channel view as a live playlist, `?format=ts` as one endless MPEG-TS stream.
   * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
   * @param {string} video @param {URL} url
   */
  const streamsApi = async (req, res, video, url) => {
    const asked = url.searchParams.get("format");
    const format = asked === "mp4" || asked === "ts" ? asked : "hls";
    const channel = format === "ts" || (format === "hls" && url.searchParams.get("live") === "1");
    const inline = format === "hls" && url.searchParams.get("delivery") === "inline";
    // A live playlist slides on every few seconds: as text, it would be stale before it played out.
    if (channel && inline) return sendJson(res, 400, { error: "inline_is_vod_only" });
    const junk = Math.min(Math.max(Number(url.searchParams.get("junk") ?? 0) || 0, 0), 65_536);
    const entry = { hls: channel ? "live.m3u8" : "master.m3u8", mp4: "video.mp4", ts: "stream.ts" }[format];
    const known = channel ? await liveSource(video) : await lookup(`${video}/${entry}`);
    if (!known) return sendJson(res, 404, { error: "not_found" });
    const exp = Math.floor(now() / 1000) + tokenTtlSec;
    const base = `${originOf(req)}/s/${exp}-${junk}-${sign(video, exp, junk)}/${video}/`;
    const info = JSON.parse((await readText(`${video}/info.json`)) ?? "{}");
    // The channel view has no subtitles and only the video rendition: it leaves the languages to the catalog.
    const languages = info.languages && !channel ? { languages: info.languages } : {};
    const answer = { referer: DEFAULT_REFERER, expiresAt: new Date(exp * 1000).toISOString(), ...languages };
    if (inline) {
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
    // "close" also fires when the client stops reading a stream early (players do that all the time).
    res.on("close", () => {
      record.status = res.statusCode;
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
        const live = LIVE_PATH.exec(rest);
        if (live) return await serveLive(res, video, rest, live[1], token.junk);
        const base = `${originOf(req)}/${signed ? `s/${parts[1]}` : "static"}/${video}/`;
        return await serveFile(req, res, video, rest, base, token.junk);
      }
      return send(res, 404, "not found");
    } catch {
      if (!res.headersSent) send(res, 500, "error");
      else res.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8788, "127.0.0.1", () => resolve(undefined));
  });
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
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
  const { values } = parseArgs({ options: { media: str, port: str, "token-ttl": str, verbose: bool } });
  const up = await startUpstream({
    mediaDir: values.media ?? null,
    port: values.port ? Number(values.port) : undefined,
    tokenTtlSec: values["token-ttl"] ? Number(values["token-ttl"]) : undefined,
    onRequest: values.verbose
      ? (r) => void process.stdout.write(`${r.status} ${r.path}${r.range ? ` range=${r.range}` : ""}${r.referer ? "" : " (no referer)"}\n`)
      : undefined,
  });
  process.stdout.write(`example upstream on ${up.url} (${values.media ? `media from ${path.resolve(values.media)}` : "synthetic media"})\n`);
  for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) process.once(sig, () => void up.close().then(() => process.exit(0)));
}
