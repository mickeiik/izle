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
- A TV connects a phone with owner access and nothing else: being in front of the TV is the security (the owner
  approved that TV at pairing), so there is no confirmation, per-TV switch or approval step. Do not add one.
- The unreleased `companion` scope is dropped by a migration (its tokens deleted, the CHECK restored) rather than by
  editing the migration that added it, so development databases that ran it open as they are.

## Command results on the TV

- Reasons beyond the spec's: `superseded` (another playback or episode step started first), `stopped` (the player was
  left before a `play` ran), `busy` (an earlier step still fetches the episode list), `episodes_unavailable` (that
  fetch failed), `background` (another app is in front: izle as the home screen stays connected there). A known type
  with an unusable payload reports `unknown_type`.
- With another app in front only `play` acts, by bringing izle back (the home app may start activities from the
  background): an owner who sends a show means it to play now, while a message or a transport command over someone
  else's app would be unseen or act on nothing. A silent update installs there too, unseen and without the idle
  wait (replacing izle does not touch the app in front); the version it installs is stored (`background_update_to`)
  so that `MY_PACKAGE_REPLACED` does not bring the new version over that app (the owner did not want the jump). No foreground service keeps a non-home izle connected: Android would
  freeze or limit it all the same, and it could not come back to play.
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
- Cards: portrait posters that open on focus (2026-10-23) replaced the 16:9 card with a cropped poster, chosen from
  prototypes over the whole poster in a wide card and a poster wall with a caption line: the open card makes the
  focus clearest. A grid row is sized to fit one open card, so only the cards after it move, never the row.

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
- TV app: one `LazyColumn` draws Home, an item a line: a grid row is a plain `Row` (a lazy grid's cell cannot widen
  for the open card), a row section a `LazyRow` slid by `HomeLayout.rowFirst`, not by bringing the focused card into
  view (it opens as it gets the focus). Section lines are drawn over the column from its layout info (a line can lie
  where no item is). ↑ ↓ ← → come from `HomeLayout`, since Compose's focus search stopped at a lazy line's first
  laid-out card.
- TV app: `:core` took only what moves without a logic edit. `EpisodeNames` stays in `:app` because it calls
  `PlaybackPlan.resumePositionMs`, and `PlaybackPlan` is TV logic (autoplay, countdown, source rotation); it moves
  when a second app needs it.

## App cards and izle as the home screen

- App cards are only in a section's `entries`, beside `itemIds` and outside `home`: a 0.6 TV reads those two and
  would meet a card it cannot draw. A `position` counts every card of the section, so one list orders both kinds.
- App cards belong to the TV, not the catalog (no `catalog_id`): the apps are on the TV, whatever bundle is loaded.
- Pictures are content-addressed and public like `/assets/`: an app's banner is not secret, and the TV uploads each
  image once for all TVs.
- izle as the home screen is a hidden-menu switch on the TV, not an owner setting: Android asks which home app to use
  on the TV itself anyway. A disabled activity carries the HOME filter, so an izle that is not chosen never makes
  Android ask.
- App pictures are kept in the database (`app_images`), not as files: `izle-server backup` then has them, and a TV
  never uploads a picture again once its report is unchanged, so a restored server could not get them back.
- An app card keeps its label and picture after the TV drops the app, so the picture stays until no report and no app
  card names it (the spec said reports only).
- `PUT …/home {"sections"}`: a deleted section's app cards go to the untitled section only when that is given with
  `itemIds`; given with `entries`, the caller set its cards exactly, so they leave Home like the section's items.
- TV app: the HOME filter is on `HomeActivity`, a no-display activity without task affinity that hands over to
  MainActivity, not on an alias of MainActivity: Android starts the home activity in its home task, so a singleTask
  MainActivity there was a second instance beside the one in front (two view models on one player and repository).
  HOME reaches MainActivity as `onNewIntent` while it is only paused (in front) or after `onStop` (another app).
- TV app: on the Android 16 TV emulator (Google's TV home screen), choosing izle as the default home app changes the
  HOME role but not HOME, which still opens Google's launcher (its HOME filter has a higher priority, which wins over
  a preferred activity); with that launcher disabled HOME, the app switch and self-updates work as specified, and the
  launcher comes back on at reboot. The row reports what HOME really opens rather than the role.
- TV app: after a self-update the system shows the task under izle, not its home screen; `MY_PACKAGE_REPLACED`
  reopens izle when it is the home screen (a background start Android 10+ allows for the home app).
- TV app: an unchanged list of apps is sent again once a day: a server that lost its pictures has no way to ask for
  them, and its answer to a report names them again. A report counts as sent once every missing picture is uploaded.
- TV app: app cards are keyed `app:<appId>` beside shows' item ids (item ids cannot hold a colon), so focus restore
  and the lazy keys need no second id space.
- Companion: an app card's picture is drawn whole in a show's poster place (36 × 54 dp, letterboxed), not cropped or
  wider: a banner cropped to a poster loses its name, and a wider picture would push the app's title off the shows'.
- Companion: Add show's **Apps** chip and the show kinds exclude each other (Apps lists the TV's apps, the kinds the
  catalog; there is no list of both), and the apps are filtered on the phone as the search text changes.
- Companion: a section entry with neither `itemId` nor `appId` (a later kind of card) is left out of the list and of
  the positions the phone sends; a Home holding such a card may get a position one off until the phone knows it.
- App cards are banner tiles, chosen by the owner from emulator prototypes (2026-10-27): a banner letterboxed in a
  portrait card read as an empty slot among posters. Tiles are two poster columns wide in a section of apps only (the
  poster's height was too big: two tiles in view) and open-card sized among shows, where a shorter centred tile broke
  the line's edges. A tile never opens; its focus ring has a dark gap so that it shows on white banners.
- Admin page: an app's picture is taken for its banner when it is wider than tall: the server keeps one PNG per app
  (banner, else icon) and does not say which, and the tile draws the two differently.
