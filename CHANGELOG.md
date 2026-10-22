# Changelog

What changed between izle releases, for the people who run it: the server package, the TV app and the admin page.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The server, the TV app and the
contract share one version number. How to update (back up, update the server, then the TVs):
[self-hosting guide](docs/deploy/self-hosting.md#10-updates-and-backups).

## [Unreleased]

### Added

- **Admin page: a catalog browser.** A TV's "Add shows" and the Catalog page's "Shows" are now one browser: a title
  search with filters for kind, genre, a year range, playable only and "new since" a catalog build, three orders (by
  title, newest year, newest in the catalog), and 50 shows at a time with "Show more". On a TV's page, "Not on this
  Home" leaves out what the TV already has. The Catalog page keeps its filters in the address, so Back from a show
  returns to the same list. It replaces the search that stopped at 200 shows and its "Show all". The admin API's
  `GET /api/v1/admin/catalog/search` takes the matching parameters plus `offset` and answers `total`;
  `GET /api/v1/admin/catalog` gains `facets`.

### Changed

- **Admin page:** a TV's page is split into tabs instead of one long page: Now playing, Home screen, Listen along,
  History, Settings and Problems (with a count when there are any). The tab is kept in the address
  (`#/devices/<id>/settings`), so a reload or a shared link opens it. Settings now holds the TV app's version and
  "Install now", the TV's settings, and "Forget this TV".
- **Admin page:** a TV's Home screen tab draws the TV's Home to scale instead of a list: the same grid, cards, chips,
  progress bars and titles, with further rows scrolling inside the screen as on the TV. Select a card (or move with
  the arrow keys) to play it, move it left, right, up or down a row or to the first place, open its episodes, or
  remove it. What the TV hides (missing from the catalog, not playable) is listed under the screen. The grid's
  columns and rows moved here from Settings: a new size is previewed on the screen before "Save grid".
- **TV app:** the chips on Home's cards ("Live", "New", "Episode 5", "2 new") are smaller (16 sp, was 20 sp), so
  they cover less of the picture.
- **TV app:** Home scrolls more smoothly. The row beyond each edge of the screen is prepared ahead, so ↓ or ↑ onto it
  no longer builds a whole row of cards at once; the dimmed cards around the focused one are drawn without an extra
  layer each; a chip's label is measured once for the whole screen.
- **TV app:** release builds are shrunk and optimized by R8 (class names are kept, so problem reports read the same):
  a smaller APK and a faster app, Home's scrolling above all.

### Fixed

- **Admin page: a Home list with a missing show could not be edited.** Once a catalog update dropped a show (or
  made it unplayable) that was on a TV's Home, every change to that list, removing the missing show included,
  failed with "That show is not in the catalog (any more)." Only the shows a change adds are checked now; the ones
  already on the list may stay until the owner removes them.
- **TV app: CH+/CH− on a dead channel.** When a channel ends on "Can't play right now" (Try again / Home with its
  countdown), CH+/CH− and |◀◀ ▶▶| now switch to the next / previous channel on Home as they do while a channel
  plays; before, they did nothing until the viewer pressed a button. The owner's `next` and `previous` commands do
  the same from that screen.

## [0.4.0] - 2026-10-21

### Added

- **Home grid size per TV:** the owner sets how many columns (3–6) and rows (1–4) one screen of the TV's Home shows,
  in the TV's settings on the admin page (default 4 × 2); the TV applies it live. The admin API takes `homeColumns`
  and `homeRows` in `PATCH /api/v1/admin/devices/:id`, and the TV reads them from `GET /api/v1/tv/state`.
- **Landscape pictures in catalogs:** a catalog item may carry an optional 16:9 `backdrop` image next to its poster
  (an additive change to the v1 bundle contract, checked by `izle-validate` like posters). The server sends it as
  `backdropUrl`; the TV shows it on the show's card.
- **Live channels (contract, specs and server):** a catalog item may be a `live` channel, carrying
  `playbackAllowed` and its `sources` itself, with no episodes; `izle-validate` checks it and counts it (`live` in
  its summary and stats). The specs say how a channel plays (at its live edge, no pause or seek, CH+/CH− zap
  between Home's channels), is reported (heartbeats without a position) and is kept in the history (when and for
  how long, never "seen"). The server now serves channels: they go on a TV's Home (`continue: null`), are resolved
  by their item id (`POST /tv/resolve {"itemId"}`), report without a position (`POST /tv/progress {"itemId"}`,
  which never bumps the state version), get viewings without episode, positions or duration, appear in problem
  reports, the catalog history and the admin catalog (`playable` on search hits and home rows, a channel's sources
  under `items/:id`), and play by remote command (`play` with a channel's `itemId`).
- **Media kind `ts`:** a source may be a progressive MPEG-TS stream over HTTP (IPTV-style), meant for channels. The
  server serves it like MP4: a plain URL goes to the TV as it is, one that needs upstream headers streams through
  the proxy at `/p/<token>/stream.ts` (`Range` forwarded, never buffered, never aligned). "Listen along" cannot play
  it in a browser and marks such a source unsupported.
- **Admin page: live channels.** A "Live" chip on a TV's Home list and in Now playing, with the time the channel
  started; Previous/Next channel, with pause and seek disabled while a channel plays; a channel's catalog page with
  its sources, Test sources and Play on; channels counted in the catalog contents and its build changes; a
  channel's history shows when it was on and for how long; Listen along says channels are not covered, and `ts`
  sources show as MPEG-TS.
- **TV app: live channels.** Channels appear on Home with a red "Live" chip ("Canlı"), no progress bar and no
  "new" count. OK plays a channel at its live edge (autoplay on start offers it as "Live"). CH+/CH− and |◀◀ ▶▶|
  switch between Home's channels in Home order, without wrapping around. A channel cannot be paused or sought: its
  information is its name and "Live", and the hidden menu (Audio language and Subtitles only) does not pause it.
  A channel whose stream ends or breaks restarts at the live edge, then tries its other sources, then shows "Can't
  play right now". MPEG-TS (`ts`) streams play. Owner commands can play a channel; pause, resume and seek on a
  channel are answered `live`, next and previous switch channels (`no_channel` at the ends).

### Changed

- **Breaking (pre-release) contract changes, made in place:** a v1 catalog item is now a union by `kind` (`movie`
  and `series` carry `episodes`; `live` carries `sources`); a resolver's `ResolveRequest.episodeId` is null for a
  channel; inline playlists from adapters are for VOD only. Nothing is deployed, so no version is bumped (see
  the spec changelogs).
- **The Docker image uses Node 26** instead of Node 24. CI builds the image and checks startup, the admin page and
  restart with a persistent data volume, with outbound networking disabled.
- **The TV's Home is a grid of wide cards** that fills the screen, with each show's name in full under its card (on
  two lines when there is room). Shows that do not fit on one screen are reached by moving down, one row at a time,
  with a thin scroll bar at the right. A show without a landscape picture shows a landscape crop of its poster.
  The chips on the cards ("New", "Episode 5", "2 new") are smaller (20 sp), and the long "Continue ·
  Episode 2" chip only shows on cards wide enough for it. The clock and the "OK: Play" hint are gone; the owner's
  message and "No connection" are drawn over the top of the grid.
- **Home holds up to 200 shows** instead of 12 (`homeMax` in the admin API).

## [0.3.0] - 2026-10-18

### Added

- **TV app updates, server side:** the server keeps one TV app APK and offers it to every TV (`GET /api/v1/tv/app`,
  `/tv/app/apk`, `event: app` on the TV's stream). By default it fetches the latest release's APK from GitHub a
  minute after the start and once a day, verified against the release's `SHA256SUMS` (config `appUpdates`:
  `source` `github` or `manual`, `repo`, `checkIntervalHours`, `auto`); the owner can also upload one
  (`PUT /api/v1/admin/app/apk`; an upload of the release's own version is kept over the release), remove it (the TVs
  hear of it: `event: app` with `versionCode` 0) or check now (`GET /api/v1/admin/app`, which also shows
  `checkIntervalHours`, `DELETE …/app/apk`, `POST …/app/check`). A new `update` command starts the install on a TV
  that needs the viewer. Each TV's app version, Android version and update capability (from its User-Agent) show in
  the device list with whether it is up to date (`app`), and the event log gains `app.uploaded`, `app.fetched`,
  `app.removed`, `app.check_failed` and `device.app_version`.
- **TV app page on the admin page** ("TV app"): the APK the server offers to the TVs (version, where it came from,
  size, how often and when the server last checked GitHub and with what result, whether TVs install by themselves),
  Check now, Remove, and an upload for a release APK. Every TV with its installed app and Android version, whether
  it updates by itself or needs Install now, and an Install now button; a TV's page has the same in its new "TV app"
  section, and the TV list flags TVs with an update waiting. The update's outcome comes back as a toast ("Update:
  the TV shows the install screen").
- **The TV app updates itself** from the version stored on the server: on Android 12 and newer (with the one-time
  "install unknown apps" permission) silently, once the TV has sat idle on Home for 3 minutes or at once on the
  owner's `update` command; on older TVs on the command only, behind a large "New version — press OK" screen and
  then the system's Install dialog ("Updating…" waits behind it; Back or 60 s go Home). Never during playback: the
  hidden menu's "Install update" is not offered over the player. An install that fails after the owner's command
  was answered reaches the owner as a problem report. After an update Android 10+ shows the TV's launcher until izle
  is opened again (the system blocks the app from coming back by itself); Android 9 and older bring it back. The
  hidden menu offers "Install update" and About says whether one is available; every API call's `User-Agent` names
  the app version, Android version and how the TV can update (`izle-tv/0.3.0 (Android 25; 300; guided)`).
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

### Security

- **Requests without a token no longer count toward the admin sign-in lockout:** they still answer 401, but another
  site's page open in the owner's browser can no longer lock the owner out of the admin API for 10 minutes by sending
  tokenless requests to it. Wrong and revoked tokens are counted as before.
- **Revoking an access token ends the admin event stream it has open:** a stream opened with the token closed
  only when the client disconnected, so it went on receiving events after the revocation; it now ends at once (and
  at the next ping, should the token be gone some other way), and a long-poll waiting with it answers 401.
- **The admin event stream's work is bounded:** opening it replays at most the newest 500 stored events (after a
  `gap`, so the admin page re-reads what it shows) instead of the whole retained log in one go, a client that stops
  reading is disconnected instead of queuing events for it without end, and each access token (or, for the owner
  token, each client address) may have at most 10 streams open (`429 too_many_streams`).
- **The per-address limits count an IPv6 client by its /64**, so one client cannot get a fresh pair/start allowance
  or admin sign-in budget by changing addresses, and their bookkeeping costs the same per request however many
  addresses are seen: it no longer scans every tracked address on each request once 10,000 are tracked, and holds
  at most 50,000.
- **A rewritten playlist stays in bounds:** every link the media proxy writes into a playlist embeds its URL, so an
  upstream playlist of many short lines behind a long URL could grow a hundredfold and stall the server while it
  was rewritten. A playlist with more than 250,000 lines, more than 16 MiB once rewritten, or a URI longer than 4096
  characters now answers 502 `playlist_too_large` and is reported, like one over 4 MiB.
- **`admin-token --rotate` no longer leaves the old token valid when `IZLE_ADMIN_TOKEN` is set:** it wrote a new
  token file that the server ignored in favour of the variable. It now refuses with a message to change or remove
  the variable, and the server warns at startup ("IZLE_ADMIN_TOKEN overrides the admin token file") when the
  variable shadows a token file.
- **Self-hosting guide: the admin token stays out of the unit's `Environment=`.** The guide offered
  `IZLE_ADMIN_TOKEN` in the systemd unit's environment as an alternative to the token file, but systemd shows a
  unit's `Environment=` to every local user. It now says to keep the token in the token file, or, if the variable
  is needed, in a root-only `EnvironmentFile=`.
- **Log redaction catches more:** protocol-relative URLs (`//host/…`) are reduced to their host like other URLs,
  playlist text (a string starting with `#EXTM3U`) is written as `<playlist>` whatever the field is called, and an
  error's class name is kept only when it is a short identifier, scrubbed like any string. The resolver module spec
  now describes the redaction as the heuristic it is: modules must not pass header maps, refs, config, playlist
  text, URLs or tokens to `ctx.log` in any shape.
- **The media proxy no longer reaches into the server's own network.** An upstream's playlist (a URI line or an
  `EXT-X-KEY` URI) or redirect could make the server fetch any address it can reach, loopback and LAN services or the
  cloud metadata address included, with the session's upstream headers, and stream the answer to the TV. Every
  proxied request and every redirect is now checked: the server resolves the host itself, connects only to the
  address it checked, and refuses loopback, private, link-local, CGNAT, multicast and other non-public addresses
  (`502 egress_denied`, recorded as the TV's problem `egress_denied`, never with the URL in the log). Redirects are
  followed by the proxy (at most 5), and `Authorization`, `Cookie` and other credential-type headers go only to the
  session's own origin. **If your upstream is on this machine or your LAN**, list it in the new config setting
  `proxy.privateUpstreams` (for example `["192.168.1.20", "127.0.0.1:8788"]`); the resolver example's config does.
- **One client can no longer keep every TV from pairing.** Anyone who reached `POST /api/v1/pair/start` could hold
  all 5 open pairing codes, refilling them as they expired, so no TV got a code. Now each client address has at most
  2 codes waiting for approval (10 open server-wide), a start never ends someone else's code, and
  `429 too_many_pending` says when to try again (`Retry-After`). Codes you did not expect can be cleared: **Clear**
  next to Approve on the admin page's TVs list, `izle-server pair cancel <code>`, or
  `DELETE /api/v1/admin/pair/pending/:code` (owner only); the event log records `pairing.cancelled`.

### Compatibility

- **Database migrations 3 to 7**, applied on the first start; an older server refuses the migrated database. To go
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

[Unreleased]: https://github.com/mickeiik/izle/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/mickeiik/izle/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mickeiik/izle/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mickeiik/izle/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mickeiik/izle/releases/tag/v0.1.0
