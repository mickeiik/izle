# Changelog

What changed between izle releases, for the people who run it: the server package, the TV app and the admin page.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The server, the TV app and the
contract share one version number. How to update (back up, update the server, then the TVs) is in the
[self-hosting guide](docs/deploy/self-hosting.md#10-updates-and-backups).

## [Unreleased]

### Added

- **Next and previous episode from the remote.** While playing, CH+/CH− and the media next/previous keys switch to
  the next or previous episode.
- **Autoplay when the TV starts** (a per-TV setting, off by default): the show watched last, or else the first
  tile, starts after a 10-second countdown.
- **Problem reports.** The TV reports playback, resolve and network problems, and the server records its own resolve
  and proxy failures. The admin page shows a TV's recent problems on its page and a warning in the TV list.
- **More remote control from the admin page:** pause, resume, seek, next and previous episode, and a message shown
  on the TV.
- **`izle-server backup <file>`** writes a consistent copy of the database while the service runs. The
  self-hosting guide's backup section uses it.
- **New episodes on the TV's home tiles.** When a catalog reload adds episodes to a show on a TV's home screen, its
  tile shows how many ("2 new episodes") at the top of the poster, until the TV plays any episode of the show. The
  count starts when the TV last played the show, or when the show was put on that TV's home screen. A TV's page on
  the admin page shows the same count ("2 new"); in the API it is `newEpisodes` on each home entry.
- **OK resumes a finished show at its first new episode:** when a show was watched to the end and a later catalog
  adds episodes to it, OK plays the first new playable one instead of starting the show over.
- **Catalog build history:** the server records every catalog build it loads, with the shows and episodes it added
  and removed, and when each episode first appeared. The first load of a catalog is the starting point: nothing in it
  counts as new. The admin page's Catalog tab lists the builds and what each one changed (new episodes by show, new
  shows, removed shows and episodes). In the API, `GET /api/v1/admin/catalog` lists the builds (newest first, up to
  50) with the latest build's changes, and `GET /api/v1/admin/catalog/builds/<buildId>` returns any one of them.
- **Self-hosting guide: publishing catalog builds.** A versioned catalog layout (one directory per build and a
  `current` symlink on the active one) that makes publishing and rolling back a build one atomic swap and a reload,
  and how to let a job on the host publish builds through the admin API, without sudo. The guide now also says
  plainly that `systemctl reload izle` re-reads the catalog only: a new resolver module needs
  `systemctl restart izle`.
- **Pairing from the server's shell:** `izle-server pair pending` lists the codes waiting for approval and
  `izle-server pair approve <code> [name]` approves one.
- **Sign-in link for a phone:** `izle-server admin-token --link` prints a sign-in link for the admin page and the
  same link as a QR code, so a phone signs in by scanning it. The guide also shows how to use a passphrase of 24
  characters or more as the admin token.
- Compose UI tests for the TV's senior-path rules (development only).
- Repository: this changelog, a [security policy](SECURITY.md) with private vulnerability reporting, GitHub Actions
  pinned by commit SHA, Dependabot version updates, and
  [notes from a first run on a real Android TV box](docs/verification/real-device/README.md).

### Changed

- **Approving a TV no longer needs a name.** Without one it is called "TV" (then "TV 2", "TV 3", …) and can be
  renamed later; `POST /api/v1/admin/pair/approve` answers with the name it gave.
- **The TV's pairing screen shows the admin page's address**, where the code is approved, instead of the bare
  server address. While no TV is waiting, the admin page shows the address to type on the TV.
- **Failed admin sign-ins are throttled** per client address: 10 per 10 minutes. Behind a reverse proxy, set
  `trustedProxies` so that each client is counted on its own.
- **Streams with an expiry time are refreshed a minute before they expire**, instead of running into the expired
  link during playback.

### Fixed

- **The clock follows the TV's own 12/24-hour convention** when the TV has no explicit setting; it used to follow the
  menu language (an English menu on a French TV showed "2:54 PM").
- **Channel keys no longer leave izle.** Outside the player, CH+/CH− are consumed, so a press cannot throw the viewer
  into the TV's Live TV app.

### Compatibility

- **Database migrations 3 and 4.** The new server migrates the database on its first start, and an older server
  refuses a migrated database. To go back, install the older package and restore the backup taken before the
  update ([updates and backups](docs/deploy/self-hosting.md#10-updates-and-backups)).
- Update the server before the TVs. The new remote commands and autoplay need the new TV app; a 0.2.0 app ignores
  commands it does not know.

## [0.2.0] - 2026-10-11

### Added

- **Listen along.** From the admin page, the owner's phone plays another source of the episode a TV is showing (a
  dub in another language, or another audio language of the same stream) in sync with the picture, for listening
  on earphones. For releases whose timing differs, an offset and a speed factor are saved per episode and source and
  can be copied to the show's other episodes; each phone keeps its own small correction. The phone gets the stream
  through the server's proxy, follows pauses, seeks and episode changes on the TV, and on Android keeps playing with
  the screen off.
- Server API, additive: admin routes for Listen along, a long-poll on `GET /api/v1/admin/devices/:id/now` (`seq`,
  `wait`), and `playing`/`ageMs` on TV progress reports
  ([server API § Listen along](docs/spec/server-api-v1.md#listen-along)).

### Changed

- The admin page's Content-Security-Policy adds `media-src 'self' blob:` for the companion audio, and the page
  carries hls.js 1.7.3 (Apache-2.0, vendored and pinned), loaded only when the phone's browser cannot play HLS
  itself. Nothing is loaded from other origins.

### Compatibility

- **Update the server before the TVs.** A 0.2.0 TV sends progress fields that a 0.1.0 server rejects; the app then
  resends without them, but the first report after each start is lost.
- **Database migration 2.** A 0.1.0 server refuses a database that 0.2.0 has migrated; to go back, restore the
  backup taken before the update.

## [0.1.0] - 2026-10-10

The first release: everything needed to run izle at home with your own catalog.

### Added

- **izle-server**, one dependency-free package (`izle-server-X.Y.Z.tgz`) that serves a catalog bundle from a local
  directory (the bundled sample catalog by default): pairing with 6-digit codes, each TV's home list, progress and
  "continue from", play order, menu, audio and subtitle languages, play and stop commands, and live updates to the
  TVs. State lives in SQLite. The log is JSON lines and never contains stream URLs, upstream headers or tokens.
  Commands: `admin-token` (`--rotate`), `validate-catalog`, `check-resolver`, `--version`; SIGHUP reloads the
  catalog.
- **The Android TV app**: one home screen of big poster tiles. OK plays the next unwatched episode or resumes the one
  in progress, episodes advance on their own after a 10-second "Up next", and Back always returns to the home
  screen. A failing source falls back to the next one, an expired stream link is resolved again, and every error ends
  on the home screen by itself. While the server is unreachable, the tiles stay with a "No connection" notice. A
  hidden menu (Menu key or hold OK) has episodes, start over, audio and subtitle tracks, settings and about. English
  and Turkish.
- **The admin page** at `/admin/`, signed in with the admin token: approve pairing codes; per TV, the home list (add,
  order, remove, play), "continue from" an episode, languages, now playing with Stop, recently watched, forget the
  TV; the catalog's facts, "Reload from disk" and a test of every source of an episode. Strict
  Content-Security-Policy, no third-party code, usable on a phone.
- **Bring your own catalog:** the catalog bundle contract v1 with its JSON Schema and the `izle-validate` checker
  (`@izle/contract`), and the resolver module API v1 for streams resolved at play time: a module the owner writes,
  loaded from a local path, with a deadline per call (`resolver.deadlineMs`) and a budget per request
  (`resolver.budgetMs`), plus a runnable example.
- **The media proxy** for streams that need upstream request headers or come as playlist text: HLS with rewritten,
  signed links and MP4 with range requests, so those headers and the upstream URLs never reach the TV;
  `proxy.always` sends every HLS and MP4 stream through it, and `proxy.alignTsSegments` repairs segments with junk
  before the first TS packet.
- **A sample catalog** of six openly licensed titles (Blender Foundation open movies and a public-domain film).
- **Self-hosting:** a guide, a sandboxed systemd unit, a Caddy example (HTTPS, unbuffered live updates, an optional
  LAN-only admin page), a Dockerfile, and `trustedProxies` so that the pairing rate limit counts each client behind
  a reverse proxy.
- **Release files:** the server package, the TV app signed with the release key, a debug APK and `SHA256SUMS`.

### Fixed

- Before the release: resolver adapter deadlines use an ordinary timer, so they also fire on Node 22 when nothing
  else keeps the process busy. The Node 22 test runs had been cancelled because of it since resolver modules were
  added; a running server was not affected, since an open request keeps Node busy.

### Compatibility

- Node.js 22.13 or newer (`node:sqlite`); tested on Node 22, 24 and 26. On Node 22 the log shows one "SQLite is an
  experimental feature" warning at start.
- The TV app needs Android 7.0 (API 24) or newer. It carries Let's Encrypt's root certificates, so a TV on 7.0 can
  reach a server behind Caddy's default certificate.

[Unreleased]: https://github.com/mickeiik/izle/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mickeiik/izle/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mickeiik/izle/releases/tag/v0.1.0
