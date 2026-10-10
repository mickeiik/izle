# Phase 4 verification — resolver module and media proxy on the emulator

Run on 2026-10-10 on the `izle_tv` AVD (Android TV, API 36, x86_64) started headless with `-no-window -no-audio
-gpu swiftshader_indirect -no-snapshot`, debug APK from `./gradlew :app:assembleDebug :app:testDebugUnitTest`,
against the [example resolver](../../../server/examples/resolver-example/README.md):

```bash
server/examples/resolver-example/make-media.sh "$MEDIA" 600         # 10-minute test pattern, HLS + MP4
node server/examples/resolver-example/upstream.js --media "$MEDIA" --token-ttl 330 --verbose
npm run -w server dev -- --config server/examples/resolver-example/izle.example.json
```

The TV only ever talks to izle-server (`http://10.0.2.2:8787`); the upstream on the host (`127.0.0.1:8788`) is
reached by the server alone and refuses requests without its `Referer`. Screenshots are `adb exec-out screencap`
captures scaled to 1280×720. Every test pattern frame carries its own clock (top left), so a frame shows where in
the video playback is.

| # | Screenshot | Step | Result |
|---|---|---|---|
| 1 | [01-home-continue](01-home-continue.jpg) | example shows on the home screen (after a few plays) | posters from the example bundle; "Continue" chips with progress |
| 2 | [02-proxy-hls-playing](02-proxy-hls-playing.jpg) | OK on *Proxy demo* (adapter `example`, signed, Referer-bound HLS) | server: `resolved … delivery:"proxy" adapterId:"example"`; the TV played `/p/<token>/index.m3u8` |
| 3 | [03-expired-url-resumed](03-expired-url-resumed.jpg) | kept playing past the 330 s token lifetime | 19:04:01 upstream 403 → session marked stale → 410 to the TV; at 6:14 (buffer drained, > 5 min played) the TV re-resolved the same source and continued at 6:14 with a new session |
| 4 | [04-audio-turkish-via-proxy](04-audio-turkish-via-proxy.jpg) | hidden menu → Audio language → Turkish | both `EXT-X-MEDIA` audio renditions (rewritten `URI="…"`) listed; Turkish selected and played on |
| 5 | [05-inline-playlist](05-inline-playlist.jpg) | OK on *Inline playlist* (adapter returns the playlist text) | played (`resolved … sourceId:"inline-hls" delivery:"proxy"`); that the master playlist is never fetched is asserted by the tests |
| 6 | [06-mp4-after-seek](06-mp4-after-seek.jpg) | OK on *MP4 via proxy*, → ×6 | upstream log: `206 /s/<token>/demo/video.mp4 range=bytes=6691772-` — the TV's `Range` passed through, playback continued at the target |
| 7 | [07-junk-without-alignment](07-junk-without-alignment.jpg) | OK on *Junk before segments* (1000 junk bytes before every TS segment), `proxy.alignTsSegments` off | Media3 1.11.1: `ParserException: Cannot find sync byte. Most likely not a Transport Stream`; no alternative → "Can't play right now" |
| 8 | [08-junk-with-alignment](08-junk-with-alignment.jpg) | server restarted with `proxy.alignTsSegments: true`, Try again | plays; no parser error |
| 9 | [09-fallback-second-source](09-fallback-second-source.jpg) | OK on *Fallback demo* (first source unknown to the upstream) | module log `video not found upstream`, server `adapter failed … code:"empty"`, then the second source resolved and played |
| 10 | [10-subtitles-via-proxy](10-subtitles-via-proxy.jpg) | subtitles set to English, *Proxy series* episode 1 | the WebVTT rendition came through the proxy; "Example subtitle at 20 s" shown from 20 to 24 s (`X-TIMESTAMP-MAP` honoured) |
| 11 | [11-auto-next-turkish](11-auto-next-turkish.jpg) | seeked to the end of episode 1 (menu language Turkish) | "Sıradaki · Bölüm 2 · Inline playlist"; episode 2 (inline playlist) started by itself through the proxy |

Also checked:

- **Direct bundle source with headers** (*Direct with headers*, no adapter): proxied; every `/static/…` request
  reached the upstream with the `Referer`.
- **Logs:** the server log of the whole run contained no upstream URL or path (`/s/`), no port of the upstream, no
  `Referer` value, no API key, no proxy token and no admin token.
- **`check-resolver`** against the running upstream: module loaded, catalog adapters provided, `✔ example:
  healthy`.

Automated coverage (`npm test -w server`): Referer-bound HLS only through the proxy with every URI rewritten and
signed, forged/foreign refs refused, inline playlists, header-bound bundle sources, MP4 `Range` passthrough,
streaming without buffering and cancellation when the TV goes away, deadlines (adapter ignoring its signal) and
the request budget, stale session → 410 after an upstream 403 and session expiry, the two-sessions-per-device cap,
junk-prefixed segments with and without alignment, adapter failures reduced to `{adapterId, code, name}` in
responses and logs, the first servable result, header-bound subtitle tracks, `proxy.always`, diagnostics,
the loader's checks and `check-resolver`, plus HLS rewriting unit tests.
