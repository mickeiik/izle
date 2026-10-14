# Vendored files

Pinned third-party builds served from `/admin/vendor/` (an allow-list in `server/src/admin-files.ts`). They are the only
exception to the admin page's "no dependencies" rule. Update by replacing the file, this table and the license.

| File | Package | Version | Source | SHA-256 |
|---|---|---|---|---|
| `hls.min.js` | [hls.js](https://github.com/video-dev/hls.js) (Apache-2.0, `LICENSE-hls.js`) | 1.7.3 | `dist/hls.min.js` of the npm tarball `https://registry.npmjs.org/hls.js/-/hls.js-1.7.3.tgz` | `a12e7ee1cd64a69dcdb314157e45dafcba705bfb0b1440b7935cb265d374423e` |

`hls.min.js` is the full build: the light build drops alternate-audio support, which "Listen along" needs to
pick a language inside a multi-audio HLS stream. It is loaded lazily, only when the phone's browser cannot play
HLS natively, and runs without a web worker (the page's CSP has no `worker-src`).
