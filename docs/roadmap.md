# izle roadmap

This is the project plan, copied from the approved planning document and edited for a public repository
(environment-specific facts and references to private catalogs removed). Routine decisions taken while
implementing it are recorded in [decisions.md](decisions.md); where the two differ, the decision log wins.

Status: Phases 0–4 implemented. Phase 5 is next.

## Context

The owner wants a dedicated Android TV app for a senior viewer who only knows classic TV: switch on, pick a "channel", it plays. Netflix-style browsing (seasons, episode lists, filters, categories) is removed from the senior's path. Pressing OK on a show plays the next unwatched episode or resumes the half-watched one; episodes auto-advance; Back always returns to the single home screen. Everything else exists but is hidden behind a long-press menu and, more importantly, is controllable remotely by the owner from a browser: which shows appear on the home screen, in what order, "continue from episode X", language settings.

The app lives in the repository `izle` (GitHub `mickeiik/izle`, MIT, created private, written so it can be made public). It is built around **bring-your-own-catalog**: the repo defines a versioned data-only catalog bundle contract plus a resolver (adapter) module API, and ships a sample catalog of authorized content. Owners with their own (private) catalogs export a bundle and a resolver module out of tree. The contract has to fit what such catalogs look like in practice: streams are resolved at play time (signed, expiring URLs), some playlists are Referer-bound, some sources return inline playlist text instead of a URL, per-source audio/subtitle facts may be unknown, identities must be durable, and play order / "playback allowed" must be explicit.

Owner decisions taken during planning:
- **Architecture:** thin Android TV client + self-hosted `izle-server` (Node ≥ 22.5, TypeScript). The TV app always talks to a server; there is no standalone mode. The sample catalog ships with, and is served by default by, the server.
- **Senior UX:** one screen of big poster tiles, OK plays, auto-next with a short countdown, Back returns home, hidden menu via long-press OK.
- **Scope:** plan the whole project now; implement phase by phase in later sessions.
- **License/remote:** MIT; GitHub repo `mickeiik/izle`, created private. Clean slate: no earlier design is carried over.

---

## Target repository layout

```
izle/
├── README.md  LICENSE(MIT)  AGENTS.md  .gitignore  .editorconfig
├── package.json              # npm workspaces: contract, server; root scripts: test, typecheck, sample:check
├── tsconfig.base.json        # ES2022, NodeNext, strict, allowImportingTsExtensions, noEmit (tsx runs .ts directly)
├── .github/workflows/ci.yml  # node: npm ci + typecheck + test; android: assembleDebug + testDebugUnitTest
├── docs/
│   ├── spec/catalog-bundle-v1.md      # normative text; schema lives in contract/
│   ├── spec/resolver-module-v1.md
│   ├── spec/server-api-v1.md          # TV API, admin API, pairing, proxy, SSE
│   ├── ux/senior-tv.md                # interaction principles, key map, copy in tr/en
│   └── deploy/self-hosting.md         # systemd, Caddy/HTTPS, admin token, pairing, APK install
├── contract/                 # @izle/contract — TS types, JSON Schema, validator, CLI `izle-validate <bundleDir>`
├── server/                   # @izle/server — Hono + node:sqlite; resolver loader; HLS proxy; admin static UI
│   ├── src/ … admin/ (static SPA) … examples/resolver-example/ … test/
├── sample-catalog/           # bundle.json + items.json + assets/<sha256>.<ext> + NOTICE.md (+ build.mjs to (re)generate posters)
└── android/                  # Gradle project: settings.gradle.kts, gradle/libs.versions.toml, app/
```

AGENTS.md outline: product principles (senior path = home → OK → plays; nothing else visible), hard invariants (server loads bundles/modules from local paths only — never downloads or installs; no stream URLs/headers/refs/tokens in logs; contract is versioned, additive changes only within v1; no source-specific code, fixtures or links to private repos), commands per package, how to run the emulator loop.

---

## Catalog bundle contract v1 (`contract/`)

A bundle is a directory: `bundle.json` (small manifest) + `items.json` (all items) + `assets/<sha256-of-content>.<jpg|png|webp>` (posters). Data only; no code.

```ts
// contract/src/bundle.ts — mirrored by contract/schema/{bundle,items}.v1.schema.json (draft 2020-12, additionalProperties:false,
// patternProperties "^x-" allowed for private annotations)
type Id = string;               // ^[A-Za-z0-9][A-Za-z0-9._~-]{0,119}$ — URL-path safe, durable across builds, never positional
export interface BundleManifest {
  format: "izle-bundle"; formatVersion: 1;
  catalogId: Id; buildId: string; builtAt: string /* ISO 8601 */; name: string;
  generator?: { name: string; version: string };
  defaults?: { uiLanguage?: "tr" | "en"; preferredAudioLanguage?: string };  // hints only; device settings win
  adapters: string[];           // adapter ids referenced by sources; server verifies the resolver module provides them
  items: "items.json"; assetsDir: "assets";
}
export interface CatalogItem {
  id: Id; kind: "movie" | "series";
  title: string; originalTitle?: string | null; year?: number | null;
  synopsis?: string | null; genres?: string[]; rating?: number | null;
  poster: string | null;        // "assets/<sha256>.<ext>" (content-addressed) or null
  autoAdvance?: boolean;        // item-level default (true)
  episodes: Episode[];          // ARRAY ORDER = approved play order; movie ⇒ exactly one episode
}
export interface Episode {
  id: Id;                       // unique within the item
  season?: number | null; number?: number | null; title?: string | null; label?: string | null; durationMs?: number | null;
  playbackAllowed: boolean;     // REQUIRED and explicit; false = never auto-selected, greyed in the hidden menu
  autoAdvance?: boolean;        // false = never auto-start the next episode after this one (season end / approval boundary)
  sources: Source[];            // preference order; may be empty only when playbackAllowed=false
}
export interface LanguageFacts { audio: string[] | null; subtitles: string[] | null }  // BCP 47; null = unknown
export interface SubtitleTrack { url: string; language: string; format: "vtt" | "srt" | "ttml"; label?: string }
export type Source = { id: Id /* unique within the episode */; label?: string; languages: LanguageFacts; subtitleTracks?: SubtitleTrack[] } & (
  | { type: "direct"; media: { kind: "hls" | "dash" | "mp4"; url: string; headers?: Record<string, string> } }
  | { type: "adapter"; adapter: string; ref: Record<string, unknown> }   // ref is opaque JSON for the adapter
);
```

Rules: ids never change across builds (exporters keep an identity registry; when the source catalog's own keys contain characters outside the id alphabet, such as `|`, `:` or spaces, the exporter derives ids deterministically, e.g. slug + short hash); schema is strict, new optional fields are documented in a changelog, required/semantic changes bump `formatVersion`; validator = ajv (`ajv/dist/2020`, `strict: true`) + semantic checks (unique ids, movie has one episode, poster file exists and its sha256 matches its name, every `adapter` id listed in `adapters`, `playbackAllowed:false` when `sources` is empty). CLI: `npx izle-validate <bundleDir>` (exit 1 with a readable report; `--probe` range-GETs direct URLs to detect link rot).

## Resolver module API v1 (`contract/src/resolver.ts`, implemented by owners, loaded by the server)

```ts
export const RESOLVER_API_VERSION = 1;
export interface ResolverModule { apiVersion: 1; createAdapters(ctx: AdapterContext): Adapter[] | Promise<Adapter[]> }
export interface AdapterContext { config: Record<string, unknown>; dataDir: string; fetch: typeof fetch;
  log(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void }   // redacted logger
export interface Adapter { id: string; resolve(req: ResolveRequest): Promise<ResolveResult[]>; healthcheck?(signal: AbortSignal): Promise<void> }
export interface ResolveRequest { catalogId: string; itemId: string; episodeId: string; sourceId: string; ref: Record<string, unknown>;
  preferredAudioLanguage: string | null; signal: AbortSignal; deadlineMs: number }
export interface ResolveResult {
  media: { kind: "hls" | "dash" | "mp4"; url: string } | { kind: "hls"; playlist: string; baseUrl: string };  // playlist text ≤ 2 MiB
  headers?: Record<string, string>;        // upstream request headers → server proxies, headers never reach the TV
  languages?: LanguageFacts; subtitleTracks?: Array<SubtitleTrack & { headers?: Record<string, string> }>; label?: string;
  expiresAt?: string;                      // validity hint so the client can re-resolve before expiry
}
```

Server behaviour: `await import(pathToFileURL(abs).href)`, require `apiVersion === 1`, log the module's sha256, call `createAdapters` once at startup, reject duplicate adapter ids; each `resolve` runs under `AbortSignal.any([reqSignal, AbortSignal.timeout(deadlineMs)])` (default 12 s per source, 30 s total budget), sync throws are caught, results are schema-validated (`resolve-result.v1.schema.json`), errors are reduced to `{adapterId, code: timeout|abort|error, name}` (never the message, it may contain a URL). Direct sources never touch adapters. Anything with `headers` or an inline `playlist` is served through the proxy; plain URLs go to the TV as-is (unless `proxy.always`). The module is owner-trusted in-process code; no sandbox beyond timeouts and validation (a `worker_threads` wrapper is the escape hatch if CPU-bound hangs ever appear; the contract stays the same). `izle-server check-resolver` loads the module and runs `healthcheck`. If Media3 proves intolerant of junk bytes before the first TS sync byte, add a generic off-by-default `proxy.alignTsSegments` option (format-level trim to the first 188-aligned 0x47 in the first 4 KB), never source-specific logic.

---

## Server design (`server/`, `@izle/server`)

- Stack: Node ≥ 22.5 ESM, TypeScript, **hono + @hono/node-server**, `node:sqlite`, ajv via `@izle/contract`. Dev via `tsx`, deploy via `tsc` → `dist/` (`node dist/cli.js --config izle.json`). Tests: `node:test` with the server started in-process on an ephemeral port.
- Config `izle.json`:
  ```json
  { "listen": { "host": "0.0.0.0", "port": 8787 }, "publicUrl": "https://izle.example.org",
    "dataDir": "./data", "catalog": { "dir": "./sample-catalog" },
    "resolver": null,  /* or { "module": "/opt/izle/resolver/index.js", "config": { } } */
    "admin": { "tokenFile": "./data/admin.token" },
    "proxy": { "always": false, "sessionTtlSec": 21600 },
    "defaults": { "uiLanguage": "en", "preferredAudioLanguage": "en" } }
  ```
- SQLite (`data/izle.db`):
  ```sql
  devices(id PK, name, token_hash UNIQUE, created_at, last_seen_at, ui_language, preferred_audio_language, subtitles_language NULL, state_version INT)
  pair_codes(code PK, pair_token_hash, device_id NULL, created_at, expires_at, approved_at NULL)
  home_entries(device_id, position, item_id, PRIMARY KEY(device_id, position))
  progress(device_id, episode_id, item_id, position_ms, duration_ms, status /*watching|finished*/, updated_at, PRIMARY KEY(device_id, episode_id))
  item_cursor(device_id, item_id, episode_id, updated_at, PRIMARY KEY(device_id, item_id))  -- owner override "continue from"
  commands(id PK AUTOINCREMENT, device_id, type, payload_json, created_at, acked_at NULL)
  now_playing(device_id PK, episode_id, position_ms, duration_ms, state, updated_at)
  ```
  `item_cursor` is always maintained by the server (progress heartbeats move it; `ended` marks the episode finished and advances it to the next `playbackAllowed` episode in array order) and the owner can overwrite it ("continue from episode X" = set cursor, reset that episode's position, so rewatches work). "Continue" shown on a tile = cursor episode + its saved position. Catalog items live only on disk (reloaded via admin or SIGHUP); the DB stores `(catalog_id, item_id)` references and tolerates missing items (hidden on the TV, warned in admin). v1 serves one catalog per server, but every id is scoped by `catalogId` so multi-catalog is a v2 option without API changes.
  Auth: admin token from `admin.tokenFile`/`IZLE_ADMIN_TOKEN` (≥ 24 chars or refuse to start), compared with `timingSafeEqual`; device tokens are 32 random bytes base64url with only the sha256 stored; pair codes 6 digits, 10 min TTL, ≤ 5 pending, `pair/start` rate-limited per IP, token delivered once via `pair/wait` then nulled; proxy sessions use a 32-byte token in the path. No CORS (admin UI is same-origin); TLS via reverse proxy, plain HTTP allowed on LAN.
- Routes (JSON; TV routes `Authorization: Bearer <deviceToken>`, admin routes `Bearer <adminToken>`):
  | Area | Route | Purpose |
  |---|---|---|
  | Pair | `POST /api/v1/pair/start` → `{code, pairToken, expiresAt}`; `GET /api/v1/pair/wait?code=` (long-poll ≤25 s, pairToken) → `{status, deviceToken?}` | TV shows 6-digit code |
  | Admin | `POST /api/v1/admin/pair/approve {code, name}` | owner approves TV |
  | TV | `GET /api/v1/tv/state` → `{version, device:{name, uiLanguage, preferredAudioLanguage, subtitlesLanguage}, catalog:{id, buildId, name}, home:[{item:{id,kind,title,year,posterUrl}, continue:{episodeId, season, number, index, count, positionMs, durationMs}}]}` | home screen |
  | TV | `GET /api/v1/tv/events` (SSE: `state {version}`, `command {id,type,payload}`, `: ping` every 20 s) | live updates |
  | TV | `GET /api/v1/tv/items/:itemId` → episodes with progress | hidden menu |
  | TV | `POST /api/v1/tv/resolve {episodeId, sourceId?, exclude?: string[]}` → `{sessionId, sourceId, media:{kind, url}, subtitleTracks, languages, alternatives:[sourceId], next:{episodeId, label} \| null}` (upstream headers never leave the server; header-bound media comes back as a `/p/:token/…` URL) | play |
  | TV | `POST /api/v1/tv/progress {sessionId, episodeId, positionMs, durationMs, status}`; `POST /api/v1/tv/commands/:id/ack` | heartbeat |
  | Proxy | `GET /p/:session/index.m3u8`, `GET /p/:session/u/:b64` (segments, keys, sub-playlists; streaming pass-through; forwards headers + Range) | header-bound / inline streams |
  | Static | `GET /assets/:file` (immutable cache), `GET /admin/*`, `GET /healthz` | |
  | Admin | `GET /api/v1/admin/devices`, `PATCH /api/v1/admin/devices/:id` (name, languages), `GET /api/v1/admin/catalog/search?q=`, `GET /api/v1/admin/catalog/items/:id`, `PUT /api/v1/admin/devices/:id/home {itemIds}`, `PUT /api/v1/admin/devices/:id/cursor {itemId, episodeId}`, `GET /api/v1/admin/devices/:id/progress`, `GET /api/v1/admin/devices/:id/now`, `POST /api/v1/admin/devices/:id/commands {type:"play", episodeId} \| {type:"stop"}`, `POST /api/v1/admin/catalog/reload`, `POST /api/v1/admin/diagnostics/resolve {episodeId}` (adapter smoke test, redacted output) | owner tooling |
- Every write that changes what the TV shows bumps `devices.state_version` and emits an SSE `state` event; the TV re-fetches `/tv/state`. SSE chosen over WebSocket (one-way, trivial in Hono, survives reverse proxies with buffering disabled); TV also polls every 60 s and on foreground as fallback.
- Resolve: 403 `not_allowed` when `playbackAllowed` is false; candidates = episode sources minus `exclude` (or the forced `sourceId`), in bundle order, stable-sorted by audio match (`languages.audio` contains the preferred primary subtag) > unknown (`null`) > known mismatch, with sources that failed in the last 10 min (in-memory) moved last; tried sequentially within the 30 s budget; the response carries `alternatives` (remaining source ids) and `next` (next episode per play order and `autoAdvance`) so the TV can fall back and pre-plan auto-next.
- Proxy sessions: in-memory `Map<token, {deviceId, upstream | playlistText, baseUrl, headers, kind, expiresAt (6 h sliding, 12 h max), stale}>`, ≤ 2 per device; playlist rewriting of relative/absolute URIs and `URI="…"` attributes (keys, sub-playlists, subtitle playlists) to `/p/:token/u/:b64`; segments streamed, never buffered; `Range` forwarded for mp4; upstream 401/403 marks the session stale and answers **410** so the TV re-resolves; DASH with headers is unsupported in v1 (documented: adapters return HLS/MP4 when headers are needed). Nothing persisted; a restart just forces re-resolve.
- Logging: JSON lines to stdout through one `redact()` helper: drops keys `url|headers|authorization|cookie|token|ref|config|playlist`, replaces `https?://\S+` in strings by `<url host>` and ≥ 20-char base64url runs by `<token>`; access log uses the route template (never a raw `/p/...` path), status, ms, deviceId; bodies and stacks (except at debug, post-redaction) never logged; the adapter logger is the same redacted logger; tests feed hostile fixtures and assert the output.
- Admin UI (`server/admin/`): vanilla HTML/JS single page, English only: token login (localStorage), devices list, device page = home-list editor (search catalog → add, move up/down, remove), "now playing" + progress table, "continue from" picker, language settings, play/stop command buttons, pairing approval, catalog info/reload.
- CLI: `izle-server --config izle.json`, `izle-server admin-token [--rotate]`, `izle-server validate-catalog <dir>`.

---

## Android TV app design (`android/`, package `io.github.mickeiik.izle`)

- Build: Kotlin DSL + `gradle/libs.versions.toml`. Pins: AGP 9.4.1, Kotlin 2.4.20 (+ `org.jetbrains.kotlin.plugin.compose`, `plugin.serialization`), compose-bom 2026.09.00, `androidx.tv:tv-material:1.1.0` (no deprecated `tv-foundation`; grids use Foundation `LazyVerticalGrid`), Media3 1.11.1 (`exoplayer`, `exoplayer-hls`, `exoplayer-dash`, `datasource-okhttp`, `ui-compose` for `PlayerSurface` + own overlay), OkHttp 5.5.0 + `okhttp-sse`, coil3 3.6.3 (`coil-compose`, `coil-network-okhttp`), kotlinx-serialization-json (latest stable 1.x, not the RC), coroutines 1.11.0, lifecycle-viewmodel-compose + lifecycle-runtime-compose, datastore-preferences (stable), junit4 + coroutines-test. compileSdk 37 (required by the compose BOM), targetSdk 36, **minSdk 24**. Gradle wrapper 9.8.x. JDK 21+ via `JAVA_HOME` (Android Studio's bundled JBR works; documented, not committed). **AGP 9 gotcha:** AGP 9 ships built-in Kotlin and its POM pins an older Kotlin — do not apply `org.jetbrains.kotlin.android`; declare KGP 2.4.20 `apply false` at the root to lift the classpath and verify with `./gradlew buildEnvironment` (fallback `android.builtInKotlin=false`). Validated in Phase 0 with a hello app before writing features.
- Manifest: `uses-feature leanback required=true`, `touchscreen required=false`, `INTERNET`, `ACCESS_NETWORK_STATE`, `android:banner` (320×180), single `MainActivity` (`singleTask`, landscape, `CATEGORY_LEANBACK_LAUNCHER`), `configChanges` to avoid recreation, `network_security_config` permitting cleartext (LAN servers; the emulator reaches the host at `http://10.0.2.2:8787`; internet deployments use the HTTPS reverse proxy).
- Structure: `IzleApp` (OkHttp, Coil loader, Json singletons; manual DI), `data/api/` (`ApiClient` + DTOs mirroring the server API, `EventsClient` SSE as `Flow<ServerEvent>` with backoff and a 60 s ping watchdog, polling fallback after 3 failures), `data/ServerRepository` (`StateFlow<TvState>`, refresh on `state` events, last state cached in DataStore for offline tiles), `settings/DeviceStore` (DataStore: serverUrl, deviceId, token), `domain/PlaybackPlan` (resume/next rules, pure Kotlin, unit-tested), `player/PlaybackController` (resolve → play → heartbeat → auto-next → fallback state machine around ExoPlayer: explicit `setMimeType` from `media.kind` because proxy URLs have no extension, external subtitle `SubtitleConfiguration`s, `DefaultTrackSelector.setPreferredAudioLanguages(preferred, primarySubtag)`, text disabled unless subtitles on, decoder fallback on, audio focus, `keepScreenOn`), `ui/` (`theme` with large type scale ≥ 24 sp, `pairing/`, `home/`, `player/`, `hidden/`, `common/`), one `AppViewModel` with a `Screen` sealed class (Pairing/Home/Player/Hidden; no Navigation Compose, simpler back semantics and focus control), `MainActivity` (key routing incl. long-press detection in `dispatchKeyEvent`). UI language: `CompositionLocalProvider(LocalContext provides context.createConfigurationContext(locale))` so `stringResource` follows the server-set language; `values/strings.xml` (en) + `values-tr/strings.xml`.
- Senior UX spec (`docs/ux/senior-tv.md`):
  - Home: `LazyVerticalGrid(4 columns)` of poster tiles (190×285 dp on the 960×540 dp TV canvas, 5 % safe margins; server caps the list at 12, recommend ≤ 8 so nothing scrolls), focused tile scales 1.1 with a 4 dp high-contrast border, unfocused dimmed; title 24 sp bold (2 lines) and a badge chip ("Bölüm 5", "Devam et", "Yeni" / "Episode 5", "Continue", "New"); clock top-right; hint bar bottom "OK: Oynat · Geri: Ana ekran"; first tile takes focus on entry, `focusRestorer()` (fallback manual `FocusRequester`) restores the last played tile; **BACK is consumed on Home** so the senior cannot fall out of the app (HOME is system-owned); empty list → big message "Henüz içerik yok / Nothing here yet". No other UI.
  - Player: video only. OK/Play-Pause toggles (pause shows title, episode label, progress bar, times for 4 s). Left/Right seek ±10 s (hold accelerates to ±60 s). Back → save + home. Up/Down ignored. Menu key or long-press OK → hidden menu. `STATE_ENDED` → post `ended`; if `next` exists and `autoAdvance` → overlay "Sıradaki: Bölüm 6 · 10 sn" with poster, "Şimdi oynat" focused and "Ana ekran"; Back cancels → home. No next or `autoAdvance:false` → "Bitti" 8 s → home.
  - Hidden menu (Menu key, or long-press OK: on key DOWN with `repeatCount > 0` and ≥ 600 ms held → open and swallow the trailing UP so no click fires): Bölümler (episode list, ✓ watched, ▶ current, greyed when not allowed), Baştan başlat, Ses dili, Altyazı (off by default), Ayarlar (server, UI language, re-pair), Hakkında (app version, catalog build id). Back closes.
  - First run: server address with the TV keyboard (debug default `http://10.0.2.2:8787`), then a 96 sp 6-digit pairing code waiting for admin approval while long-polling `pair/wait`; `adb shell am start … --es server_url <url>` skips typing in debug builds.
  - Resume rules (`PlaybackPlan`): resume when position ≥ 30 s and remaining > max(120 s, 5 %); resume point = position − 5 s; `finished` when remaining ≤ threshold or playback ends. Heartbeat every 15 s while playing plus on pause/seek/stop/ended/`onStop`, carrying the server's `sessionId`.
  - Errors: resolve failure → next alternative from the server; `onPlayerError` → if alternatives remain, re-resolve with `exclude` and continue from the same position silently; HTTP 403/410 after > 5 min of playback → re-resolve the *same* source first (expired URL) and seek back; all failed → full-screen "Şu anda oynatılamıyor" with poster, "Tekrar dene" focused and "Ana ekran", auto-home after 30 s. Server unreachable → cached home with a "Bağlantı yok" banner, retry every 10 s; OK shows the same message (playback needs the server). The player is released in `onStop` after posting progress; `onStart` always lands on Home.
  - Languages: UI language and preferred audio language come from the server state (owner-controlled); public builds default to the system locale / `null`, an owner's deployment can set Turkish. Subtitles off by default; when on, `setPreferredTextLanguage(uiLanguage)`.
  - Android TV gotchas to handle: `keepScreenOn` while playing; audio focus; HOME key cannot be intercepted (onStop → pause+save); emulator x86_64 decodes H.264 in software (cap debug builds at 720p via `setMaxVideoSize`, avoid HEVC, start the emulator with `-gpu swiftshader_indirect -no-snapshot`); Coil 3 needs the OkHttp network module explicitly; archive.org 302 redirects are followed by OkHttp.

---

## Sample catalog (authorized content, `sample-catalog/`)

Two sources per item where possible (exercises fallback). Re-verify the URLs when building (`npm run sample:check`).

| Item | Kind | License | Sources (direct) | Exercises |
|---|---|---|---|---|
| Tears of Steel (2012) | movie | CC-BY 3.0, Blender Foundation | HLS audio en+it (Unified Streaming demo); HLS subs de/en/fr/ru/es (Unified Streaming demo); Mux test stream | preferredAudioLanguage, subtitle tracks, fallback |
| Big Buck Bunny (2008) | movie | CC-BY 3.0, Blender Foundation | HLS (Mux test stream); DASH (Akamai demo) | HLS + DASH |
| Sintel (2010) | movie | CC-BY 3.0, Blender Foundation | DASH (Shaka demo assets); progressive MP4 (archive.org) | DASH subtitles, progressive |
| Elephants Dream (2006) | movie | CC-BY 2.5, Orange Open Movie Project | progressive (archive.org); progressive (blender.org) | progressive |
| Caminandes (2013–2016) | series, 3 episodes | CC-BY 3.0, Pablo Vázquez / Blender Institute | progressive MP4 per episode (archive.org) | auto-next, cursor, "Bölüm N" |
| His Girl Friday (1940) | movie | public domain (archive.org) | progressive MP4 (archive.org) | long-movie resume |

Exact URLs live in `sample-catalog/items.json`. Excluded: demo streams whose content is not clearly licensed for redistribution. Posters: CC-BY stills/posters from the official Blender project pages and public-domain posters from Wikimedia Commons / archive.org item images, re-encoded to JPEG ≤ 200 KB by `sample-catalog/build.mjs` into `assets/<sha256>.jpg` and committed. `NOTICE.md` lists per item the work, author, license URL and hosting party, per poster the source URL and license, and states that the bundle contains metadata and links only (demo CDNs belong to their operators). `npm run sample:check` (= `izle-validate --probe`) range-GETs every media URL (archive.org answers HEAD with 503; use GET `Range: bytes=0-0`); manual/weekly, not in CI. Automated tests never hit the network: `server/test/fixtures/` holds a synthetic bundle with local HLS (multi-audio, Referer-required upstream, inline playlist) served by an in-test `node:http` server.

---

## Phased delivery (each phase shippable and verified before the next)

**Phase 0 — Bootstrap** ✅
- Repository skeleton: README (product + BYO catalog + status), LICENSE MIT, AGENTS.md, .gitignore, .editorconfig, root `package.json` workspaces + `tsconfig.base.json`, CI skeleton (node matrix 22/26; android job with Temurin JDK 21 + `gradle/actions/setup-gradle` running `assembleDebug` and uploading the APK).
- Toolchain smoke: `server/src/main.ts` answering `/healthz`, and an Android **hello TV app** with the Leanback manifest that builds with AGP 9.4.1 + Kotlin 2.4.20 (`./gradlew buildEnvironment :app:assembleDebug`) and appears in the emulator's TV launcher — this de-risks the AGP 9 built-in Kotlin setup before Phase 3.
- This roadmap (scrubbed for a public repo) and `docs/decisions.md`, where unattended sessions record routine decisions they made.
- Private GitHub repository `mickeiik/izle`.
- Verify: `gh repo view mickeiik/izle --json visibility` → PRIVATE; `npm ci && npm test` runs; `curl localhost:8787/healthz`; hello APK installs on the TV emulator.

**Phase 1 — Contract + sample catalog** ✅
- `contract/`: types, JSON Schema, validator (`validateBundle(dir)`), CLI `izle-validate`; `docs/spec/catalog-bundle-v1.md`, `docs/spec/resolver-module-v1.md`.
- `sample-catalog/` built and validated; `NOTICE.md`; `sample:check` script.
- Tests (node:test): schema accepts the sample, rejects fixtures (duplicate ids, bad poster hash, unknown adapter, movie with 2 episodes, unknown field).
- Verify: `npm test -w contract`, `npx izle-validate sample-catalog`, `npm run sample:check`.

**Phase 2 — Server core (direct sources)** ✅
- Config loading, catalog load + validate at start, SQLite store + migrations, pairing, TV API (state/items/resolve for direct sources/progress/ack), admin API, SSE, redacted logging, CLI, `docs/spec/server-api-v1.md`.
- Tests: config parsing; pairing flow (expiry, one-shot token, rate limit); cursor/next logic (progress → ended → advance, owner override, `playbackAllowed` skipped, `autoAdvance` boundary); home list cap; resolve ordering (audio match > unknown > mismatch, exclusions, failure penalty, `not_allowed`); SSE connect/ping/version replay and event on home change; auth failures; redaction against hostile fixtures; full boot integration with the sample catalog on port 0.
- Verify: `npm test -w server`; manual `curl` flow in README.

**Phase 3 — Android TV app MVP** ✅
- Gradle project, pairing screen, home, player (resume, auto-next, heartbeat, fallback), SSE live updates, tr/en strings, hidden menu (episodes, restart, audio, subtitles, settings, about), message screens.
- Tests: JVM unit tests for `PlaybackPlan` and API models; `./gradlew :app:testDebugUnitTest`.
- Verify on the emulator against the local server with the sample catalog (loop below): pair → tiles appear → OK plays Caminandes ep1 → Back → tile says "Continue: Episode 1 · …" → finish ep1 → auto-next ep2 → admin reorders home → TV updates live → preferred audio `it` on Tears of Steel selects Italian.

**Phase 4 — Resolver module API + proxy** ✅
- Resolver loader (import, apiVersion check, deadlines, validation), proxy sessions with playlist rewriting + header forwarding + inline playlists (+ optional `ts-resync` repair), `server/examples/resolver-example/` (public example BYO module resolving against a local fixture server; used by tests), admin diagnostics endpoint.
- Tests: Referer-required upstream plays only through the proxy; inline playlist served; playlist rewriting (`URI="…"` attributes, relative resolution — implemented generically); streaming + `Range` passthrough; deadline abort with an adapter that never resolves; stale session → 410 after upstream 403; TS segment prefixed with junk bytes (decides whether `alignTsSegments` is needed); redaction of adapter errors.
- Verify: TV app plays a proxied fixture end-to-end on the emulator.

**Phase 5 — Admin UI**
- Static SPA in `server/admin/`; pairing approval, devices, home editor, now playing, cursor, settings, commands, diagnostics.
- Verify: browser against local server; optional Playwright smoke test.

**Phase 6 — Deployment & hardening**
- `docs/deploy/self-hosting.md` (systemd unit, Caddy HTTPS reverse proxy with SSE buffering off, admin token, firewall), Dockerfile (optional), GitHub Actions release on tag: `npm pack` server + debug/unsigned APK artifact; Android release signing docs; APK install via `adb install` or "Send files to TV"; optional Watch Next channel; make-public checklist (secret scan, history review).

**Phase 7 — Private catalog exports (out of tree)**
- Owners with private catalogs implement, in their own repositories: an exporter producing a bundle per `catalog-bundle-v1` with a durable identity registry, explicit play order, `playbackAllowed`, honest language facts (`audio: null` where unknown, no language-based filtering at export time); and a resolver module (`createAdapters`) with config-injected paths/keys, AbortSignal threading, and inline playlists where the upstream yields playlist text. Nothing of this lives in this repository.

---

## Verification (end-to-end loop used from Phase 3 on)

```bash
# server (from the repository root)
npm ci && npm run -w server dev -- --config server/izle.dev.json   # serves sample-catalog on :8787
# emulator (headless) + app; JAVA_HOME = a JDK 21+ (e.g. Android Studio's bundled JBR), ANDROID_HOME = the Android SDK
$ANDROID_HOME/emulator/emulator -avd <tv-avd> -no-window -no-audio -gpu swiftshader_indirect &
adb wait-for-device
cd android && ./gradlew :app:assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.github.mickeiik.izle/.MainActivity --es izle.server http://10.0.2.2:8787
adb shell input keyevent KEYCODE_DPAD_CENTER      # drive the UI; hidden menu: KEYCODE_MENU or --duration 1000 KEYCODE_DPAD_CENTER (--longpress is only 400 ms)
adb exec-out screencap -p > /tmp/izle-home.png     # inspect screenshots
```
Automated: `npm test` (contract + server), `./gradlew :app:testDebugUnitTest`, CI on every push.

## Delivery sessions

Phases are implemented in unattended coding-agent sessions whose working directory is this repository. Standing rules for every session: read this roadmap and `docs/decisions.md`; do not ask questions, make routine decisions and log them in `docs/decisions.md`; commit after each phase with its verification passing and push; never change the repository's visibility; never write private source names, private repository links or secrets into the repository; stop at the end of the assigned phase; finish with a summary.

| Session | Phases | Scope |
|---|---|---|
| S1 | 0, 1, 2 | Bootstrap (incl. private GitHub repo), contract + sample catalog, server core. Verification: `npm test`, `npx izle-validate sample-catalog`, `npm run sample:check`, curl pairing/state/resolve flow documented in README. |
| S2 | 3 | Android TV app MVP against the server; `./gradlew :app:assembleDebug :app:testDebugUnitTest`, the emulator loop above; screenshots of pairing, home, player, auto-next in `docs/verification/phase3/`. |
| S3 | 4, 5 | Resolver module API + proxy, example resolver, tests; admin UI. Verify proxied fixture playback on the emulator and the admin flows in a browser. |
| S4 | 6 | Self-hosting docs, systemd/Caddy examples, release workflow producing the server package and a debug APK. |

## Key risks and mitigations
- Demo CDNs / archive.org links for the sample can change or throttle → `sample:check` script, easy replacement, tests never depend on the network.
- Junk bytes before the first TS sync byte in some upstream sources → Media3's `TsExtractor` resynchronizes on 0x47 and likely tolerates a short prefix; verify with a fixture in Phase 4; fallback is the generic off-by-default `proxy.alignTsSegments` option (format-level, not source-specific).
- Expiring signed URLs mid-playback → proxy marks the session stale and answers 410; the TV re-resolves the same source and seeks back; adapters may return `expiresAt` for pre-emptive re-resolve.
- SSE through reverse proxies / idle timeouts → 20 s ping comments, no-buffering headers, `Last-Event-ID` resume, polling fallback.
- AGP 9 / Compose for TV churn → pin tv-material 1.1.0 + BOM, avoid `tv-foundation`, validate built-in Kotlin + compose/serialization plugins in Phase 0 before writing features.
- Long-press detection and focus restoration in Compose for TV → handle in `dispatchKeyEvent`, suppress trailing click, unit-test the key state machine.
- Emulator software decoding → ≤ 720p variants in debug; real device for 1080p.
- Senior UX regressions → BACK consumed on Home, every error path auto-returns home, no screen requires reading small text; scripted `adb` runs of the full flows in `docs/verification/`.
- Accidental leakage before going public → redaction tests, no private hosts/source names anywhere in the repo, secret scan in the Phase 6 make-public checklist.
- Hung CPU-bound adapter → deadlines cover async hangs; `worker_threads` wrapper behind the same `Adapter` interface if ever needed.
- Source catalogs whose identities are not durable → the contract requires durability; exporters add an identity registry (e.g. slug + short hash of the source keys) before the first export.
