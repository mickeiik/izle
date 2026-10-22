import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlaylistText, PlaylistTooLarge, rewritePlaylist, summarizePlaylist, tsSyncOffset } from "../src/hls.ts";
import { junkBytes, syntheticTsSegment } from "../examples/resolver-example/upstream.js";

const BASE = "https://cdn.example.test/vod/show/master.m3u8?sig=abc";
const tag = (url: string, kind: string) => `[${kind}:${url}]`;

/** Rewrites the input lines of `pairs` (each `[input, output]`, or `[line]` when it stays as it is) and compares. */
function assertRewrites(pairs: string[][], base: string, separator = "\n") {
  const out = rewritePlaylist(pairs.map((p) => p[0]).join(separator), base, tag);
  assert.deepEqual(out.split("\n"), pairs.map((p) => p[1] ?? p[0]));
}

test("master playlist: variants are playlists, rendition and i-frame URIs too; relative URIs resolve against the base", () => {
  const cdn = "https://cdn.example.test";
  assertRewrites([
    ["﻿#EXTM3U", "#EXTM3U"],
    ["#EXT-X-VERSION:6"],
    ['## a comment with URI="not-touched.m3u8"'],
    ['#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="tr",NAME="Türkçe",URI="audio/tr.m3u8"',
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="tr",NAME="Türkçe",URI="[p:${cdn}/vod/show/audio/tr.m3u8]"`],
    ['#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="en",NAME="English"'],
    ['#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="/subs/en.m3u8?x=1"',
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="[p:${cdn}/subs/en.m3u8?x=1]"`],
    ['#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="iframe/index.m3u8"', `#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="[p:${cdn}/vod/show/iframe/index.m3u8]"`],
    ['#EXT-X-SESSION-KEY:METHOD=AES-128,URI="../keys/session.key"', `#EXT-X-SESSION-KEY:METHOD=AES-128,URI="[r:${cdn}/vod/keys/session.key]"`],
    ['#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,AUDIO="aud",SUBTITLES="subs"'],
    ["720p/index.m3u8", `[p:${cdn}/vod/show/720p/index.m3u8]`],
    [""],
    ['#EXT-X-STREAM-INF:BANDWIDTH=640000,CODECS="avc1.4d401e,mp4a.40.2"'],
    ["  //other-cdn.example.test/480p/index.m3u8  ", "[p:https://other-cdn.example.test/480p/index.m3u8]"],
    ["#EXT-X-STREAM-INF:BANDWIDTH=300000"],
    ["https://third.example.test/abs/240p.m3u8#frag", "[p:https://third.example.test/abs/240p.m3u8]"],
  ], BASE, "\r\n");
});

test("media playlist: segments, keys, maps, parts and preload hints are raw resources; data: and skd: stay", () => {
  const v = "https://cdn.example.test/v";
  assertRewrites([
    ["#EXTM3U"],
    ["#EXT-X-TARGETDURATION:6"],
    ['#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"', `#EXT-X-MAP:URI="[r:${v}/480p/init.mp4]",BYTERANGE="720@0"`],
    ['#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.test/k?id=7",IV=0x00000000000000000000000000000001',
      '#EXT-X-KEY:METHOD=AES-128,URI="[r:https://keys.example.test/k?id=7]",IV=0x00000000000000000000000000000001'],
    ["#EXTINF:6.0,"],
    ["seg-1.m4s?token=xyz", `[r:${v}/480p/seg-1.m4s?token=xyz]`],
    ["#EXT-X-BYTERANGE:1000@0"],
    ["#EXTINF:6.0,title with, commas"],
    ["seg 2.ts", `[r:${v}/480p/seg%202.ts]`],
    ['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-id",KEYFORMAT="com.apple.streamingkeydelivery"'],
    ['#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"'],
    ['#EXT-X-PART:DURATION=1.0,URI="part1.m4s"', `#EXT-X-PART:DURATION=1.0,URI="[r:${v}/480p/part1.m4s]"`],
    ['#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part2.m4s"', `#EXT-X-PRELOAD-HINT:TYPE=PART,URI="[r:${v}/480p/part2.m4s]"`],
    ['#EXT-X-RENDITION-REPORT:URI="../720p/index.m3u8",LAST-MSN=10', `#EXT-X-RENDITION-REPORT:URI="[p:${v}/720p/index.m3u8]",LAST-MSN=10`],
    ["#EXT-X-ENDLIST"],
  ], `${v}/480p/index.m3u8`);
});

test("summaries and playlist detection", () => {
  assert.deepEqual([isPlaylistText("﻿  #EXTM3U\n"), isPlaylistText("<html>")], [true, false]);
  const master = summarizePlaylist("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"a.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n");
  assert.deepEqual(master, { master: true, variants: 1, renditions: 1, segments: 0, endList: false });
  const media = summarizePlaylist("#EXTM3U\r\n#EXTINF:4,\r\na.ts\r\n\r\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST\n");
  assert.deepEqual(media, { master: false, variants: 0, renditions: 0, segments: 2, endList: true });
});

test("TS sync detection: aligned data, junk prefixes, and data that is not TS", () => {
  const seg = syntheticTsSegment(1);
  assert.equal(tsSyncOffset(seg), 0);
  for (const n of [1, 100, 187, 188, 1000, 4000]) assert.equal(tsSyncOffset(Buffer.concat([junkBytes(n), seg])), n, `junk ${n}`);
  assert.equal(tsSyncOffset(Buffer.concat([junkBytes(5000), seg])), 0, "beyond the 4 KB window nothing is trimmed");
  assert.equal(tsSyncOffset(Buffer.concat([junkBytes(100), seg.subarray(0, 188 * 3)])), 0, "too short to be sure");
  const notTs = Buffer.alloc(8192, 0x47);
  notTs[0] = 0;
  for (let i = 1; i < notTs.length; i += 2) notTs[i] = 0x11; // 0x47 only at even offsets: 188-spaced runs exist
  assert.equal(tsSyncOffset(notTs), 2, "a perfectly regular pattern is indistinguishable from TS");
  assert.equal(tsSyncOffset(Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 2654435761) >>> 24))), 0, "random bytes");
});

test("rewrite limits: lines, rewritten length and URL length are capped; a URL too long is refused, not kept", () => {
  const limits = { maxLines: 100, maxLength: 10_000, maxUrlLength: 200 };
  const sign = (url: string, kind: string) => `${kind}.${Buffer.from(url).toString("base64url")}`;
  const rewrite = (lines: string[], base = BASE) => rewritePlaylist(["#EXTM3U", ...lines].join("\n"), base, sign, limits);
  assert.equal(rewrite(["#EXTINF:4,", "seg0.ts", "#EXT-X-ENDLIST"]).split("\n")[2], sign("https://cdn.example.test/vod/show/seg0.ts", "r"), "within the limits");

  const tooLarge = (lines: string[], why: RegExp, base?: string) =>
    assert.throws(() => rewrite(lines, base), (e: unknown) => e instanceof PlaylistTooLarge && why.test(e.message) && !e.message.includes("example"));
  tooLarge(Array<string>(100).fill("#EXTINF:4,"), /more than 100 lines/);
  // Many 1-byte lines against a long base: each embeds the whole base, the input stays tiny.
  tooLarge(Array<string>(60).fill("a"), /more than 10000 characters/, `https://cdn.example.test/${"x".repeat(150)}/index.m3u8`);
  tooLarge([`${"y".repeat(200)}.ts`], /a URI longer than 200 characters/);
  tooLarge([`#EXT-X-KEY:METHOD=AES-128,URI="${"k".repeat(200)}"`], /a URI longer than 200 characters/);
  assert.ok(rewrite([`#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:${"k".repeat(300)}"`]).length > 300, "a data: URI is kept as it is");
});
