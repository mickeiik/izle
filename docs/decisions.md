# Decision log

Choices that the code, the specs and AGENTS.md do not explain on their own: what was decided and why, a few lines
each, newest last. The earlier, longer log is in git history: `git show e7a6f7f:docs/decisions.md`.

## Cleanup pass (2026-10-15)

The owner asked for fewer lines of code, tests and docs, with no change in behaviour. They chose to delete the
roadmap, `docs/verification/` and the long log (all still in git history).
- Tests were merged into tables, and tests that re-checked what another test covers were dropped. Contract 31 → 12,
  server 142 → 132, TV 171 → 129. The redaction, upstream-header, local-loading and senior-invariant tests stay.
- Server store: one `fromRow` mapper and one private `insert` helper replace the per-table mappers. `insert` builds
  SQL from the store's own field names, never from request input. Shipped migrations are untouched.
- TV DTOs declare only the fields the app reads. Decoding stays lenient because `ignoreUnknownKeys` is set.
- Left in place: `Theme.kt`'s colour scheme (it may be dead, but only a visual check could show that). Also two
  existing admin focus losses, after "Reload from disk" and after approving a pairing code.

## Second cleanup pass (2026-10-15)

Same goal as the first, same rule (no change in behaviour); 28 554 → 27 333 tracked text lines. Tests: contract 12,
server 132 → 129, TV 129 → 126, the dropped ones covered by another test through the function the app calls.
- Exports that only tests used are private now; tests use the limits the spec documents instead of importing them.
- `Theme.kt` keeps the four colours tv-material actually reads (primary, surface, onSurface, surfaceTint).
- Left in place: `core-ktx` and `kotlinx-coroutines-android` (dropping them would lower a resolved version), the
  saved-but-unread `device_id` in `DeviceStore` (changing it changes what the TV stores), `admin-files.ts` as a file
  (the spec names it), `.dockerignore` entries for untracked local files. Response builders and fixtures now put
  several properties on one line; one commit ("response shapes and options packed onto fewer lines") carries that
  choice and can be reverted alone.

## Remote management foundation (2026-10-16)

- Migration 5 holds the whole remote-management schema (tokens, events, viewings, ranges, marks, command results),
  although this slice uses only part of it, so that the history and command slices built in parallel do not each
  claim a migration number. Saved positions are imported as viewings in SQL inside the migration.
- Events are published to stream and long-poll consumers from `Store.afterCommit` hooks, so a subscriber never hears
  of a change that rolled back, and the one `append()` call sits inside the change's transaction.
- `lastEventId` falls back to SQLite's sequence when the log is empty, so a consumer behind a purge that emptied the
  log still sees `gap: true` instead of a clean "nothing new".
- The scope table in the middleware already lists the routes of the later slices (single home changes, history
  marks), and every unlisted non-`GET` admin route needs the owner token, so a new route is never open by accident.
- `pairing.pending` has the server as its actor: the TV has no device id before the code is collected.

## Remote management: viewing history (2026-10-16)

- A TV that has not opened its event stream since the server started counts as offline since then, so the lost
  sweep's "offline for 2 minutes" rule holds from the start. A TV that reports progress without a stream loses its
  viewing after 2 minutes (the app always keeps one open); the TV's own resume and cursor are untouched.
- The pause and stall events are transitions: a second `paused` report in a row (or a repeated stall) emits
  nothing, so a consumer sees one `playback.paused` per pause.
- Played ranges are stored as the TV reports them, a consecutive report extending the previous row, and merged
  when read; the watched time is a running total on the viewing. A lost viewing's `endedAt` is its last report,
  earlier than its `playback.ended` event.
- `TitleSummary.episodes` and `seasons` count over the item's playable episodes in the current catalog (so `seen`
  never exceeds `total`); an episode that left the catalog counts only once the item itself has. `rewatches` are
  the seen viewings of an episode beyond its first, within the TV asked for; a mark is not a viewing.
- `sort=title` and the items within a day use the catalog search's collation (`byTitle` in catalog.ts).

## Remote management: commands and devices (2026-10-16)

- A replacement needs no new column: the pair code is bound to the device it replaces, and collecting it tells a
  takeover from a new TV by the device already having a token. The purge only deletes devices without one, so an
  expired replacement code never touches the device it named.
- The old TV's event streams close like a disconnect, not like a deletion, so the new TV connecting within the
  online grace keeps the device online without an offline/online flap. Its own proxy sessions end; the owner's
  Listen along sessions are left to expire.
- The single home changes rebuild the whole list and go through `setHome`, so an item already on the list that left
  the catalog blocks an addition with `unknown_item` (its `itemId` says which), as it blocks a whole-list `PUT`.
- A command result does not count as the acknowledgement: `deliveredAt` stays the ack's time (or null), as the spec
  keeps the two apart.

## Remote management, TV side (2026-10-16)

- Result reasons beyond the spec's list: `superseded` (another playback or episode step started before a `play` ran,
  or the playback changed while `next`/`previous` fetched the episode list), `stopped` (the player was left before a
  `play` ran: Back, `stop`, standby), `busy` (an earlier step is still fetching the list) and `episodes_unavailable`
  (that fetch failed: `failed`). A known type with an unusable payload reports `unknown_type`, like an unknown type.
- `play` fails with `no_playable_source` whenever its resolves end without a stream (also a 403/404 or a network
  failure), `playback_error` when the player failed or the media URL was unusable. It reports `done` at the first
  frame of any resolve of its playback, a source fallback included; Try again after `failed` sends no second result.
- The autoplay countdown's "Play now" is trigger `autoplay`: the viewer confirmed what autoplay offered.
- Try again repeats the trigger and `commandId` (the spec's trigger list had it under `viewer`; changed to match), so
  a retried remote play stays the command's in the history.
- Results are not queued behind each other (unlike progress reports): each is independent. The reporter drops a
  second result for the same command id (per server connection, last 64) as a safety net.

## TV app updates: server (2026-10-16)

- The APK's metadata is a single SQLite row (`app_apk`, `id = 1`), its bytes a content-addressed file
  `<dataDir>/app/<sha256>.apk`, written to a temp file in the same directory, synced and renamed; the old file goes
  in an after-commit hook, and a start forgets a row whose file is missing (a restored backup has only the row).
- The versionCode is derived from the asset's file name with the Gradle formula (`X·10000 + Y·100 + Z`), so the
  server never parses the APK; the name pattern keeps minor and patch below 100, as the formula needs.
- The TV's User-Agent is the version channel: every call carries it, so no new route or field is needed and an
  older app (OkHttp's default User-Agent) simply stays `unknown`. It is recorded only when it changes, re-read in
  the transaction so concurrent calls make one `device.app_version` event.
- The default source is `github` with the first check 60 s after listening: a fresh install offers the matching TV
  app without any setup, while startup and tests stay offline (tests default to `manual`). A stored APK newer than
  the latest release (an upload) is kept: the check answers `up_to_date` instead of replacing it with an older one.
- No signature check on the server: Android refuses an update not signed with the installed app's key, and the TV
  verifies size and sha256 before installing; the server checks the zip magic, the size cap and, for GitHub, the
  release's `SHA256SUMS`.
- The 64 KiB API body limit is skipped for exactly `PUT /api/v1/admin/app/apk` (matched by route template, after
  the admin token and scope are checked): an APK is megabytes, and the route streams to disk with its own 64 MiB
  cap instead of buffering.
- The schedule lives in `AppUpdateService` (started from `server.ts`, stopped in `close()`), so `GET /admin/app`
  can show `nextAt`; a scheduled check that finds one running is skipped. Release JSON larger than 1 MiB or not an
  object fails as `bad_release` (a reason beyond the agreed list).

## TV app updates: admin page (2026-10-16)

- A page of its own ("TV app") rather than per-TV controls only: the stored APK, the GitHub checks and the upload
  belong to the server, not to one TV, and the owner updating several TVs wants their versions side by side. A TV's
  page repeats its own state and Install now.
- `GET /admin/app` answering 404 means a server without TV app updates: the page says so and offers nothing, the
  TV list and a TV's page show "Unknown" and keep Install now off, instead of failing as a load error.
- Install now stays available for a TV that installs by itself and for one whose state is unknown (an older app):
  the TV answers with its own result (`up_to_date`, `busy`…), shown as a toast. It is off only for what the page
  knows for certain: no stored APK, a TV offline or not set up, or one reported up to date.
- Sizes are in powers of 1000 (`12.3 MB`), the 64 MiB cap is named in MiB where it is quoted; the upload shows no
  byte progress, because `fetch` reports none for request bodies, only "Uploading …" until the answer.

## TV app updates: TV side (2026-10-16)

- The `update` command's single result goes out, and is waited for (two tries), right before `session.commit()`:
  `done installing` (silent) or `done prompted` (guided, once OK was pressed and the archive checked out, as the
  system dialog comes up). A successful install ends the process, so nothing could be sent afterwards; install
  failures after that point only reach the owner as problem reports (`update_failure_storage`, …). On the guided
  "press OK" screen the result waits for the viewer: Back, Not now or HOME is `declined`, 60 s is `timeout`, also
  while a guided download is still running. `update` during the update screen answers `busy`, other commands
  `not_ready`.
- Capability is decided at runtime (Android 12+, the "install unknown apps" grant, no refusal yet) and re-read when
  the app comes to the front. A silent session that comes back `STATUS_PENDING_USER_ACTION` is abandoned, stored as
  `silentRefused` (the `User-Agent` says `guided` from then on) and reported as `update_needs_user_action`; a
  `MY_PACKAGE_REPLACED` clears it, so each new version tries silent once again.
- Idle means 3 minutes since the last key press, the app coming to the front or the end of playback, checked every
  30 s while in front; the same conditions are checked again after the download, right before committing. A failed
  attempt (download, check or install) and an unanswered commit hold automatic attempts back for 6 h; the command
  and the menu entry ignore that. Cancel in the system dialog is not a failure.
- No relaunch after an update on Android 10+: verified on the API 36 emulator, the install session's status intent
  (an activity `PendingIntent` for `MainActivity`) is sent by the package installer with background activity starts
  denied, so the system logs "Background activity launch blocked" and the TV shows its launcher until izle is opened
  again; `AlarmManager` sends every alarm's intent the same way, so an alarm is no way around it. The status intent
  is kept for the outcome while the app is visible (the guided path) and only counts for a session this process
  committed and still owns (session ids are random), since the activity is exported. Below Android 10 the
  `MY_PACKAGE_REPLACED` receiver starts the activity itself, which is allowed there. The deploy guide tells owners
  to keep izle first in the launcher's favourites.
- The archive's own versionCode must equal the one `/tv/app` announced (else `bad_archive`) and be newer than the
  running one (else `ignored not_newer`); `404 no_apk` during the download is `ignored up_to_date`.

## Proxy destinations and the pairing pool (security audit, 2026-10-18)

- The proxy's upstream transport is node:http(s), not `fetch`: Node's bundled undici `Agent` (needed to pin a
  connection to the vetted address with `connect.lookup`) is not exported, and the npm `undici` would be a new
  dependency whose dispatcher API must match the Node release's fetch. node:http takes a per-request `lookup`, so
  the address the policy checked is the one the socket connects to; DNS rebinding between check and connect has no
  window. Bodies are decoded like fetch (gzip, deflate, br) and the default `Accept`/`User-Agent` match fetch's.
- `proxy.privateUpstreams` entries may carry a port: the resolver example's stand-in site and its tests' internal
  servers share 127.0.0.1, and only the port tells the allowed upstream from the others.
- Approved codes do not count towards a client's 2-code cap (the owner already acted on them; several TVs approved
  before collecting behind one address must still pair); they still count towards the server-wide 10.

## Home grid and backdrops, server side (2026-10-19)

- `homeColumns`/`homeRows` have no server-wide (`defaults`) or catalog default: the right grid depends on each TV's
  screen size and viewing distance, so it is only ever a per-TV owner choice; `effective` repeats the stored value.
- The columns are plain `INTEGER NOT NULL DEFAULT` without a `CHECK`: like the other device settings, the admin API's
  schema is the only writer and holds the ranges (`HOME_COLUMNS`/`HOME_ROWS` in tv.ts, mirrored in the admin page's
  lib.js and checked against each other by a test).

## Home grid, TV app (2026-10-19)

- A card's picture falls back on its own: a backdrop that fails to load gives way to the poster, a poster that fails
  to the title drawn in the card. The picture's content description is the show's title, since the name under the
  card is outside the clickable card.
- Without a backdrop the poster is cropped to the card at a band 28 % of the way down (vertical bias −0.44), not at
  its centre: posters keep faces and titles in their upper part. The owner preferred this crop to the whole poster
  on a blurred copy of itself, which the prototype also showed.
- The "2 new" chip shows only when it fits the card's width and clears the bottom chip and bar: it gives way on
  short cards (6 columns, 4 rows, and 5 columns when a progress bar is shown).
- The scroll spec is exact, with no tolerance: Compose asks it again on every frame of the scroll, so a tolerance
  stops the scroll short by up to that much.

## Live channels: specification (2026-10-21)

The specs and the contract were written first; the server, admin page and TV app follow in later steps.
- A channel is its own kind, never a one-episode series: it has no duration, resume, play order or "seen", and
  forcing it through episodes would leak nulls into every episode path. `Playable {playbackAllowed, sources}` is
  shared by `Episode` and `LiveItem` so movies can move to item-level sources later with no new shape;
  `EpisodicItem` is a transitional name for the items that still carry episodes.
- Nothing is deployed, so the v1 contracts change in place, marked "breaking (pre-release)" in their changelogs;
  AGENTS.md and the Versioning sections carry the clause so a later pass does not undo it.
- The items schema discriminates on `kind` with an `enum` branch for movie/series (Ajv 8.20 accepts `enum` tags);
  the common property list is repeated per branch because `additionalProperties: false` rules out `allOf`.
- `year`, `rating` and `autoAdvance` are forbidden on a channel rather than ignored: a strict schema catches an
  exporter that still thinks in films. Stats gain `live` only (no `playableLive`); the warning for an unplayable
  channel mirrors the one for shows.
- The TV API names episodes by `episodeId` and channels by `itemId`, in different fields, so the two id spaces stay
  separate. The error for `itemId` naming an item played through its episodes is `has_episodes`, a statement that
  stays true after movies migrate (a movie then has none).
- `continue: null` marks a channel's home entry; a channel's progress reports carry no position, never bump the
  state version and know only `playing` and `stopped` (no pause on live). Zapping is the TV's business over its
  Home list; the server has no "next channel" notion and `next`/`previous` commands just reach the TV.
- Inline-playlist adapter results are VOD only (the proxy serves the text as given for the session); a channel's
  adapter returns a URL, which the proxy fetches anew on every request.
- Media kind `ts` (raw MPEG-TS over HTTP) for IPTV-style channels: proxied like MP4 at `stream.ts`, never played by
  the admin page's browser (Listen along marks it unsupported).
- The "Live" chip is red with white text, television's own convention, rather than a fourth hue of the chip palette.
- Until the server step lands, the server narrows its catalog type to `EpisodicItem` and refuses a bundle with a
  channel (a reload keeps the previous catalog) so that a channel is never silently dropped and every root command
  stays green; a `ts` stream counts as `unsupported` in resolve (the proxy would otherwise serve it as a playlist).
- From the spec writing: opening the hidden menu over a channel does not pause it (there is no pause on live); the
  "Live" chip stays on the smallest cards like "New"; a channel's sources SHOULD be HLS without `#EXT-X-ENDLIST`,
  dynamic DASH (`type="dynamic"`, since DASH has no end-list tag) or `ts`.
- From the server API spec: a `positionMs` sent with `play` of a channel is left out of the payload, not refused;
  `companion/resolve` on a `ts` source answers `400 unsupported_media` like DASH; `no_channel` means no channel
  after or before the playing one on the TV's Home list, which also covers a channel started remotely that is not
  on Home. The proxy problem `detail` word for `stream.ts` requests is left to the server step.

## Live channels: server (2026-10-21)

The server side of the specification above, in one change (the admin page and the TV app follow).
- `PlayableRef` (`{kind: "episode", item, episode, index} | {kind: "live", item}`) is the one value resolve, the
  viewing history, problem reports and the proxy sessions work from; `playableOf(ref)` gives the shared
  `Playable`. Stored rows and session keys carry `{itemId, episodeId | null}` rather than the episode id alone,
  because an episode id may equal an item id: the failure penalty and `PlaybackSessions.owned` match on both.
- Migration 9 rebuilds `now_playing` and `viewings` (SQLite cannot drop a `NOT NULL`), copying the rows, the
  viewing ranges and the `sqlite_sequence` entry so viewing ids never repeat; `catalog_seen_items` tracks channels
  by item id next to `catalog_seen` (its primary key is the episode id, which a channel does not have).
- The proxy problem `detail` word for `stream.ts` requests is `stream` (next to `playlist`, `segment`, `video`,
  `subtitles`); the spec's table lists it now.
- A channel's report writes now playing with null positions and `anchor: null` in `GET …/now`, and is the
  heartbeat of its viewing: watched time between consecutive reports while playing, stall and recovery events with
  `positionMs: null`, no ranges, no seeks, never seen; the 10 s drop rule and the lost sweep apply unchanged.
- `GET …/now` and `GET /admin/status` match the running viewing to the now-playing row by item and episode, since
  two channels have the same (null) episode id.
- Problem reports take `itemId` and resolve titles from the item when there is no episode; `missing` then says the
  item left the catalog. The `problem.recorded` event carries `itemId` too.
- The test fixture gained two channels (`news`, playable, with HLS and a Referer-bound `ts` source, and `off-air`,
  not playable), so every server test runs with channels in the catalog.
- The example upstream's channel view numbers live segments from the epoch (every request agrees on "now", and a
  returning player starts at the live edge), answers `stream.ts` with 200 whatever the `Range` (an endless stream
  has no byte position to go back to; the TV app should restart a live `ts` stream after an error rather than
  resume it), refuses `?delivery=inline` for a channel (`400 inline_is_vod_only`), and for real media rewrites the
  PCR/PTS/DTS and continuity counters where the loop restarts, since a raw stream has no `#EXT-X-DISCONTINUITY`.
  The looped 360p rendition is silent: the catalog's audio facts for `live-demo` describe the VOD, a known gap.
- The work ran as three batches: S1 (core, sequential) took the kind branches of history, catalog-admin, devices,
  commands, problems and viewing-summaries along, because they were needed to compile and were the feature; S2
  (diagnostics, companion, tests) and S3 (example, proxy tests) ran in parallel on disjoint files.

## Live channels: admin page (2026-10-21)

- "Show" stays the page's word for any catalog item, channels included ("9 shows (5 films, 1 series, 3 channels)",
  "Add shows"); the "Live" chip is red with white text in both themes, the page's only red chip, like the TV's.
- Pause, Resume and ±30 s are disabled rather than hidden while a channel plays, so the keyboard focus stays put; a
  hint says why. Previous/Next read "Previous channel"/"Next channel", and command reasons are looked up as
  `type:reason` first, so `no_channel` reads "after this one" for next and "before this one" for previous.
- The now-playing card reads the running viewing's start time from `GET /history/viewings/:id` once per viewing,
  because `nowPlaying` carries no `startedAt`; a channel's history page lists its latest 50 viewings from
  `/history/viewings?item=` (since `titles/:itemId` answers `episodes: []`) and leaves out the "short viewings"
  note, because short channel viewings are just zapping. A channel viewing with trigger `next` is labelled
  "CH+/CH−".
- `ts` shows as "MPEG-TS" everywhere; `viewingEnd` leaves out the position whenever `endPositionMs` is null (also an
  episode viewing that ended before its first report, which used to read "at –").
- The TVs list and the TV app page show nothing about what a TV plays, so they needed no channel wording; "Live ·
  <title>" there would be a new feature (polling `/admin/status`).

## Live channels: TV app (2026-10-21)

- Where "live" is decided: `ItemCard.isLive` (`kind == "live"`); a Home tile or a `play` command with
  `episodeId: null` becomes `PlayableRef.Channel(itemId)`, everything else `PlayableRef.Episode`; in the player the
  resolve answer's `item.kind` confirms it. `media.kind` only picks the MIME type (`ts` → `video/mp2t`).
- Zapping is computed from the latest cached home state (`ChannelZap.neighbour`: Home order, shows skipped, no
  wrap, null when the channel is not on Home) and also works while a channel is still loading, so CH+ CH+ jumps two
  channels like a real TV; the channel being left is reported `stopped`.
- Beyond the UX text: on a channel OK, Play and Play/Pause resume playback when the system paused it (lost audio
  focus, headphones unplugged), else they do nothing; a channel's information shows no play icon, just the name and
  "Live"; on a channel's error screen commands answer `not_in_player` as for shows.
- The same source is retried "once" per failure streak, and again only after it had played 60 s
  (`LIVE_STABLE_PLAYED_MS`): a stream that keeps breaking cannot loop forever. A `ts` stream never retries in
  place (ExoPlayer would Range-resume an endless response); the error reaches the app, which resolves again at the
  live edge. A clean end of a channel's stream sends no problem report; `gave_up` goes out only when every source
  failed.
- A `400` on a channel's progress report no longer switches the reporter into its old-server mode; that fallback is
  for episode reports only. `ResolveRequest` refuses both or neither of `episodeId` and `itemId`.
- The "Live" chip is `#C62828` with white text (5.6:1), 20 sp like the other chips, the same red as the admin page.

## Architecture: the playing key (2026-10-21)

- `PlayingKey`, `playingKey`, `samePlaying` and `PlayingDescription` live in `catalog.ts` next to `PlayableRef`,
  and the lookups on `CatalogService`: the key is a catalog notion (what a ref plays), not a resolve one. Two lookups
  on purpose: `catalog.playing(key)` is lenient (stored rows outlive catalogs: undefined when gone, the episode by its
  id alone), `requirePlayableRef` strict (a request body: HTTP errors, `has_episodes`).
- `describe` keeps the old sites' edges: the item still names an episode that left; a channel key is missing only
  when its item is gone, so a channel id that became a series is named by the series and not flagged (as
  `problems.list` and Listen along did). `progress` keeps its own wire form (`kind`, titles only when present).
- Partial matching stays in `PlaybackSessions.owned` (`PartialPlayingKey`): episode reports name the episode alone
  and problem reports either id, both or neither; the fields a report leaves out are taken from the session and the
  rest goes through `samePlaying`. A problem row may know an episode without its item, so `problemKey` fills the item
  from the catalog and the catalog-id check stays at `problems.list`.
- A running viewing now continues only for the same item and episode, not the same episode id alone; they differ
  only when an episode moved to another item between resolves (the row's item columns would be stale otherwise).
  The one deliberate behaviour change of the step. A viewing's title columns come from the resolved ref itself
  (`describePlayable`), never from a fresh lookup: the catalog may have been reloaded while the adapter ran.
- Left alone: `failureKey` (a map key string, already per catalog, item, episode and source); `commandBody`'s play
  branches (an item with an optional episode, not the exclusive pair the fragment builds); the episode report's
  match on the running viewing (it names the episode alone, like its session lookup; `matchesSaid` since the next
  step).

## Architecture: what a TV is playing (2026-10-21)

- The now-playing row and the running viewing are one fact written by the same two things (a resolve, a report), so
  `PlayingService` (playing.ts) owns both, with the long-poll waiters: a report is turned once into a `Report` whose
  `position` is null for a channel (the episode-or-channel decision, from `ref.kind`), the row is its projection and
  `hear` is one function from the viewing and the report to the patch, the events (in the old order: stall, seek,
  pause), the played range and the end.
- `started` and `reported` run in their own transaction, nested in the caller's when there is one (an episode report
  saves the position and the cursor first); the waiters wake through `store.afterCommit`, so a long-poll never
  answers a row that rolled back and wakes after the outer commit.
- tv.ts keeps the cursor and the saved position (Home's business: they decide what OK plays and bump the state
  version) and the HTTP answers, and computes an episode's start (the resume offered, else 0; the duration the TV last
  reported, else the catalog's), since the resume rule is Home's. `ViewingService` keeps the owner's marks and
  deletions and `VIEWING_TRIGGERS`: the owner's word on the history, not a playback event.
- `started` takes `{ref, sourceId}` and the trigger fields rather than a `ResolvedStream`: that is all it reads, and
  the tests drive it without resolving. `reported` has overloads pairing an episode's ref with an episode's report and
  a channel's with a channel's; `requirePlayableRef` gained one that types an `itemId` lookup as a `LiveRef`.
- The session and the running viewing a report names are matched by one rule, `matchesSaid` (resolve.ts, extracted
  from `PlaybackSessions.owned`): an episode report names the episode alone, a channel report the item. Sessions stay
  in resolve.ts, which opens them; problem reports keep reading them there.
- `DeviceService.now` takes the `Current` value (the route passes the waited one), so its constructor needed no
  `playing`; `playing` is on `AppContext`, not on `Services`. `running()` stays public for the HTTP tests, which now
  read `ctx.playing.running` and call `ctx.playing.sweep`.

## Architecture: the Home list (2026-10-21)

- A TV's Home list is one value, `HomeService.list` (home.ts): every entry in display order, with the item (null when
  it left the catalog), `missing`, `playable`, what OK plays (`continue`) and the new-episode count, read in three
  queries. The TV's state and the admin page are its two projections: `TvService.state` drops the missing and
  unplayable entries (the TV shows nothing it cannot play), `DeviceService.home` keeps and flags them, so the owner
  sees what a reload took away. New episodes are counted for an unplayable item too; only the admin page shows them.
- The owner's operations live with the list: `set` (with its expected-list check), `add`, `move`, `remove` (each
  rebuilds the whole list and goes through `set`) and the "continue from" override `setCursor`, so the routes call
  `ctx.home` directly. A progress report's cursor move stays in tv.ts, next to the saved position it writes;
  `HomeService.itemProgress` gives the hidden menu's item view its positions and cursor in one facts load.
- The effective settings (server defaults, then the catalog's hints) became `effectiveSettings` in devices.ts: the
  device page shows them and the TV gets them, and DeviceService was the last module that needed `tv` for them.
- The `Services` bag is gone: every module declares the deps interface it uses, and `AppContext` is the routes' view
  of the running server, every module and the settings in one flat interface (`sessions` stays on it although no
  route reads it, since it is one of the modules). server.ts still spreads one object of the built modules into each
  constructor; the types, not the call site, say what a module may use. `StartOptions` is left for a later step.
