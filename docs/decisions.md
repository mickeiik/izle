# Decision log

Choices that the code, the specs, the UX docs and AGENTS.md do not explain on their own, a line or two each. Earlier
entries, and how each feature was built, are in git history.

## Left in place on purpose

- `core-ktx` and `kotlinx-coroutines-android` stay: dropping them would lower a resolved version.
- `DeviceStore` still saves the unread `device_id`: removing it changes what the TV stores.
- `admin-files.ts` stays a file of its own: the server API spec names it.
- The store's one `insert` helper builds SQL from the store's own field names, never from request input.

## Remote management

- `lastEventId` falls back to SQLite's sequence when the log is empty, so a consumer behind a purge sees `gap: true`.
- The middleware's scope table lists routes, and an unlisted non-`GET` admin route needs the owner token, so a new
  route is never open by accident.
- A TV that has not connected since the start counts as offline since then, so the lost sweep's 2-minute rule holds
  from the start (the TV's resume and cursor are untouched).
- Played ranges are stored as reported (a consecutive report extends the previous row) and merged when read; the
  watched time is a running total on the viewing.
- A replacement needs no new column: the pair code names the device it replaces, and collecting it tells a takeover
  by the device already having a token. The purge deletes only devices without one.
- The replaced TV's streams close like a disconnect, not a deletion, so the device stays online without a flap.

## Command results on the TV

- Reasons beyond the spec's: `superseded` (another playback or episode step started first), `stopped` (the player was
  left before a `play` ran), `busy` (an earlier step still fetches the episode list), `episodes_unavailable` (that
  fetch failed). A known type with an unusable payload reports `unknown_type`.
- `play` fails with `no_playable_source` whenever its resolves end without a stream (also a 403/404 or a network
  failure), `playback_error` when the player failed; `done` comes at the first frame of any resolve of its playback,
  a fallback included; Try again after `failed` sends no second result.
- The autoplay countdown's "Play now" is trigger `autoplay`. Try again repeats `commandId` too, so a retried remote
  play stays the command's in the history.
- Results are not queued behind each other (unlike progress reports); the reporter drops a second result for the
  same command id (per server connection, last 64).

## TV app updates

- The APK's metadata is one row (`app_apk`, `id = 1`), its file written to a temp file, synced and renamed; the old
  file goes in an after-commit hook. The versionCode comes from the file name, so the server never parses the APK.
- The User-Agent is the version channel: every call carries it, so no route or field was needed and an older app
  stays `unknown`. It is recorded only on change, re-read in the transaction, so concurrent calls make one event.
- The default source is `github` so that a fresh install offers the matching app without setup; startup and tests
  (which default to `manual`) stay offline.
- The 64 KiB limit is skipped for exactly `PUT /api/v1/admin/app/apk`, by route template, after token and scope.
- The admin page's own "TV app" page: the APK and checks belong to the server, and an owner wants several TVs'
  versions side by side. Install now is off only for what the page knows for certain.
- On the TV, the `update` result goes out (two tries) right before `session.commit()`: a successful install ends the
  process. A silent session answered `STATUS_PENDING_USER_ACTION` is abandoned and stored as `silentRefused` (the
  User-Agent says `guided` from then on) until `MY_PACKAGE_REPLACED`.
- The install status intent counts only for a session this process committed and owns: the activity is exported.

## Media proxy

- The upstream transport (egress.ts) is node:http(s), not `fetch`: Node's bundled undici `Agent` is not exported, and
  npm `undici` would be a dependency that must match Node's fetch; node:http takes a per-request `lookup`.
- `proxy.privateUpstreams` entries may carry a port: the resolver example's upstream and test servers share 127.0.0.1.

## Home grid and cards

- `homeColumns`/`homeRows` have no server or catalog default (the right grid depends on each screen) and no `CHECK`:
  the admin API is the only writer (`HOME_COLUMNS`/`HOME_ROWS` in home.ts, mirrored in lib.js, checked by a test).
- The owner preferred the cropped poster to the whole poster on a blurred copy of itself.

## Live channels

- A channel is its own kind, never a one-episode series: it has no duration, resume, play order or "seen", which would
  leak nulls into every episode path. `Playable {playbackAllowed, sources}` is shared by `Episode` and `LiveItem`, so
  movies can move to item-level sources later.
- The items schema repeats the common properties per `kind` branch because `additionalProperties: false` rules out
  `allOf`. `year`, `rating` and `autoAdvance` are forbidden on a channel, not ignored, to catch film-minded exporters.
- `has_episodes` stays true after movies migrate. Zapping is the TV's business over its Home list; the server has no
  "next channel". Stored rows and session keys carry `{itemId, episodeId | null}`.
- The example upstream's channel numbers live segments from the epoch (every request agrees on "now"), answers
  `stream.ts` with 200 whatever the `Range`, and rewrites PCR/PTS/DTS and continuity counters at its loop. Its loop
  is silent: the catalog's audio facts for `live-demo` describe the VOD, a known gap.
- Admin page: "Show" stays the word for any item. Pause, Resume and ±30 s are disabled rather than hidden for a
  channel, so focus stays put. A channel's history lists its latest 50 viewings without the "short viewings" note.
- TV: a `ts` stream never retries in place (ExoPlayer would Range-resume an endless response).

## Server architecture

- A running viewing's titles come from the resolved ref, not a fresh lookup: the catalog may reload meanwhile.
- Now playing and the running viewing are one fact written by a resolve or a report, so `PlayingService` owns both
  and the long-poll waiters. tv.ts keeps the cursor and saved position; `ViewingService` the marks and deletions.
- Every Home change runs one edit in one transaction, then checks it, so `expected` comes before the body's refusals.

## TV app architecture

- `MediaEngine` follows the controller's needs (load, transport, tracks, ordered main-thread events), not Media3's
  state machine; only the surface uses Media3's `Player`, so a fake exercises every rule.
- Controller tests are plain JUnit against the real API client and an in-process server, Robolectric only at Android
  boundaries; their loops run in `runTest`'s background scope so an endless heartbeat cannot stall a test's end.

## Admin page

- Catalog pages of 50 are appended ("Show more"), not numbered: Add moves the focus to the next show, which needs one
  list. "Not on this Home" is the server's (`notOnDevice`): hiding rows would give uneven pages and a wrong total.
- The browse index is built lazily once per `LoadedCatalog` object, so the load hook's order never matters. "New in
  the catalog" is chosen by build: `since` is its `loadedAt`, the stamp the history puts on what it added.
- The tabs keep their key with `history.replaceState`: a hash navigation re-renders the view and restarts its polls.
- The Home screen tab mirrors the TV app's numbers (`tvGrid`, `tvCard` in lib.js mirror HomeGrid, EpisodeNames.badge,
  tileBadgeText): change both. A mirror won over a tile grid or a board because it shows what the viewer sees.

## Home sections

- The line between sections was the owner's choice over titles alone, a lighter panel or a "More" heading; a wider
  gap than a row step read as a hole.
- `homeSections` sits beside the flat `home`, so Home order stays the one list the TV uses. `PUT …/home {"itemIds"}`
  keeps sections and deleting one keeps its shows, so an old script cannot wipe the owner's titles.
- `layout` is an enum with no table `CHECK`, so a new layout is additive and needs no rebuild. A home entry names its
  section by a composite foreign key (TV, section). A TV has no section row until its Home is first written.
- Admin page: a section chosen in the list stays chosen across refreshes until a card is selected; moves and adds made
  while a change saves are dropped, since each was computed from what the owner saw.
- TV app: one `LazyVerticalGrid` draws Home (a title spans the grid, a row section is one item holding a `LazyRow`).
  Section lines are drawn over the grid from its layout info (a line can lie where no item is, and dimming would cover
  it). ↑ ↓ ← → come from `HomeLayout`, since Compose's focus search stopped at a lazy line's first laid-out card.
- Home cards: posters that open on focus won over the whole poster in a wide card and a poster wall with a caption
  line (prototypes, 2026-10-23): the focused card is the clearest. A grid row is sized to fit one open card, so only
  the cards after it move; a grid never slides sideways.
