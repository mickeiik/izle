# Senior TV experience

How the izle TV app behaves for its viewer: someone who knows classic TV (switch on, pick a channel, it plays)
and should never need to read small text, browse or configure anything. Everything else is the owner's job,
done remotely from the browser admin page (`/admin/` on the server) or, on the TV itself, behind a hidden menu.

Screenshots of every screen below are in [`docs/verification/phase3/`](../verification/phase3/README.md); the
channel keys, autoplay on start, the owner's messages and remote controls, the stream refresh and problem reports
in [`docs/verification/tv-controls/`](../verification/tv-controls/README.md).

## Principles

1. **Home → OK → plays.** One screen of poster tiles. OK on a tile plays the right episode at the right place:
   the next unwatched episode, or the half-watched one where it was left.
2. **Back always goes home**, and Back on Home does nothing — the viewer cannot fall out of the app. (The remote's
   HOME button belongs to the system; when it is pressed the app saves the position and comes back on Home.)
3. **Every error ends on Home by itself**, after a short, large message. Nothing waits for an answer.
4. **Nothing small.** No text below 24 sp on the 960×540 dp TV canvas; high contrast; one focused element with a
   thick white border, everything else dimmed.
5. **Owner-controlled.** Which shows appear, their order, "continue from episode X", UI language, audio and
   subtitle languages, autoplay on start, play/stop/pause/resume/seek/next/previous and short messages all come
   from the server and apply live. When something goes wrong the TV tells the owner (problem reports), not the
   viewer.

## Screens

### Home

- Up to 12 poster tiles (190×285 dp, 2:3) in a 4-column grid with 5 % safe margins; one row (≤ 4 shows) fits
  without scrolling, more rows scroll with the focus and the second row peeks in to show there is more.
- The focused tile scales to 110 % with a 4 dp white border; the others are dimmed.
- Under the poster: the title (24 sp bold, up to 2 lines). On the poster: a chip saying what OK will do, and a
  progress bar when it will resume.
- Top right: a clock (24-hour or 12-hour following the TV's setting, or the TV's own language when that is unset). Bottom: the hint "OK: Play · Back: Home".
- The tile played last gets the focus back; after a live reorder the focus stays on the same show.
- No shows: "Nothing here yet" in large type.
- Server unreachable: the last home screen stays (cached), a red "No connection" chip appears top left, the TV
  retries every 10 s, and OK shows "No connection · Trying again…" for 5 s instead of trying to play.
- **Autoplay on start** (per TV, owner setting, off by default): when the app comes to the front on Home — the TV
  is switched on, the app starts, or the viewer comes back from the launcher — and the first home state fetched
  from the server in that moment says so, the show played last on this TV (else the first tile) is offered over
  Home like "Up next": its poster, title, what OK on its tile would play ("Episode 2", "Continue · Episode 2"),
  "Starts in 10 s", **Play now** focused and **Not now** next to it. At 0 its tile's episode plays under the
  normal resume rules. Back, Not now or any other key cancels it and leaves the focus on that show; the viewer
  just started doing something. It never appears after in-app steps (Back from the player, "The end", the error
  screen, closing the hidden menu), from the offline cache, or once a key was pressed; the hidden menu and the
  tiles wait while it shows.
- **Messages from the owner** appear as a banner across the top (30 sp bold, dark on yellow, up to 3 lines) for
  the time the owner chose, on Home and over the playing video (playback goes on). A new message replaces the
  current one; the banner takes no focus and has no buttons. Other screens ignore messages.

### Player

- Video only. Information appears for 4 s after a key press: title, episode, a progress bar and times; a small
  pause symbol stays in the corner while paused.
- Resolving/buffering before the first frame: black screen with a spinner, the title and the episode.
- At the end of an episode with a next one (and auto-advance allowed): **Up next** — poster, "Episode 3",
  its title and "Starts in 10 s"; **Play now** is focused, **Home** next to it. The next episode starts by itself.
- At the end of the last episode (or an auto-advance boundary): "The end" for 8 s, then Home.
- Nothing playable: "Can't play right now" with the poster, **Try again** focused and **Home**; Home after 30 s.
- Subtitles (off unless the owner chose a language) are drawn large, white on a dark box, above the bottom edge.
- **CH+ / CH−** (and the remote's **|◀◀ / ▶▶|** keys) switch to the next / previous episode of the show, like
  changing channels: the episode playing ends exactly as with Back (its place is saved), the nearest playable
  episode starts in the same player (its name shows while it loads) under the normal resume rules. At the first
  or last episode nothing happens except the information appearing for 4 s; there is no wrap-around. Holding
  the key steps once.
- Stream addresses that expire (signed URLs) are renewed a minute before they run out, in the background: at
  most a short spinner while the new stream buffers at the same place, paused or not.
- The owner can pause, resume, jump (and show the information as if a key had been pressed), switch episodes
  like CH+/CH−, stop, and show a message, all from the admin page. These act only while video shows; resume,
  next and previous close the hidden menu if it is open.

### Hidden menu

Opened with the remote's **Menu** key or by **holding OK for 0.6 s** (on Home: for the focused show; in the
player: for what is playing, which pauses). A panel slides over the right half; Back steps back one level and
closes it.

| Entry | Shown | Does |
|---|---|---|
| Episodes | series | the play order with ✓ watched, ▶ plays next / now playing, greyed when not allowed; OK plays one |
| Start over | always for a show | plays the episode OK would play from the beginning (in the player: seeks to 0) |
| Audio language | player, ≥ 2 audio tracks | Automatic (the owner's preference) or a specific track, for this playback |
| Subtitles | player | Off or one of the stream's subtitle tracks, for this playback |
| Settings | always | Server address (back to the address screen), Language (Automatic → Türkçe → English), Pair again |
| About | always | app version, TV name, server, catalog and catalog build |

### First run

1. **Server address**: a large text field (the TV keyboard opens), prefilled with `http://10.0.2.2:8787` in
   debug builds; Connect checks `/healthz`. Debug builds also accept
   `adb shell am start -n io.github.mickeiik.izle/.MainActivity --es izle.server <url>` to skip typing.
2. **Pairing code**: "Pair this TV", the admin page's address to open on a phone, the 6-digit code in 96 sp,
   "Waiting for approval…". The owner approves it from the admin side; the TV long-polls, then shows Home. Expired codes are replaced on their own; Back returns
   to the address screen. If the owner later deletes the TV, it shows a new pairing code by itself.

## Remote key map

| Key | Home | Player (video) | Up next / error overlay | Hidden menu |
|---|---|---|---|---|
| OK (short) | play the focused show | pause / resume | press the focused button | choose |
| OK (hold 0.6 s) | hidden menu | hidden menu | — | — |
| Menu | hidden menu | hidden menu | — | — |
| ← / → | move | seek −/+ 10 s (holding: 30 s steps after 2 s, 60 s after 4 s; one seek on release) | move | — |
| ↑ / ↓ | move | nothing | move | move |
| Play/Pause, Play, Pause | — | pause / resume | — | — |
| Rewind / Fast forward | — | like ← / → | — | — |
| Stop | — | save, Home | — | — |
| CH+ / CH−, ▶▶\| / \|◀◀ | nothing | next / previous episode (first press only; the ends: information only) | nothing | nothing |
| Back | nothing | save, Home | Home | one level up / close |
| HOME (system) | leaves the app; it reopens on Home | saves the position, releases the player | | |

A short OK is delivered on release; a release without a press (the OK that launched the app from the TV
launcher) is ignored so the app never starts playing by accident.

Channel keys never reach the system, also where they do nothing (pairing and the server address screen included):
on many Android TV devices an unhandled channel key opens the TV's own live-TV app, and the viewer would be out of
izle. While the **autoplay countdown** shows over Home, OK presses its focused button (Play now / Not now); Back and
every other key cancel it and do nothing else.

## Playback rules

| Rule | Value |
|---|---|
| Resume | saved position ≥ 30 s and not within the end threshold; start 5 s before it |
| End threshold ("finished") | remaining ≤ max(2 min, 5 % of the duration), capped at 10 % of the duration (so a 90 s episode is finished in its last 9 s, a 2 h film in its last 6 min) |
| Heartbeat | every 15 s while playing, plus pause, resume, seek, stop and end |
| Auto-next countdown | 10 s |
| "The end" | 8 s, then Home |
| Error screen | Home after 30 s |
| Source errors | try the server's next alternative from the same position; HTTP 403/410 after more than 5 min of playback re-resolves the same source first (an expired signed URL) |
| Stream refresh | when a resolve answer's `expiresAt` is ≥ 90 s away (measured on the server's clock): resolve the same source again at `expiresAt` − 60 s, playing or paused; new media only when the URL changed, at the same position; at most one refresh per 60 s; a network or server failure is retried once after 30 s while the URL is still valid, else the 403/410 rule above applies |
| Episode keys (CH+/CH−, ▶▶\|/\|◀◀, next/previous commands) | the nearest `playbackAllowed` episode after / before the current one in play order; no wrap-around; the current one is reported like Back (stopped, or finished within the end threshold) |
| Autoplay on start | owner setting, off by default; 10 s countdown; the show played last on this TV if it is on Home, else the first tile; only when the app comes to the front on Home, from a state fetched from the server, before any key |
| Owner's message | up to 200 characters, 3–120 s (the server's default: 15 s); a new one replaces the current one |
| Problem reports (to the owner) | one attempt in the background, never retried, failures ignored: player errors (Media3 error code, HTTP status, exception class names — never messages or URLs), failed resolves (the server's error code or `network`), "Can't play right now" (`gave_up`), the server unreachable for ≥ 5 min (`server_unreachable`, sent once it answers again) |
| Languages | audio: the owner's preferred language (and its primary subtag), else the stream default; subtitles: off unless the owner set a language |

## Copy (en / tr)

| Key | English | Türkçe |
|---|---|---|
| Home hint | OK: Play · Back: Home | OK: Oynat · Geri: Ana ekran |
| Empty home | Nothing here yet | Henüz içerik yok |
| Chip: new / continue / watch again | New / Continue / Watch again | Yeni / Devam et / Tekrar izle |
| Chip: episode | Episode 5 · Season 2, Episode 5 · Continue · Episode 5 | Bölüm 5 · Sezon 2, Bölüm 5 · Devam et · Bölüm 5 |
| Offline | No connection · Trying again… | Bağlantı yok · Yeniden deneniyor… |
| Loading | Loading… | Yükleniyor… |
| Paused | Paused | Duraklatıldı |
| Up next | Up next · Starts in 10 s · Play now · Home | Sıradaki · 10 sn içinde başlıyor · Şimdi oynat · Ana ekran |
| Autoplay on start | Starts in 10 s · Play now · Not now (with the tile's chip text) | 10 sn içinde başlıyor · Şimdi oynat · Şimdi değil |
| End | The end | Bitti |
| Error | Can't play right now · Try again · Home | Şu anda oynatılamıyor · Tekrar dene · Ana ekran |
| Pairing | Pair this TV · Open http://… /admin on your phone or computer and approve this code · Waiting for approval… | Bu televizyonu eşleştirin · Telefonunuzda veya bilgisayarınızda http://… /admin adresini açın ve bu kodu onaylayın · Onay bekleniyor… |
| Server address | Server address · Connect · The server cannot be reached. | Sunucu adresi · Bağlan · Sunucuya ulaşılamıyor. |
| Menu | Episodes · Start over · Audio language · Subtitles · Settings · About | Bölümler · Baştan başlat · Ses dili · Altyazı · Ayarlar · Hakkında |

The full lists are `android/app/src/main/res/values/strings.xml` and `values-tr/strings.xml`. The UI language is
the hidden-menu override if set, else the server's (owner-controlled) setting, else the TV's system language.
