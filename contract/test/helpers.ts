import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** 1×1 transparent PNG. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
export const TINY_PNG_NAME = `${createHash("sha256").update(TINY_PNG).digest("hex")}.png`;

// Loosely typed on purpose: fixtures are mutated into invalid shapes.
export type Json = any;

export interface FixtureOptions {
  manifest?: (m: Json) => void;
  items?: (i: Json) => void;
  /** Extra files to write after the default ones, relative to the bundle dir; string values are written verbatim. */
  files?: Record<string, string | Buffer>;
}

/** A valid bundle (a movie with a direct source, a series with an adapter source) in a new temporary directory. */
export async function makeBundle(opts: FixtureOptions = {}): Promise<string> {
  const manifest: Json = {
    format: "izle-bundle", formatVersion: 1, catalogId: "fixture", buildId: "test-1", builtAt: "2026-10-10T12:00:00Z",
    name: "Fixture catalog", adapters: ["example"], items: "items.json", assetsDir: "assets",
  };
  const items: Json = {
    items: [
      {
        id: "movie-a", kind: "movie", title: "Movie A", year: 2001, poster: `assets/${TINY_PNG_NAME}`,
        episodes: [
          {
            id: "movie-a.film", playbackAllowed: true,
            sources: [
              {
                id: "hls", type: "direct", languages: { audio: ["en"], subtitles: [] },
                media: { kind: "hls", url: "https://media.example.test/a/master.m3u8" },
                subtitleTracks: [{ url: "https://media.example.test/a/en.vtt", language: "en", format: "vtt" }],
              },
            ],
          },
        ],
      },
      {
        id: "series-b", kind: "series", title: "Series B", poster: null,
        episodes: [
          {
            id: "series-b.e1", season: 1, number: 1, playbackAllowed: true,
            sources: [{ id: "a1", type: "adapter", adapter: "example", ref: { any: ["json", 1] }, languages: { audio: null, subtitles: null } }],
          },
          { id: "series-b.e2", season: 1, number: 2, playbackAllowed: false, sources: [] },
        ],
      },
    ],
  };
  const dir = await mkdtemp(path.join(tmpdir(), "izle-bundle-"));
  opts.manifest?.(manifest);
  opts.items?.(items);
  await mkdir(path.join(dir, "assets"));
  await writeFile(path.join(dir, "bundle.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, "items.json"), JSON.stringify(items, null, 2));
  await writeFile(path.join(dir, "assets", TINY_PNG_NAME), TINY_PNG);
  for (const [rel, content] of Object.entries(opts.files ?? {})) await writeFile(path.join(dir, rel), content);
  return dir;
}
