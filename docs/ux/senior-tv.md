# Senior TV experience

How the izle TV app behaves for its viewer: someone who knows classic TV (switch on, pick a channel, it plays)
and should never need to read small text, browse or configure anything. Everything else is the owner's job, done
remotely from the admin page (`/admin/` on the server) or, on the TV itself, behind a hidden menu.

## Principles

1. **Home → OK → plays.** One screen of poster tiles. OK on a tile plays the right episode at the right place:
   the next unwatched episode, or the half-watched one where it was left.
2. **Back always goes home**, and Back on Home does nothing: the viewer cannot fall out of the app. (The remote's
   HOME button belongs to the system; when it is pressed the app saves the position and comes back on Home.)
3. **Every error ends on Home by itself**, after a short, large message. Nothing waits for an answer.
4. **Nothing small.** No text below 24 sp on the 960×540 dp TV canvas; high contrast; one focused element with a
   thick white border, everything else dimmed; nothing that matters outside the 5 % safe margins (48 dp left and
   right, 27 dp top and bottom), where many TVs crop the picture.
5. **Owner-controlled.** Which shows appear, their order, "continue from episode X", UI language, audio and
   subtitle languages, autoplay on start, play/stop/pause/resume/seek/next/previous and short messages all come
   from the server and apply live. When something goes wrong the TV tells the owner (problem reports), not the
   viewer.

## Screens

### Home

- Up to 12 poster tiles (190×285 dp, 2:3) in a 4-column grid inside the safe margins; one row (≤ 4 shows) fits
  without scrolling. With more, the next row peeks in under the first and fades out at the bottom edge; moving down
  brings the focused row up to the top, poster and title fully in view, and the row above leaves the screen.
- The focused tile scales to 110 % with a 4 dp white border, its title clear of the grown poster; the others are
  dimmed.
- Under the poster: the title (24 sp bold, up to 2 lines). On the poster, at the bottom, a solid chip says what OK
  will do, readable on dark and bright posters alike: mint for "New", the warm accent when OK resumes ("Continue",
  "Continue · Episode 2", with a progress bar under it), light grey otherwise ("Episode 5", "Watch again"). A
  missing poster shows the show's title in its place.
- When episodes were added to a show since the viewer last watched it (or since it was put on Home), a small dark
  chip at the poster's top right counts them ("2 new", read out as "2 new episodes"; the server's `newEpisodes`).
  Quieter than the bottom chip, it only informs: it takes no focus, never changes what OK plays, and goes away once
  an episode of the show has been played.
- Top right: a clock (24-hour or 12-hour following the TV's setting, or the TV's own language when that is unset).
  Bottom: the hint "OK: Play" (Back does nothing on Home, so it is not offered).
- The tile played last gets the focus back; after a live reorder the focus stays on the same show.
- No shows: "Nothing here yet" in large type.
- Server unreachable: the last home screen stays (cached), a solid red "No connection" chip with dark text appears
  top left, the TV retries every 10 s, and OK shows "No connection · Trying again…" for 5 s instead of playing.
- **Autoplay on start** (per TV, owner setting, off by default): when the app comes to the front on Home (the TV is
  switched on, the app starts, or the viewer comes back from the launcher) and the first home state fetched from the
  server in that moment says so, the show played last on this TV if it is on Home (else the first tile) is offered
  over Home in the "Up next" panel: its poster, title, what OK on its tile would play ("Episode 2",
  "Continue · Episode 2"), "Starts in 10 s" over a bar that runs down with it, **Play now** focused and **Not now**
  next to it. At 0 its tile's episode plays under the normal resume rules. OK presses the focused button; Back and
  every other key cancel it, do nothing else and leave the focus on that show. It never appears after in-app steps
  (Back from the player, "The end", the error screen, closing the hidden menu), from the offline cache, or once a
  key was pressed; the hidden menu and the tiles wait while it shows.
- **Messages from the owner** appear as a banner (30 sp bold, stepping down to 24 sp only for the longest ones, dark
  on yellow, up to 3 lines, no focus, no buttons) for the time the owner chose, on Home and over the playing video
  (playback goes on); other screens ignore them. On Home the banner sits in the top band, left of the clock, and
  covers nothing: the band grows to fit it, the tiles move down and the hint makes room; a message that does not fit
  beside the clock in three lines takes the band's full width under the clock. Over the video, the hidden menu or
  the autoplay countdown it is drawn across the top.

### Player

- Video only. For 4 s after a key press: title, episode, a progress bar and times, on a dark shade that is solid
  behind the text; a small pause symbol stays in the corner while paused.
- Resolving/buffering before the first frame: black screen with a spinner, the title and the episode.
- Up next, "The end" and "Can't play right now" (and autoplay on start over Home) share one panel: the show's
  poster always at the same spot, left of the centre, beside it the text in a fixed order, then the countdown over a
  bar that runs down with it, then the buttons, the first one focused.
- End of an episode with a next one (and auto-advance allowed): **Up next** with the poster, "Episode 3", its title
  and "Starts in 10 s"; **Play now** focused, **Home** next to it; the next episode starts by itself.
- End of the last episode (or an auto-advance boundary): "The end" with the show's poster and title for 8 s, then
  Home. No buttons: nothing on it takes the focus.
- Nothing playable: "Can't play right now" with the poster, "Home in 30 s" counting down over its bar, **Try
  again** focused and **Home**; Home after 30 s.
- Subtitles (off unless the owner chose a language) are drawn large, white on a dark box, above the bottom edge,
  and just above the information while it shows.
- **CH+ / CH−** (and the remote's **|◀◀ / ▶▶|** keys) switch to the next / previous episode of the show, like
  changing channels (Episode keys under [Playback rules](#playback-rules)): the new one starts in the same player
  (its name shows while it loads) under the normal resume rules. At the first or last episode only the information
  appears. Holding the key steps once.
- Expiring stream addresses (signed URLs) are renewed in the background (Stream refresh under
  [Playback rules](#playback-rules)): at most a short spinner while the new stream buffers at the same place, paused
  or not.
- From the admin page the owner can pause, resume, jump (which shows the information as if a key had been pressed),
  switch episodes like CH+/CH−, stop, and show a message. These act only while video shows; resume, next and
  previous close the hidden menu if it is open.

### Hidden menu

Opened with the remote's **Menu** key or by **holding OK for 0.6 s** (on Home: for the focused show; in the
player: for what is playing, which pauses). A panel slides over a little more than the right half, its rows ending
at the safe margin; the focused row has the same white border as the tiles and buttons. Back steps back one level
and closes it.

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
   "Waiting for approval…". The owner approves it from the admin side; the TV long-polls, then shows Home. Expired
   codes are replaced on their own; Back returns to the address screen. If the owner later deletes the TV, it shows
   a new pairing code by itself.

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
izle.

## Playback rules

| Rule | Value |
|---|---|
| Resume | saved position ≥ 30 s and not within the end threshold; start 5 s before it |
| End threshold ("finished") | remaining ≤ max(2 min, 5 % of the duration), capped at 10 % of the duration (so a 90 s episode is finished in its last 9 s, a 2 h film in its last 6 min) |
| Heartbeat | every 15 s while playing, plus pause, resume, seek, stop and end |
| Countdowns | auto-next and autoplay on start 10 s, error screen 30 s, each with a bar that runs down a step a second; "The end" 8 s, then Home |
| Source errors | try the server's next alternative from the same position; HTTP 403/410 after more than 5 min of playback re-resolves the same source first (an expired signed URL) |
| Stream refresh | when a resolve answer's `expiresAt` is ≥ 90 s away (measured on the server's clock): resolve the same source again at `expiresAt` − 60 s, playing or paused; new media only when the URL changed, at the same position; at most one refresh per 60 s; a network or server failure is retried once after 30 s while the URL is still valid, else the 403/410 rule above applies |
| Episode keys (CH+/CH−, ▶▶\|/\|◀◀, next/previous commands) | the nearest `playbackAllowed` episode after / before the current one in play order; no wrap-around; the current one is reported like Back (stopped, or finished within the end threshold) |
| Owner's message | up to 200 characters, 3–120 s (the server's default: 15 s); a new one replaces the current one |
| Problem reports (to the owner) | one attempt in the background, never retried, failures ignored: player errors (Media3 error code, HTTP status, exception class names — never messages or URLs), failed resolves (the server's error code or `network`), "Can't play right now" (`gave_up`), the server unreachable for ≥ 5 min (`server_unreachable`, sent once it answers again) |
| Languages | audio: the owner's preferred language (and its primary subtag), else the stream default; subtitles: off unless the owner set a language |

## Copy (en / tr)

| Key | English | Türkçe |
|---|---|---|
| Home hint | OK: Play | OK: Oynat |
| Empty home | Nothing here yet | Henüz içerik yok |
| Chip: new / continue / watch again | New / Continue / Watch again | Yeni / Devam et / Tekrar izle |
| Chip: episode | Episode 5 · Season 2, Episode 5 · Continue · Episode 5 | Bölüm 5 · Sezon 2, Bölüm 5 · Devam et · Bölüm 5 |
| Chip: new episodes (on the poster; read out) | 1 new · 3 new (1 new episode · 3 new episodes) | 1 yeni · 3 yeni (1 yeni bölüm · 3 yeni bölüm) |
| Offline | No connection · Trying again… | Bağlantı yok · Yeniden deneniyor… |
| Loading | Loading… | Yükleniyor… |
| Paused | Paused | Duraklatıldı |
| Up next | Up next · Starts in 10 s · Play now · Home | Sıradaki · 10 sn içinde başlıyor · Şimdi oynat · Ana ekran |
| Autoplay on start | Starts in 10 s · Play now · Not now (with the tile's chip text) | 10 sn içinde başlıyor · Şimdi oynat · Şimdi değil |
| End | The end (with the show's title) | Bitti |
| Error | Can't play right now · Home in 30 s · Try again · Home | Şu anda oynatılamıyor · 30 sn sonra ana ekran · Tekrar dene · Ana ekran |
| Pairing | Pair this TV · Open http://… /admin on your phone or computer and approve this code · Waiting for approval… | Bu televizyonu eşleştirin · Telefonunuzda veya bilgisayarınızda http://… /admin adresini açın ve bu kodu onaylayın · Onay bekleniyor… |
| Server address | Server address · Connect · The server cannot be reached. | Sunucu adresi · Bağlan · Sunucuya ulaşılamıyor. |
| Menu | Episodes · Start over · Audio language · Subtitles · Settings · About | Bölümler · Baştan başlat · Ses dili · Altyazı · Ayarlar · Hakkında |

The full lists are `android/app/src/main/res/values/strings.xml` and `values-tr/strings.xml`. The UI language is
the hidden-menu override if set, else the server's (owner-controlled) setting, else the TV's system language.
