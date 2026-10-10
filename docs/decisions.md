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
