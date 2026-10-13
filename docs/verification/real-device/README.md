# Real-device verification — Android TV box

Run on 2026-10-11, the first run of izle on real hardware (every earlier verification used the `izle_tv` emulator):
a **Freebox Player Mini v2**, an Android TV box with Android 7.1.1 (API 25), `armeabi-v7a` and a 1920×1080 output at
320 dpi. The debug APK of 0.2.0 (`./gradlew :app:assembleDebug :app:testDebugUnitTest`, 52 JVM tests passing; JDK:
Android Studio's JBR) was installed with `adb` over the network, and the box used the dev server with the sample
catalog (`server/izle.dev.json`) on the development machine across the LAN, at `http://192.168.1.54:8787`. The
owner's side was driven with `curl` against the admin API. Screenshots are `adb exec-out screencap` captures
(1920×1080) scaled to 960×540; the emulator screenshots in the other folders are 1280×720.

These notes were written on 2026-10-14 from the transcript of that session and its two screenshots. The session
stopped after the home screen, because the owner wanted to try the box by hand, and wrote no report at the time.
Checks it did not complete are marked "not run".

| # | Check | How | Result |
|---|---|---|---|
| – | adb over the network | USB debugging on (the box has no "Wireless debugging"), `adb connect <box>:5555`, "Allow USB debugging?" accepted on the TV | connected; `getprop`: Freebox Player Mini v2, Android 7.1.1, SDK 25, `armeabi-v7a` |
| – | Install | `adb install -r app-debug.apk` | `Success`; versionName 0.2.0, versionCode 200, primary ABI `armeabi-v7a` |
| – | Server reachable from the box | `GET /healthz` from the box (`toybox nc`) | timed out until the development machine's firewall allowed port 8787 from the LAN (the rule in the [self-hosting guide § 7](../../deploy/self-hosting.md#7-firewall)); then `200 {"ok":true}` |
| 1 | Setup and pairing | `am start … --es izle.server http://192.168.1.54:8787` | [01-pairing](01-pairing.jpg): the 6-digit code, "Waiting for approval…" and the server address. Approved with `POST /admin/pair/approve` as "Living room (Freebox)": the TV went to its home screen on its own, still empty |
| 2 | Home on a real panel | `PUT /admin/devices/:id/home` with the six sample shows | [02-home](02-home.jpg): the tiles appeared live (on screen 3 s later); first tile focused and scaled with "Episode 1", "New" on the films, the second row peeking in, the hint line. The clock read "2:54 PM" (see the notes). Legibility from the sofa and the margins against overscan: not recorded |
| 3 | Real remote: short OK, OK held 0.6 s, Menu, Back on Home, Play/Pause, Stop, ←/→ seeking, HOME and back | planned: the owner presses, the session watches the server and `logcat` | not run |
| 4 | Playback per format: HLS, DASH, MP4, and the Elephants Dream `.mov` fallback that the emulator's decoders reject | planned: `logcat` for the hardware decoder and the 1080p selection, time to first frame | not run |
| 5 | Resume: Continue chip with progress bar, resuming 5 s before | | not run |
| 6 | Auto-next, "The end", error screen | | not run |
| 7 | Audio language and subtitles on the real panel | | not run |
| 8 | The owner's live controls: order, menu language, continue from, play/stop | | not run (beyond the live home list of row 2) |
| 9 | Offline: "No connection", recovery after a server restart | | not run |
| 10 | Screen stays on while playing past the box's screensaver timeout | | not run |
| 11 | Listen along from a phone on the same network | | not run |
| 12 | Server log and `logcat` free of stream URLs, upstream hosts and tokens | | not run |

Notes:

- **After row 2 the owner took over**, tried the box with its own remote and reported that everything worked well.
  No per-check results, logs or further screenshots were recorded, so rows 3–12 count as not run here, not as
  passed. They are what a second pass should cover, in particular hardware decoding at 1080p (the debug build caps
  video at 720p on the emulator only), the `.mov` fallback, a real remote's key repeats for the 0.6 s long press,
  and overscan.
- **Open issue: without a 12/24-hour setting on the TV, the clock follows the app's language.** The box's locale is
  fr-FR (24-hour by default) and its 12/24-hour setting is unset (`settings get system time_12_24` answers `null`),
  yet Home showed "2:54 PM" with the menu language English. `Clock` asks `DateFormat.is24HourFormat()` with the
  app's localized context, and Android falls back to that context's locale when the setting is unset; the UX notes
  say the clock follows the TV's setting. On the emulator, Turkish gave a 24-hour clock
  ([phase 3](../phase3/README.md), row 10). Not fixed yet.
- **adb on this box:** there is no "Wireless debugging" (Android 7.1). With USB debugging on, the box accepted
  `adb connect` on port 5555 directly.
- `am start -W` printed `TotalTime: 0` on this box, so no launch time was measured.
- The pairing screen in [01-pairing](01-pairing.jpg) shows the server address; since 2026-10-14 the TV shows the
  admin page's address there.
- The sample media comes from the demo CDNs, so the box needs internet access; playback was not part of the
  recorded checks.
