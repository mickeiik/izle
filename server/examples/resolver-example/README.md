# Example resolver module

A complete, public example of the [resolver module API v1](../../../docs/spec/resolver-module-v1.md): what an
owner with a private catalog writes, out of tree, to turn catalog references into playable streams at play time.
Everything here is synthetic and local; nothing points at a real site.

| File | What |
|---|---|
| [`index.js`](index.js) | the resolver module: one adapter, `example` |
| [`upstream.js`](upstream.js) | a local stand-in for a streaming site, with the traits the contract was designed for |
| [`make-media.sh`](make-media.sh) | generates real, playable media for the upstream (ffmpeg test pattern) |
| [`catalog/`](catalog/) | a catalog bundle whose sources use the adapter (posters generated with ImageMagick) |
| [`izle.example.json`](izle.example.json) | a server configuration tying the three together |

The server tests use the same module and upstream (with synthetic in-memory media) through
`server/test/fixtures/test-resolver.js`.

## The stand-in upstream

`upstream.js` behaves like a typical site that streams with protection:

- `GET /api/streams/<video>` (header `X-Api-Key`) answers `{url, referer, expiresAt, languages}`: a **signed,
  expiring** URL (the signature and expiry live in the path, so relative segment URIs inherit them);
  `?delivery=inline` returns the master playlist **text** instead of a URL, `?format=mp4` a progressive MP4.
- Every media request needs the right **`Referer`**, else `403`; an expired signature also answers `403`.
- `?junk=<n>` prefixes every MPEG-TS segment with `n` junk bytes (a fake PNG header), as some sites do.
- `/static/<video>/…` serves the same files without a signature, still Referer-bound: for bundle `direct`
  sources that list a `Referer` header.

Without `--media` it serves small synthetic files (not decodable video — enough for the tests).

## The module

`createAdapters(ctx)` reads `apiBase` and `apiKey` from `ctx.config` and returns one adapter. Its `resolve` asks the
upstream's API for the stream (passing `req.signal` so a deadline or a TV that goes away cancels the call) and
returns the URL or the inline playlist **plus the `Referer` header it needs**. izle sees the header, serves the
stream through its proxy, and the TV never sees the header or the upstream URL. A video the upstream does not know
returns `[]`, so the server moves on to the episode's next source. Errors are thrown as `UpstreamError` with the
URL in the message — izle records only the class name, never the message.

Refs it understands (opaque to izle; their shape is the module's own business):

```json
{ "video": "demo" }
{ "video": "demo", "inline": true }
{ "video": "demo", "format": "mp4" }
{ "video": "demo", "junkBytes": 1000 }
```

## Run it

From the repository root (needs `ffmpeg` with libx264 and drawtext for real video):

```bash
server/examples/resolver-example/make-media.sh /tmp/izle-media 600
node server/examples/resolver-example/upstream.js --media /tmp/izle-media --verbose
npm run -w server dev -- --config server/examples/resolver-example/izle.example.json
npm run -s -w server dev -- check-resolver --config server/examples/resolver-example/izle.example.json
```

The server listens on port 8787 with the example catalog and keeps its state in `server/data/example/`. Pair a TV
(or the emulator, `--es izle.server http://10.0.2.2:8787`) from the admin page at `http://localhost:8787/admin/`
— print the token with `npm run -s -w server dev -- admin-token --config server/examples/resolver-example/izle.example.json`
— and put the example shows on its home screen. `--token-ttl 330` on the upstream makes signed URLs expire mid-way
through the 10-minute video, to watch the TV recover (the proxy answers 410, the TV resolves again and continues).

The example configuration turns on `proxy.alignTsSegments`, because one of its shows ("Junk before segments")
only plays with it. The server default is off.

## Writing your own

Copy `index.js`, keep the shape (`apiVersion`, `createAdapters`, adapters with `id`, `resolve`, optional
`healthcheck`) and replace the API calls with your site's. Keep the module and its catalog out of this repository;
point `resolver.module` at it by local path. Check it with `izle-server check-resolver`, and test single episodes
from the admin page (Catalog → a show → Test sources).
