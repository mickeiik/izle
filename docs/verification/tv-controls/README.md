# TV controls verification — channel keys, autoplay on start, stream refresh, owner commands, problem reports

Run on 2026-10-13/14 on the `izle_tv` AVD (Android TV, API 36, x86_64) started headless with `-no-window -no-audio
-gpu swiftshader_indirect -no-snapshot -cores 2 -memory 2048`, debug APK from
`./gradlew --max-workers=4 :app:assembleDebug :app:testDebugUnitTest` (90 JVM tests, all green). Keys were sent with
`adb shell input keyevent`, screenshots taken with `adb exec-out screencap` and scaled to 1280×720 JPEG. Three servers
were used, one after the other, all on `http://10.0.2.2:8787` as the emulator sees it:

1. **this branch's server** with `server/izle.dev.json` (the sample catalog; Caminandes media comes from its CDN);
2. **this branch's server** with the example resolver (`server/examples/resolver-example/izle.example.json`) and the
   example upstream started with `--token-ttl 100`, so every signed stream URL expires 100 s after it is handed out;
3. **the main branch's server** after the server side of these features was merged (read-only checkout, same
   example configuration; upstream with its default 600 s tokens): the new owner commands from the admin API,
   `autoplayOnStart` and `POST /tv/problems` exist only there.

## Channel keys (server 1, Caminandes)

| # | Screenshot | Step | Result |
|---|---|---|---|
| — | | CH+, CH−, ▶▶\|, \|◀◀ on Home | nothing happens, the app stays the resumed activity (`dumpsys activity`), the focus stays on the first tile |
| 1 | [01-ch-minus-on-episode-1](01-ch-minus-on-episode-1.jpg) | CH− while episode 1 plays | only the information appears; no request at all (the first episode needs no episode list) |
| 2 | [02-ch-plus-loads-episode-2](02-ch-plus-loads-episode-2.jpg) | CH+ during episode 1 at 0:30 | server log, within 32 ms: `GET /tv/items/:itemId`, `POST /tv/progress` (episode 1 `stopped` at 30.2 s), `resolved … caminandes.s01e02`; the loading screen names episode 2 at once; the cursor moved to episode 2 |
| — | | CH− during episode 2 | episode 1 again (the cached list: no `/tv/items` request), resumed 5 s before its saved 30.2 s |
| — | | CH+, then ▶▶\| | episode 2, then episode 3 (one resolve each) |
| 3 | [03-ch-plus-on-the-last-episode](03-ch-plus-on-the-last-episode.jpg) | CH+ during episode 3 (the last) | only the information; no resolve |
| 4 | [04-home-after-switching](04-home-after-switching.jpg) | CH− held on episode 3 (`--longpress`: a key repeat), 45 s of episode 2, Back | exactly one resolve (episode 2); Home says "Continue · Episode 2" with a progress bar |
| 5 | [05-ch-plus-ignored-in-the-menu](05-ch-plus-ignored-in-the-menu.jpg) | Menu during playback, CH+ | the hidden menu stays, no resolve; after closing it and pausing with OK, CH+ switched to episode 3 and played |

## Stream refresh before expiry (server 2, signed HLS through the proxy, 100 s tokens)

OK on *Proxy demo* at 23:57:10. Server log (`resolved`, all `proxy-demo.film` / `signed-hls` / `delivery: proxy`):
23:57:10.631, **23:57:50.641** (+40.0 s: `expiresAt` − 60 s), 23:58:50.648, 23:59:50.652, 00:00:50.658, … 00:06:50.691
(every 60 s: the refreshed URL again lived 100 s, and refreshes are at least 60 s apart). The upstream logged a new
`master.m3u8` fetch after every resolve (the player switched to each new proxy session) and 416 requests without a
single refusal; the server logged no 4xx/5xx for the TV (the only one in the whole run was the 401 before pairing).
Without the refresh this film fails after about two minutes: the first URL expires at 100 s, the proxy answers 410,
and with less than 5 minutes played and no alternative the TV gives up.

| # | Screenshot | Step | Result |
|---|---|---|---|
| 6 | [06-signed-hls-after-first-refresh](06-signed-hls-after-first-refresh.jpg) | 55 s after OK (after the first swap) | the test pattern's clock at 0:53.6, playing |
| 7 | [07-signed-hls-after-four-refreshes](07-signed-hls-after-four-refreshes.jpg) | 245 s after OK | 4:03.0, playing; no error screen at any point |
| 8 | [08-film-played-to-the-end](08-film-played-to-the-end.jpg) | left alone | the 10-minute film played to its end through 11 refreshes (`finished` reported at 00:07:13); Home says "Watch again" |

## Owner commands

On server 1 (before the server side existed) commands were inserted into its SQLite `commands` table with the
server stopped; after the restart the TV's event stream reconnected and got them replayed:

| Command | Result |
|---|---|
| `dance` (an unknown type, payload `{"style":"tango","speed":[1,2]}`) | acknowledged 7.0 s after it was created (the reconnect), nothing happened, playback went on |
| `message` | acknowledged together with `dance`; the banner appeared over the playing video |
| `pause` + `seek {"deltaMs":-30000}` | paused; the now-playing anchor showed 39.1 s, about 30 s before where the episode had got to |
| `resume` + `seek {"positionMs":15000}` + `message` | playing again from 0:15 (anchor 28.0 s 15 s later, after a 2.4 s rebuffer), new banner |
| `next` | the episode list fetched (a new player visit), episode 3 resolved |
| `play` (from the admin API) | episode 1 resolved 4 ms after the command, acknowledged 5 ms after it |

On server 3, every command sent with `POST /api/v1/admin/devices/:id/commands` while *Proxy series* episode 1 played
was acknowledged 1–13 ms after the server queued it:

| # | Screenshot | Command | Result (now-playing anchor from `GET …/now`) |
|---|---|---|---|
| 9 | [09-command-pause](09-command-pause.jpg) | `pause` | paused at 13.6 s, information shown |
| — | | `resume` | playing at 13.6 s |
| 10 | [10-command-seek-plus-60s](10-command-seek-plus-60s.jpg) | `seek {"deltaMs":60000}` | 76.7 s, information shown |
| — | | `seek {"positionMs":5000}` | 5.0 s |
| 11 | [11-message-over-video](11-message-over-video.jpg) | `message` (20 s) | the banner over the video, playback going on |
| — | | `next`, then `previous` | episode 2 resolved, then episode 1 |
| — | | `stop`, then `pause` and `next` on Home | Home; `pause`/`next` acknowledged and ignored (no resolve) |
| 12 | [12-message-on-home](12-message-on-home.jpg) | `message` (15 s) on Home | the banner over Home, the focus untouched |

## Autoplay on start (server 3)

`PATCH /api/v1/admin/devices/:id {"autoplayOnStart": true}` while Home showed: no countdown (the setting arrived
in-app). Then:

| # | Screenshot | Step | Result |
|---|---|---|---|
| 13 | [13-autoplay-countdown](13-autoplay-countdown.jpg) | HOME key, then the app reopened | the countdown over Home for *Proxy series*, the show played last (not the first tile): "Episode 1", "Starts in 8 s" 3 s later, **Play now** focused |
| 15 | [15-autoplay-started](15-autoplay-started.jpg) | left alone | episode 1 resolved 10 s after the countdown appeared and played |
| — | | Back from the player | Home, no countdown |
| 14 | [14-autoplay-cancelled-by-back](14-autoplay-cancelled-by-back.jpg) | HOME, reopened, Back | the countdown closed, the focus on *Proxy series*; nothing resolved in the next 14 s |
| — | | HOME, reopened, ← | the same: closed, the focus still on *Proxy series* (← did not move it), nothing resolved |
| — | | `am force-stop`, app started | the countdown at process start; OK on **Play now** resolved episode 1 at once |

## Problem reports (server 3)

`GET /api/v1/admin/devices/:id/problems` after each case (newest first, abridged):

| # | Screenshot | Case | TV reports (`origin: tv`, all `appVersion: 0.2.0`) |
|---|---|---|---|
| 16 | [16-cannot-play-right-now](16-cannot-play-right-now.jpg) | upstream stopped, OK on *Proxy demo*: the resolve answers `502 no_playable_source` | `resolve` · `no_playable_source` · `httpStatus 502`; `playback` · `gave_up` · "tried 0 sources, then resolve failed: no_playable_source" (next to the server's own `resolve` · `no_playable_source` · "signed-hls: error TypeError") |
| — | (same screen) | *Proxy demo* playing, upstream stopped at 0:12; the buffer ran out at 1:06 | `playback` · `ERROR_CODE_IO_BAD_HTTP_STATUS` · `httpStatus 502` · `positionMs 65855` · "ExoPlaybackException < InvalidResponseCodeException", with `sourceId`; then `gave_up` · "tried 1 source" (the server: `proxy` · `upstream_unreachable` · "segment: ECONNREFUSED") |
| 17 | [17-server-unreachable](17-server-unreachable.jpg) | server stopped at 07:38:52 for 5 min 21 s while Home showed ("No connection") | sent at 07:44:23, 10 s after the restart (the offline poll): `network` · `server_unreachable` · "unreachable for 5 min 30 s", stored with `at` 07:38:52.5 (its `ageMs` is the outage's length) |

No report contains a URL, a host, a header or a token; the server answered `202` to every one. (The server's own log
prints the Media3 code as `<token>`: its log redaction turns runs of 20+ letters into `<token>`, an accepted Phase 2
trade-off; the stored problem keeps the code.)

## Not verified here

- That an unconsumed channel key would really open a live-TV app: the emulator image has none; what was checked is
  that the keys are consumed and izle stays in front.
- Autoplay's fallback to the first tile when the show played last is no longer on Home, and the countdown after
  switching the TV on from standby (the same `onStart` path as reopening from the launcher): unit-tested / not run.
- A refresh that fails and is retried 30 s later, and a refresh while paused: unit-tested scheduling only.
- Turkish copy of the new string ("Şimdi değil") on screen; a real remote and a real TV (only the emulator).
