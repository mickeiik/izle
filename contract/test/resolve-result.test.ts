import { test } from "node:test";
import assert from "node:assert/strict";
import { RESOLVER_API_VERSION, validateResolveResultsSchema } from "../src/index.ts";

test("resolver API version is 1", () => {
  assert.equal(RESOLVER_API_VERSION, 1);
});

test("accepts URL media, inline playlists and optional fields", () => {
  const ok = validateResolveResultsSchema([
    { media: { kind: "mp4", url: "https://cdn.example.test/v.mp4" } },
    {
      media: { kind: "hls", playlist: "#EXTM3U\n#EXT-X-ENDLIST\n", baseUrl: "https://cdn.example.test/p/" },
      headers: { Referer: "https://site.example.test/" },
      languages: { audio: null, subtitles: ["tr"] },
      subtitleTracks: [{ url: "https://cdn.example.test/tr.vtt", language: "tr", format: "vtt", headers: { Origin: "https://site.example.test" } }],
      label: "alt",
      expiresAt: "2026-10-10T12:00:00Z",
    },
  ]);
  assert.equal(ok, true, JSON.stringify(validateResolveResultsSchema.errors));
});

test("rejects malformed results", () => {
  const bad: unknown[] = [
    { media: { kind: "dash", playlist: "#EXTM3U", baseUrl: "https://x.test/" } }, // inline playlists are HLS only
    { media: { kind: "hls", url: "https://x.test/a.m3u8", playlist: "#EXTM3U" } }, // url and playlist mixed
    { media: { kind: "mp4", url: "ftp://x.test/a.mp4" } },
    { media: { kind: "mp4", url: "https://x.test/a.mp4" }, headers: { Referer: "x\nInjected: 1" } },
    { media: { kind: "mp4", url: "https://x.test/a.mp4" }, extra: true },
    { media: { kind: "mp4", url: "https://x.test/a.mp4" }, expiresAt: "tomorrow" },
  ];
  for (const r of bad) assert.equal(validateResolveResultsSchema([r]), false, JSON.stringify(r));
  assert.equal(validateResolveResultsSchema({ media: {} }), false);
});
