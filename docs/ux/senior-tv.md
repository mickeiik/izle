# Senior TV experience

How the izle TV app behaves for its viewer: someone who knows classic TV (switch on, pick a channel, it plays)
and should never need to read small text, browse or configure anything. Everything else is the owner's job, done
remotely from the admin page (`/admin/` on the server) or, on the TV itself, behind a hidden menu.

## Principles

1. **Home → OK → plays.** One screen of show and channel cards, which the owner may group in titled sections. OK on a
   card plays the right episode at the right place: the next unwatched episode, or the half-watched one where it was
   left; or a channel at its live edge.
2. **Back always goes home**, and Back on Home does nothing: the viewer cannot fall out of the app. (The remote's
   HOME button belongs to the system; when it is pressed the app saves the position and comes back on Home.)
3. **Every error ends on Home by itself**, after a short, large message. Nothing waits for an answer.
4. **Nothing small.** No text below 24 sp on the 960×540 dp TV canvas, except the chips on Home cards (16 sp,
   short words in solid colours); high contrast; one focused element with a thick white border, everything else
   dimmed; nothing that matters outside the 5 % safe margins (48 dp left and right, 27 dp top and bottom), where
   many TVs crop the picture.
5. **Owner-controlled.** Which shows and channels appear, their order and sections, how many fit on one screen,
   "continue from episode X", UI language, audio and subtitle languages, autoplay on start,
   play/stop/pause/resume/seek/next/previous and short messages all come from the server and apply live. When something
   goes wrong the TV tells the owner (problem reports), not the viewer.

## Screens

### Home

- Wide 16:9 cards fill the safe area, with nothing above or below them (no clock, no hint). The owner sets how many
  columns (3–6) and rows (1–4) one screen shows, per TV, from the admin page (default 4 × 2); the cards are sized to
  fill the screen and the change applies live. Without [sections](#sections) Home is one grid and exactly that many
  rows show: when there are more shows, moving down from the last visible row scrolls the grid by one row (up from
  the first scrolls back), and a thin scroll bar in the right margin shows where the screen is in the list. Left and
  right stop at a row's ends.
- The focused card scales to 110 % with a 4 dp white border, its name clear of the grown card; the others are dimmed.
- Under the card: the show's name (24 sp bold), on two lines when that leaves the card as large as one line would,
  else on one, cut with "…" only when it is longer than that.
- The card's picture is the catalog's landscape image (`backdrop`); a show without one shows its poster, cropped to
  the card around its upper part, and a show without any picture shows its name in the card.
- On the card, at the bottom, a solid chip says what OK will do, readable on dark and bright pictures alike: mint
  for "New", the warm accent when OK resumes ("Continue", "Continue · Episode 2", with a progress bar under it),
  light grey otherwise ("Episode 5", "Watch again"). The chip only shows when it fits on one line; on smaller cards
  the progress bar and the short "New" chip stay.
- A channel's card has a solid red chip with white text that says **Live** (TV's convention for a live picture);
  short like "New", it stays on smaller cards. No progress bar, and never a "2 new" chip.
- When episodes were added to a show since the viewer last watched it (or since it was put on Home), a small dark chip
  at the card's top right counts them ("2 new", read out as "2 new episodes"; the server's `newEpisodes`), when it fits
  beside the bottom chip and bar. Quieter than the bottom chip, it only informs: it takes no focus, never changes what
  OK plays, and goes away once an episode of the show has been played.
- The tile played last gets the focus back; when the owner reorders Home while it shows (or moves the card to another
  section), the focus stays on the same card.
- No shows: "Nothing here yet" in large type, and a line saying that the owner adds shows from the admin page. A
  first start with no cached Home shows "Loading…", or "No connection" while the server is unreachable.
- Server unreachable: the last home screen stays (cached), a solid red "No connection" chip with dark text appears
  over the grid at the top left, the TV retries every 10 s, and OK shows "No connection · Trying again…" for 5 s
  instead of playing.
- **Autoplay on start** (per TV, owner setting, off by default): when the app comes to the front on Home (the TV is
  switched on, the app starts, or the viewer comes back from the launcher) and the first home state fetched from the
  server in that moment says so, the show or channel played last on this TV if it is on Home (else the first tile)
  is offered over Home in the "Up next" panel: its poster, title, what OK on its tile would play ("Episode 2",
  "Continue · Episode 2", or "Live" for a channel), "Starts in 10 s" over a bar that runs down with it, **Play now**
  focused and **Not now** next to it. At 0 it plays as OK on its tile would: the episode under the normal resume
  rules, a channel at its live edge. OK presses the focused button; Back and every other key cancel it, do nothing
  else and leave the focus on its tile. It never appears after in-app steps (Back from the player, "The end", the
  error screen, closing the hidden menu), from the offline cache, or once a key was pressed; the hidden menu and the
  tiles wait while it shows.
- **Messages from the owner** appear as a banner (30 sp bold, stepping down to 24 sp only for the longest ones, dark
  on yellow, up to 3 lines, no focus, no buttons) for the time the owner chose, on Home and on every player screen
  (playback goes on); other screens ignore them. On Home, as over the video, the hidden menu or the autoplay
  countdown, it is drawn across the top; the cards under it do not move.

#### Sections

The owner may cut Home into sections ([Home sections](../spec/server-api-v1.md#home-sections) in the server API),
shown one under the other in the owner's order. They change how the cards are laid out, never what OK does.

- A **titled section** starts with its title: 30 sp bold on one line (cut with "…"), aligned with the cards' left
  edge, white while the focus is in the section and dimmed like the cards otherwise. It takes no focus.
- The **untitled section** holds the shows put on Home without a section and has no title. It comes first unless the
  owner moved it; a Home with only the untitled section looks exactly as Home without sections.
- **Grid** (the default layout): the section's cards wrap in rows of the owner's columns, as above.
- **Row**: the section is one line of cards that scrolls sideways. ← and → move along it; once the focus reaches the
  last card in view, the line slides by one card under it (and back the same way). In the side margins the edge of
  the next card (and of the previous one, once the line has moved) shows, so the line visibly goes on. The line keeps
  its place when the focus leaves it. ← and → stop at its ends.
- **Between two sections** a thin line (2 dp, white at 18 %) runs across the width of the cards. The boundary takes
  exactly the height of the step between two rows of one section: the next section (its title, else its cards)
  starts where a next row would, and the line lies in the middle of the empty space above it, which is the gap
  between rows plus the second title line when no card of the last row uses it. The line is what keeps the untitled
  section apart from a titled grid above it, without a word on screen.
- **One card size** for the whole Home, from the owner's columns × rows. When Home shows a titled section, the height
  of one title is set aside first, so one screen holds a title and that many rows.
- **Moving:** ↑ and ↓ go line by line (a row of a grid, or a scrolling line) and across sections, to the card nearest
  the one left, side to side (in a scrolling line, among the cards in view). The screen moves as little as possible to
  show the focused line whole, with its section's title when it is the section's first line; on Home's first line it
  is at the top. The scroll bar in the right margin shows where the screen is in all of Home.
- A section with nothing the TV can play is not shown. **Home order** is the sections in order, each with its cards in
  order: autoplay's first tile is the first in it, and CH+ / CH− go through the channels in it, across sections. The
  offline home screen keeps its sections.

### Player

- Video only. For 4 s after a key press: title, episode, a progress bar and times, on a dark shade that is solid
  behind the text; a small pause symbol stays in the corner while paused. For a channel the information is its name
  and the line "Live", on the same shade: no progress bar, no times, no clock.
- Resolving/buffering before the first frame: black screen with a spinner, the title and the episode (for a channel,
  its name and "Live").
- Up next, "The end" and "Can't play right now" (and autoplay on start over Home) share one panel: the show's
  poster always at the same spot, left of the centre, beside it the text in a fixed order, then the countdown over a
  bar that runs down with it, then the buttons, the first one focused.
- End of an episode with a next one (and auto-advance allowed): **Up next** with the poster, "Episode 3", its title
  and "Starts in 10 s"; **Play now** focused, **Home** next to it; the next episode starts by itself.
- End of the last episode (or an auto-advance boundary): "The end" with the show's poster and title for 8 s, then
  Home. No buttons: nothing on it takes the focus.
- Nothing playable: "Can't play right now" with the poster, "Home in 30 s" counting down over its bar, **Try
  again** focused and **Home**; Home after 30 s.
- A channel never ends and never shows Up next or "The end": when its stream ends, breaks or falls behind the live
  window, the same source is resolved again and plays from the live edge; if that fails, the source-error ladder
  follows (Live channels under [Playback rules](#playback-rules)), ending on "Can't play right now", whose
  **Try again** restarts the channel at the live edge. **CH+ / CH−** still change channels from there: a dead channel
  is left the way any channel is.
- Subtitles (off unless the owner chose a language) are drawn large, white on a dark box, above the bottom edge,
  and just above the information while it shows.
- **CH+ / CH−** (and the remote's **|◀◀ / ▶▶|** keys) switch to the next / previous episode of the show, like
  changing channels (Channel keys under [Playback rules](#playback-rules)): the new one starts in the same player
  (its name shows while it loads) under the normal resume rules. At the first or last episode only the information
  appears. Holding the key steps once. While a channel plays they switch to the next / previous channel on this
  TV's Home, in Home order (shows in between are skipped): it starts in the same player at its live edge, its name
  showing while it loads; at the first or last channel only the information appears.
- Expiring stream addresses (signed URLs) are renewed in the background (Stream refresh under
  [Playback rules](#playback-rules)): at most a short spinner while the new stream buffers at the same place, paused
  or not; a channel's new stream starts at the live edge.
- No pause on a channel, as on classic TV: a short OK only shows the information, and Play/Pause, Rewind, Fast
  forward and ← / → do nothing.
- From the admin page the owner can pause, resume, jump (which shows the information as if a key had been pressed),
  switch episodes like CH+/CH−, stop, and show a message. Pause, resume, jump and the episode switches act only while
  video shows, stop on any player screen; resume, next and previous close the hidden menu if it is open. On a channel,
  pause, resume and jump do nothing; next and previous switch channels like CH+/CH−.

### Update

The server keeps one TV app version for its TVs; the owner uploads it and may send a TV the **update** command.
Nothing about it ever interrupts playback: during playback the command answers `busy` and nothing is installed.

- **Android 12 and newer, with the one-time "install unknown apps" grant for izle**: the TV updates itself, without
  any dialog, once it has sat on Home for 3 minutes with no key pressed (no hidden menu, no autoplay countdown,
  nothing playing, server reachable), when the owner allows TVs to update by themselves; the owner's command
  installs at once. "Updating…" shows for the moment of the install; Android then closes the app and does not let
  it come back on its own (Android 10+ blocks background activity starts, verified on the API 36 emulator), so the TV
  shows its launcher until izle is opened again, which starts the new version on Home. After a failed attempt the TV
  waits 6 hours before trying by itself again. If the system asks for a confirmation anyway,
  the TV gives up on silent updates and behaves as below until its next update.
- **Android 11 and older** (the system always asks): only on the owner's command, a full-screen panel says "New
  version", the version, "Press OK to install" and "Home in 60 s" over its bar, **Install** focused and **Not now**
  beside it. OK shows "Updating…" while it downloads, then the system's own Install/Cancel dialog ("Updating…"
  stays behind it until it is answered). Back, Not now, Cancel or 60 s without a press: Home.
- A failure says "Could not update" for 15 s (with **Home** focused), then Home; "Updating…" goes Home by itself after 2
  minutes if the system never answers (Back too, without stopping an install already under way). Owner messages are not
  shown on this screen; the Menu key and holding OK do nothing on it.

### Hidden menu

Opened with the remote's **Menu** key or by **holding OK for 0.6 s** (on Home: for the focused show or channel; in the
player, once it plays: for what is playing, which pauses, except a channel, which plays on). A panel slides over a
little more than the right half, its rows ending at the safe margin; the focused row has the same white border as the
tiles and buttons. Back steps back one level and closes it.

| Entry | Shown | Does |
|---|---|---|
| Episodes | series | the play order with ✓ watched, ▶ plays next / now playing, greyed when not allowed; OK plays one |
| Start over | always for a show (not for channels) | plays the episode OK would play from the beginning (in the player: seeks to 0) |
| Audio language | player (shows and channels), ≥ 2 audio tracks | Automatic (the owner's preference) or a specific track, for this playback |
| Subtitles | player (shows and channels) | Off or one of the stream's subtitle tracks, for this playback |
| Settings | always | Server address (back to the address screen), Language (Automatic → Türkçe → English), Pair again; Install update (with the version) while the server offers a newer one, as the owner's command (not in the player's menu) |
| About | always | app version, TV name, server, catalog and catalog build; "Update available" with the version, or "Up to date" |

### First run

1. **Server address**: a large text field (the TV keyboard opens), prefilled with `http://10.0.2.2:8787` in
   debug builds; Connect checks `/healthz`. Debug builds also accept
   `adb shell am start -n io.github.mickeiik.izle/.MainActivity --es izle.server <url>` to skip typing.
2. **Pairing code**: "Pair this TV", the admin page's address to open on a phone, the 6-digit code in 96 sp,
   "Waiting for approval…". The owner approves it from the admin side; the TV long-polls, then shows Home. Expired
   codes are replaced on their own; Back returns to the address screen. If the owner later deletes the TV, it shows
   a new pairing code by itself.

## Remote key map

| Key | Home | Player (video) | Player (channel) | Up next / error overlay | Hidden menu |
|---|---|---|---|---|---|
| OK (short) | play the focused show or channel | pause / resume | information (and undo a system pause) | press the focused button | choose |
| OK (hold 0.6 s) | hidden menu | hidden menu | hidden menu | — | — |
| Menu | hidden menu | hidden menu | hidden menu | — | — |
| ← / → | move | seek −/+ 10 s (holding: 30 s steps after 2 s, 60 s after 4 s; one seek on release) | nothing | move | — |
| ↑ / ↓ | move | nothing | nothing | move | move |
| Play/Pause, Play, Pause | — | pause / resume | Play/Pause, Play: undo a pause the system made (lost audio focus); else nothing | — | — |
| Rewind / Fast forward | — | like ← / → | nothing | — | — |
| Stop | — | save, Home | Home | — | — |
| CH+ / CH−, ▶▶\| / \|◀◀ | nothing | next / previous episode (first press only; the ends: information only) | next / previous channel (first press only; the ends: information only) | a channel's error overlay: next / previous channel; else nothing | nothing |
| Back | nothing | save, Home | Home | Home (also from the update screen) | one level up / close |
| HOME (system) | leaves the app; it reopens on Home | saves the position, releases the player | releases the player | | |

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
| Heartbeat | every 15 s while playing, plus pause, resume, seek, stop and end (a channel: see Live channels) |
| Countdowns | auto-next and autoplay on start 10 s, error screen 30 s, update "press OK" 60 s, "Could not update" 15 s, each with a bar that runs down a step a second; "The end" 8 s, then Home; "Updating…" at most 2 min |
| Source errors | try the server's next alternative from the same position (a channel: see Live channels); HTTP 403/410 after more than 5 min of playback re-resolves the same source first (an expired signed URL) |
| Stream refresh | when a resolve answer's `expiresAt` is ≥ 90 s away (measured on the server's clock): resolve the same source again at `expiresAt` − 60 s, playing or paused; new media only when the URL changed, at the same position; at most one refresh per 60 s; a network or server failure is retried once after 30 s while the URL is still valid, else the 403/410 rule above applies |
| Channel keys (CH+/CH−, ▶▶\|/\|◀◀, next/previous commands) | while a show plays: the nearest `playbackAllowed` episode after / before the current one in play order; while a channel plays, loads or shows "Can't play right now": the next / previous channel on this TV's Home, in Home order; no wrap-around; the current one is reported like Back (stopped, or finished within the end threshold) |
| Live channels | no resume, end threshold or pause; starts at the live edge; heartbeat every 15 s while playing, without a position, plus stall, recovery and stop (Back, Stop, HOME or a channel key); any failure (the end of the stream, a player error, falling behind the live window): a re-resolve of the same source at the live edge, once per failure streak and again only after 60 s of play, then the next alternative at the live edge; a stream refresh (at `expiresAt` − 60 s) that brings new media restarts at the live edge |
| Owner's message | up to 200 characters, 3–120 s (the server's default: 15 s); a new one replaces the current one |
| Problem reports (to the owner) | one attempt in the background, never retried, failures ignored: player errors (Media3 error code, HTTP status, exception class names — never messages or URLs), failed resolves (the server's error code or `network`), "Can't play right now" (`gave_up`), the server unreachable for ≥ 5 min (`server_unreachable`, sent once it answers again), a self-update that failed (`update_…`: the download or archive check without a command, the install once the command's result went out — its session write or status —, `update_needs_user_action`) |
| Languages | audio: the owner's preferred language (and its primary subtag), else the stream default; subtitles: off unless the owner set a language |

## Copy (en / tr)

| Key | English | Türkçe |
|---|---|---|
| Empty home | Nothing here yet | Henüz içerik yok |
| Chip: new / continue / watch again | New / Continue / Watch again | Yeni / Devam et / Tekrar izle |
| Chip: episode | Episode 5 · Season 2, Episode 5 · Continue · Episode 5 | Bölüm 5 · Sezon 2, Bölüm 5 · Devam et · Bölüm 5 |
| Chip: new episodes (on the poster; read out) | 1 new · 3 new (1 new episode · 3 new episodes) | 1 yeni · 3 yeni (1 yeni bölüm · 3 yeni bölüm) |
| Live (chip and player line) | Live | Canlı |
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
| Update | New version · Press OK to install · Home in 60 s · Install · Not now | Yeni sürüm · Kurmak için OK'a basın · 60 sn sonra ana ekran · Kur · Şimdi değil |
| Update under way / failed | Updating… · Could not update · Home in 15 s · Home | Güncelleniyor… · Güncellenemedi · 15 sn sonra ana ekran · Ana ekran |
| Menu: update | Install update · Update available · Up to date | Güncellemeyi kur · Güncelleme var · Güncel |

The full lists are `android/app/src/main/res/values/strings.xml` and `values-tr/strings.xml`. The UI language is
the hidden-menu override if set, else the server's (owner-controlled) setting, else the TV's system language.
