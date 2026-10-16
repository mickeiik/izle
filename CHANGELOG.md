# Changelog

What changed between izle releases, for the people who run it: the server package, the TV app and the admin page.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The server, the TV app and the
contract share one version number. How to update (back up, update the server, then the TVs):
[self-hosting guide](docs/deploy/self-hosting.md#10-updates-and-backups).

## [Unreleased]

### Added

- **TV app updates, server side:** the server keeps one TV app APK and offers it to every TV (`GET /api/v1/tv/app`,
  `/tv/app/apk`, `event: app` on the TV's stream). By default it fetches the latest release's APK from GitHub a
  minute after the start and once a day, verified against the release's `SHA256SUMS` (config `appUpdates`:
  `source` `github` or `manual`, `repo`, `checkIntervalHours`, `auto`); the owner can also upload one
  (`PUT /api/v1/admin/app/apk`), remove it or check now (`GET /api/v1/admin/app`, `DELETE …/app/apk`,
  `POST …/app/check`). A new `update` command starts the install on a TV that needs the viewer. Each TV's app
  version, Android version and update capability (from its User-Agent) show in the device list with whether it is
  up to date (`app`), and the event log gains `app.uploaded`, `app.fetched`, `app.removed`, `app.check_failed` and
  `device.app_version`.
- **The admin page follows the TVs live:** it reads the server's event log, so a TV going online, a playback, a
  command's outcome or a change made elsewhere shows up as it happens; the polls stay as a fallback. After a remote
  command, a toast says what the TV made of it ("Play: done", "Pause: ignored (nothing is playing)").
- **History tab on the admin page:** what was watched per day over the last week, every title with its status
  (watching, new episodes, finished, idle) and, per title, its episodes with how much of each was played and the
  owner's marks (seen, not seen, which win over what the TVs reported). A TV's page lists its viewings: who started
  each, how much was watched and how it ended.
- **Access tokens on the admin page** ("Access"): create a token with a scope for an app or an agent, see when it
  was last used, revoke it. The secret is shown once.
- **Play any show on a TV from its catalog page** ("Play on"), whether it is on that TV's home screen or not; and
  when approving a pairing code, a new TV can take over an existing one ("Replaces"), keeping its name, settings,
  home screen and history.
- **Viewing history:** the server keeps every playback of an episode on a TV as a viewing (which TV, what, when,
  how much was watched and which parts, how it ended, whether the episode was seen: at the end, or past 90 %),
  outliving the TV and the catalog. `GET /api/v1/admin/history/viewings` (filters and pages), `…/viewings/:id`
  (with the played ranges), `…/titles` and `…/titles/:itemId` (what was seen and covered, with a status:
  finished, new episodes, watching, idle), `…/days` (watched time per calendar day in a time zone), the owner's
  marks (`POST …/history/marks`, winning over the viewings) and deletions (`DELETE …/history`, owner token only).
  The saved positions from before became the first viewings. The TV's resolve may say what started a playback
  (`trigger`, `commandId`). New events: `playback.started`, `paused`, `resumed`, `seeked`, `stalled`, `recovered`,
  `ended`, `episode.seen` and `history.changed`; the status's `nowPlaying` shows only a running viewing, with its
  `viewingId`.
- **Access tokens for agents and apps:** the owner creates named tokens with a scope (`read`, `control` or
  `manage`) and revokes them at any time, through `GET`/`POST`/`DELETE /api/v1/admin/tokens` or `izle-server token
  create <name> --scope <scope>`, `token list` and `token revoke <id>`. A token lacking a route's scope gets
  `403 insufficient_scope`; a wrong or revoked one counts like a wrong admin token. Every change records who made
  it (its `actor`), and the access log names a token by its id, never its secret.
- **`GET /api/v1/admin/status`:** every active TV in one call (online, last seen, what it plays), the catalog, the
  pending pairing codes and the id of the latest event.
- **Event log:** the server keeps every change worth reacting to (TVs coming online and going offline, pairing,
  settings, home lists, cursors, commands sent and delivered, problems, catalog reloads) for `events.retentionDays`
  (default 7) and serves it as a stream (`GET /api/v1/admin/events/stream`) and a long-poll (`GET
  /api/v1/admin/events`), with device and type filters and a `gap` marker when a consumer fell behind.
- **Play any show at any position from the admin API:** `play` takes an `itemId` (the episode OK would play on
  that TV) and an optional `positionMs`, for any playable show in the catalog, on the TV's home screen or not. The
  TV reports what it made of every command (`done`, `ignored` or `failed`, with a reason); `GET
  /api/v1/admin/devices/:id/commands/:commandId` shows it with when the TV received the command, and the event log
  carries it as `command.result`.
- **Single home list changes:** `POST`, `PATCH` and `DELETE /api/v1/admin/devices/:id/home/items…` add, move and
  remove one show, so two editors (the owner, an agent) do not overwrite each other; `PUT …/home` takes an optional
  `expected` list and answers `409 home_changed` when the list changed in the meantime.
- **Replacing a TV at pairing:** approving a new TV's code with `replaces` gives it an existing TV with its name,
  settings, home list and progress; the old TV's token stops working. `POST
  /api/v1/admin/devices/:id/history/adopt` gives the viewings of a deleted TV to another one.
- **The TV reports what became of each remote command:** done, ignored (and why: not playing, not ready, no next
  episode, unknown command) or failed (no playable source, playback error); a remote play reports once the video
  runs or fails. Every playback tells the server who started it (the viewer, autoplay, auto-next or a command), for
  the viewing history. A remote play can start at a given position (0 = from the beginning).
- **Next and previous episode from the remote:** CH+/CH− and the media next/previous keys switch episodes while
  playing.
- **Autoplay when the TV starts** (per TV, off by default): the show watched last, else the first tile, starts after
  a 10-second countdown.
- **Problem reports:** the TV reports playback, resolve and network problems, the server records its own resolve
  and proxy failures; the admin page shows them on the TV's page and a warning in the TV list.
- **More remote control from the admin page:** pause, resume, seek, next and previous episode, and a message shown
  on the TV.
- **`izle-server backup <file>`** writes a consistent copy of the database while the service runs (used by the
  self-hosting guide's backups).
- **New episodes on the TV's home tiles:** when a catalog reload adds episodes to a show on a TV's home screen, its
  tile shows how many ("2 new") until the TV plays any episode of the show, counting from when the TV last played
  the show or the show was put on that home screen. Also on the TV's admin page, and `newEpisodes` in the API.
- **OK resumes a finished show at its first new episode** (the first new playable one a later catalog added)
  instead of starting it over.
- **Catalog build history:** the server records every catalog build it loads, with the shows and episodes it added
  and removed and when each episode first appeared; the first load of a catalog is the baseline (nothing in it is
  new). The admin page's Catalog tab lists the builds and their changes (new episodes by show, new shows, removed
  shows and episodes); in the API, `GET /api/v1/admin/catalog` lists them (newest first, up to 50) with the latest
  build's changes, and `GET /api/v1/admin/catalog/builds/<buildId>` returns any one.
- **Self-hosting guide: publishing catalog builds:** one directory per build and a `current` symlink, so publishing
  or rolling back is one atomic swap and a reload; a job on the host can publish through the admin API without sudo.
  The guide also says that `systemctl reload izle` re-reads the catalog only: a new resolver module needs
  `systemctl restart izle`.
- **Pairing from the server's shell:** `izle-server pair pending` lists the waiting codes, `izle-server pair approve
  <code> [name]` approves one.
- **Sign-in link for a phone:** `izle-server admin-token --link` prints a sign-in link for the admin page and its QR
  code. The guide shows how to use a passphrase of 24 characters or more as the admin token.
- Compose UI tests for the TV's senior-path rules (development only).
- Repository: this changelog, a [security policy](SECURITY.md) with private vulnerability reporting, GitHub Actions
  pinned by commit SHA and Dependabot version updates. The TV app had its first run on a real Android TV box.

### Changed

- **A TV counts as online for a minute after its event stream closed**, so a reconnect does not show it offline
  and back; the device list, the answer to a command and the status all follow this one rule.
- **Approving a TV no longer needs a name:** it is called "TV" (then "TV 2", "TV 3", …) and can be renamed later;
  `POST /api/v1/admin/pair/approve` answers with the name it gave.
- **The TV's pairing screen shows the admin page's address**, where the code is approved, instead of the bare
  server address; while no TV is waiting, the admin page shows the address to type on the TV.
- **Failed admin sign-ins are throttled** per client address (10 per 10 minutes); behind a reverse proxy, set
  `trustedProxies` so that each client counts on its own.
- **Streams with an expiry time are refreshed a minute before they expire** instead of running into the expired
  link during playback.
- **The admin page has a new look:** one main action per card, red outlines on Stop, Remove, Clear and Forget, a
  visible busy state that also stops a double click from sending twice, stronger borders and contrast in light and
  dark mode, a header that fits on a phone; for screen readers, named buttons per show, labelled progress bars and
  announced search results.
- **A TV's admin page has a section bar** under its name (Now playing, Home screen, Settings, Listen along, History,
  Problems) that stays in view while you scroll. "Now playing" shows its state as a badge, with Stop next to the
  remote control. **"Add shows" searches as you type**, and with nothing typed shows a hint and a "Show all" button
  instead of the whole catalog. The history and problems sections are called History and Problems; a film's page
  lists its sources without an "Episodes" heading.
- **The TV's look:** one set of colours, margins and shapes on every screen, nothing that matters in the outer 5 %
  of the picture (which many TVs crop), and one button style where the focused one is white with a white border. In
  the hidden menu the focused row has the same white border instead of a grey fill, and the panel no longer reaches
  into the screen's edge.
- **Countdown bars on Up next, autoplay and "Can't play right now"**, which now says when it goes back Home ("Home in
  30 s"). These three and "The end" share one layout with the show's poster always in the same place; "The end"
  shows the poster and the show's title.
- **The owner's message no longer covers the clock or the tiles on Home:** it sits at the top beside the clock and
  the tiles move down; a long one gets the full width under the clock, so all 200 characters fit. Over the video it
  still runs across the top.
- **The TV's Home screen:** the chip saying what OK plays reads clearly on dark posters, the new-episodes count is
  shorter ("2 new"), "No connection" is a solid red chip, a further row of shows fades out at the bottom edge and
  comes up whole, title included, when the viewer moves down to it, and the hint says just "OK: Play" (Back does
  nothing on Home).

### Fixed

- **The admin page no longer loses your place:** refreshing a TV's page or the TV list keeps the keyboard focus,
  also while you reorder the home screen with ▲ and ▼, and a half-typed name or message stays.
- **The admin page stops refreshing a page you left**, also one you left before it finished loading; the page of a
  TV that no longer exists no longer sends you to the TV list after you went elsewhere.
- **When the server cannot be reached**, the admin page says so with a Retry button instead of "Loading…" for ever,
  an open page says "Not updated since …" until the server answers again, and a show page no longer says "This show
  is not in the catalog".
- **The clock follows the TV's own 12/24-hour convention** when the TV has no explicit setting, not the menu
  language (an English menu on a French TV showed "2:54 PM").
- **Channel keys no longer leave izle:** outside the player, CH+/CH− are consumed instead of opening the TV's Live
  TV app.
- **A catalog reload that runs into an error no longer ends the server:** when `systemctl reload izle` (SIGHUP)
  failed after reading the catalog, for example during shutdown, the process ended with an unhandled error; it now
  logs a warning (`catalog reload failed`).
- **The TV's clock changes language at once** when the owner switches the menu language while Home shows (it kept
  "PM" for up to a minute after a switch to Turkish).

### Compatibility

- **Database migrations 3 and 4**, applied on the first start; an older server refuses the migrated database. To go
  back, install the older package and restore the backup taken before the update
  ([updates and backups](docs/deploy/self-hosting.md#10-updates-and-backups)).
- Update the server before the TVs. The new remote commands and autoplay need the new TV app; a 0.2.0 app ignores
  commands it does not know.

## [0.2.0] - 2026-10-11

### Added

- **Listen along:** from the admin page, the owner's phone plays another source of the episode a TV is showing (a
  dub, or another audio language of the same stream) in sync with the picture, for earphones. An offset and a speed
  factor for releases with different timing are saved per episode and source and can be copied to the show's other
  episodes; each phone keeps its own small correction. The phone gets the stream through the server's proxy,
  follows pauses, seeks and episode changes on the TV, and on Android keeps playing with the screen off.
- Server API, additive: admin routes for Listen along, a long-poll on `GET /api/v1/admin/devices/:id/now` (`seq`,
  `wait`), and `playing`/`ageMs` on TV progress reports
  ([server API § Listen along](docs/spec/server-api-v1.md#listen-along)).

### Changed

- The admin page's Content-Security-Policy adds `media-src 'self' blob:` for the companion audio, and the page
  carries hls.js 1.7.3 (Apache-2.0, vendored and pinned), loaded only when the phone's browser cannot play HLS
  itself. Nothing is loaded from other origins.

### Compatibility

- **Update the server before the TVs:** a 0.1.0 server rejects progress fields a 0.2.0 TV sends; the app then
  resends without them, but the first report after each start is lost.
- **Database migration 2:** a 0.1.0 server refuses a database 0.2.0 has migrated; to go back, restore the backup
  taken before the update.

## [0.1.0] - 2026-10-10

The first release: everything needed to run izle at home with your own catalog.

### Added

- **izle-server**, one dependency-free package (`izle-server-X.Y.Z.tgz`) serving a catalog bundle from a local
  directory (the bundled sample catalog by default): pairing with 6-digit codes, each TV's home list, progress and
  "continue from", play order, menu, audio and subtitle languages, play and stop commands, live updates to the TVs.
  State in SQLite; a JSON-lines log that never contains stream URLs, upstream headers or tokens. Commands:
  `admin-token` (`--rotate`), `validate-catalog`, `check-resolver`, `--version`; SIGHUP reloads the catalog.
- **The Android TV app**, English and Turkish: one home screen of big poster tiles; OK plays the next unwatched
  episode or resumes the one in progress, episodes advance on their own after a 10-second "Up next", Back always
  returns home. A failing source falls back to the next one, an expired stream link is resolved again, and every
  error ends on the home screen by itself; while the server is unreachable the tiles stay with a "No connection"
  notice. A hidden menu (Menu key or hold OK) has episodes, start over, audio and subtitle tracks, settings, about.
- **The admin page** at `/admin/`, signed in with the admin token: approve pairing codes; per TV, the home list (add,
  order, remove, play), "continue from" an episode, languages, now playing with Stop, recently watched, forget the
  TV; the catalog's facts, "Reload from disk" and a test of every source of an episode. Strict
  Content-Security-Policy, no third-party code, usable on a phone.
- **Bring your own catalog:** the catalog bundle contract v1 with its JSON Schema and the `izle-validate` checker
  (`@izle/contract`), and the resolver module API v1 for streams resolved at play time (a module the owner writes,
  loaded from a local path, with a deadline per call, `resolver.deadlineMs`, and a budget per request,
  `resolver.budgetMs`), plus a runnable example.
- **The media proxy** for streams that need upstream request headers or come as playlist text (HLS with rewritten,
  signed links, MP4 with range requests), so those headers and the upstream URLs never reach the TV;
  `proxy.always` sends every HLS and MP4 stream through it, `proxy.alignTsSegments` repairs segments with junk
  before the first TS packet.
- **A sample catalog** of six openly licensed titles (Blender Foundation open movies and a public-domain film).
- **Self-hosting:** a guide, a sandboxed systemd unit, a Caddy example (HTTPS, unbuffered live updates, an optional
  LAN-only admin page), a Dockerfile, and `trustedProxies` so the pairing rate limit counts each client behind a
  reverse proxy.
- **Release files:** the server package, the TV app signed with the release key, a debug APK and `SHA256SUMS`.

### Fixed

- Before the release: resolver adapter deadlines use an ordinary timer, so they also fire on Node 22 when nothing
  else keeps the process busy. Node 22 test runs had been cancelled because of it since resolver modules were added;
  a running server was not affected, since an open request keeps Node busy.

### Compatibility

- Node.js 22.13 or newer (`node:sqlite`); tested on Node 22, 24 and 26. On Node 22 the log shows one "SQLite is an
  experimental feature" warning at start.
- The TV app needs Android 7.0 (API 24) or newer. It carries Let's Encrypt's root certificates, so a TV on 7.0 can
  reach a server behind Caddy's default certificate.

[Unreleased]: https://github.com/mickeiik/izle/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mickeiik/izle/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mickeiik/izle/releases/tag/v0.1.0
