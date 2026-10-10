import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { probeBundle, type Bundle } from "../src/index.ts";

test("probe range-GETs direct media and subtitles, follows redirects, forwards headers", async () => {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders; method: string }> = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers, method: req.method ?? "" });
    if (req.url === "/ok.m3u8") return void res.writeHead(206, { "Content-Range": "bytes 0-0/10" }).end("#");
    if (req.url === "/moved") return void res.writeHead(302, { Location: "/ok.m3u8" }).end();
    if (req.url === "/needs-referer.mp4") {
      return void res.writeHead(req.headers.referer === "https://site.example.test/" ? 200 : 403).end("x");
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const languages = { audio: null, subtitles: null };
  const bundle: Bundle = {
    dir: "/x",
    manifest: { format: "izle-bundle", formatVersion: 1, catalogId: "c", buildId: "b", builtAt: "2026-01-01T00:00:00Z", name: "n", adapters: ["a"], items: "items.json", assetsDir: "assets" },
    items: [
      {
        id: "i",
        kind: "movie",
        title: "t",
        poster: null,
        episodes: [
          {
            id: "e",
            playbackAllowed: true,
            sources: [
              { id: "ok", type: "direct", languages, media: { kind: "hls", url: `${base}/ok.m3u8` }, subtitleTracks: [{ url: `${base}/gone.vtt`, language: "en", format: "vtt" }] },
              { id: "redirect", type: "direct", languages, media: { kind: "hls", url: `${base}/moved` } },
              { id: "hdr", type: "direct", languages, media: { kind: "mp4", url: `${base}/needs-referer.mp4`, headers: { Referer: "https://site.example.test/" } } },
              { id: "adapter", type: "adapter", adapter: "a", ref: {}, languages },
            ],
          },
        ],
      },
    ],
  };
  try {
    const results = await probeBundle(bundle, { concurrency: 2 });
    const byId = Object.fromEntries(results.map((r) => [`${r.target.sourceId}:${r.target.what}`, r]));
    assert.equal(results.length, 4, "adapter sources are not probed");
    assert.equal(byId["ok:media"]?.ok, true);
    assert.equal(byId["ok:media"]?.status, 206);
    assert.equal(byId["ok:subtitle"]?.ok, false);
    assert.equal(byId["ok:subtitle"]?.status, 404);
    assert.equal(byId["redirect:media"]?.ok, true);
    assert.equal(byId["hdr:media"]?.ok, true);
    assert.ok(seen.every((s) => s.method === "GET" && s.headers.range === "bytes=0-0"));
  } finally {
    server.close();
  }
});
