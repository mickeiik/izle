# Decision log

Routine decisions taken while implementing the [roadmap](roadmap.md), most recent phase last. Each entry says
what was decided and why, so the owner can review choices made in unattended sessions. Where an entry deviates
from the roadmap, the entry wins until the roadmap is updated.

## Phase 0 — Bootstrap (2026-10-10)

- **Node engine floor is 22.13, not 22.5.** `node:sqlite` exists since 22.5 but needs `--experimental-sqlite`
  until 22.13, where it was unflagged. `engines.node` is `>=22.13`; CI tests 22 (latest) and 26.
- **`@types/node` is pinned to the 22.x line** so type-checking catches use of APIs newer than the engine floor.
- **TypeScript 7** (`typescript@^7.0.2`, the current npm release) is used for `typecheck` only; `tsx` runs the
  `.ts` sources directly. `erasableSyntaxOnly` is on so the sources also run under Node's native type stripping.
- **Workspace bins launch through `tsx`'s ESM API** (`bin/*.js` registers `tsx/esm/api`, then imports the `.ts`
  entry), and package `exports` point at `src/*.ts`. A `tsc` → `dist/` build for deployment is deferred to Phase 6.
- **`tsx` is a runtime dependency of each workspace package** (not a root dev dependency) because the bins need
  it at run time.
- **npm 11 `allowScripts`:** esbuild's postinstall is left unapproved; esbuild works from its platform package
  without it.
- **Android `compileSdk` is 37, `targetSdk` stays 36.** compose-bom 2026.09.00 (compose runtime 1.12) and
  core-ktx 1.19.1 refuse to build against API 36 (AAR metadata `minCompileSdk` 37). Raising only `compileSdk`
  keeps runtime behaviour at API 36 as planned.
- **AGP 9 built-in Kotlin confirmed:** `org.jetbrains.kotlin.android` is declared `apply false` at the root and
  never applied; `./gradlew buildEnvironment` shows `kotlin-gradle-plugin:2.2.10 -> 2.4.20`. The compose and
  serialization compiler plugins (2.4.20) are applied in `:app`; the hello app uses both. No
  `android.builtInKotlin=false` fallback was needed.
- **Gradle wrapper 9.8.0** (the roadmap allows 9.8.x; 9.8.0 is the version the build was validated with).
- **Library versions for the hello app:** activity-compose 1.13.0, core-ktx 1.19.1, kotlinx-serialization-json
  1.11.0 (latest stable; 1.12.0 is still RC), tv-material 1.1.0, compose-bom 2026.09.00, junit 4.13.2.
- **Hello app:** a `@Serializable` model decoded at start and shown with tv-material `Text` on a dark scheme; one
  JVM unit test so `testDebugUnitTest` has something to run in CI.
- **Banner/icon:** generated locally (ImageMagick, Noto Sans Bold) as a 320×180 xhdpi PNG banner and a vector
  icon; no third-party artwork.
- **CI action versions:** checkout v7, setup-node v7, setup-java v6 (Temurin 21), gradle/actions/setup-gradle v6,
  upload-artifact v7 (latest releases on 2026-10-10). The Android job disables the configuration cache to keep
  CI logs simple.
- **LICENSE holder** is `mickeiik` (the GitHub account); no e-mail address is written into the repository.
- **`.gitignore`** extends the roadmap list with `*.token`, `*.db*`, `/data/`, `*.apk`/`*.aab` and editor folders
  so local server data, tokens and build outputs cannot be committed by accident.
- **Roadmap scrubbing:** `docs/roadmap.md` is the approved plan minus the environment-facts section, private
  source names, private repository references and local paths; the sample-catalog table names hosting parties
  instead of repeating URLs (the URLs live in `sample-catalog/items.json`). Phase 7 is rewritten as a generic
  "private catalog exports live out of tree" note.

## Phase 1 — Contract + sample catalog (2026-10-10)

- **Bundle layout follows the contract** (`bundle.json` + `items.json` + `assets/`); the roadmap's layout sketch
  mentioned a `catalog.json`, which was a leftover.
- **`items.json` is an object `{"items": [...]}`**, not a bare array, so the file can grow optional top-level
  fields within v1.
- **Episode ids are unique across the whole bundle**, not only within their item. The TV API addresses episodes
  by `episodeId` alone (`/tv/resolve`, progress, play commands), so per-item uniqueness would be ambiguous.
  Exporters can prefix with the item id (the sample uses `<item>.film` / `<item>.s01e01`).
- **LanguageFacts semantics:** `null` = unknown, `[]` = known none; `audio: []` means "no spoken dialogue" and
  will rank as a match for every preferred audio language in Phase 2.
- **Schemas** are split into `common`, `bundle`, `items` and `resolve-result` (draft 2020-12, URN `$id`s such as
  `urn:izle:schema:items:v1`, so no fake web URLs). ajv runs with `strict: true`, `allErrors` and the
  `discriminator` keyword for the `Source` union.
- **No `ajv-formats` dependency:** `builtAt`/`expiresAt` use an ISO 8601 pattern plus a calendar check
  (`Date.parse` accepts 31 February); URLs use an `^https?://` pattern plus `new URL()` parsing.
- **Extra validator checks** beyond the roadmap list: poster bytes must match the extension (JPEG/PNG/WebP
  magic), header names must be HTTP tokens and values must not contain CR/LF, source ids unique per episode,
  `file:`/non-http URLs rejected. Warnings: unused declared adapters, items with no playable episode,
  unreferenced or > 1 MiB assets.
- **Probe output never prints full URLs** (they may be signed): only `item/episode/source`, the host, the status
  and the time. `--probe` uses `GET` with `Range: bytes=0-0` and `User-Agent: izle-validate/1`, concurrency 4,
  20 s timeout; unreachable URLs make the exit status 1. Added `--json`.
- **`resolve-result.v1.schema.json` is part of Phase 1** (it belongs to the contract); the server uses it in
  Phase 4.
- **Sample catalog media:** every URL from the roadmap, including the ones marked unverified, answered 200/206
  on 2026-10-10 and is used. Language facts were read from the HLS/DASH manifests: Tears of Steel multi-lang has
  `en`+`it` audio, the TTML variant has `de/en/fr/ru/es` subtitles, the Mux alternative's subtitles carry no
  language (`subtitles: null`); Sintel DASH has ten subtitle languages; Big Buck Bunny and Caminandes have no
  dialogue (`audio: []`).
- **Elephants Dream source order:** archive.org MP4 first, the blender.org QuickTime `.mov` (declared `kind:
  "mp4"`, since Media3's MP4 extractor reads QuickTime) second as the fallback.
- **Caminandes has one source per episode**: no second authorized host was verified.
- **No external `subtitleTracks` in the sample** (no standalone, clearly licensed subtitle files found); the
  in-stream subtitles of Tears of Steel and Sintel cover the TV feature, and tests cover `subtitleTracks` with
  fixtures.
- **Posters** come from Wikimedia Commons (CC BY 3.0 / 2.5 Blender posters and stills, public-domain *His Girl
  Friday* poster). `build.mjs` scales to cover 400×600 and crops with a per-item horizontal focus (the two
  landscape stills are cropped around their subject), JPEG q85 progressive (all ≤ 64 KB). Requires ImageMagick
  (`magick`) only when rebuilding posters.
- **`buildId` format:** `YYYYMMDD-<first 8 hex of sha256(items.json)>`, written by `build.mjs`.
- **Synopses** were written for the sample (no copied text); `NOTICE.md` lists works, authors, licenses, hosting
  parties and poster sources.

## Phase 2 — Server core (2026-10-10)

- **Config paths:** relative paths inside a config file resolve against the file's directory; a relative
  `--config` resolves against `INIT_CWD` (set by npm) or the shell's directory, so
  `npm run -w server dev -- --config server/izle.dev.json` works from the repository root as the roadmap writes
  it. Without a config file the server serves the sample catalog with `./data`. Unknown keys are errors. Added
  `log.level` and allowed `$schema`. `server/izle.dev.json` is committed (state goes to the ignored
  `server/data/`).
- **Language defaults precedence:** device setting > server `defaults` > catalog `defaults` hints > built-in
  (`uiLanguage: "en"`, `preferredAudioLanguage: null`). Server defaults are therefore nullable.
- **Admin token bootstrap:** when neither `IZLE_ADMIN_TOKEN` nor the token file exists, the server creates the
  file (32 random bytes, mode 0600) instead of refusing to start; tokens shorter than 24 characters still stop
  it. The token is never logged; `izle-server admin-token` prints it to stdout.
- **Resolver modules are not loaded yet** (Phase 4): a configured `resolver` only logs a warning. Adapter
  sources and direct sources with upstream `headers` (which need the proxy) are skipped by resolve with
  `adapter_unavailable` / `proxy_unavailable`. A bundle declaring adapters without a resolver logs a warning
  instead of refusing to start; Phase 4 enforces the check when a resolver is configured.
- **Pairing:** approval creates the device immediately (status `pending`, no token hash) so the owner can set it
  up before the TV collects its token; the device token is generated at the moment `pair/wait` delivers it, so
  the plaintext never touches the database. Unknown code and wrong pair token both answer 404; expired and
  already-delivered codes both answer 410. `pair/wait` takes `wait=<0..25>` seconds (tests use 0).
  `pair/start` allows 10 calls per 10 minutes per socket address (no `X-Forwarded-For` trust yet: behind a
  reverse proxy all TVs share the limit) and at most 5 open codes server-wide. Pending devices whose code
  expires uncollected are deleted.
- **Progress statuses** are `playing | paused | stopped | finished` (`finished` covers the roadmap's `ended`). The
  server trusts the TV's `finished` (resume/finish thresholds live in the TV's `PlaybackPlan`) and does not
  re-derive it from positions.
- **State version** bumps on home/settings/cursor changes, catalog reloads, `stopped` and `finished`, but not on
  plain `playing`/`paused` heartbeats (the TV itself is the source of those, and it re-reads state when it
  returns home).
- **Cursor rules:** after the last allowed episode is finished the cursor wraps to the first allowed episode
  (OK on a fully watched item starts it again); without a cursor OK plays the first allowed unfinished episode.
  `autoAdvance` never stops the cursor, only automatic playback.
- **Additive response fields:** `continue.status` (`new`/`watching`/`finished`, positionMs 0 when finished),
  `continue.title`/`label`; resolve also returns `item`, `episode` and `resume`; `next` carries
  season/number/title/label so the TV can label the auto-next overlay.
- **Failure penalty input:** source ids the TV lists in `exclude` are recorded as failed for 10 minutes (direct
  sources are never probed by the server).
- **Home list validation:** unknown, duplicate and non-playable items are rejected on `PUT`; items that
  disappear in a later catalog build stay stored, are hidden on the TV and flagged `missing` in the admin API.
- **Extra admin routes** (additive): `GET /admin/devices/:id`, `DELETE /admin/devices/:id`,
  `GET /admin/pair/pending`, `GET /admin/catalog`. The admin item view hides upstream URLs, headers and refs.
  `POST /admin/diagnostics/resolve` and `izle-server check-resolver` are adapter tools and move to Phase 4.
- **Commands:** play commands are validated (episode exists and is allowed); unacknowledged commands younger than
  2 minutes are replayed on every SSE connect, older ones are not (a stale "play" should not fire hours later);
  commands are purged after 7 days.
- **SSE:** event ids `s<version>` / `c<commandId>`, `retry: 5000`, `: ping` every 20 s, `X-Accel-Buffering: no`.
  `Last-Event-ID` is not needed: state events are idempotent and commands replay until acknowledged.
- **posterUrl is relative** (`/assets/<sha256>.<ext>`); the TV resolves it against its server URL, which also
  works behind reverse proxies. `publicUrl` is accepted but informational for now.
- **Ids:** device ids are 12 and playback session ids 16 random alphanumeric characters. (Base64url ids could
  start with `-`/`_`, which the id pattern rejects — found through a flaky test.)
- **Logging details:** secret keys are matched per word of the key (camelCase/snake/kebab split), so
  `preferredAudioLanguage` survives while `baseUrl`, `pairToken` or `set-cookie` are dropped; `uri`, `href`,
  `password`, `secret` and `body` were added to the roadmap's list; any `scheme://` URL is reduced to its host.
  Accepted trade-off: catalog ids containing a run of 20+ `[A-Za-z0-9_-]` characters show up as `<token>` in
  logs. `/healthz` requests are logged at debug level.
- **Database:** `home_entries`, `progress`, `item_cursor` and `now_playing` carry `catalog_id` (multi-catalog
  ready); `pair_codes.delivered_at` and `now_playing.source_id` were added; WAL mode; migrations via
  `PRAGMA user_version`. Only `node:sqlite` APIs available in Node 22.13 are used (no `isOpen`,
  `isTransaction` or `timeout` option).
- **HTTP hardening:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Cache-Control: no-store` on the API, 64 KiB request bodies. `/admin/` serves a placeholder page until
  Phase 5 and `/` redirects to it. SIGINT/SIGTERM close SSE streams and the database; SIGHUP reloads the
  catalog.
- **Still no `tsc` → `dist/` build** (Phase 6); the bin runs the TypeScript sources through tsx.

## Phase 3 — Android TV app MVP (2026-10-10)

- **Library versions** (latest stable on 2026-10-10, as pinned by the roadmap): Media3 1.11.1 (`exoplayer`,
  `exoplayer-hls`, `exoplayer-dash`, `datasource-okhttp`, `ui-compose`), OkHttp 5.5.0 + `okhttp-sse`, Coil 3.6.3
  (`coil-compose`, `coil-network-okhttp`), coroutines 1.11.0, lifecycle 2.11.0, DataStore 1.2.1;
  `mockwebserver3` 5.5.0 for tests only. No `media3-ui` (View) dependency.
- **Screens and the hidden menu:** `Screen` is `Starting | Setup | Pairing | Home | Player`; the hidden menu is
  an overlay (`MenuUi`, a stack of pages) rather than a `Screen`, so the paused video or the home tiles stay
  visible underneath and Back pops one level. Focus is trapped in the menu panel
  (`focusProperties { onExit = { cancelFocusChange() } }`) and the home tiles behind it are not focusable while
  it is open (a page that is still loading has nothing focusable). Every transition to Home goes through one
  helper that (re)starts live updates when the app is in front.
- **Key routing in `MainActivity.dispatchKeyEvent`:** OK DOWN is held back; a key repeat ≥ 600 ms after the
  press (or a release after ≥ 600 ms) opens the hidden menu and the release is swallowed; a short press is
  re-dispatched as DOWN+UP on release (Compose clicks on UP anyway, so no added latency). A release without a
  press is ignored (the launcher's OK must not start playback). In the player the activity owns ←/→/↑/↓, OK and
  the media keys; Back goes through `BackHandler` (works with predictive back on targetSdk 36).
  `adb shell input keyevent --longpress` holds only 400 ms and therefore clicks; automation uses
  `--duration 1000` or `KEYCODE_MENU`.
- **End threshold capped at 10 % of the duration** (deviation from the roadmap's plain max(2 min, 5 %)): with
  the roadmap rule every episode shorter than 2 minutes — Caminandes 1 is 90 s — counts as finished the moment it
  starts, so Back would skip it. Short episodes now finish in their last 10 %.
- **Seeking:** ←/→ move a preview target (10 s per press; while held, a step every 250 ms: 10 s, 30 s after
  2 s, 60 s after 4 s) and the player seeks once on release, which keeps progressive MP4 responsive.
- **Tile chip:** movies say New / Continue / Watch again; series name the episode OK plays ("Episode 5",
  "Season 2, Episode 5" beyond season 1, or the catalog `label`), prefixed "Continue ·" when it will resume.
  "Continue" appears only when OK really resumes (saved position ≥ 30 s), with a progress bar.
- **Home layout:** with 190×285 dp posters only one row fits on the 540 dp canvas, so the roadmap's "≤ 8 fit
  without scrolling" does not hold: ≤ 4 shows fit, more rows scroll with the focus and the second row peeks in.
  The chip is drawn on the poster (bottom gradient) to save height. Focus returns to the tile played last and
  follows a show when the owner reorders the list.
- **Hidden menu content:** Episodes only for series; Start over plays the focused show's episode from 0 (in the
  player: seek to 0); Audio language only in the player with ≥ 2 audio tracks; Audio and Subtitles choices apply
  to the current playback only (the owner's settings stay server-side). Settings → Language is a local override
  (DataStore) cycling Automatic → Türkçe → English; Automatic follows the server.
- **UI language** = local override, else the server's effective `uiLanguage`, else the system language (before
  pairing). Implemented with a `ContextWrapper` around the activity carrying localized `Resources`, provided as
  `LocalContext`, `LocalResources` (which `stringResource` reads since Compose 1.9) and `LocalConfiguration`.
- **Debug launch extra is `izle.server`** (the roadmap's verification loop name; the UX section's `server_url`
  is not used), honoured in debug builds only. Pointing at the stored server while paired does nothing; another
  address forgets the pairing and shows a pairing code.
- **Server URLs:** typed addresses get `http://` when no scheme is given and always end with `/`; server-relative
  URLs (`/assets/…`, later `/p/…`) are resolved *below* the base path, so a server behind a reverse proxy at
  `https://host/izle/` works. The device token is attached per request, never via an interceptor, so media and
  poster requests sharing the OkHttp pool cannot carry it. Token, server and cached state live in app-private
  DataStore (EncryptedSharedPreferences is deprecated; app-private storage is the TV norm).
- **Live updates:** the SSE client's 60 s read timeout is the dead-connection watchdog (server pings every 20 s);
  reconnect backoff 1 s → 30 s; a broken stream triggers an immediate `/tv/state` check so the "No connection"
  chip appears within seconds. Network errors and 5xx/408 answers both count as unreachable (behind a reverse
  proxy a stopped server answers 502). `/tv/state` is polled every 60 s (10 s while offline) regardless of SSE health,
  rather than only after three SSE failures. The last state is cached in DataStore for offline starts and
  cleared when the server or pairing changes.
- **Commands** are acted on only on Home and in the player, deduplicated by id (replays until acknowledged) and
  acknowledged right after dispatch. `play` uses the normal resume rules.
- **Progress reports** go through one ordered queue in the application scope, so a late heartbeat can never
  overwrite `finished` and the report sent when leaving the player still reaches the server after the screen
  is gone. `stopped` is only reported for a playback that actually started (reached READY). Heartbeats are best
  effort; `stopped`/`finished` are retried up to 4 times (2/4/6 s apart) and then refresh Home, and a new resolve
  waits up to 3 s for queued reports so `resume` and the cursor are current.
- **Errors:** player errors re-resolve with the failed source in `exclude` at the same position (keeping the
  viewer's pause); HTTP 403/410 after > 5 min re-resolves the same source first, again after each further
  5 min of playback. A pinned re-resolve returns no alternatives, so the TV keeps the fallback order of the
  last unpinned resolve and continues with it if the pinned source fails again. When nothing is left: the error
  screen (Try again / Home, Home after 30 s). Try again restarts at the last known position, or at the server's resume point when
  playback never started. OK while offline shows "No connection" for 5 s and triggers a refresh instead of
  resolving. 401 on any TV route forgets the token and shows a new pairing code for the same server.
- **Pairing loop:** 429 waits `Retry-After` (5–600 s), an unreachable server is retried every 10 s, 404 during
  the long-poll (server restarted) and 410 start a new code; Back goes to the server address screen. The
  one-time device token is saved non-cancellably once received, even if the screen is left at that moment.
- **Player:** one ExoPlayer per player visit (reused across episodes and fallbacks, released on exit and in
  `onStop`); `OkHttpDataSource` with `User-Agent: izle-tv/<version>`, decoder fallback, audio focus, becoming-noisy
  handling, `setMaxVideoSize(1280, 720)` in debug builds only; `ContentFrame` with a `SurfaceView`;
  `keepScreenOn` on the Compose view while loading or playing.
- **Subtitles** are drawn from `onCues` as large plain text (Media3 `ui-compose` 1.11 has no subtitle composable);
  bitmap subtitle formats are not rendered.
- **Up-next overlay is opaque** (end credits showing through the countdown hurt legibility).
- **Tests:** 49 JVM tests (`PlaybackPlan`, seek accumulator, long-press detector, chip/episode naming, URL
  handling, DTO decoding/encoding, `ApiClient`, `EventsClient` and `ServerRepository` against an in-process
  MockWebServer, `DeviceStore` on a temporary file). No instrumented tests (no device in CI); the emulator run is
  documented in `docs/verification/phase3/`. The Phase 0 hello model and test were removed.
- **Verification screenshots** are JPEG scaled to 1280×720 (≈ 1 MB for 15 instead of 13 MB of PNG).
- **Sample media on the emulator:** the blender.org `.mov` fallback of Elephants Dream (H.264 720×405) fails
  `MediaCodec.configure` on both emulator decoders; recorded in the verification notes, the catalog is unchanged
  (the archive.org source plays, the `.mov` is untested on hardware).

## Phase 4 — Resolver modules and the media proxy (2026-10-10)

- **Loader:** the default export wins over the namespace; `createAdapters` gets 30 s; adapter ids must use the
  catalog id syntax. Load failures stop the server with the module path and the error's class name only (a module's
  messages may hold URLs or keys); `check-resolver` says how to see the details (`node <module>`).
- **The logged module hash is the first 16 hex digits.** The full SHA-256 is a 64-character run that the log
  redaction turns into `<token>`; the full hash is printed by `check-resolver` and returned by
  `GET /admin/catalog` (`resolver.sha256`).
- **Missing adapters refuse the catalog only when a module is configured** (at start and on reload, as a
  `bundle.json /adapters` validation error). Without a module the Phase 2 behaviour stays: a warning, and adapter
  sources are `adapter_unavailable`. A bundle can thus be inspected and its direct sources played before the owner
  sets up the module.
- **New config keys:** `resolver.deadlineMs` (default 12 000) and `resolver.budgetMs` (30 000), so slow upstreams
  can be accommodated and tests can use short deadlines; `proxy.alignTsSegments` (default false).
- **The first servable adapter result is used; the others are ignored.** The TV's fallback works on source ids
  (`exclude`), so distinct alternatives belong in separate bundle sources. "Servable" excludes DASH with headers.
- **Failure codes** beyond the roadmap's `timeout|abort|error`: `empty` (the adapter returned `[]`), `unsupported`
  (DASH that needs headers; replaces Phase 2's `proxy_unavailable`), and the name `BudgetExhausted` for sources
  skipped once the 30 s budget is spent. Invalid results are `error` named `InvalidResult`, `NotAPlaylist` or
  `PlaylistTooLarge`. Adapter failures get the same 10-minute "move last" penalty as sources the TV excluded. A
  TV that disconnects mid-resolve (`abort`) ends the request (`503 aborted`, nobody reads it).
- **Adapters get a deep copy of `ref`**, so a module cannot change the loaded catalog.
- **Proxy URLs are signed:** a `u/` link is `<p|r>.<base64url URL>.<HMAC-SHA256 truncated to 128 bits>[.<ext>]`
  with a random key per session. Without the signature anyone holding a session token (it travels in clear on a
  LAN) could make the server fetch any URL with the owner's upstream headers. The extension is kept as a hint for
  players that infer the container from the path.
- **Links are relative** (`u/…` from the entry playlist, bare refs from playlists already under `u/`), so a server
  behind a reverse proxy under a path prefix keeps working; the entry URL the TV gets is server-relative, which the
  TV already resolves below its base URL (Phase 3).
- **Playlist or not is decided by position**, not by guessing: URIs after `#EXT-X-STREAM-INF` and in
  `EXT-X-MEDIA` / `EXT-X-I-FRAME-STREAM-INF` / `EXT-X-RENDITION-REPORT` are playlists (`p`, rewritten); everything
  else is a raw resource (`r`, streamed), except that an `r` answered with an `mpegurl` content type is still
  rewritten.
- **Entry routes:** `/p/<token>/index.m3u8`, `/p/<token>/video.mp4`, `/p/<token>/sub/<n>.<ext>` (the roadmap only
  named the HLS one). A session may have no main media when only subtitle tracks need headers.
- **Unknown or expired sessions answer 410**, not 404, so a TV that outlived a server restart re-resolves like it
  does for an expired URL. Upstream 410 also marks a session stale (with 401/403).
- **Upstream traffic:** response headers pass through an allow-list (type, length, range, validators); raw
  resources are requested with `Accept-Encoding: identity` and a compressed answer loses its `Content-Length`;
  upstream headers must arrive within 20 s, bodies then stream without a time limit (the TV's own read timeout ends
  stalled transfers, and its disconnect cancels the upstream fetch). An upstream that breaks mid-body ends the
  response like a dropped connection. Playlists are read up to 4 MiB.
- **`proxy.always` covers bundle `direct` sources too** (not only adapter URLs): it exists so the TV never contacts
  upstream hosts. DASH is never proxied (no MPD rewriting in v1) and stays direct under `proxy.always`.
- **Proxy requests are logged at debug level unless they fail** (a playing TV makes a request every few seconds).
- **`proxy.alignTsSegments` is needed and implemented (off by default).** On the emulator, Media3 1.11.1 refused
  HLS segments prefixed with 1000 junk bytes (`ParserException: Cannot find sync byte. Most likely not a Transport
  Stream`) and played them with the option on. Shorter prefixes were not measured on a device. The rule is
  format-level only: in proxied HLS segments without `Range` and without a known non-TS extension (`.m4s`, `.mp4`,
  `.aac`, `.vtt`, `.key`, …), find the first offset below 4 KiB with five 0x47 bytes 188 apart, drop what precedes
  it and label the result `video/mp2t`; otherwise pass the bytes unchanged.
- **Diagnostics** (`POST /admin/diagnostics/resolve`) test sources in bundle order (not the device's language
  ranking), take an optional `preferredAudioLanguage` for adapters, probe by default and return hosts and header
  names only. The upstream host is shown because the redacted log shows it too.
- **The example module is plain JavaScript with JSDoc types** (`// @ts-check`), so owners can copy it without a
  build step; the server's `tsconfig` now has `allowJs`/`checkJs` and includes `examples/`, which typechecks the
  example and the test fixtures against `@izle/contract`.
- **Example upstream:** a single `upstream.js` serves both the tests (synthetic in-memory files) and the emulator
  run (a directory generated by `make-media.sh`; generated media is never committed). Signed tokens live in the
  path so relative segment URIs inherit them. `--verbose` prints one line per request (token replaced by
  `<token>`). The example catalog (posters drawn with ImageMagick) has six films and one series covering signed
  HLS, inline playlists, MP4, junk-prefixed segments, a header-bound bundle source and server-side fallback; its
  config enables `alignTsSegments`, keeps state in `server/data/example/` and uses a dummy API key.
- **Test resolver:** `server/test/fixtures/test-resolver.js` re-exports the example adapters and adds a `test`
  adapter whose ref picks a hostile behaviour (hang ignoring the signal, hang honouring it, async and sync throws
  with secrets in the message, invalid results, logging secrets through `ctx.log`). No test fetches a `.test` host:
  those URLs only appear in resolve responses.
- **TV:** `/tv/resolve` now uses the 40 s client (the default read timeout is 20 s, the server's budget 30 s). The
  TV does not act on `expiresAt` yet; expired URLs are handled by the 410 → re-resolve path, verified on the
  emulator (`docs/verification/phase4/`).
