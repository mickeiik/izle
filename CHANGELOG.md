# Changelog

What changed between izle releases (server package, TV app, admin page), in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The server, the TV app and the contract share one version
number. How to update: [self-hosting guide](docs/deploy/self-hosting.md#10-updates-and-backups).

## [Unreleased]

### Changed

- **The v1 contracts change only additively.** Since 0.6.0, the server API, the catalog bundle format and the
  resolver module API change within v1 only in the additive ways each spec lists; anything else gets a new version
  (`/api/v2`, `formatVersion: 2`, a new resolver API version). The server API spec is now marked stable and says
  what counts as additive.

### Fixed

- **Logs show catalog, item, episode and source ids and TV problem codes again.** Redaction took any run of 20 or
  more letters, digits, `-` and `_` for a token, so a build id like `20261023-78ece5b2deea`, most item and episode
  ids, adapter lists and codes like `ERROR_CODE_IO_BAD_HTTP_STATUS` or `SQLITE_CONSTRAINT_PRIMARYKEY` were logged as
  `<token>`. In their own fields (`catalogId`, `buildId`, `itemId`, `episodeId`, `sourceId`, `adapterId`, `adapters`,
  `code`, and an error's `code`) a value shaped like an id or a code is now written as given; tokens, UUIDs, URLs and
  anything else there, and ids in any other field or in nested objects, are still scrubbed.
- **A proxied segment labelled as a playlist no longer stops playback.** Some sites now and then answer a segment
  with a playlist content type (`application/x-mpegURL`); the proxy answered `502 not_a_playlist` and the TV gave up.
  It now looks at the first bytes: media (MPEG-TS, MP4/fMP4, ADTS, ID3 or other binary data) and subtitles stream
  through as the segment with a media content type, a real playlist is still rewritten, and an error page is refused
  and reported as `not_media` (a new problem code), as catalog checks call it. A body that breaks off while it is
  looked at is reported with its network error code, and one that stalls gives up after 20 s.

## [0.6.0] - 2026-10-23

### Changed

- **TV Home: portrait cards that open on focus.** Cards are shaped like posters and show the whole poster (and a
  channel's whole logo) instead of a cropped band; the focused card widens to 16:9 with the show's name and what OK
  plays in large type, over the backdrop or the blurred poster. Names no longer sit under the cards. The owner's
  columns × rows keep their meaning; the admin page's Home screen draws the same cards.
- **`POST /api/v1/admin/diagnostics/resolve` answers the deep check** (*breaking, pre-release*): `probe` is gone from
  the request and from each source, replaced by `verdict`, `steps`, `codecs`, `warnings` and `checkMs`; the answer
  gains the playable's `verdict` and `checkedAt`, and is kept as that source's last result. The admin page's "Test
  sources" is now "Check sources".

### Added

- **Catalog checks: a whole show or a TV's whole Home in one go, deeper than before.** A check follows each source the
  way the TV would fetch it, through the server's proxy when the TV gets it proxied: the playlist, every variant and
  rendition playlist, the first segment (a live playlist's last), the init segment and the AES key, a file's first
  bytes, subtitle tracks. It fails a source on what would stop the TV (a dead link, an error page instead of media,
  an address the egress policy refuses) and warns on what may (HEVC, AV1 or Dolby codecs, above 1080p, SAMPLE-AES, an
  MP4 without range requests). A pass means the server reached real media now, not that the TV can decode it.
  - Server: `POST /api/v1/admin/checks` (`{itemId}`, or `{deviceId, mode: "quick" | "full"}` for what OK plays or
    every episode of a TV's Home), `GET …/checks/current`, `GET …/checks/:id?seq=&wait=`, `DELETE …/checks/:id`,
    `GET …/checks/playables/:id?itemId=`; one run at a time, two playables at once; `check.started` and `check.finished`
    events. The last result of every source is kept until the source changes, and summarized as `check` on an
    item's episodes and a Home's entries (`checkAll` for a show's every episode).
  - Admin page: "Check all episodes" on a show's page and "Check Home…" (quick or full) on a TV's Home screen tab,
    with progress and Stop; a chip on every episode and on the selected Home card; a "Check results" list of what
    failed or warned; "Last result" shows a source's stored report without checking again.
- **The validator is a stable interface for catalog producers:** `izle-validate` and `izle-server validate-catalog`,
  their exit status and their `--json` report are documented in the
  [catalog bundle spec](docs/spec/catalog-bundle-v1.md#json-report); within v1 the report only gains fields.

## [0.5.0] - 2026-10-23

### Added

- **Admin page: a catalog browser** for a TV's "Add shows" and the Catalog page's "Shows": title search, filters
  (kind, genre, years, playable only, "new since" a build, "Not on this Home"), three orders and 50 shows at a time
  with "Show more", replacing the search that stopped at 200; the Catalog page keeps its filters in the address. API:
  `GET /api/v1/admin/catalog/search` takes the matching parameters plus `offset` and answers `total`;
  `GET /api/v1/admin/catalog` gains `facets`.
- **Sections on Home:** up to 20 titled sections in the owner's order, each a grid or a sideways-scrolling line;
  shows put on Home without a section stay in the untitled one, where every Home starts and where a deleted
  section's shows go.
  - Server: `POST`/`PATCH`/`DELETE /api/v1/admin/devices/:id/home/sections[/:sectionId]`, `sectionId` on the single
    item changes, `PUT …/home {"sections"}` (`{"itemIds"}` keeps each show's section); a TV's page and every Home
    change answer `sections`; the TV's state carries `homeSections`, with `home` in section order.
  - Admin page: the Home screen tab draws the sections as the TV does (one with nothing playable as an empty band);
    a Sections list adds, renames, reorders, deletes and makes scrolling lines; cards move within or between
    sections; "Add shows" adds to the section in "Add to"; each edit is one change, so edits made elsewhere stay.
  - TV app: section titles, a thin line between sections, the next card's edge in a scrolling line's margin; ↑ ↓ go
    line by line to the nearest card; the focus follows a card the owner moves; offline Home keeps its sections.

### Changed

- **Breaking (pre-release):** a viewing in the API no longer has `imported`, and the database starts over: a data
  directory from 0.4.0 or earlier is refused (start with an empty one and pair the TVs again).
- **Admin page:** a TV's page is split into tabs (Now playing, Home screen, Listen along, History, Settings,
  Problems with a count), kept in the address (`#/devices/<id>/settings`). Settings holds the TV app's version and
  "Install now", the TV's settings and "Forget this TV".
- **Admin page:** the Home screen tab draws the TV's Home to scale instead of a list, with further rows scrolling
  inside the screen. Select a card (or move with the arrow keys) to play it, move it, open its episodes or remove it.
  What the TV hides (missing from the catalog, not playable) is listed under the screen. The grid's columns and rows
  moved here from Settings and are previewed before "Save grid".
- **TV app:** the chips on Home's cards are smaller (16 sp, was 20 sp); Home scrolls more smoothly (the row beyond
  each edge is prepared ahead, dimmed cards need no extra layer, a chip's label is measured once per screen).
- **TV app:** release builds are shrunk and optimized by R8 (class names are kept, so problem reports read the same).

### Fixed

- **Admin page:** a Home list with a missing or unplayable show could not be edited at all ("That show is not in the
  catalog (any more)."); only the shows a change adds are checked now.
- **TV app:** on a channel's "Can't play right now", CH+/CH−, |◀◀ ▶▶| and the owner's `next`/`previous` now switch
  channels as they do while a channel plays.

## [0.4.0] - 2026-10-21

### Added

- **Home grid size per TV:** 3–6 columns and 1–4 rows per screen (default 4 × 2), set on the admin page, applied live
  (`homeColumns`/`homeRows`).
- **Landscape pictures:** an optional 16:9 `backdrop` per catalog item (additive to bundle v1, checked by
  `izle-validate`), sent as `backdropUrl` and shown on the TV's cards.
- **Live channels** (`kind: live`): in the contract and `izle-validate`, on Home, resolved and reported by item id
  (heartbeats without a position), in viewings (when and how long, never "seen"), problem reports, the catalog
  history, the admin catalog and remote commands (pause, resume and seek answer `live`, next and previous zap).
  - Admin page: "Live" chips with the start time, Previous/Next channel with pause and seek disabled, a channel's
    catalog page (sources, Test sources, Play on), channel counts, a channel's history; Listen along does not cover
    channels.
  - TV app: a red "Live" chip ("Canlı"), OK plays at the live edge (autoplay offers "Live"), CH+/CH− and |◀◀ ▶▶| zap
    through Home's channels without wrapping, no pause or seek, a hidden menu of Audio language and Subtitles; a
    broken stream restarts at the live edge, then tries other sources, then shows "Can't play right now".
- **Media kind `ts`** (progressive MPEG-TS, IPTV-style, meant for channels): played by the TV, proxied like MP4 when
  it needs headers (`/p/<token>/stream.ts`), shown as MPEG-TS and unsupported in Listen along.

### Changed

- **Breaking (pre-release), in place:** a v1 catalog item is a union by `kind`; `ResolveRequest.episodeId` is null for
  a channel; adapters' inline playlists are VOD only.
- **The Docker image uses Node 26** (was 24); CI builds it and checks startup, the admin page and a restart, offline.
- **The TV's Home is a grid of wide cards** filling the screen, names in full under the cards, scrolling a row at a
  time with a scroll bar, a poster crop without a landscape picture, smaller chips (20 sp), no clock or hint; the
  owner's message and "No connection" are drawn over the grid.
- **Home holds up to 200 shows** (was 12; `homeMax`).

## [0.3.0] - 2026-10-18

### Added

- **TV app updates:** the server offers one APK to its TVs, fetched from the latest GitHub release (verified against
  `SHA256SUMS`; config `appUpdates`) or uploaded, with an `update` command, each TV's app version and capability, and
  `app.*`/`device.app_version` events. The admin page's "TV app" page and a TV's page show versions, checks, Check
  now, Remove, upload and Install now, with the outcome as a toast. Android 12+ TVs update silently when idle;
  older ones on the command, through a "New version — press OK" screen; never during playback; "Install update" in
  the hidden menu, availability in About; the `User-Agent` names app, Android version and capability.
- **The admin page follows the TVs live** from the event log; a toast says what the TV made of a remote command.
- **Viewing history** (`/api/v1/admin/history/*`): every playback of an episode as a viewing, outliving the TV and the
  catalog, with played ranges, per-title status, watched time per day, the owner's marks and deletions, the trigger
  of each playback and `playback.*`/`episode.seen`/`history.changed` events; a History tab, and a TV's viewings.
- **Access tokens** scoped `read`, `control` or `manage` (admin page "Access", `/api/v1/admin/tokens`,
  `izle-server token create|list|revoke`), with `403 insufficient_scope`; every change records its `actor`.
- **`GET /api/v1/admin/status`** (every TV, the catalog, pending codes, the latest event id) and an **event log**
  (`events.retentionDays`) as a stream and a long-poll, with filters and a `gap` marker.
- **Remote play of any show at any position** (`play` with `itemId` and `positionMs`; "Play on" on a catalog page),
  and **command results** from the TV (`done`, `ignored`, `failed` with a reason; `GET …/commands/:commandId`,
  `command.result`).
- **Single home list changes** (`POST`/`PATCH`/`DELETE …/home/items…`; `expected` and `409 home_changed` on `PUT`).
- **Replacing a TV at pairing** ("Replaces", `replaces`), and adopting a deleted TV's history.
- **Remote control:** CH+/CH− and media next/previous switch episodes; the admin page pauses, resumes, seeks, skips
  episodes and shows a message on the TV.
- **Autoplay when the TV starts** (per TV, off by default) after a 10-second countdown.
- **Problem reports** from the TV and the server, on the TV's admin page and flagged in the TV list.
- **`izle-server backup <file>`**, a consistent copy while the service runs.
- **New episodes on Home** ("2 new", `newEpisodes`), and OK resumes a finished show at its first new episode.
- **Catalog build history** (added and removed shows and episodes per build, a baseline) on the Catalog tab and in the
  API (`builds`, `…/catalog/builds/<buildId>`).
- **Shell and guide:** `izle-server pair pending|approve`, `admin-token --link` (a sign-in link and QR code), a
  passphrase as admin token, and publishing catalog builds through a `current` symlink, also from a host job.
- Compose UI tests for the senior-path rules; this changelog, a [security policy](SECURITY.md), pinned GitHub Actions
  and Dependabot. The TV app ran on a real Android TV box.

### Changed

- **Online for a minute after a TV's event stream closed**, everywhere, so a reconnect does not flap.
- **Approving a TV needs no name** ("TV", "TV 2", …).
- **The TV's pairing screen shows the admin page's address**, and the admin page the address to type on the TV.
- **Failed admin sign-ins are throttled** per client address (10 per 10 minutes; behind a proxy set `trustedProxies`).
- **Streams with an expiry are refreshed a minute before it.**
- **The admin page's look:** one main action per card, red outlines on destructive buttons, a busy state, stronger
  contrast, a phone-sized header, screen-reader labels; a TV's page gets a sticky section bar and a state badge;
  "Add shows" searches as you type; a film's page lists its sources directly.
- **The TV's look:** one set of colours, margins and shapes within the 5 % safe area, one button and focus style,
  countdown bars on one shared layout for Up next, autoplay, "Can't play right now" ("Home in 30 s") and "The end";
  on Home the owner's message beside the clock, clearer chips ("2 new"), a solid red "No connection", a fading
  further row and the hint "OK: Play".

### Fixed

- **Admin page:** keeps focus and half-typed text across refreshes, stops refreshing pages you left (and jumping to
  the TV list from them), and says when the server cannot be reached instead of "Loading…" or "not in the catalog".
- **TV app:** the clock follows the TV's 12/24-hour setting and changes language at once; CH+/CH− outside the player
  no longer open the TV's Live TV app.
- **Server:** a failed catalog reload (SIGHUP) logs `catalog reload failed` instead of ending the process.

### Security

- **Tokenless requests no longer count toward the admin sign-in lockout** (another site could lock the owner out).
- **Revoking an access token ends the event stream it has open.**
- **The admin event stream is bounded:** a replay of at most 500 events, slow readers disconnected, at most 10 streams
  per token or address (`429 too_many_streams`).
- **Per-address limits count an IPv6 client by its /64**, at a fixed cost per request, tracking at most 50,000.
- **Rewritten playlists stay in bounds** (`502 playlist_too_large` past 250,000 lines, 16 MiB or a 4096-character URI).
- **`admin-token --rotate` refuses while `IZLE_ADMIN_TOKEN` is set**, the server warns when the variable shadows the
  token file, and the guide keeps the token out of the unit's `Environment=`.
- **Log redaction catches more** (protocol-relative URLs, playlist text, long error names); the resolver spec says
  what modules must never log.
- **The media proxy no longer reaches into the server's own network** (`502 egress_denied`, redirects checked,
  credential headers only to the session's origin). **An upstream on this machine or your LAN** must be listed in the
  new `proxy.privateUpstreams`.
- **One client can no longer keep every TV from pairing** (2 waiting codes per address, 10 in all,
  `429 too_many_pending`); unexpected codes can be cleared (**Clear**, `pair cancel`, `DELETE …/pair/pending/:code`).

### Compatibility

- **Database migrations 3 to 7**; an older server refuses the migrated database (restore the backup to go back).
  Update the server before the TVs; a 0.2.0 app ignores commands it does not know.

## [0.2.0] - 2026-10-11

### Added

- **Listen along:** the owner's phone plays another source of the episode a TV shows (a dub, another audio language)
  in sync, through the server's proxy, following pauses, seeks and episode changes, also with an Android phone's
  screen off; an offset and speed saved per episode and source (copyable to the show's other episodes) and a
  per-phone correction ([server API § Listen along](docs/spec/server-api-v1.md#listen-along)).

### Changed

- The admin page's CSP adds `media-src 'self' blob:`, and the page carries a pinned hls.js 1.7.3 (Apache-2.0), loaded
  only when the browser cannot play HLS itself.

### Compatibility

- Update the server before the TVs (a 0.1.0 server rejects a 0.2.0 TV's new progress fields; the app resends without
  them). **Database migration 2:** to go back, restore the backup.

## [0.1.0] - 2026-10-10

The first release: everything needed to run izle at home with your own catalog.

### Added

- **izle-server**, one dependency-free package: pairing with 6-digit codes, each TV's home list, progress, play
  order, languages, play and stop commands, live updates, SQLite state, a log without URLs, headers or tokens;
  `admin-token`, `validate-catalog`, `check-resolver`, `--version`; SIGHUP reloads the catalog.
- **The Android TV app**, English and Turkish: one home screen of poster tiles, OK plays or resumes, "Up next", Back
  always home, source fallback, errors end on Home, "No connection" offline, a hidden menu (Menu key or hold OK).
- **The admin page** at `/admin/`: pairing, each TV's home list, "continue from", languages, now playing with Stop,
  recently watched, forget the TV, the catalog with "Reload from disk" and a source test; strict CSP, phone-friendly.
- **Bring your own catalog:** the catalog bundle contract v1 with `izle-validate` (`@izle/contract`), and the resolver
  module API v1 with a runnable example.
- **The media proxy** for streams needing upstream headers or given as playlist text; `proxy.always`,
  `proxy.alignTsSegments`.
- **A sample catalog** of six openly licensed titles.
- **Self-hosting:** a guide, a sandboxed systemd unit, a Caddy example, a Dockerfile, `trustedProxies`; release files
  (server package, release-signed and debug APKs, `SHA256SUMS`).

### Fixed

- Before the release: resolver adapter deadlines also fire on Node 22 when nothing else keeps the process busy.

### Compatibility

- Node.js 22.13 or newer (`node:sqlite`), tested on 22, 24 and 26. The TV app needs Android 7.0 (API 24)+ and carries
  Let's Encrypt's roots.

[Unreleased]: https://github.com/mickeiik/izle/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/mickeiik/izle/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mickeiik/izle/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mickeiik/izle/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mickeiik/izle/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mickeiik/izle/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mickeiik/izle/releases/tag/v0.1.0
