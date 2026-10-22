# Senior TV experience

How the izle TV app behaves for its viewer: someone who knows classic TV (switch on, pick a channel, it plays)
and should never need to read small text, browse or configure anything. Everything else is the owner's job, done
remotely from the admin page or, on the TV itself, behind a hidden menu.

## Principles

1. **Home → OK → plays.** One screen of show and channel cards, which the owner may group in titled sections. OK on a
   card plays the next unwatched episode, or the half-watched one where it was left, or a channel at its live edge.
2. **Back always goes home**, and Back on Home does nothing. (The remote's HOME button belongs to the system; the app
   saves the position and comes back on Home.)
3. **Every error ends on Home by itself**, after a short, large message. Nothing waits for an answer.
4. **Nothing small.** No text below 24 sp on the 960×540 dp TV canvas, except the chips on Home cards (16 sp,
   short words in solid colours); high contrast; one focused element with a thick white border, everything else
   dimmed; nothing that matters outside the 5 % safe margins (48 dp left and right, 27 dp top and bottom).
5. **Owner-controlled.** Which shows and channels appear, their order and sections, the grid size, "continue from
   episode X", languages, autoplay on start, transport commands and short messages all come from the server and apply
   live. When something goes wrong the TV tells the owner (problem reports), not the viewer.

## Screens

### Home

- Wide 16:9 cards fill the safe area, with nothing above or below them (no clock, no hint), sized from the owner's
  columns (3–6) and rows (1–4) per screen (default 4 × 2). Without [sections](#sections) Home is one grid showing
  exactly that many rows: moving down from the last visible row scrolls by one row (up from the first scrolls back),
  and a thin scroll bar in the right margin shows where the screen is. Left and right stop at a row's ends.
- The focused card scales to 110 % with a 4 dp white border, its name clear of the grown card; the others are dimmed.
- Under the card: the show's name (24 sp bold), on two lines when that leaves the card as large as one line would,
  else on one, cut with "…" only when longer.
- The picture is the catalog's `backdrop`, else the poster cropped around its upper part, else the show's name.
- At the card's bottom, a solid chip says what OK will do: mint for "New", the warm accent when OK resumes
  ("Continue", "Continue · Episode 2", with a progress bar under it), light grey otherwise ("Episode 5", "Watch
  again"). It shows only when it fits on one line; smaller cards keep the progress bar and the short "New".
- A channel's card has a solid red **Live** chip with white text, kept on smaller cards; no progress bar or "2 new".
- When episodes were added since the viewer last watched the show (or since it was put on Home), a small dark chip at
  the top right counts them ("2 new", read out as "2 new episodes"; the server's `newEpisodes`) when it fits beside
  the bottom chip. It takes no focus, never changes what OK plays, and goes once an episode was played.
- The tile played last gets the focus back; the focus stays on its card when the owner reorders or moves cards.
- No shows: "Nothing here yet" in large type and a line saying that the owner adds shows from the admin page. A first
  start with no cached Home shows "Loading…", or "No connection" while the server is unreachable.
- Server unreachable: the cached home screen stays, a solid red "No connection" chip with dark text appears at the top
  left, the TV retries every 10 s, and OK shows "No connection · Trying again…" for 5 s instead of playing.
- **Autoplay on start** (owner setting, off by default): when the app comes to the front on Home (TV switched on, app
  started, back from the launcher) and the first home state fetched then says so, the show or channel played last on
  this TV if it is on Home (else the first tile) is offered in the "Up next" panel: poster, title, what OK on its tile
  would play ("Episode 2", "Continue · Episode 2", "Live"), "Starts in 10 s" over its bar, **Play now** focused and
  **Not now**. At 0 it plays as OK on its tile would. OK presses the focused button; Back and every other key cancel
  it, do nothing else and leave the focus on its tile. It never appears after in-app steps (Back from the player, "The
  end", the error screen, closing the hidden menu), from the offline cache, or once a key was pressed; the hidden menu
  and the tiles wait while it shows.
- **Messages from the owner** appear as a banner (30 sp bold, down to 24 sp only for the longest, dark on yellow, up
  to 3 lines, no focus, no buttons) for the time the owner chose, across the top of Home and every player screen
  (playback goes on, the cards do not move); other screens ignore them.

#### Sections

The owner may cut Home into [sections](../spec/server-api-v1.md#home-sections), shown one under the other in the
owner's order. They change how the cards are laid out, never what OK does.

- A **titled section** starts with its title: 30 sp bold on one line (cut with "…"), aligned with the cards' left
  edge, white while the focus is in the section and dimmed otherwise. It takes no focus.
- The **untitled section** has no title and comes first unless moved; a Home with only it looks as without sections.
- **Grid** (the default layout): the cards wrap in rows of the owner's columns. **Row**: one line of cards that
  scrolls sideways: once the focus reaches the last card in view, the line slides by one card (and back the same way);
  the margins show the edge of the next (and previous) card; the line keeps its place when the focus leaves; ← → stop
  at its ends.
- **Between two sections** a thin line (2 dp, white at 18 %) runs across the cards' width. The boundary takes exactly
  the step between two rows of one section: the next section (its title, else its cards) starts where a next row
  would, and the line lies in the middle of the empty space above it (the gap between rows, plus the second title
  line when no card of the last row uses it).
- **One card size** for all of Home, from the owner's columns × rows; with a titled section, one title's height is set
  aside first, so one screen holds a title and that many rows.
- **Moving:** ↑ and ↓ go line by line (a grid row or a scrolling line), across sections, to the card nearest the one
  left (in a scrolling line, among the cards in view). The screen moves as little as possible to show the focused
  line whole, with its section's title when it is the section's first line; on Home's first line it is at the top.
- A section with nothing the TV can play is not shown. **Home order** (the sections in order, each with its cards in
  order) gives autoplay's first tile and CH+ / CH−'s channel order. The offline home screen keeps its sections.

### Player

- Video only. For 4 s after a key press: title, episode, a progress bar and times, on a dark shade solid behind the
  text (a channel: its name and "Live", no bar, times or clock); a small pause symbol stays in the corner while paused.
- Before the first frame: black with a spinner, the title and the episode (a channel: its name and "Live").
- Up next, "The end", "Can't play right now" and autoplay on start share one panel: the poster always at the same
  spot left of the centre, beside it the text in a fixed order, the countdown over a bar, the buttons (first focused).
- End of an episode with a next one (and auto-advance allowed): **Up next** ("Episode 3", its title, "Starts in 10 s";
  **Play now** focused, **Home**); the next episode starts by itself.
- End of the last episode (or an auto-advance boundary): "The end" with the show's title for 8 s (no focus), then Home.
- Nothing playable: "Can't play right now", "Home in 30 s", **Try again** focused and **Home**.
- A channel never ends and never shows Up next or "The end": when its stream ends, breaks or falls behind the live
  window, it follows the Live channels rule under [Playback rules](#playback-rules), ending on "Can't play right now",
  whose **Try again** restarts the channel; **CH+ / CH−** still change channels from there.
- Subtitles (off unless the owner chose a language): large, white on a dark box, above the bottom edge (and above the
  information).
- **CH+ / CH−** (and **|◀◀ / ▶▶|**) switch to the next / previous episode like changing channels, in the same player
  (its name shows while it loads) under the normal resume rules; while a channel plays, to the next / previous channel
  in Home order (shows skipped), at its live edge. At the ends only the information appears; holding steps once.
- Expiring stream addresses are renewed in the background (Stream refresh): at most a short spinner while the new
  stream buffers at the same place, paused or not (a channel: at the live edge).
- No pause on a channel: a short OK only shows the information; Play/Pause, Rewind, Fast forward and ← → do nothing.
- Owner commands: pause, resume and jump (which shows the information) act while video shows, not on a channel; next
  and previous switch like CH+/CH− (and close the hidden menu, like resume); stop works on any player screen.

### Update

The server keeps one TV app version for its TVs and may send a TV the **update** command. Nothing about it ever
interrupts playback: during playback the command answers `busy` and nothing is installed.

- **Android 12+, with the one-time "install unknown apps" grant**: when the owner allows TVs to update by themselves,
  the TV updates silently once it has sat on Home for 3 minutes with no key pressed (no hidden menu, no autoplay
  countdown, nothing playing, server reachable); the owner's command installs at once. "Updating…" shows during the
  install; Android then closes the app and does not let it come back (Android 10+ blocks background activity starts,
  verified on the API 36 emulator), so the TV shows its launcher until izle is opened again, on Home. After a failed
  attempt the TV waits 6 hours before trying by itself again. If the system asks for a confirmation anyway, the TV
  gives up on silent updates and behaves as below until its next update.
- **Android 11 and older** (the system always asks): only on the owner's command, a full-screen panel says "New
  version", the version, "Press OK to install" and "Home in 60 s" over its bar, **Install** focused and **Not now**.
  OK shows "Updating…" while it downloads, then the system's Install/Cancel dialog (with "Updating…" behind it).
  Back, Not now, Cancel or 60 s without a press: Home.
- A failure says "Could not update" for 15 s (**Home** focused), then Home; "Updating…" goes Home by itself after 2
  minutes if the system never answers (Back too, without stopping an install under way). Owner messages, the Menu key
  and holding OK do nothing on this screen.

### Hidden menu

Opened with the **Menu** key or by **holding OK for 0.6 s** (on Home: for the focused card; in the player, once it
plays: for what is playing, which pauses, except a channel). A panel slides over a little more than the right half,
its rows ending at the safe margin; the focused row has the tiles' white border. Back goes up one level, then closes.

| Entry | Shown | Does |
|---|---|---|
| Episodes | series | the play order with ✓ watched, ▶ plays next / now playing, greyed when not allowed; OK plays one |
| Start over | shows (not channels) | plays the episode OK would play from the beginning (in the player: seeks to 0) |
| Audio language | player, ≥ 2 audio tracks | Automatic (the owner's preference) or a specific track, for this playback |
| Subtitles | player | Off or one of the stream's subtitle tracks, for this playback |
| Settings | always | Server address (back to the address screen), Language (Automatic → Türkçe → English), Pair again; Install update (with the version) while the server offers a newer one, as the owner's command (not in the player's menu) |
| About | always | app version, TV name, server, catalog and catalog build; "Update available" with the version, or "Up to date" |

### First run

1. **Server address**: a large text field (the TV keyboard opens), prefilled with `http://10.0.2.2:8787` in debug
   builds (which take the `izle.server` extra, [AGENTS.md](../../AGENTS.md#emulator-loop)); Connect checks `/healthz`.
2. **Pairing code**: "Pair this TV", the admin page's address, the 6-digit code in 96 sp, "Waiting for approval…";
   Home once the owner approved it. Expired codes are replaced on their own; Back returns to the address screen. A TV
   the owner deleted shows a new pairing code by itself.

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

A short OK is delivered on release; a release without a press (the OK that launched the app) is ignored. Channel
keys never reach the system, also where they do nothing (pairing and the address screen included): many Android TV
devices open their own live-TV app on an unhandled channel key.

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
| Languages | audio: the owner's preferred language (and its primary subtag), else the stream default; subtitles: off unless the owner set a language; UI: the hidden-menu override, else the server's setting, else the TV's system language |

## Copy

English and Turkish, in `android/app/src/main/res/values/strings.xml` and `values-tr/strings.xml`. The words quoted
above are the English ones; besides them: "Paused", the pairing line "Open http://… /admin on your phone or computer
and approve this code", and on the address screen "Server address · Connect · The server cannot be reached."
