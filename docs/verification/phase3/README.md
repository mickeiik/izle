# Phase 3 verification — Android TV app on the emulator

Run on 2026-10-10 against the local dev server with the sample catalog (`npm run -w server dev -- --config
server/izle.dev.json`), on the `izle_tv` AVD (Android TV, API 36, x86_64, 1920×1080 @ 320 dpi) started headless
with `-no-window -no-audio -gpu swiftshader_indirect -no-snapshot`, debug APK from
`./gradlew :app:assembleDebug :app:testDebugUnitTest` (JDK: Android Studio's JBR). The owner's side was driven
with `curl` against the admin API, the TV with `adb shell input keyevent`; the server's
`GET /api/v1/admin/devices/:id/now` and `…/progress` confirmed what the TV reported. Screenshots are
`adb exec-out screencap` captures scaled to 1280×720.

| # | Screenshot | Step | Result |
|---|---|---|---|
| 1 | [01-pairing](01-pairing.jpg) | `am start … --es izle.server http://10.0.2.2:8787` on a fresh install | 6-digit code, waiting; approved with `POST /admin/pair/approve`, the TV went to Home on its own and showed as `online` |
| 2 | [02-home](02-home.jpg) | `PUT /admin/devices/:id/home` with six shows while the TV showed "Nothing here yet" | tiles appeared live (SSE), first tile focused and scaled, chips "Episode 1" / "New" |
| 3 | [03-player](03-player.jpg) | OK on Caminandes, OK again after ~40 s | episode 1 played (1080p MP4, software decoding); pause overlay; server saw `playing` @36.6 s (heartbeat) and `paused` @40.3 s |
| 4 | [04-home-continue](04-home-continue.jpg) | Back | `stopped` @40.4 s saved; Home with focus back on Caminandes, chip "Continue · Episode 1" and a progress bar. Back twice more: the app stayed in front |
| 5 | [05-auto-next](05-auto-next.jpg) | OK (resumed at 0:35), → seeks to the end | `finished` reported, cursor moved to episode 2, "Up next · Episode 2 · Starts in 10 s" with Play now focused |
| 6 | [06-episode-2](06-episode-2.jpg) | countdown left alone | episode 2 started by itself after 10 s |
| 7 | [07-hidden-menu-episodes](07-hidden-menu-episodes.jpg) | `input keyevent --duration 1000 KEYCODE_DPAD_CENTER` in the player, OK on Episodes | menu opened, playback paused; ✓ episode 1 watched, ▶ episode 2 focused |
| 8 | [08-home-reordered-live](08-home-reordered-live.jpg) | Back ×3, then `PUT …/home` with a new order | tiles reordered live; focus stayed on Caminandes in its new place |
| 9 | [09-audio-italian](09-audio-italian.jpg) | `PATCH /admin/devices/:id {"preferredAudioLanguage":"it"}`, OK on Tears of Steel, menu → Audio language | server picked `hls-multi-audio` (audio en+it) and ExoPlayer selected **Italian** |
| 10 | [10-home-turkish](10-home-turkish.jpg) | `PATCH … {"uiLanguage":"tr"}` | UI switched to Turkish live (Yeni, Bölüm 2, hint, 24-hour clock); then `POST …/commands {"type":"play","episodeId":"big-buck-bunny.film"}` started Big Buck Bunny and `{"type":"stop"}` returned Home with focus on it |
| 11 | [11-offline-banner](11-offline-banner.jpg) | server stopped | cached tiles stayed, "Bağlantı yok" chip within seconds |
| 12 | [12-offline-ok](12-offline-ok.jpg) | OK while offline | large "No connection · Trying again…" message instead of playback; server restarted → TV back online after 9 s |
| 13 | [13-cannot-play](13-cannot-play.jpg) | server restarted with a copy of the sample catalog whose His Girl Friday URL points at a closed port; OK on it | "Şu anda oynatılamıyor" with Tekrar dene focused; Home by itself after 30 s, focus on the tile |
| 14 | [14-the-end](14-the-end.jpg) | last Caminandes episode played to the end | "The end" for 8 s, then Home; the cursor wrapped to episode 1 |
| 15 | [15-subtitles](15-subtitles.jpg) | `PATCH … {"subtitlesLanguage":"en"}`, OK on Sintel | DASH source with ten subtitle tracks; English selected and drawn large |

Also checked, without a screenshot:

- **Source fallback**: in the same modified catalog Big Buck Bunny's first source (HLS) pointed at a closed port;
  the player error made the TV re-resolve with `exclude: ["hls"]` and Big Buck Bunny played from the DASH
  source (`nowPlaying.sourceId = "dash"`).
- **Elephants Dream fallback limit on the emulator**: its second sample source (blender.org `.mov`, H.264
  720×405) is rejected by both emulator decoders at `MediaCodec.configure` (`CCodecConfig: config failed =>
  CORRUPTED`), also on a fresh player, so with the first source broken the TV correctly ended on the error
  screen. The first (archive.org) source is unaffected; the `.mov` is untested on real hardware.
- **HOME key** mid-playback: `stopped` @43 s saved, event stream closed (`online: false`); reopening the app landed
  on Home with "Devam et" on the tile.
- **Device deleted** by the owner (`DELETE /admin/devices/:id`): the TV showed a new pairing code within a second.
- **Hidden menu** from Home via `KEYCODE_MENU`: About (version, TV name, server, catalog), Settings → Server
  address (TV keyboard opens; Connect with the same address returns to Home); Back restores the focus on the
  entry that opened a sub-page.

Emulator notes: `input keyevent --longpress` holds OK only for the system long-press timeout (400 ms), shorter
than the app's 0.6 s, so it acts as a click; use `--duration 1000` or `KEYCODE_MENU`. `input keyevent
--duration` sends a single key repeat, so it cannot show the seek acceleration of a held ←/→ (covered by
`SeekAccumulatorTest`).
