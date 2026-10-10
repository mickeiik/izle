# izle-server API v1

Status: **draft, implemented for direct sources** (Phase 2). The proxy routes (`/p/…`) and the resolver-backed
parts arrive in Phase 4, the browser admin UI in Phase 5 (see the [roadmap](../roadmap.md)). Changes within v1 are
additive only (new optional request fields, new response fields, new routes); clients MUST ignore unknown
response fields.

## Conventions

- Base path `/api/v1`. JSON request and response bodies (`Content-Type: application/json`), request bodies ≤ 64 KiB.
- **TV routes** (`/api/v1/tv/*`) need `Authorization: Bearer <deviceToken>`; **admin routes**
  (`/api/v1/admin/*`) need `Authorization: Bearer <adminToken>`. A missing or wrong token answers `401` with a
  `WWW-Authenticate: Bearer` header. Device tokens never work on admin routes and vice versa.
- Errors: `{"error": "<code>", "message"?: "<human text>", …details}` with an HTTP status; codes are listed per
  route. `400 invalid_json`, `400 invalid_request` (with `details: [{path, message}]`), `413 body_too_large` and
  `500 internal` can happen anywhere.
- Timestamps are ISO 8601 strings; positions and durations are integer milliseconds.
- All ids are catalog ids (`^[A-Za-z0-9][A-Za-z0-9._~-]{0,119}$`) except device ids (12 alphanumeric
  characters) and playback session ids (16 alphanumeric characters).
- API responses carry `Cache-Control: no-store`. There is no CORS: the admin UI is served by the same origin.
  TLS is the reverse proxy's job; plain HTTP is fine on a LAN.
- One catalog per server in v1, but every stored reference is scoped by `catalogId`, so switching bundles never
  mixes progress.

## Authentication model

| Secret | Where it comes from | Stored as |
|---|---|---|
| Admin token | `IZLE_ADMIN_TOKEN`, else `admin.tokenFile` (created with 32 random bytes, mode 0600, on first start). Shorter than 24 characters → the server refuses to start. `izle-server admin-token [--rotate]` prints / replaces it. | the file (owner's responsibility) |
| Pair token | `POST /pair/start`, 32 random bytes base64url | sha256 |
| Device token | handed out once by `GET /pair/wait` after approval, 32 random bytes base64url | sha256 |

Tokens are compared in constant time. They never appear in logs (see [Logging](#logging)).

## Pairing

The TV shows a 6-digit code; the owner approves it from the admin API; the TV's long-poll then receives its
device token.

### `POST /api/v1/pair/start`

No body. → `200 {"code": "483920", "pairToken": "<secret>", "expiresAt": "…"}`. Codes live 10 minutes.

Errors: `429 rate_limited` (more than 10 starts per client address in 10 minutes; `Retry-After` header),
`429 too_many_pending` (5 codes are already open).

### `GET /api/v1/pair/wait?code=<6 digits>[&wait=<0..25>]`

`Authorization: Bearer <pairToken>`. Long-polls up to `wait` seconds (default 25) for the approval.

- `200 {"status": "pending"}` — not approved yet; poll again.
- `200 {"status": "approved", "deviceId": "…", "deviceToken": "<secret>"}` — **exactly once**; the TV stores the
  token. The server keeps only its hash.
- `410 {"error": "expired", "status": "expired"}` — expired or already delivered; start over.
- `404 not_found` — unknown code or wrong pair token (indistinguishable on purpose).

### `POST /api/v1/admin/pair/approve`

`{"code": "483920", "name": "Living room"}` (name 1–60 characters) → `200 {"deviceId": "…"}`. The device exists
from now on (status `pending`) and can be configured before the TV collects its token. If the code expires
uncollected, the pending device is removed.

Errors: `404 unknown_code`, `409 already_approved`.

### `GET /api/v1/admin/pair/pending`

→ `{"codes": [{"code", "createdAt", "expiresAt", "approved"}]}` — open (unexpired, undelivered) codes.

## TV API

### `GET /api/v1/tv/state`

Everything the home screen needs.

```json
{
  "version": 7,
  "device": { "id": "aZ3…", "name": "Living room", "uiLanguage": "tr", "preferredAudioLanguage": "tr", "subtitlesLanguage": null },
  "catalog": { "id": "izle-sample", "buildId": "20261010-247b34f7", "name": "izle sample catalog" },
  "home": [
    {
      "item": { "id": "caminandes", "kind": "series", "title": "Caminandes", "year": 2013, "posterUrl": "/assets/f3f9….jpg" },
      "continue": {
        "episodeId": "caminandes.s01e02", "season": 1, "number": 2, "title": "Gran Dillama", "label": null,
        "index": 1, "count": 3, "positionMs": 0, "durationMs": 146050, "status": "new"
      }
    }
  ]
}
```

- `version` is the device's state version. It increases whenever something the TV shows changes (home list,
  settings, cursor, catalog reload, a stopped/finished episode). The TV re-fetches this document when the
  `state` event announces a higher version.
- `device.*Language` are **effective** values: the device's own setting, else the server's `defaults`, else the
  catalog's `defaults` hints, else `uiLanguage: "en"` / `preferredAudioLanguage: null`. `subtitlesLanguage: null`
  means subtitles off.
- `home` is the owner's list in the owner's order (at most 12 entries). Items that vanished from the catalog or
  have no episode with `playbackAllowed` are left out.
- `posterUrl` is relative to the server's base URL (null when the item has no poster).
- `continue` is what OK plays: the item's cursor episode (see [Play order](#play-order-and-the-cursor)).
  `status`: `new` (never started), `watching` (`positionMs` is the saved position), `finished` (`positionMs` is
  0: it starts over). `index`/`count` are the position in the item's play order.

### `GET /api/v1/tv/events`

Server-sent events (`text/event-stream`, `X-Accel-Buffering: no`; reverse proxies must not buffer it).

- On connect: `event: state` with `{"version": n}` (id `s<n>`, `retry: 5000`), then every unacknowledged command
  younger than 2 minutes.
- `event: state` `{"version": n}` whenever the state version changes.
- `event: command` `{"id": 12, "type": "play", "payload": {"itemId": "…", "episodeId": "…"}}` or
  `{"id": 13, "type": "stop", "payload": {}}` (id `c<id>`). The TV acknowledges with `POST
  /tv/commands/:id/ack`; unacknowledged commands are replayed on reconnect for 2 minutes.
- A `: ping` comment every 20 seconds. The TV should treat 60 s of silence as a dead connection, reconnect with
  backoff, and additionally poll `/tv/state` every 60 s and when it comes to the foreground.

### `GET /api/v1/tv/items/:itemId`

The hidden menu's episode list, for any catalog item.

```json
{
  "item": { "id", "kind", "title", "year", "posterUrl", "originalTitle", "synopsis", "genres" },
  "cursorEpisodeId": "show.e2",
  "episodes": [
    { "id": "show.e1", "index": 0, "season": 1, "number": 1, "title": "Pilot", "label": null, "durationMs": 1200000,
      "playbackAllowed": true,
      "progress": { "positionMs": 1190000, "durationMs": 1200000, "status": "finished", "updatedAt": "…" },
      "sources": [ { "id": "tr-dub", "label": null, "languages": { "audio": ["tr"], "subtitles": [] } } ] }
  ]
}
```

Errors: `404 unknown_item`.

### `POST /api/v1/tv/resolve`

`{"episodeId": "…", "sourceId"?: "…", "exclude"?: ["sourceId", …]}` → what to play.

```json
{
  "sessionId": "Q8m…",
  "sourceId": "tr-dub",
  "media": { "kind": "hls", "url": "https://…/master.m3u8" },
  "subtitleTracks": [ { "url": "https://…/tr.vtt", "language": "tr", "format": "vtt", "label": null } ],
  "languages": { "audio": ["tr"], "subtitles": [] },
  "alternatives": ["multi", "unknown"],
  "next": { "episodeId": "show.e2", "season": 1, "number": 2, "title": "Season finale", "label": null },
  "item": { "id", "kind", "title", "year", "posterUrl" },
  "episode": { "id": "show.e1", "index": 0, "count": 5, "season": 1, "number": 1, "title": "Pilot", "label": null, "durationMs": 1200000 },
  "resume": { "positionMs": 90000, "durationMs": 1200000 }
}
```

Source selection:

1. `403 not_allowed` when the episode's `playbackAllowed` is false; `404 unknown_episode` / `unknown_source`.
2. Candidates are the episode's sources minus `exclude` (or only `sourceId` when given), in bundle order,
   stable-sorted by the device's preferred audio language: **match** (some `languages.audio` tag has the same
   primary subtag, or `audio: []` = no dialogue, or no preference) **> unknown** (`audio: null`) **> known
   mismatch**. Sources the TV reported as failing (by listing them in `exclude`) in the last 10 minutes move to
   the end.
3. Candidates are tried in order. Direct sources without upstream headers succeed immediately: their URL goes to
   the TV as-is. *This version* skips sources that need the proxy (direct media with `headers`) or a resolver
   module (`adapter` sources); both arrive in Phase 4, where header-bound or inline media comes back as a
   `/p/<session>/…` URL and upstream headers never leave the server.
4. Nothing playable → `502 no_playable_source` with `tried: [{sourceId, code}]` (`proxy_unavailable`,
   `adapter_unavailable`).

`alternatives` are the remaining playable candidates in order: on a player error the TV re-resolves with the
failed source in `exclude` and continues at the same position. `next` is the episode auto-next would start (next
`playbackAllowed` episode in play order), or null at the end of the item or when the episode (or item) has
`autoAdvance: false`. `resume` is the saved position when the episode is being watched (the TV applies its own
resume threshold), else null. `sessionId` identifies this playback in progress reports.

### `POST /api/v1/tv/progress`

`{"sessionId"?: "…", "episodeId": "…", "positionMs": 90000, "durationMs"?: 1200000, "status": "playing"}` →
`{"ok": true, "version": 8}`.

`status` is one of `playing`, `paused`, `stopped` (left the player), `finished` (ended, or stopped within the
TV's end threshold). The TV sends one every 15 s while playing and on pause, seek, stop, end and when the app
goes to the background.

- `playing`/`paused`/`stopped` save the position (status `watching`) and point the item's cursor at this episode.
- `finished` marks the episode finished and moves the cursor to the next `playbackAllowed` episode in play order
  — regardless of `autoAdvance`, which only governs automatic playback — wrapping to the first allowed episode
  after the last one.
- `stopped`, `finished` and cursor moves bump the state version; plain heartbeats do not.

Errors: `404 unknown_episode`.

### `POST /api/v1/tv/commands/:id/ack`

→ `{"ok": true}`. Errors: `404 unknown_command` (not this device's command).

## Play order and the cursor

Each device has, per item, a **cursor**: the episode OK plays. The server maintains it from progress reports
(above), and the owner can overwrite it (`PUT …/cursor`). Without a cursor, OK plays the first allowed episode
that is not finished (or the first allowed one when all are). A cursor pointing at an episode that is no longer
allowed moves to the next allowed one. Episode array order in the bundle is the play order; `season`/`number`
are display only.

## Admin API

### Devices

| Route | Body | Response |
|---|---|---|
| `GET /api/v1/admin/devices` | | `{"devices": [Device & {"homeCount"}]}` |
| `GET /api/v1/admin/devices/:id` | | `{"device": Device, "home": [{"itemId", "title", "missing", "continue"}], "homeMax": 12}` |
| `PATCH /api/v1/admin/devices/:id` | any of `name`, `uiLanguage` (`"tr"`/`"en"`/null), `preferredAudioLanguage` (tag/null), `subtitlesLanguage` (tag/null = off) | `{"device": Device}` |
| `DELETE /api/v1/admin/devices/:id` | | `204` — the TV must pair again |
| `PUT /api/v1/admin/devices/:id/home` | `{"itemIds": [...]}` (≤ 12, in display order) | `{"version", "home"}` |
| `PUT /api/v1/admin/devices/:id/cursor` | `{"itemId", "episodeId"}` | `{"version"}` |
| `GET /api/v1/admin/devices/:id/progress` | | `{"cursors": [...], "progress": [...]}` with titles |
| `GET /api/v1/admin/devices/:id/now` | | `{"online", "nowPlaying": {itemId, episodeId, sourceId, itemTitle, episodeTitle, positionMs, durationMs, state, updatedAt} \| null}` |
| `POST /api/v1/admin/devices/:id/commands` | `{"type": "play", "episodeId"}` or `{"type": "stop"}` | `202 {"id", "online"}` |

`Device` = `{"id", "name", "status": "pending"|"active", "online", "createdAt", "lastSeenAt", "stateVersion",
"settings": {stored values, null = default}, "effective": {resolved values}}`.

Home list errors: `400 too_many_items` (`max`), `duplicate_item`, `unknown_item`, `not_playable` (`itemId`).
Cursor errors: `404 unknown_item`, `400 unknown_episode` (not in this item), `400 not_allowed`; setting the cursor
also forgets that episode's saved position, so "continue from episode X" starts X from the beginning.
Command errors: `400 unknown_episode`, `400 not_allowed`. All `:id` routes answer `404 unknown_device`.

Every change that affects the TV bumps the device's state version and emits a `state` event.

### Catalog

| Route | Response |
|---|---|
| `GET /api/v1/admin/catalog` | `{"id", "buildId", "builtAt", "name", "loadedAt", "stats", "adapters", "warnings"}` |
| `GET /api/v1/admin/catalog/search?q=&limit=` | `{"items": [{"id", "kind", "title", "year", "posterUrl", "episodeCount", "playableCount"}]}` — case-, accent- and dotless-ı-insensitive match on title, original title and id; empty `q` lists everything (by title, `limit` ≤ 200, default 50) |
| `GET /api/v1/admin/catalog/items/:id` | the item with all episodes; sources as `{id, type, label, languages, kind, needsProxy}` or `{…, adapter}` — upstream URLs, headers and refs are not exposed |
| `POST /api/v1/admin/catalog/reload` | re-reads the bundle from disk: `200 {"catalog"}`, or `422 {"error": "invalid_catalog", "issues"}` and the previous catalog stays active. `SIGHUP` does the same. All devices get a new state version. |

## Static routes

| Route | |
|---|---|
| `GET /healthz` | `{"ok": true}` |
| `GET /assets/<sha256>.<jpg\|png\|webp>` | catalog posters, `Cache-Control: public, max-age=31536000, immutable` |
| `GET /admin/` | admin UI (a placeholder page until Phase 5) |
| `GET /p/:session/…` | media proxy (Phase 4) |

## Logging

One JSON object per line on stdout: `time`, `level`, `msg` and fields. Every line passes through one redaction
step: fields whose name contains a word like `url`, `headers`, `authorization`, `cookie`, `token`, `ref`,
`config`, `playlist`, `password`, `secret` or `body` are dropped; `scheme://…` in strings becomes
`<url host>`; runs of 20 or more base64url characters become `<token>`; errors are reduced to their class name
(and a short `code`). The access log records the **route template** (e.g. `/api/v1/tv/items/:itemId`), status,
duration and device id — never the raw path or query.

## Configuration

`izle-server --config izle.json` (relative paths inside resolve against the file's directory):

```json
{
  "listen": { "host": "0.0.0.0", "port": 8787 },
  "publicUrl": "https://izle.example.org",
  "dataDir": "./data",
  "catalog": { "dir": "./sample-catalog" },
  "resolver": null,
  "admin": { "tokenFile": "./data/admin.token" },
  "proxy": { "always": false, "sessionTtlSec": 21600 },
  "defaults": { "uiLanguage": "en", "preferredAudioLanguage": "en" },
  "log": { "level": "info" }
}
```

Every key is optional. Without a file the server listens on `0.0.0.0:8787`, serves the sample catalog shipped in
the repository and keeps its data in `./data` (`izle.db`, `admin.token`). Unknown keys are errors.
`resolver` and `proxy` are accepted but not used until Phase 4.
