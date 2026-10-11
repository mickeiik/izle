# Listen along — verification (2026-10-11)

Companion audio on the owner's phone: the admin page plays another source of the episode the TV is playing, in
sync with the picture. Verified against the dev server (`server/izle.dev.json`, sample catalog) with the Android
TV emulator (`izle_tv`, API 36, debug build) and the desktop app's browser pane standing in for the phone.
Screenshots: `01-tv-playing.jpg` (the emulator playing Tears of Steel), `02-card.jpg` (the Listen along card),
`03-synced.jpg` (the status line once synced), `04-tv-caminandes.jpg` (the emulator on Caminandes).

| Check | Result |
|---|---|
| TV reports anchor the timeline | A report at playback start (`playing: true, ageMs: 0`), one every 15 s, two per pause and resume (explicit + `onIsPlayingChanged`), `playing: false` while paused; sample ages 0–4 ms |
| `GET …/now` long-poll | `?seq=&wait=25` answers within a round trip of the TV's next report; the phone's clock offset estimate stayed at ±1 ms on the LAN |
| Candidates | The playing episode's sources, one option per audio language (`hls-multi-audio` → English, Italiano), the TV's own source flagged, the chosen option remembered per show on the phone |
| Native HLS (this Chromium claims it) | Synced to within 40 ms after about 15 s (rate nudges of ±2 %/±5 %, then nominal); used only when no specific language is wanted, since the element has no `audioTracks` API here |
| hls.js (MSE) | With Italian chosen: hls.js loaded lazily from `/admin/vendor/`, fetched the Italian rendition (`audio_ita`) and the lowest video variant through the proxy, synced to within 30 ms. Needed `media-src 'self' blob:` in the CSP |
| MP4 companion (Caminandes) | Played through `/p/<token>/video.mp4` on the audio element ("direct"), synced |
| Pause / resume on the TV | The phone paused within a round trip (−115 ms overshoot) and resumed, catching up |
| Seek on the TV (3 × Right) | The phone seeked to the new position and re-synced |
| Offset live + Save | Offset 2.000 s applied while listening (phone 2 s ahead, drift −14 ms); "Save timing" stored `{offsetMs: 2000, rate: 1, language: "it"}` for the episode; restored to 0 |
| Switching the TV to another show | Listening ended with a toast (the new show has no source of that id); the card refreshed its candidates |
| Auto-next (Caminandes e1 → e2) and owner-driven episode changes | The long-poll showed the new episode, the phone re-resolved the same source and was at the TV's position (0:05) within a round trip; a play command switching e3 → e1 was followed the same way and synced within 25 ms after 15 s. A first attempt had revealed a race (the loop's `pause()` while the new `play()` was pending rejected it with `AbortError`), fixed by ignoring that rejection |
| Logs | No `/p/` tokens, no upstream URLs or hosts in the server log; companion resolves are logged with `companion: true` |
| Tests | `npm test` (contract 31, server 83), `npm run typecheck`, `npm run pack:server && npm run smoke:server` (the vendored hls.js and the CSP are checked), `./gradlew :app:assembleDebug :app:testDebugUnitTest` (52 tests) |

Notes:

- The emulator decodes in software; the debug build caps video at 720p there. The sample media is fetched from
  the demo CDNs (network), as the manual `sample:check` does.
- The browser pane of the desktop app reports `document.hidden = true` while it is not in front, which pauses the
  admin page's polling (by design: the page only polls while visible). For this verification the flag was
  overridden from the console; on a phone the page is in front when the owner taps Listen.
- An `adb install -r` over an app signed with another debug key fails without replacing the app; the first
  verification run was unknowingly against the previous build until `adb uninstall` was used.
