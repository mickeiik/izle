# Decision log

Choices that the code, the specs and AGENTS.md do not explain on their own: what was decided and why, a few lines
each. Earlier entries, and the history of how each feature was built, are in git history.

## Left in place on purpose

- `core-ktx` and `kotlinx-coroutines-android` stay: dropping them would lower a resolved version.
- `DeviceStore` still saves the unread `device_id`: removing it changes what the TV stores.
- `admin-files.ts` stays a file of its own: the server API spec names it.
- TV DTOs declare only the fields the app reads; decoding stays lenient (`ignoreUnknownKeys`).
- The store's one `insert` helper builds SQL from the store's own field names, never from request input.

## Remote management

- Events reach stream and long-poll consumers from `Store.afterCommit` hooks, so a subscriber never hears of a change
  that rolled back; the one `append()` call sits inside the change's transaction.
- `lastEventId` falls back to SQLite's sequence when the log is empty, so a consumer behind a purge that emptied the
  log still sees `gap: true` instead of a clean "nothing new".
- The scope table in the middleware lists the routes, and every unlisted non-`GET` admin route needs the owner token,
  so a new route is never open by accident.
- A TV that has not opened its event stream since the server started counts as offline since then, so the lost
  sweep's "offline for 2 minutes" rule holds from the start. The TV's own resume and cursor are untouched by it.
- Pause and stall events are transitions: a second `paused` report in a row (or a repeated stall) emits nothing.
- Played ranges are stored as the TV reports them, a consecutive report extending the previous row, and merged when
  read; the watched time is a running total on the viewing.
- `TitleSummary.episodes` and `seasons` count over the item's playable episodes in the current catalog, so `seen`
  never exceeds `total`. A mark is not a viewing, so it is no rewatch.
- A replacement needs no new column: the pair code is bound to the device it replaces, and collecting it tells a
  takeover from a new TV by the device already having a token. The purge only deletes devices without one, so an
  expired replacement code never touches the device it named.
- The replaced TV's event streams close like a disconnect, not a deletion, so the new TV connecting within the online
  grace keeps the device online without a flap.
- A command result does not count as the acknowledgement: `deliveredAt` stays the ack's time (or null).

## Command results on the TV

- Reasons beyond the spec's list: `superseded` (another playback or episode step started first), `stopped` (the
  player was left before a `play` ran), `busy` (an earlier step is still fetching the episode list) and
  `episodes_unavailable` (that fetch failed). A known type with an unusable payload reports `unknown_type`.
- `play` fails with `no_playable_source` whenever its resolves end without a stream (also a 403/404 or a network
  failure), `playback_error` when the player failed. It reports `done` at the first frame of any resolve of its
  playback, a source fallback included; Try again after `failed` sends no second result.
- The autoplay countdown's "Play now" is trigger `autoplay`: the viewer confirmed what autoplay offered. Try again
  repeats the trigger and `commandId`, so a retried remote play stays the command's in the history.
- Results are not queued behind each other (unlike progress reports). The reporter drops a second result for the
  same command id (per server connection, last 64) as a safety net.

## TV app updates

- The APK's metadata is one SQLite row (`app_apk`, `id = 1`), its bytes a content-addressed file
  `<dataDir>/app/<sha256>.apk`, written to a temp file, synced and renamed; the old file goes in an after-commit
  hook, and a start forgets a row whose file is missing (a restored backup has only the row).
- The versionCode comes from the asset's file name with the Gradle formula, so the server never parses the APK.
- The TV's User-Agent is the version channel: every call carries it, so no new route or field was needed and an older
  app simply stays `unknown`. It is recorded only when it changes, re-read in the transaction so concurrent calls make
  one `device.app_version` event.
- The default source is `github` with the first check 60 s after listening: a fresh install offers the matching TV
  app without setup, while startup and tests stay offline (tests default to `manual`).
- No signature check on the server: Android refuses an update not signed with the installed app's key, and the TV
  verifies size and sha256 before installing.
- The 64 KiB body limit is skipped for exactly `PUT /api/v1/admin/app/apk`, matched by route template after the token
  and scope are checked; the route streams to disk with its own cap.
- The admin page has a "TV app" page of its own: the stored APK and the checks belong to the server, and an owner
  updating several TVs wants their versions side by side. Install now stays available for a TV that installs by
  itself and one whose state is unknown (the TV answers with its own result); it is off only for what the page knows
  for certain. Sizes are in powers of 1000; the upload shows no byte progress because `fetch` reports none.
- On the TV, the `update` result goes out (two tries) right before `session.commit()`: a successful install ends the
  process, so nothing could be sent afterwards; later failures reach the owner as problem reports.
- A silent session that comes back `STATUS_PENDING_USER_ACTION` is abandoned and stored as `silentRefused` (the
  User-Agent says `guided` from then on); `MY_PACKAGE_REPLACED` clears it, so each new version tries silent again.
- No relaunch after an update on Android 10+: the install session's status intent is sent with background activity
  starts denied, and `AlarmManager` sends alarms the same way, so there is no way around it; the deploy guide tells
  owners to keep izle first in the launcher's favourites. The status intent only counts for a session this process
  committed and still owns, since the activity is exported. Below Android 10 the `MY_PACKAGE_REPLACED` receiver
  starts the activity itself.

## Media proxy and pairing

- The proxy's upstream transport (egress.ts) is node:http(s), not `fetch`: Node's bundled undici `Agent` is not
  exported, and the npm `undici` would be a new dependency whose API must match the Node release's fetch. node:http
  takes a per-request `lookup`, so the socket connects to the address the policy checked; DNS rebinding has no window.
- `proxy.privateUpstreams` entries may carry a port: the resolver example's stand-in site and the tests' internal
  servers share 127.0.0.1, and only the port tells them apart.
- Approved codes do not count towards a client's 2-code cap (the owner already acted on them; several TVs behind one
  address must still pair); they still count towards the server-wide 10.

## Home grid and cards

- `homeColumns`/`homeRows` have no server-wide or catalog default: the right grid depends on each TV's screen and
  viewing distance. The columns have no `CHECK`: the admin API's schema is the only writer (`HOME_COLUMNS`/`HOME_ROWS`
  in home.ts, mirrored in the admin page's lib.js and checked against each other by a test).
- Without a backdrop the poster is cropped at a band 28 % of the way down, not at its centre: posters keep faces and
  titles in their upper part. The owner preferred this to the whole poster on a blurred copy of itself.
- The scroll spec is exact, with no tolerance: Compose asks it again on every frame, so a tolerance stops the scroll
  short by up to that much.

## Live channels

- A channel is its own kind, never a one-episode series: it has no duration, resume, play order or "seen", and
  forcing it through episodes would leak nulls into every episode path. `Playable {playbackAllowed, sources}` is
  shared by `Episode` and `LiveItem` so movies can move to item-level sources later with no new shape.
- The items schema discriminates on `kind` with an `enum` branch for movie/series; the common property list is
  repeated per branch because `additionalProperties: false` rules out `allOf`.
- `year`, `rating` and `autoAdvance` are forbidden on a channel rather than ignored: a strict schema catches an
  exporter that still thinks in films.
- The error for `itemId` naming an item played through its episodes is `has_episodes`, a statement that stays true
  after movies migrate.
- Zapping is the TV's business over its Home list; the server has no "next channel" notion.
- The "Live" chip is red with white text (`#C62828`), television's own convention, on the TV and the admin page alike.
- Stored rows and session keys carry `{itemId, episodeId | null}` rather than the episode id alone, because an
  episode id may equal an item id.
- The example upstream's channel numbers live segments from the epoch (every request agrees on "now"), answers
  `stream.ts` with 200 whatever the `Range` (an endless stream has no byte position), and rewrites PCR/PTS/DTS and
  continuity counters where its loop restarts. Its looped rendition is silent: the catalog's audio facts for
  `live-demo` describe the VOD, a known gap.
- On the admin page "Show" stays the word for any catalog item, channels included. Pause, Resume and ±30 s are
  disabled rather than hidden while a channel plays, so the keyboard focus stays put. A channel's history page lists
  its latest 50 viewings and leaves out the "short viewings" note: short channel viewings are just zapping.
- On the TV the same source is retried once per failure streak, and again only after it had played 60 s
  (`LIVE_STABLE_PLAYED_MS`), so a stream that keeps breaking cannot loop forever. A `ts` stream never retries in
  place (ExoPlayer would Range-resume an endless response); the app resolves again at the live edge.
- A `400` on a channel's progress report does not switch the reporter into its old-server mode; that fallback is for
  episode reports only.

## Server architecture

- `PlayingKey` and its helpers live in catalog.ts next to `PlayableRef`: the key is a catalog notion. Two lookups on
  purpose: `catalog.playing(key)` is lenient (stored rows outlive catalogs), `requirePlayableRef` (lookup.ts) strict
  (a request body: HTTP errors, `has_episodes`).
- A running viewing continues only for the same item and episode, not the same episode id alone. Its title columns
  come from the resolved ref itself, never from a fresh lookup: the catalog may have been reloaded while the adapter
  ran.
- The now-playing row and the running viewing are one fact written by the same two things (a resolve, a report), so
  `PlayingService` owns both, with the long-poll waiters, which wake through `store.afterCommit`.
- tv.ts keeps the cursor and the saved position (they decide what OK plays and bump the state version);
  `ViewingService` keeps the owner's marks and deletions.
- A TV's Home list is one value, `HomeService.list`; the TV's state drops missing and unplayable entries, the admin
  page keeps and flags them, so the owner sees what a reload took away. Every Home change runs one edit inside one
  transaction and checks the result, so `expected` is checked before the body's own refusals.
- Every module declares the deps interface it uses; `AppContext` is the routes' flat view of the running server.
- The pre-release migration chain was collapsed into one initial schema at `user_version` 10, its last version, so a
  database made since opens as it is. One below 10 (izle 0.4.0 or earlier, or a backup of one) is refused rather than
  migrated: nothing was deployed, and keeping the chain meant testing upgrades nobody needs. Later changes append to
  `MIGRATIONS` after the schema.

## TV app architecture

- `MediaEngine` follows the controller's needs (load, transport, tracks, ordered main-thread events) rather than
  exposing Media3's state machine; only the rendering surface uses Media3's `Player` type, so a fake without a picture
  still exercises every playback rule. `MediaError` keeps the original exception, so problem reports keep the same
  class chain.
- Controller tests run plain JUnit against the real API client with an in-process server; Robolectric only at Android
  boundaries. Their loops live in `runTest`'s background scope so finishing a test cannot drain an endless heartbeat.

## Admin catalog browser

- One module (`catalog-browser.js`) serves the Catalog page and a TV's "Add shows". Pages of 50 are appended by "Show
  more" rather than numbered: Add moves the focus on to the next show, which needs one continuous list.
- The server builds the browse index once per loaded catalog, lazily, keyed on the `LoadedCatalog` object, so the
  order of the load hook and the catalog history never matters.
- "New in the catalog" is chosen by build, not by date: `since` is that build's `loadedAt`, the time the history
  stamps on what it added, so `>=` catches exactly its shows and episodes.
- "Not on this Home" is answered by the server (`notOnDevice`): hiding rows in the page would leave uneven pages and a
  wrong total, and up to 200 ids do not fit a query string well.

## A TV's admin page

- The tabs keep their key in the address with `history.replaceState`, not a hash navigation: the router renders a
  view again on every hash change, which would reload the TV and restart its polls.
- The Home screen tab draws the TV's Home from the TV app's own numbers (`tvGrid` and `tvCard` in lib.js mirror
  HomeGrid, EpisodeNames.badge and tileBadgeText): a change to the TV's grid or chips has to be made in both. A mirror
  won over a tile grid and a drag-and-drop board because it shows the owner exactly what the viewer sees.

## Home sections

- The untitled section is kept apart from a titled grid above it by a line; the owner chose it over titles alone, a
  lighter panel and a "More" heading, and asked for the boundary to take exactly the step between two rows: a wider
  gap read as a hole in the screen.
- `homeSections` sits beside the flat `home` rather than replacing it, so a TV without sections shows one grid in Home
  order, and Home order stays the one list the TV already uses.
- `PUT …/home {"itemIds"}` keeps each item's section, and deleting a section moves its shows to the untitled section:
  a script written before sections cannot wipe the owner's titles, and nothing leaves Home unless it is removed.
- `layout` is an enum rather than a boolean, so a later layout is additive; the table has no CHECK on it, so a new
  layout needs no rebuild. Each home entry names its section through a composite foreign key (TV, section), so it can
  never point at another TV's section.
- A TV has no section row until its Home is first written, and reads as the untitled section alone: one rule for
  reads, no write on pairing.
- `expected` in the `{"sections"}` form compares `title` and `layout` only when given, so a caller that tracks only
  what is on Home is not refused over a renamed section.
- Admin page: choosing a section in the list scrolls the screen without moving the selection, and it stays there
  across refreshes until a card is selected (the owner is editing that section). A title or layout edit made while
  another change is saving waits for it; moves and adds are dropped, as each was computed from what the owner saw.
- TV app: one `LazyVerticalGrid` draws all of Home (a title is an item across the grid, a row section one item
  holding a `LazyRow`), so a Home without titled sections is the same grid as before. The lines between sections are
  drawn over the grid from its layout info, since a line can lie where no item is laid out and the cards' dimming
  would cover it. ↑ ↓ ← → are handled from `HomeLayout`, not Compose's focus search, which stopped at a lazy line's
  first laid-out card. Bring-into-view works from the focused card's unscaled bounds, since the 110 % scale animates.
