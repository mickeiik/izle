# izle-server API v1

Status: **stable** (API version 1). Within v1 only additive changes are allowed, recorded in the
[changelog](#changelog): new optional request fields, new response fields, new routes, new error codes, and new values
where this text says clients ignore unknown ones (TV and admin event types, command types, actor types, a home
section's `layout`). Clients MUST ignore unknown response fields and handle an unknown error code by its HTTP status.
Anything else (a removed or renamed field, a changed meaning, a new required request field, a new value anywhere
else) needs a new API version under `/api/v2`. Up to and including izle 0.6.0, the first deployment, v1 changed in
place, marked **breaking (pre-release)** in the changelog; since then it does not.

## Conventions

- Base path `/api/v1`. JSON request and response bodies, requests ≤ 64 KiB (except the APK upload,
  [`PUT /admin/app/apk`](#tv-app), which streams up to 64 MiB).
- **TV routes** (`/api/v1/tv/*`) need `Authorization: Bearer <deviceToken>`, **admin routes** (`/api/v1/admin/*`) the
  admin token or an [access token](#access-tokens); neither works on the other's routes. A missing or wrong token
  answers `401 unauthorized` with `WWW-Authenticate: Bearer` (on admin routes `429` after repeated failures, see
  [Authentication model](#authentication-model)).
- Errors: `{"error": "<code>", "message"?, …details}` with an HTTP status; codes are listed per route. Anywhere:
  `400 invalid_json`, `400 invalid_request` (with `details: [{path, message}]`; also for unknown request fields, which
  every route refuses), `404 not_found` (no such route), `413 body_too_large`, `500 internal`.
- Timestamps are ISO 8601 strings; positions and durations are integer milliseconds.
- All ids are catalog ids (`^[A-Za-z0-9][A-Za-z0-9._~-]{0,119}$`) except device ids (12 alphanumeric characters) and
  playback session ids (16). Episodes are addressed by episode id, channels by item id; the two id spaces are
  separate (an episode id may equal an item id), so the field (`episodeId` or `itemId`) says which one is meant.
- A **channel** (a catalog item of kind `live`) has no episodes, cursor, saved position or duration, is never
  "seen" and always plays at its live edge: response fields that describe an episode or a position (`episodeId`,
  `episodeTitle`, `season`, `number`, `positionMs`, `durationMs`, `startPositionMs`, `endPositionMs`) are null for it.
- Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
  `X-Frame-Options: DENY`; API responses also `Cache-Control: no-store`. No CORS: the admin UI is served by the same
  origin. TLS is the reverse proxy's job; plain HTTP is fine on a LAN.
- One catalog per server in v1; every stored reference is scoped by `catalogId`, so switching bundles mixes nothing.

## Authentication model

| Secret | Where it comes from | Stored as |
|---|---|---|
| Admin token | `IZLE_ADMIN_TOKEN`, else `admin.tokenFile` (created with 32 random bytes, mode 0600, on first start). Shorter than 24 characters → the server refuses to start. `izle-server admin-token [--rotate]` prints / replaces it (`--rotate` is refused while `IZLE_ADMIN_TOKEN` is set, and the server warns at startup when the variable shadows a token file); `--link` prints a sign-in link for the admin page (`<base>/admin/#token=<token>`, the token in the URL fragment, which browsers never send) and its QR code. | the file (owner's responsibility) |
| Pair token | `POST /pair/start`, 32 random bytes base64url | sha256 |
| Device token | handed out once by `GET /pair/wait` after approval, 32 random bytes base64url | sha256 |

The admin and pair tokens are compared in constant time; device and access tokens are looked up by their hash.
No token is ever logged ([Logging](#logging)).

Failed admin authentications (a wrong or revoked token on `/api/v1/admin/*`) are counted per client address
([`trustedProxies`](#configuration); an IPv6 address by its /64): after 10 within 10 minutes of the first, every admin
request from that address, even with the right token, answers `429 too_many_attempts` with `Retry-After` until those
10 minutes are over. Successes and requests without a token are never counted (so tokenless requests that another
site's page sends from the owner's browser cannot lock the owner out). Each failure is logged as a warning with the
client address and the route template. TV routes and pairing are not affected.

## Pairing

The TV shows a 6-digit code; the owner approves it; the TV's long-poll then receives its device token.

### `POST /api/v1/pair/start`

No body. → `200 {"code": "483920", "pairToken": "<secret>", "expiresAt": "…"}`; codes live 10 minutes. Errors:
`429 rate_limited` (more than 10 starts per client address, an IPv6 one by its /64, in 10 minutes; `Retry-After`),
`429 too_many_pending` with `Retry-After` (seconds until the earliest of those codes expires): this client address
already has 2 codes waiting for approval, or 10 codes are open server-wide; `503 busy` (no free code found). A start
never ends another code (clients sharing an address pair one after the other); each remembers its address's hash.

### `GET /api/v1/pair/wait?code=<6 digits>[&wait=<0..25>]`

`Authorization: Bearer <pairToken>`. Long-polls up to `wait` seconds (default 25) for the approval.

- `200 {"status": "pending"}`: not approved yet; poll again.
- `200 {"status": "approved", "deviceId": "…", "deviceToken": "<secret>"}`: **exactly once** (only its hash is kept).
- `410 {"error": "expired", "status": "expired"}`: expired or already delivered; start over.
- `404 not_found`: unknown code or wrong pair token (indistinguishable on purpose); `401` without a pair token,
  `400 invalid_request` for a malformed `code` or `wait`.

### `POST /api/v1/admin/pair/approve`

`{"code": "483920", "name"?: "Living room"}` (1–60 characters; without a name the TV is called `TV`, or the first
free `TV 2`, `TV 3`, …) → `200 {"deviceId": "…", "name": "…"}`. The device exists from now on (status `pending`)
and can be configured before the TV collects its token; if the code expires uncollected, it is removed. Errors:
`404 unknown_code`, `409 already_approved`. `izle-server pair approve <code> [name…]` calls this route on the running
server, `pair pending` and `pair cancel <code>` the next two.

### `GET /api/v1/admin/pair/pending`

→ `{"codes": [{"code", "createdAt", "expiresAt", "approved"}]}`: open (unexpired, undelivered) codes.

### `DELETE /api/v1/admin/pair/pending/:code`

Owner only. Clears an open code that none of the owner's TVs shows → `204`: the code expires now (its `pair/wait`
answers `410`, so a TV that showed it asks for a new one) and can no longer be approved. A device approved on it that
never collected its token is deleted; a TV it was to [replace](#replacing-a-tv) stays as it is. Event
`pairing.cancelled`. Errors: `404 unknown_code` (no open code with this value).

## TV API

**User-Agent.** The TV app names itself on every API call: `izle-tv/<versionName> (Android <sdkInt>;
<versionCode>; silent|guided)`, e.g. `izle-tv/0.2.0 (Android 25; 200; guided)`; `silent`: the TV can install an
update by itself (Android 12+, API 31), `guided`: the viewer has to confirm Android's install screen. The server
matches it strictly
(`^izle-tv\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) \(Android (\d{1,3}); (\d{1,9}); (silent|guided)\)$`, at most 200
characters) and records a change for the device ([`Device.app`](#devices), event `device.app_version`); anything
else (an older app sends OkHttp's default) is ignored without an error.

### `GET /api/v1/tv/state`

Everything the home screen needs:

```json
{
  "version": 7,
  "device": { "id": "aZ3…", "name": "Living room", "uiLanguage": "tr", "preferredAudioLanguage": "tr",
              "subtitlesLanguage": null, "autoplayOnStart": false, "homeColumns": 4, "homeRows": 2 },
  "catalog": { "id": "izle-sample", "buildId": "20261010-247b34f7", "name": "izle sample catalog" },
  "home": [
    { "item": { "id": "caminandes", "kind": "series", "title": "Caminandes", "year": 2013,
                "posterUrl": "/assets/f3f9….jpg", "backdropUrl": null },
      "continue": { "episodeId": "caminandes.s01e02", "season": 1, "number": 2, "title": "Gran Dillama", "label": null,
                    "index": 1, "count": 3, "positionMs": 0, "durationMs": 146050, "status": "new" },
      "newEpisodes": 0 },
    { "item": { "id": "news-24", "kind": "live", "title": "News 24", "year": null, "posterUrl": "/assets/7b0e….png",
                "backdropUrl": null },
      "continue": null, "newEpisodes": 0 }
  ],
  "homeSections": [ { "id": "untitled", "title": null, "layout": "grid", "itemIds": ["caminandes"] },
                    { "id": "Hq7cP2xd", "title": "Channels", "layout": "row", "itemIds": ["news-24"] } ]
}
```

- `version`: the device's state version, increased whenever something the TV shows changes (home list, settings,
  cursor, catalog reload, a stopped/finished episode); the TV re-fetches when a `state` event announces a higher one.
- `device.uiLanguage` and `preferredAudioLanguage` are **effective** values: the device's own setting, else the
  server's `defaults`, else the catalog's `defaults` hints, else `"en"` / null. `subtitlesLanguage` is the device's
  own setting (no fallback); null means subtitles off.
- `device.autoplayOnStart` (owner setting, default false): when the app opens, the show or channel watched last (else
  the first tile; the TV decides what "last" is) starts after a 10-second countdown that any key stops.
- `device.homeColumns` (3–6, default 4) and `device.homeRows` (1–4, default 2), owner settings: Home is a grid of
  portrait cards, `homeColumns` per row and `homeRows` rows per screen; the rest of the list scrolls.
- `home`: the owner's list (≤ 200, a safety limit) in [Home order](#home-sections), without items that left the
  catalog or cannot be played (no `playbackAllowed` episode; a channel with `playbackAllowed: false`). `posterUrl` and
  `backdropUrl` (the catalog's optional landscape image) are relative to the server's base URL, each null without its
  image; the TV's cards show the poster, and the focused card's panel lies over the backdrop (else the poster, blurred).
- `continue`: what OK plays, the item's cursor episode ([Play order](#play-order-and-the-cursor)). `status`: `new`
  (never started), `watching` (`positionMs` is the saved position), `finished` (`positionMs` 0: it starts over).
  `index`/`count`: the position in the item's play order. Null for a channel: OK resolves it by `itemId`.
- `newEpisodes`: `playbackAllowed` episodes that entered the catalog (a reload that first carried them) after the
  later of the TV's last progress report on this item and the moment the item was put on this home list (episodes
  present when the server first loaded this catalog never count); 0 once the TV reports progress on any episode of
  the item, and always for a channel.
- `homeSections`: how `home` is cut into [sections](#home-sections), in display order, each with `id`, `title` (null
  for the untitled section), `layout` and `itemIds` (its entries in `home`, in order). Only sections with an entry in
  `home` are listed, so the `itemIds` of all sections, one after another, are exactly the ids of `home`. A TV that
  ignores `homeSections` shows `home` as one grid; clients MUST treat an unknown `layout` as `grid`.

### `GET /api/v1/tv/events`

Server-sent events (`text/event-stream`, `X-Accel-Buffering: no`; reverse proxies must not buffer it).

- On connect: `event: state` `{"version": n}` (id `s<n>`, `retry: 5000`), then `event: app` if an APK is stored,
  then every unacknowledged command younger than 2 minutes; later `event: state` whenever the state version changes.
- `event: app` `{"versionCode": 300}` (id `a<versionCode>`): an APK is on offer ([`GET /tv/app`](#get-apiv1tvapp)),
  sent on connect and to every open stream whenever the stored APK changes (an upload, a fetch from GitHub); a TV
  whose own versionCode is lower updates as [TV app updates](#tv-app-updates) says. When the owner removes the APK,
  every open stream gets `{"versionCode": 0}` (id `a0`): nothing is on offer (`GET /tv/app` answers `204`).
- `event: command` `{"id": 12, "type": "play", "payload": {"itemId": "…", "episodeId": "…"}}` (id `c<id>`), one of
  the [commands](#commands). The TV acknowledges every command it receives, also those it ignores, with
  `POST /tv/commands/:id/ack`; unacknowledged ones are replayed on reconnect for 2 minutes (deleted after 7 days).
- A `: ping` comment every 20 seconds. The TV should treat 60 s of silence as a dead connection, reconnect with
  backoff, poll `/tv/state` every 60 s and in the foreground, and ignore event types it does not know.

#### Commands

The owner sends them with `POST /api/v1/admin/devices/:id/commands` (body: `type` plus the request fields below);
the TV gets `{"id", "type", "payload"}`. What a command does is the TV's business:

| `type` | Request fields | `payload` | On the TV |
|---|---|---|---|
| `play` | `episodeId` (allowed episode) or `itemId`, `positionMs`?, see [Remote play](#remote-play-and-command-results) | `{"itemId", "episodeId", "positionMs"?}` | plays that episode (from its saved position), or the channel |
| `stop` | | `{}` | saves and goes home |
| `pause` / `resume` | | `{}` | pauses / plays on; on a channel ignored (reason `live`) |
| `seek` | exactly one of `deltaMs` (integer −3 600 000…3 600 000) and `positionMs` (integer 0…10¹²) | `{"deltaMs"}` or `{"positionMs"}` | jumps by `deltaMs` (negative: back), or to `positionMs`; on a channel ignored (reason `live`) |
| `next` / `previous` | | `{}` | switches to the nearest `playbackAllowed` episode after / before the current one in play order, if any; while a channel plays, loads or shows its error screen, to the channel after / before it in the TV's Home order, without wrap-around (ignored, reason `no_channel`, at the ends) |
| `message` | `text` (1–200 characters with a non-space; trimmed), `durationSec`? (integer 3–120, default 15) | `{"text", "durationSec"}` (default applied by the server) | shows `text` as a large banner, on Home and in the player, for `durationSec` seconds |
| `update` | | `{"versionCode"}` (the stored APK's; `409 no_apk` when none is stored) | installs the stored APK now, see [TV app updates](#tv-app-updates) |

The transport commands (`stop`, `pause`, `resume`, `seek`, `next`, `previous`) act only while the TV is in the
player; otherwise they are acknowledged and ignored. A TV also acknowledges and ignores command types it does not
know, so new types can be added within v1; the server refuses unknown types (`400 invalid_request`).

### `GET /api/v1/tv/app`

The APK on offer: `200 {"versionName": "0.3.0", "versionCode": 300, "sha256": "<64 hex>", "size": 12345678,
"auto": true}`, or `204` when none is stored. `auto` (`appUpdates.auto`): a TV that can install silently does so.

### `GET /api/v1/tv/app/apk`

The APK's bytes: `Content-Type: application/vnd.android.package-archive`, `Content-Length`, `ETag: "<sha256>"`,
`Cache-Control: no-store`; `404 no_apk` when none is stored. `HEAD` answers the same headers. No range requests. The TV
checks the size and sha256 against `GET /tv/app` before installing; Android checks the signature.

#### TV app updates

- A TV learns of an APK from `event: app` and `GET /tv/app` and compares `versionCode` with its own.
- `auto: true` and a `silent` TV: it downloads, verifies and installs the APK by itself while idle (on Home).
- A `guided` TV (or `auto: false`): the owner sends the [`update` command](#commands) when someone is at the TV,
  which shows Android's install screen (a TV that can install silently installs at once).
- `update` results ([command results](#remote-play-and-command-results)): `done` with `installing` or `prompted`
  (Android's install screen is up); `ignored` with `up_to_date`, `not_newer`, `busy`, `not_ready`, `declined` or
  `timeout`; `failed` with `download`, `too_large`, `verify`, `wrong_package`, `bad_archive` or `install_<status>`
  (Android's install status in lower case, e.g. `install_failure_incompatible`). The TV's next User-Agent shows it.

### `GET /api/v1/tv/items/:itemId`

The hidden menu's episode list, for any catalog item (`404 unknown_item`).

```json
{
  "item": { "id", "kind", "title", "year", "posterUrl", "backdropUrl", "originalTitle", "synopsis", "genres" },
  "cursorEpisodeId": "show.e2", "episodes": [
    { "id": "show.e1", "index": 0, "season": 1, "number": 1, "title": "Pilot", "label": null, "durationMs": 1200000,
      "playbackAllowed": true, "progress": { "positionMs": 1190000, "durationMs": 1200000, "status": "finished",
                                         "updatedAt": "…" },
      "sources": [ { "id": "tr-dub", "label": null, "languages": { "audio": ["tr"], "subtitles": [] } } ] }
  ]
}
```

A channel answers `"channel": {"playbackAllowed", "sources": [{"id", "label", "languages"}]}` instead of
`cursorEpisodeId` and `episodes`.

### `POST /api/v1/tv/resolve`

`{"episodeId": "…", "sourceId"?: "…", "exclude"?: ["sourceId", …], "trigger"?: "…", "commandId"?: 12}`, or
`{"itemId": "…", …}` for a channel (exactly one of `episodeId` and `itemId`) → what to play. `exclude` holds at most
64 ids. `trigger` (`viewer`, `autoplay`, `next`, `command`) and `commandId` (integer ≥ 1, with `trigger: "command"`)
tell the [viewing history](#viewing-history) what started the playback; a `commandId` that is not a `play`, `next` or
`previous` command of this TV is ignored (the viewing gets trigger `command` with the TV as its actor). An aborted
request answers `503 aborted`.

```json
{
  "sessionId": "Q8m…", "sourceId": "tr-dub", "media": { "kind": "hls", "url": "https://…/master.m3u8" },
  "subtitleTracks": [ { "url": "https://…/tr.vtt", "language": "tr", "format": "vtt", "label": null } ],
  "languages": { "audio": ["tr"], "subtitles": [] }, "alternatives": ["multi", "unknown"],
  "next": { "episodeId": "show.e2", "season": 1, "number": 2, "title": "Season finale", "label": null },
  "item": { "id", "kind", "title", "year", "posterUrl", "backdropUrl" },
  "episode": { "id": "show.e1", "index": 0, "count": 5, "season": 1, "number": 1, "title": "Pilot", "label": null,
               "durationMs": 1200000 },
  "resume": { "positionMs": 90000, "durationMs": 1200000 }, "expiresAt": null
}
```

A channel's response has `"next": null, "episode": null, "resume": null`. `media.kind` is `hls`, `dash`, `mp4` or
`ts` (progressive MPEG-TS over HTTP, an endless response for a channel; [Source](catalog-bundle-v1.md#source)).

Source selection:

1. `403 not_allowed` when the episode's (or the channel's) `playbackAllowed` is false; `404 unknown_episode` /
   `unknown_item` / `unknown_source`; `400 has_episodes` when `itemId` names an item played through its episodes.
2. Candidates are the episode's (or the channel's) sources minus `exclude` (or only `sourceId` when given), in
   bundle order, stable-sorted by the device's preferred audio language: **match** (some `languages.audio` tag has the
   same primary subtag, or `audio: []` = no dialogue, or no preference) **> unknown** (`audio: null`) **> known
   mismatch**. Sources the TV listed in `exclude` (as failing) in the last 10 minutes move to the end.
3. Candidates are tried in order. Direct sources succeed immediately. `adapter` sources go through the
   [resolver module](resolver-module-v1.md) under a per-source deadline (`resolver.deadlineMs`, 12 s) within a
   budget for the whole request (`resolver.budgetMs`, 30 s), so a TV should allow ~35 s for this call. An adapter
   source that fails is skipped (and moved last for 10 minutes) and the next candidate is tried.
4. A plain URL without upstream headers goes to the TV as-is. Media that needs upstream `headers` (bundle
   `media.headers` or an adapter result's `headers`) and inline playlists (VOD only,
   [ResolveResult](resolver-module-v1.md#resolveresult)) come back as a **server-relative** proxy URL,
   `/p/<token>/index.m3u8` (HLS), `/p/<token>/video.mp4` (MP4) or `/p/<token>/stream.ts` (MPEG-TS), which the TV
   resolves against its server base URL; upstream headers never leave the server. Subtitle tracks that need headers
   come back as `/p/<token>/sub/<n>.<ext>`. With `proxy.always`, every HLS/MP4/MPEG-TS stream and subtitle track is
   proxied. DASH is never proxied in v1, so DASH that needs headers cannot be served.
5. Nothing playable → `502 no_playable_source` with `tried: [{sourceId, code, adapterId?, name?}]`. Codes:
   `adapter_unavailable` (no resolver module provides the adapter), `unsupported` (DASH that needs headers),
   `timeout`, `abort`, `error`, `empty` (the adapter returned no result). `name` is the error's class name (never
   its message): `InvalidResult` for a result that fails validation, `BudgetExhausted` once the budget ran out.

- `alternatives`: the remaining playable candidates in order (sources that cannot be served at all, such as a
  missing adapter or DASH that needs headers, left out). On a player error the TV re-resolves with the failed
  source in `exclude` and continues at the same position (a channel: at its live edge).
- `next`: the episode auto-next would start (next `playbackAllowed` episode in play order), or null at the end of
  the item or when the episode (or item) has `autoAdvance: false`.
- `resume`: the saved position when the episode is being watched (the TV applies its own resume threshold), else
  null. `sessionId` identifies this playback in progress reports.
- `expiresAt`: the adapter's validity hint for the stream, or null. `languages` and `subtitleTracks` are the adapter
  result's when it gives them, else the bundle source's.

## Media proxy

`GET /p/<token>/…` serves header-bound and inline-playlist streams. The token (32 random bytes, base64url) is the
credential; the TV's media player sends no device token. Sessions live in memory only and slide with use
(`proxy.sessionTtlSec`, 6 h) up to 12 h; an owner (a TV, and separately its [Listen along](#listen-along) scope, so
the phone never ends the TV's sessions) keeps at most two: resolving a third ends the oldest.

| Route | |
|---|---|
| `GET /p/<token>/index.m3u8` | the session's HLS playlist: fetched upstream with the session's headers (or the adapter's inline text), every URI rewritten |
| `GET /p/<token>/video.mp4`, `/p/<token>/stream.ts` | the session's MP4 or MPEG-TS stream (media kind `ts`), streamed; `Range` is forwarded and `206`/`Content-Range` pass back |
| `GET /p/<token>/u/<ref>` | a URI from a rewritten playlist: another playlist (rewritten in turn) or a segment, key, init section or subtitle segment (streamed, `Range` forwarded) |
| `GET /p/<token>/sub/<n>.<vtt\|srt\|ttml>` | subtitle track `n` of the resolve response, with that track's headers |

- **Rewriting** is generic HLS: URI lines and `URI="…"` attributes (`EXT-X-KEY`, `EXT-X-MAP`, `EXT-X-MEDIA`,
  `EXT-X-I-FRAME-STREAM-INF`, `EXT-X-SESSION-KEY`, `EXT-X-PART`, `EXT-X-PRELOAD-HINT`, `EXT-X-RENDITION-REPORT`, …)
  are resolved against the playlist's own URL (after redirects) or the inline `baseUrl` and written as relative
  `u/<ref>` links. `data:` and other non-HTTP URIs are left alone. DASH manifests are not rewritten (v1).
- **`<ref>`** = `<p|r>.<base64url of the URL>.<HMAC>[.<extension>]`, signed with a per-session key: only URLs the
  proxy wrote itself can be fetched; a wrong or foreign ref answers `404`. The extension is a hint for players.
- **Destinations:** every upstream request (the session's URL, each URL a playlist names, each redirect) is checked
  first; the server resolves the host itself and connects only to an address it checked. Loopback, private (RFC 1918,
  unique-local `fc00::/7`), link-local (`169.254.0.0/16`, the cloud metadata address, `fe80::/10`), CGNAT
  (`100.64.0.0/10`), multicast, reserved and unspecified addresses, the same inside IPv4-mapped or NAT64 IPv6, and IP
  literals in these ranges are refused with `502 {"error":"egress_denied"}`, unless the owner lists the upstream in
  [`proxy.privateUpstreams`](#configuration). So are URLs with credentials (`user:pass@`) and non-HTTP schemes. The
  proxy follows redirects (`301`/`302`/`303`/`307`/`308`) itself, at most 5 per request, each `Location` checked like
  the first URL. Credential-type request headers (`Authorization`, `Cookie`, and names containing `token`, `secret`,
  `passw`, `api-key`/`apikey` or `session`) go only to the origin of the session's own URL (the adapter's inline
  `baseUrl`; a subtitle track's own URL for `/sub/`); the others (`Referer`, `User-Agent`, …) with every request.
- **Streaming:** segments, MP4 and MPEG-TS bodies pass through as they arrive, never buffered (a channel's
  `stream.ts` never ends); a TV that disconnects cancels the upstream request. Only `Content-Type`,
  `Content-Length`, `Content-Range`, `Accept-Ranges`, `Last-Modified` and `ETag` are passed back.
- **Errors:** a malformed token, an entry file of another kind than the session's, or an unknown subtitle track
  `404 not_found`; unknown or expired session `410 {"error":"gone"}`. An upstream `401`/`403`/`410` marks the session
  **stale**: this and every later request answer `410 {"error":"stale"}`, so the TV re-resolves (the same source
  first when the playback ran for more than 5 minutes: an expired signed URL). Upstream `404` →
  `404 upstream_not_found`, a `416` passes through, other upstream errors (also a bad or sixth redirect) →
  `502 upstream_error`, unreachable → `502 upstream_unreachable`, a refused destination → `502 egress_denied`, a
  playlist that is none or too large ([Problem reports](#problem-reports)) → `502 not_a_playlist` /
  `502 playlist_too_large`, no headers within 20 s → `504 upstream_timeout`.
- **Channels:** a channel left on for more than 12 h outlives its session and gets `410 gone`; the TV re-resolves
  (the same source first) and its [viewing](#viewing-history) continues.
- **`proxy.alignTsSegments`** (off by default): for segments of proxied HLS (no `Range`, not
  `.m4s/.mp4/.aac/.vtt/…`; never `stream.ts`), junk before the first MPEG-TS packet (up to 4 KiB, recognized by five
  0x47 sync bytes 188 bytes apart) is cut off and the type set to `video/mp2t`. Some sites prefix segments with such
  bytes, and Media3 rejects segments with more than a few hundred ("Cannot find sync byte").

### `POST /api/v1/tv/progress`

`{"sessionId"?: "…", "episodeId": "…", "positionMs": 90000, "durationMs"?: 1200000, "status": "playing",
"playing"?: true, "ageMs"?: 0}` → `{"ok": true, "version": 8}`; `404 unknown_episode`. A channel's report is
`{"sessionId"?, "itemId", "status", "playing"?, "ageMs"?}`, with no position and `status` `playing` or `stopped`
only; `404 unknown_item`, `400 has_episodes` (the item is played through its episodes).

- `status`: `playing`, `paused`, `stopped` (left the player) or `finished` (ended, or stopped within the TV's end
  threshold). The TV reports every 15 s while playing and on pause, seek, stop, end, every rebuffer stall and its
  end, leaving a channel, and when the app goes to the background.
- `playing` (default `status === "playing"`): whether the player was actually advancing when it sampled
  `positionMs` (a rebuffer stall is `status: "playing", playing: false`). `ageMs` (0–60000): how long before sending
  the position was sampled (a queued report). They anchor the TV's timeline for [Listen along](#listen-along).
- An episode's `playing`/`paused`/`stopped` reports save the position (status `watching`) and point the item's cursor
  at this episode. `finished` marks the episode finished and moves the cursor to the next `playbackAllowed` episode
  in play order, regardless of `autoAdvance` (which only governs automatic playback), wrapping to the first allowed
  episode after the last one (a wrapped cursor, see [Play order](#play-order-and-the-cursor)).
- `stopped` and `finished` reports of an episode and cursor moves bump the state version; plain heartbeats do not.
- A channel's report saves no position, moves no cursor and never bumps the state version; it writes now playing
  ([`GET …/now`](#devices)) and is the heartbeat of the TV's running [viewing](#viewing-history).

### `POST /api/v1/tv/commands/:id/ack`

→ `{"ok": true}`, or `404 unknown_command` (not this device's command).

### `POST /api/v1/tv/problems`

Something went wrong on the TV ("Can't play right now", a player error, the server unreachable for a while); the
owner sees it on the admin page ([Problem reports](#problem-reports)).

```json
{ "kind": "playback", "code": "ERROR_CODE_IO_BAD_HTTP_STATUS", "ageMs": 4000, "episodeId": "show.e1",
  "sourceId": "tr-dub", "sessionId": "Q8m…", "positionMs": 754000, "httpStatus": 403,
  "detail": "InvalidResponseCodeException: Response code: 403", "appVersion": "0.3.0" }
```

→ `202 {"ok": true}`; `429 too_many_problems` (more than 30 reports in 10 minutes from one TV; `Retry-After`). A
report for an item or episode the catalog does not have is stored all the same.

- Required: `kind` (`playback`, `resolve`, `network` or `other`) and `code` (1–64 of `A-Z a-z 0-9 _ . : -`).
- Optional, no other fields and no `null`s: `ageMs` (0–86 400 000: how long ago it happened; stored time = receipt −
  `ageMs`), `itemId`, `episodeId`, `sourceId` (catalog ids), `sessionId` (≤ 64 characters: the resolve's
  `sessionId`; when it names this TV's playback session, a missing `episodeId`/`sourceId`, or for a channel's
  session a missing `itemId`/`sourceId`, is taken from it), `positionMs` (≥ 0), `httpStatus` (100–599), `detail`
  (≤ 500 characters), `appVersion` (≤ 40 characters).
- `code`, `detail` and `appVersion` are redacted before they are stored: URLs become `<url host>`, runs of 20 or more
  letters, digits, `_` and `-` become `<token>` unless they read as an identifier (`SCREAMING_SNAKE`, `snake_case`,
  `CamelCase` without digits, such as player error names).

## Play order and the cursor

Each device has, per item, a **cursor**: the episode OK plays. The server maintains it from progress reports and the
owner can overwrite it (`PUT …/cursor`). Without a cursor, OK plays the first allowed episode that is not finished
(or the first allowed one when all are). A cursor on an episode that is no longer allowed moves to the next allowed
one. Episode array order in the bundle is the play order; `season`/`number` are display only.

**Episodes appended to a finished item.** A cursor the server placed by wrapping (a `finished` report on the item's
last allowed episode) marks the item as watched to the end. When a later catalog reload adds episodes to the item
(first entering the catalog after the wrap), OK plays the first of them in play order that has `playbackAllowed`
instead of the cursor episode (when there is none, the cursor episode). `continue` in
[`GET /tv/state`](#get-apiv1tvstate) and on the admin device page and `cursorEpisodeId` in
[`GET /tv/items/:itemId`](#get-apiv1tvitemsitemid) follow this rule. Any other progress report on the item, or the
owner's `PUT …/cursor`, makes the cursor an ordinary one again.

## Admin API

### Devices

| Route | Body | Response |
|---|---|---|
| `GET /api/v1/admin/devices` | | `{"devices": [Device & {"homeCount"}]}` |
| `GET /api/v1/admin/devices/:id` | | `{"device": Device, "home": [{"itemId", "title", "kind", "posterUrl", "backdropUrl", "missing", "playable", "continue", "newEpisodes", "check", "checkAll"}], "homeMax": 200, "sections": [Section], "sectionsMax": 20}` (`home` in [Home order](#home-sections)); `playable`: the item has a `playbackAllowed` episode, or is a channel with `playbackAllowed: true` (false for a missing item); `continue` and `newEpisodes` as in [`GET /tv/state`](#get-apiv1tvstate) (`null` and 0 for a missing item); `check`: the [`CheckSummary`](#checks) of what OK plays (the channel itself), null when nothing plays; `checkAll`: `{"verdict", "checked", "total", "failed", "warned", "oldestCheckedAt"}` over every episode that may play (`total`; `checked`: those with a summary; `verdict` the worst of theirs, null when none), null for a channel or a missing item |
| `PATCH /api/v1/admin/devices/:id` | any of `name`, `uiLanguage` (`"tr"`/`"en"`/null), `preferredAudioLanguage` (tag/null), `subtitlesLanguage` (tag/null = off), `autoplayOnStart` (boolean), `homeColumns` (integer 3–6), `homeRows` (integer 1–4) | `{"device": Device}` |
| `DELETE /api/v1/admin/devices/:id` | | `204`; the TV must pair again |
| `PUT /api/v1/admin/devices/:id/home` | `{"itemIds": [...]}` (≤ 200, in display order) or `{"sections": [...]}`, see [Home sections](#home-sections) | `{"version", "home", "sections"}` |
| `PUT /api/v1/admin/devices/:id/cursor` | `{"itemId", "episodeId"}` | `{"version"}` |
| `GET /api/v1/admin/devices/:id/progress` | | `{"cursors": [...], "progress": [...]}` with `itemTitle`, `kind`, `season`, `number`, `episodeTitle` (or `missing: true`); channels are never listed |
| `GET /api/v1/admin/devices/:id/now?seq=&wait=` | | `{"online", "serverNowMs", "seq", "nowPlaying": {itemId, itemKind, episodeId, sourceId, itemTitle, episodeTitle, positionMs, durationMs, state, updatedAt, playing, viewingId} \| null, "anchor": {positionMs, atMs, playing, rate} \| null}`; for a channel `state` is `starting`, `playing` or `stopped` and `anchor` is null; with `seq` equal to the current `seq` and `wait` (0–25 s, default 0) the answer waits for the next resolve or progress report, see [Listen along](#listen-along) |
| `POST /api/v1/admin/devices/:id/commands` | `{"type", …}`, see [Commands](#commands) | `202 {"id", "online"}`; `online: false`: queued, the TV gets it if it connects within 2 minutes |
| `GET /api/v1/admin/devices/:id/problems?limit=` | | `{"problems": [Problem]}`, newest first (`limit` default 50, at most 100), see [Problem reports](#problem-reports) |
| `DELETE /api/v1/admin/devices/:id/problems` | | `204`; forgets the TV's problems |

`Device` = `{"id", "name", "status": "pending"|"active", "online", "createdAt", "lastSeenAt", "stateVersion",
"settings": {stored values, null = default}, "effective": {resolved values}, "problems": {"recent", "lastAt"}, "app"}`.
`settings`/`effective` hold `uiLanguage`, `preferredAudioLanguage`, `subtitlesLanguage`, `autoplayOnStart` (false by
default) and `homeColumns`/`homeRows` (4 and 2 by default); with no server default, both show the stored value.
`problems.recent`: problems in the last 24 hours; `lastAt`: when the latest stored one happened (or null). `app` =
`{"version", "versionCode", "androidSdk", "capability": "silent"|"guided", "reportedAt", "update"}` as the TV's
[User-Agent](#tv-api) last reported it (each null until it does; `reportedAt`: when it first reported these values),
with `update`: `unknown` (never reported, or no APK stored), `up_to_date` (its versionCode ≥ the stored APK's),
`pending` (an older app on a `silent` TV with `appUpdates.auto`: it installs by itself) or `needs_install_now` (an older
app on a `guided` TV, or `auto` off: send [`update`](#commands)).

Errors. Home list: `400 too_many_items` (`max`), `duplicate_item`, `unknown_item`, `not_playable` (`itemId`: no
`playbackAllowed` episode, or a channel with `playbackAllowed: false`), the last two checked only for items not
already on the list, so one a catalog reload left missing or unplayable may stay and the list can still be reordered
or shortened. Cursor: `404 unknown_item`, `400 unknown_episode` (not in this item; always for a channel),
`400 not_allowed`; setting the cursor also forgets that episode's saved position, so "continue from episode X" starts
X from the beginning. Commands: `400 unknown_episode`, `400 not_allowed`, `404 unknown_item`, `400 not_playable`
(play, see [Remote play](#remote-play-and-command-results)), `400 invalid_request` (unknown type, a seek with both or
neither field, a bad message or `durationSec`), `409 no_apk` (update). Every `:id` route: `404 unknown_device`.

Every change that affects the TV bumps the device's state version and emits a `state` event.

### Problem reports

What went wrong on a TV, kept for the owner: the TV's own reports (`origin: "tv"`,
[`POST /tv/problems`](#post-apiv1tvproblems)) and what the server ran into for it (`origin: "server"`):

| `kind` · `code` | Recorded when | Also |
|---|---|---|
| `resolve` · `no_playable_source` | a TV resolve answers `502 no_playable_source` | `detail`: the `tried` list in short (`src-a: timeout; src-b: error InvalidResult`) and the sources the TV excluded |
| `resolve` · `source_failed` | a source failed during a TV resolve and a later candidate played | `sourceId`; `detail`: `<code> <name?>` (`error InvalidResult`, `timeout`, `empty`). Missing adapters are not recorded (the catalog page warns about them) |
| `proxy` · `upstream_401` / `upstream_403` / `upstream_410` | the upstream refused a request of a TV's proxy session, which is now stale | `httpStatus`; `detail`: what was requested (`playlist`, `segment`, `video`, `stream` for `stream.ts`, `subtitles`) |
| `proxy` · `upstream_error` | the upstream answered 5xx, or a playlist broke off | `httpStatus`; `detail` as above |
| `proxy` · `upstream_unreachable` | network error, or no answer within 20 s | `detail`: what was requested and why (`ECONNREFUSED`, `no answer within 20 s`) |
| `proxy` · `not_a_playlist` / `playlist_too_large` | the upstream sent something else than a playlist (`detail` gives its media type), or more than 4 MiB, or one the rewrite cannot keep in bounds (more than 250,000 lines, more than 16 MiB rewritten, or a URI longer than 4096 characters) | |
| `proxy` · `egress_denied` | a URL or redirect of the session named a destination the [proxy refuses](#media-proxy) | `detail`: what was requested and why (`segment: private address`, `credentials in url`, `scheme`); never the URL |

Server-origin proxy problems are recorded at most once per TV and code a minute; [Listen along](#listen-along)'s
resolves and proxy sessions never, nor those of [checks](#checks). `kind` values overall: `playback`, `resolve`, `proxy`, `network`, `other`.

`Problem` = `{"id", "at", "origin": "tv"|"server", "kind", "code", "itemId", "itemTitle", "itemKind", "episodeId",
"episodeTitle", "season", "number", "sourceId", "positionMs", "httpStatus", "detail", "appVersion", "missing"}`:
`at` is when it happened; titles come from the current catalog; `missing: true` (with null titles) when the episode
(for a channel: the item) is not in the catalog (any more). Each TV keeps its newest 100, for at most 30 days.

### Catalog

| Route | Response |
|---|---|
| `GET /api/v1/admin/catalog` | `{"id", "buildId", "builtAt", "name", "loadedAt", "stats", "adapters", "warnings", "resolver", "server", "builds", "changes", "facets"}`: `resolver` is `{"sha256", "adapters"}` of the loaded module, or null; `server` is `{"version"}` of the running server; `builds` is the loaded catalog's [history](#catalog-history), `[Build]` newest first, at most 50; `changes` is the `Changes` of the newest build that is not the baseline, or null; `facets` is `{"kinds": {"movie", "series", "live"}, "genres": [{"name", "count"}], "years": {"min", "max"} \| null}` over the whole catalog: genres matched case- and accent-insensitively under the first spelling the catalog uses, most common first; `years` null when no film or series has one |
| `GET /api/v1/admin/catalog/builds/:buildId` | `{"build": Build, "changes": Changes}` for any build in the loaded catalog's history (also one beyond the 50 listed); `404 unknown_build` |
| `GET /api/v1/admin/catalog/search?q=&kind=&genre=&yearFrom=&yearTo=&playable=&since=&notOnDevice=&sort=&offset=&limit=` | `{"items": [{"id", "kind", "title", "year", "posterUrl", "backdropUrl", "episodeCount", "playableCount", "playable", "firstSeenAt", "newEpisodes"}], "total", "offset"}`: `total` counts every match, `items` is the page from `offset` (default 0), at most `limit` (1–200, default 50; other values fall back to it). `q` (cut to 200 characters) matches title, original title and id, case-, accent- and dotless-ı-insensitively (empty: everything); `kind` a comma list of `movie`, `series`, `live`; `genre` a comma list (any of them, matched like `q`); `yearFrom`/`yearTo` leave out items without a year (channels); `playable=true` only what OK can play; `since` (ISO 8601, UTC without an offset, or epoch ms) items first seen at or after it, or with an episode first seen at or after it; `notOnDevice` leaves out that TV's home list (`404 unknown_device`). `sort` is `title` (default), `year` (newest first, none last) or `newest` (newest in the catalog first); ties by title, then id. `playable` as on the [device's home list](#devices); `episodeCount` and `playableCount` null for a channel; `firstSeenAt` when the item first appeared ([catalog history](#catalog-history); null for what the baseline carried); `newEpisodes` the episodes first seen at or after `since` (0 without it, null for a channel). Anything else in a parameter is `400 invalid_request` |
| `GET /api/v1/admin/catalog/items/:id` | `{"item"}`: the item with all episodes, each with its stored [`check`](#checks) (a `CheckSummary`); a channel instead `{…, "kind": "live", "playbackAllowed", "sources": [...], "check"}`; sources as `{id, type, label, languages, kind, needsProxy}` or `{…, adapter}`; upstream URLs, headers and refs are not exposed |
| `POST /api/v1/admin/catalog/reload` | re-reads the bundle from `catalog.dir` (a symlink there is followed anew on each reload): `200 {"catalog"}` (the object `GET /admin/catalog` returns), or `422 {"error": "invalid_catalog", "issues"}` and the previous catalog stays active (also when the bundle needs an adapter the resolver module does not provide). The whole bundle is validated, including a hash of every poster, so a large catalog takes a while. `SIGHUP` does the same. After a successful reload all devices get a new state version. The resolver module is not re-read: a new module needs a restart. |

#### Catalog history

The server records each build of a catalog id that it loads, at start and on every reload; loading the build id it
recorded last (a restart, a reload of the same bundle) records nothing.

`Build` = `{"buildId", "builtAt", "loadedAt", "baseline", "counts": {"items", "episodes"}, "added": {"items",
"episodes"}, "removed": {"items", "episodes"}}`: `builtAt` comes from the bundle, `loadedAt` is when this server
loaded it; `counts` is what the build holds, `added`/`removed` what changed against the build loaded before it (exact
counts). `baseline: true` marks the first build the server loaded for this catalog id: nothing in it counts as new,
and its `added`/`removed` are 0.

`Changes` = `{"items": {"added": [{"id", "title", "kind"}], "removed": [{"id", "title"}]}, "episodes": {"added":
[{"id", "itemId", "itemTitle", "season", "number", "label", "playbackAllowed"}], "removed": [{"id", "itemId",
"itemTitle"}]}}`, each list at most 500 entries. Added ones are in catalog order (play order within an item), removed
ones by item id, then episode id. An item counts as added when none of its episodes was in the catalog before (also
when it comes back); an episode that comes back is not listed as added. Channels count by their item id among the
items (added when the id was not in the catalog before), never among the episodes. A removed entry's
`title`/`itemTitle` is null when the catalog loaded before was not in memory (a restart onto a changed bundle).

### Checks

A **check** follows a source the way the TV would fetch it, down to real media bytes, so that the owner learns what
fails before the viewer does. A pass means the server reached real media along the TV's path just now; it does not
prove that the TV decodes the codecs (they are listed, and the risky ones only warn). Nothing on the TV changes.

`POST /api/v1/admin/diagnostics/resolve` `{"episodeId", "sourceId"?, "preferredAudioLanguage"?}`, or `{"itemId", …}`
for a channel (exactly one of `episodeId` and `itemId`), checks every source of the episode or channel (or only
`sourceId`), one after the other in bundle order, whether it may play or not, and stores each source's report. Each
source goes through the same path as a TV resolve (adapters, deadlines, validation) without creating sessions, then
the stream is followed:

- **Proxied** (headers, an inline playlist, or `proxy.always`): through a proxy session of the check's own, served
  in-process, so the [egress policy](#media-proxy), redirects, the upstream headers and the playlist rewriting are the
  TV's. **Direct**: straight to the upstream; the URLs an upstream playlist names (not the catalog or the adapter)
  go through the egress policy.
- **HLS**: the playlist; for a master playlist every variant and rendition playlist (at most 16, the rest is
  `playlists_unchecked`), then the first segment (of a live playlist, without `#EXT-X-ENDLIST`: the last, where a TV
  starts) of the first variant that answered and of each audio rendition, with its `#EXT-X-MAP` init section and its
  `METHOD=AES-128` key (exactly 16 bytes); any other method warns `sample_aes`. A subtitle rendition that fails
  warns, the others fail.
- **MP4**: `Range: bytes=0-65535`; `206` passes, `200` passes with `no_range` (resume and seeking break).
  **MPEG-TS** (`ts`): up to 64 KiB of the stream. **DASH**: the MPD only (`manifest_only`).
- **Subtitle tracks**: each fetched (proxied as the TV gets it) and expected to be WebVTT, SRT or TTML; one that
  fails warns `subtitle_failed`.
- **Media** is recognized by its first bytes (at most 256 KiB are read): MPEG-TS sync bytes, MP4 boxes (`ftyp`,
  `moov`, … as `mp4`; `styp`, `moof`, `sidx` as `fmp4`), ADTS (`aac`), ID3. A body that reads as text where media was
  expected (an HTML error page that answered 200, JSON) fails `not_media`; unknown binary data passes.

Each source has 20 s for all of this, each request 10 s.

`SourceReport` = `{"sourceId", "type", "adapterId"?, "ok", "ms", "code"?, "name"?, "results"?, "stream"?, "verdict",
"steps", "codecs", "warnings", "checkMs"}`: `ok` says whether the source resolved, `ms` how long that took, `code` and
`name` why it did not (as in `tried` of a [resolve](#post-apiv1tvresolve)); `results` are the adapter's results and
`stream` the one used, summarized (`delivery` is `direct`, `proxy` or `unsupported`); `checkMs` is the time after
resolving (0 without a stream).

- `steps`: `[{"what", "index"?, "of"?, "host", "ok", "status"?, "ms", "error"?, "bytes"?, "container"?}]` in the order they
  were made (empty when the source did not resolve). `what`: `playlist`, `variant`, `rendition`, `segment`, `init`,
  `key`, `subtitle`, `file` (MP4, MPEG-TS) or `manifest` (DASH). `index`: the variant, rendition or subtitle track
  (0-based); for a segment, init section or key of a multivariant playlist, its variant's or rendition's, which `of`
  (`variant` or `rendition`) names. `host`: the upstream reached (for a
  proxied stream, not the server). `status`: the upstream's HTTP status when one came. `error`: `timeout`, `network`,
  `http`, `not_a_playlist`, `too_large`, `not_media`, `bad_key`, `egress_denied`, `not_subtitles`, `not_mpd`,
  `aborted`, `budget` (the source's 20 s ran out) or `bad_uri` (a URI the playlist names that is not an http(s) URL;
  `data:` URIs are inline and not fetched). `bytes`: bytes read. `container`: `ts`, `mp4`, `fmp4`, `aac`,
  `id3`, `webvtt`, `srt`, `ttml`, `mpd` or `m3u8`.
- `codecs`: the master playlist's variants, `[{"codecs", "resolution", "bandwidth"}]` (each null when absent).
- `warnings`: `risky_codec` (`hvc1`/`hev1`, `av01`, `ec-3`/`ac-3`, `dvh1`/`dvhe`: may not decode on every TV),
  `high_resolution` (above 1920×1080), `sample_aes`, `no_range`, `subtitle_failed`, `manifest_only`,
  `playlists_unchecked`. A short `expiresAt` is no warning: the TV renews a link before it expires.
- `verdict`: `fail` when the source did not resolve or a step it needs failed, `warn` when it works with warnings,
  `ok` otherwise.

The answer: `{"itemId", "episodeId" (null for a channel), "playbackAllowed", "verdict", "checkedAt", "sources":
[SourceReport]}`. The verdict of an episode or channel: `fail` when no source passes (or it has none), `warn` when one
passes but another fails or warns, `ok` when every source is `ok` (the TV falls back through the sources, so one that
works plays). Nothing secret is returned or stored: hosts, statuses and header *names* only, never URLs, header
values, refs or playlist text.

```json
{ "itemId": "proxy-demo", "episodeId": "proxy-demo.film", "playbackAllowed": true, "verdict": "warn", "checkedAt": "…", "sources": [
  { "sourceId": "missing", "type": "adapter", "adapterId": "example", "ok": false, "ms": 1, "code": "empty",
    "verdict": "fail", "steps": [], "codecs": [], "warnings": [], "checkMs": 0 },
  { "sourceId": "signed-hls", "type": "adapter", "adapterId": "example", "ok": true, "ms": 2, "results": [ … ],
    "stream": { "kind": "hls", "inline": false, "host": "127.0.0.1:8788", "headerNames": ["Referer"], "delivery": "proxy",
                "languages": { "audio": ["en", "tr"], "subtitles": ["en"] }, "subtitleTracks": 0, "label": null, "expiresAt": "…" },
    "verdict": "ok", "checkMs": 9, "warnings": [],
    "codecs": [{ "codecs": null, "resolution": "640x360", "bandwidth": 900000 }, … ],
    "steps": [{ "what": "playlist", "host": "127.0.0.1:8788", "ok": true, "status": 200, "ms": 2, "container": "m3u8" },
              { "what": "variant", "index": 0, "host": "127.0.0.1:8788", "ok": true, "status": 200, "ms": 1, "container": "m3u8" }, …,
              { "what": "segment", "index": 0, "host": "127.0.0.1:8788", "ok": true, "status": 200, "ms": 1, "bytes": 7520, "container": "ts" }] } ] }
```

Errors: `404 unknown_episode`, `404 unknown_item`, `400 has_episodes`, `404 unknown_source`.

**Stored results.** The last report of each source is kept, with a fingerprint of the source as the catalog has it;
a source that changed reads as not checked, and the reports of sources the catalog no longer has are forgotten.
`CheckSummary` = `{"verdict", "checkedAt", "working", "total", "stale"}` or null (no current source has a report of its
current fingerprint): `verdict` as above over the sources with a current report, `checkedAt` the oldest of those,
`working` how many of them pass, `total` the sources the episode or channel has now, `stale` whether one of them has
no current report. It is in [`GET …/catalog/items/:id`](#catalog) (`check` of each episode, of a channel at the top)
and in [`GET …/devices/:id`](#devices).

| Route | Response |
|---|---|
| `GET /api/v1/admin/checks/playables/:playableId?itemId=` | an episode by its id, else a channel by its item id; with `itemId`, the channel `itemId` itself or its episode (an episode id may equal a channel's id): `{"itemId", "episodeId", "check": CheckSummary, "sources": [SourceReport & {"checkedAt", "stale"}]}`, the sources still in the catalog that have a report, in bundle order (`stale`: the source changed since); `404 unknown_item`, `404 unknown_episode` (with `itemId`), `400 has_episodes` |
| `POST /api/v1/admin/checks` | `{"itemId"}` (every episode of a show that may play, or the channel) or `{"deviceId", "mode": "quick"\|"full"}` (a TV's Home: `quick` what OK plays on each entry, a channel itself; `full` every episode that may play, and the channels) → `202 {"run": Run}`; `409 check_running` (`runId`) while a run is going, `404 unknown_item`, `404 unknown_device`, `400 nothing_to_check` |
| `GET /api/v1/admin/checks/current` | `{"run": Run \| null}`: the running run, else the last one that ended, else null |
| `GET /api/v1/admin/checks/:runId?seq=&wait=` | `{"run": Run}`; with `seq` it waits until the run's `seq` is past it, at most `wait` ms (0–25000, default 0); `404 unknown_check` (only the last run is kept) |
| `DELETE /api/v1/admin/checks/:runId` | `{"run": Run}`: stops a running run (`cancelled`; what it checked so far stays stored); a run that ended is answered as it is |

A **run** checks many episodes or channels in the background, two at a time, each like
`POST …/diagnostics/resolve` (a Home run with the TV's audio language) and each stored. One runs at a time on the
server; runs live in memory and a restart forgets them. Home entries that left the catalog or cannot play are listed
in `skipped`; an episode is checked once however often it comes up. `Run` = `{"id", "target", "title" (the show's or
channel's title, or the TV's name), "state": "running"|"done"|"cancelled", "seq" (grows with every change), "total",
"done", "failed", "warned", "startedAt", "finishedAt", "skipped": [{"itemId", "title", "reason":
"missing"|"not_playable"}], "results": [{"playableId", "itemId", "episodeId", "title", "label", "verdict"}]}`, results
in the order they finished (`label` names a series' episode, `S1 E2 · Pilot`; null otherwise). The
[event log](#events) gets `check.started` and `check.finished`, never an event per episode.

### Listen along

The owner's phone plays **another source of the episode the TV is playing** (a dubbed release, or another audio
language inside the same multi-audio stream) in sync with the picture, from the admin page. Nothing changes on the TV.

- **Anchor.** `GET …/now` carries `serverNowMs` (the server clock), `seq` (bumped on every now-playing write) and
  `anchor`: the TV's `positionMs` as of `atMs` (server clock, = receipt of the report − its `ageMs`), advancing at
  `rate` (1) while `playing`. The phone extrapolates `tv = positionMs + (serverNow − atMs)` and estimates its clock
  offset from `serverNowMs` and the round trip. `?seq=<current>&wait=25` returns on the next write, so a pause, seek
  or stall reaches the phone within a round trip.
- **Links** (device-independent: timing belongs to the two releases, not to a TV), per episode and source:
  `offsetMs` (companion position when the TV is at 0, ±6 h), `rate` (companion seconds per TV second, 0.5–2; a PAL
  transfer against a film-rate source is 1.0427) and `language` (audio language to pick inside the stream, or null).
  The companion target is `rate · tv + offsetMs`. Earphone latency is a per-phone nudge kept in the browser.
- **Companion media is always proxied** (`/p/<token>/…`, under the owner key `companion:<deviceId>` with its own
  two-session limit), so the page only loads same-origin media (plus `blob:` object URLs when hls.js feeds the element
  through Media Source Extensions). DASH and MPEG-TS are refused. A companion resolve never writes now playing,
  creates no TV playback session and never penalizes a source for the TV.
- **Channels are not covered** (no timeline to sync to): while a channel plays, `GET …/companion` answers `nowPlaying`
  with `itemKind: "live"` and `candidates: []`; the other routes take episodes only.

| Route | Body | Response |
|---|---|---|
| `GET /api/v1/admin/devices/:id/companion` | | `{"nowPlaying": {itemId, itemKind, episodeId, sourceId, itemTitle, episodeTitle, state} \| null, "candidates": [{sourceId, type, kind, label, languages, current, supported, reason, link}]}`: the sources of the episode now playing (`kind` for direct sources; `supported: false` with `reason` `dash` or `ts`, which the browser cannot play), each with its stored link or the defaults; no URLs, headers or refs |
| `POST /api/v1/admin/devices/:id/companion/resolve` | `{"episodeId", "sourceId", "language"?}` | `{"episodeId", "sourceId", "media": {"kind", "url": "/p/…"}, "languages", "expiresAt", "link"}` |
| `PUT /api/v1/admin/companion/links/:episodeId/:sourceId` | `{"offsetMs", "rate", "language"?}` | `{"link": {episodeId, sourceId, offsetMs, rate, language, updatedAt}}` |
| `POST /api/v1/admin/companion/links/:episodeId/:sourceId/copy-to-item` | | `{"updated", "episodeIds"}`: the same values written for every other episode of the item that has a source with that id |

`link` = `{"offsetMs", "rate", "language", "updatedAt"}` (`updatedAt` null = defaults, nothing stored). Errors:
`404 unknown_episode`, `404 unknown_source`, `403 not_allowed`, `400 unsupported_media` (DASH, MPEG-TS), `404 no_link`
(copy without a stored link), `502 no_playable_source`.

### TV app

The server keeps one TV app APK, the **current** one, and offers it to every TV ([TV app updates](#tv-app-updates)).
It comes from the owner's uploads, or with `appUpdates.source: "github"` ([Configuration](#configuration)) from the
latest release of `appUpdates.repo`: a minute after the server starts, then every `checkIntervalHours`, and on
demand. This APK is the one thing the server fetches, and only verified against the release's `SHA256SUMS`. It does
not check the APK's signature: Android refuses an update not signed like the installed app.

| Route | Scope | Body | Response |
|---|---|---|---|
| `GET /api/v1/admin/app` | `read` | | `{"apk": StoredApk \| null, "source": "github"\|"manual", "repo", "auto", "checkIntervalHours", "check": {"lastAt", "nextAt", "result": "fetched"\|"up_to_date"\|"failed"\|null, "reason", "running"}}` |
| `PUT /api/v1/admin/app/apk` | `manage` | the APK's bytes, `Content-Type: application/vnd.android.package-archive`, file name in `X-Izle-Filename` (or `?name=`) | `200 {"apk": StoredApk}` |
| `DELETE /api/v1/admin/app/apk` | `manage` | | `204` (every TV stream gets `event: app` `{"versionCode": 0}`); `404 no_apk` |
| `POST /api/v1/admin/app/check` | `manage` | | `200 {"result", "reason", "apk": StoredApk \| null}` |

`StoredApk` = `{"versionName", "versionCode", "sha256", "size", "source": "github"|"upload", "releaseTag": "v0.3.0" |
null, "storedAt"}`. `versionCode` comes from the file name as the app's build computes it (`X·10000 + Y·100 + Z`,
a `-suffix` ignored). Storing an APK (upload or fetch) replaces the previous one and sends `event: app` to every TV.
`source`, `repo`, `auto` and `checkIntervalHours` are the server's `appUpdates` configuration.

- **Upload:** the file name must be `izle-tv-X.Y.Z[-suffix].apk`
  (`^izle-tv-(0|[1-9]\d*)\.([1-9]?\d)\.([1-9]?\d)(-[0-9A-Za-z.-]+)?\.apk$`, at most 128 characters), else
  `400 invalid_filename`; another media type `400 unsupported_media_type`; a body that does not start like a zip
  (`PK\x03\x04`) `400 not_an_apk`; more than 64 MiB `413 apk_too_large` (`maxBytes`). A body refused part-way is still
  read to its end (up to `maxBytes` more bytes), so a client that is still sending gets the answer.
- **Check:** `GET /repos/<repo>/releases/latest` (GitHub's API, `User-Agent: izle-server/<version>`, 30 s); the release
  must not be a prerelease, its tag must be `vX.Y.Z`, and it must carry the assets `izle-tv-X.Y.Z.apk` (never the
  `-debug` build) and `SHA256SUMS` (≤ 16 KiB, `<sha256>  <name>` lines). When the listed sha256 is the stored APK's, the
  stored APK's versionCode is higher than the release's, or the stored APK is an upload with the release's versionCode
  (a patched build: its `-suffix` leaves the versionCode alone), the result is `up_to_date` and nothing is downloaded (a
  fetched APK of the release's version with another sha256 is fetched again: the asset was re-published); otherwise the
  APK is downloaded (5 min) and stored if its sha256 matches: `fetched`. Anything else is `failed` with a `reason` and
  leaves the stored APK as it was: `network` (also a timeout), `http_<status>`, `rate_limited` (403/429), `no_release`,
  `bad_release` (not a release object, or over 1 MiB), `prerelease` (also a draft), `bad_tag`, `no_apk_asset`,
  `no_checksums`, `checksums_too_large`, `checksum_missing`, `checksum_mismatch`, `too_large`, `not_an_apk`, `internal`.
  `409 github_disabled` with `source: "manual"`, `409 check_running` while a check runs.
- The bytes are kept as `<dataDir>/app/<sha256>.apk` (not in the database, so not in a backup): a server whose
  APK file is gone forgets the APK at start, and the next check fetches it again.

## Remote management

The viewer only watches; the TV is run from elsewhere, by the owner on the admin page, the owner's own apps or AI
agents, all through these routes (an MCP server for agents is a thin wrapper with an [access token](#access-tokens),
not part of the server). One family per server: every token sees every TV. Whether an agent must ask before acting
is decided where the agent is set up, not by the server.

### Access tokens

The admin token (the **owner token**) keeps full access. The owner creates named **access tokens**, each with one
scope, and revokes them at any time:

| Scope | Allows |
|---|---|
| `read` | every `GET` admin route except `GET /admin/tokens`: devices, catalog, problems, Listen along candidates, the pending pairing codes, [status](#status), [events](#events) and [history](#viewing-history) |
| `control` | `read`, plus [`POST …/commands`](#commands) (`update` included) |
| `manage` | `control`, plus the home list (`PUT …/home`, the [single changes](#home-list-changes) and the [sections](#home-sections)), `PUT …/cursor`, `PATCH /admin/devices/:id`, [history marks](#viewing-history), `DELETE …/problems`, `POST /admin/catalog/reload` and the [TV app](#tv-app) (`PUT`/`DELETE /admin/app/apk`, `POST /admin/app/check`) |

Every other route needs the owner token: pairing approval and clearing a code, deleting a TV, deleting and adopting
history, [checks](#checks) (`POST`/`DELETE`; reading them is `read`), [Listen along](#listen-along) resolves and links, and the access tokens themselves
(every method). A token that does not cover the route gets `403 insufficient_scope` with `required` (the scope it
needs, or `owner`); it does not count as a failed sign-in.

| Route | Body | Response |
|---|---|---|
| `GET /api/v1/admin/tokens` | | `{"tokens": [AccessToken]}`, oldest first |
| `POST /api/v1/admin/tokens` | `{"name", "scope"}` (`name`: 1–60 characters, trimmed, unique) | `201 {"token": AccessToken, "secret": "izat_…"}`; the secret is shown only here |
| `DELETE /api/v1/admin/tokens/:id` | | `204`; requests with that token answer `401` from now on, and an [event stream](#events) it has open ends at once (a long-poll answers `401`) |

`AccessToken` = `{"id", "name", "scope", "createdAt", "lastUsedAt"}` (`id`: 12 alphanumeric characters;
`lastUsedAt` is written at most once a minute). The secret is `izat_` and 32 random bytes base64url (the prefix lets
secret scanners recognize it, and the server tell it from the owner token); the server keeps its sha256. The admin
sign-in throttle ([Authentication model](#authentication-model)) counts a wrong or revoked one like a wrong owner
token, so an app that keeps sending a revoked token locks its address out for 10 minutes: stop the app before
revoking. Errors: `409 duplicate_name`, `404 unknown_token`. `izle-server token create <name> --scope <scope>`
(prints the secret once), `token list` and `token revoke <id>` call these routes on the running server.

`Actor` (who caused a change or an event) = `{"type": "owner"}`, `{"type": "token", "tokenId", "name"}` (the name at
that moment), `{"type": "tv", "deviceId"}` (the viewer, with the remote; also what the TV reports and its
connections) or `{"type": "server"}` (a catalog reload by `SIGHUP`, a viewing that timed out, housekeeping, the
start). Consumers MUST ignore unknown actor types.

### Status

`GET /api/v1/admin/status` → `{"serverNowMs", "server": {"version"}, "catalog": {"id", "buildId"},
"pairing": {"pending"}, "devices": [{"id", "name", "online", "lastSeenAt", "nowPlaying"}], "lastEventId"}`: every
active TV in one call. `nowPlaying` is the object of [`GET …/now`](#devices) while the TV has a running
[viewing](#viewing-history), else null (`GET …/now` itself keeps answering the last report, with its `state`); its
`viewingId` (here and in `GET …/now`) is the running viewing, or null once it ended. `lastEventId` is read first, so
the [events](#events) after it miss nothing (a change in between shows twice).

**Online.** A TV is online while it has an event stream open, and for 60 s after its last one closed (a reconnect does
not flap). `online` everywhere follows this rule; at start every TV is offline until it connects.

### Events

Everything worth reacting to is appended to a stored event log, kept for `events.retentionDays`; the
[viewing history](#viewing-history) is the permanent record.

`Event` = `{"id": 1234, "at": "…", "type": "playback.started", "deviceId": "…" | null, "actor": Actor, "data": {…}}`.
`id` increases strictly, in the order the changes were stored (an event is written in the transaction of its change).
Events carry no URLs, headers, refs, tokens, message texts or problem details.

- **Stream:** `GET /api/v1/admin/events/stream?after=&devices=&types=`, server-sent events as for
  [`/tv/events`](#get-apiv1tvevents): each event as `id: <id>`, `event: <type>`, `data: <Event>`, starting after
  `after`, else after `Last-Event-ID` (without either: new events only); `retry: 5000`, a `: ping` comment every
  20 s. The token goes in the `Authorization` header, never in the query string (the admin page reads the stream
  with `fetch`, since `EventSource` cannot set it). A replay sends at most the newest 500 events; when more were
  stored after `after`, it starts with `event: gap`. A client that stops reading while events keep coming is
  disconnected (it reconnects with `Last-Event-ID`). At most 10 streams are open at once per access token, and per
  client address for the owner token; one more answers `429 too_many_streams` (`Retry-After`).
- **Long-poll:** `GET /api/v1/admin/events?after=&wait=&limit=&devices=&types=` → `{"events": [Event], "last",
  "gap"}`, oldest first (`limit` ≤ 500, default 100); with no event after `after` it waits up to `wait` seconds (0–25,
  default 0), for clients that cannot keep a stream open (MCP tools, scripts). `last` is the id of the last event
  returned, else `after`; without `after` the answer is empty at once and `last` is the newest id, to follow from.
- **Filters:** `devices`: device ids, comma-separated (events without a device pass); `types`: types or prefixes
  ending in `.`, comma-separated (`playback.,command.result`).
- **Gap:** when `after` is older than the oldest kept event, events were lost: `gap: true` and the kept events from
  the oldest on (the stream sends `event: gap` `{"oldest"}`, the first id it sends). The consumer re-reads
  [`/admin/status`](#status) and what it needs from the history.

| `type` | `data` |
|---|---|
| `server.started` | `{"version"}`: the server (re)started; every TV is offline until it connects, and streams have to be reopened |
| `device.online` / `device.offline` | `{}`, by the rule under [Status](#status) |
| `device.paired` | `{"name", "replaced"}`: a TV collected its token; `replaced: true`: it took over an existing TV ([Replacing a TV](#replacing-a-tv)) |
| `device.updated` / `device.removed` | `{"fields"}` (names of the settings the `PATCH` sent, `name` included) / `{"name"}` |
| `device.app_version` | `{"from", "to", "versionCode", "androidSdk", "capability"}`: the TV's [User-Agent](#tv-api) reports another app version, Android version or capability (`from`: the version before, null the first time); the TV is the actor |
| `app.uploaded` / `app.fetched` | `{"versionName", "versionCode", "source": "upload"}` / `{"versionName", "versionCode", "source": "github", "releaseTag"}`: a new [TV app](#tv-app) APK is on offer |
| `app.removed` / `app.check_failed` | `{"versionName"}` / `{"reason"}` (a GitHub check failed; the server is the actor of a scheduled check) |
| `pairing.pending` | `{"code", "expiresAt"}`: a TV shows a new pairing code; the server is the actor (the TV has no id yet) |
| `pairing.cancelled` | `{"code"}`: the owner cleared a waiting code ([`DELETE …/pair/pending/:code`](#delete-apiv1adminpairpendingcode)) |
| `playback.started` | `{"viewingId", "itemId", "itemKind", "itemTitle", "episodeId", "episodeTitle", "season", "number", "sourceId", "positionMs", "trigger"}`: a [viewing](#viewing-history) starts (its first resolve; the re-resolves that continue it send nothing); `positionMs` is where it will start |
| `playback.paused` / `playback.resumed` | `{"viewingId", "positionMs"}`: a `paused` report / a `playing` report after one; never for a channel |
| `playback.seeked` | `{"viewingId", "fromMs", "toMs"}`: a report's position is more than 10 s from where playback should be (see [`coveredFraction`](#viewing-history)); never for a channel |
| `playback.stalled` / `playback.recovered` | `{"viewingId", "positionMs"}`: a `playing` report with `playing: false` / the next one with `playing: true` (a `paused` report in between is a pause, not a recovery) |
| `playback.ended` | `{"viewingId", "endReason", "seen", "positionMs", "watchedMs", "dropped"}`; `dropped: true`: the viewing was too short to keep, its id is gone |
| `episode.seen` | `{"viewingId", "itemId", "episodeId", "firstTime", "itemFinished"}`: a viewing ended [seen](#viewing-history); `firstTime`: the episode was not seen before (by any TV, or a mark); `itemFinished`: every playable episode of the item in the current catalog is now seen (false when the item left it) |
| `command.sent` / `command.delivered` | `{"commandId", "type", "online"}` / `{"commandId"}` (the TV acknowledged it) |
| `command.result` | `{"commandId", "type", "result", "reason"}`, see [Remote play and command results](#remote-play-and-command-results) |
| `home.changed` | `{"itemIds", "added", "removed"}` (`itemIds` in Home order; the ids that came and went; a reorder, a move to another section and a change of [sections](#home-sections) alone have both empty) |
| `cursor.changed` | `{"itemId", "episodeId"}`: set through `PUT …/cursor` (not the moves that come from watching) |
| `problem.recorded` | `{"problemId", "origin", "kind", "code", "itemId", "episodeId"}` |
| `catalog.reloaded` / `catalog.reload_failed` | `{"buildId", "added", "removed"}` (`{"items", "episodes"}` counts as in [`Build`](#catalog-history), 0 when the build was the one already loaded) on every successful reload, not at start / `{"issues"}` (their number) |
| `history.changed` | `{"episodeIds", "seen"}` (marks), `{"deleted"}` (viewings deleted) or `{"moved"}` (viewings adopted, `deviceId`: the TV that got them) |
| `check.started` / `check.finished` | `{"runId", "total"}` / `{"runId", "total", "failed", "warned", "state"}` (`done` or `cancelled`): a [check run](#checks) started / ended; `deviceId`: the TV of a Home run |

Ordering within one change: when a resolve replaces a running viewing, `playback.ended` comes before
`playback.started`; `episode.seen` follows its `playback.ended`. New types and fields are added within v1; consumers
MUST ignore those they do not know.

### Viewing history

A **viewing** is one playback of one episode or channel on one TV; a TV has at most one running viewing. It starts
with a successful TV resolve and ends with a `stopped` or `finished` report, with the TV resolving something else, or
with silence. Pauses and seeks (skipping an intro, a recap or the credits) stay within the viewing. A resolve of the
same item and episode by the same TV while its viewing runs continues it (the re-resolves after a player error, for an
expired stream, a channel's after 12 h and "Try again" go on at the same position, a channel at its live edge); a
viewing never reopens once it ended. A report is applied to the TV's running viewing when it names that viewing's
episode (or channel), and otherwise ignored by the history (the saved position and the cursor take it all the same).
Viewings are **never deleted automatically** and outlive catalog builds and the removal of the TV: each keeps a copy
of the titles it was watched under. Like every stored reference, the history is scoped by `catalogId`: its lists,
summaries, marks and deletions cover the loaded catalog's viewings only.

`Viewing` = `{"id", "deviceId", "deviceName", "itemId", "itemKind", "itemTitle", "episodeId", "episodeTitle",
"season", "number", "sourceId", "startedAt", "endedAt", "startPositionMs", "endPositionMs", "durationMs",
"watchedMs", "endReason", "seen", "trigger", "actor", "commandId"}`:

- `id` is an integer. Titles, `season`, `number`, `itemKind` and `deviceName` are copied when the viewing starts;
  `sourceId` is the source played last; `durationMs` is the reports' duration, else the catalog's, else null.
- `startPositionMs`: the position of the first report (until it arrives, the resume position the server offered);
  `endPositionMs`: the position of the last report (a `finished` report: the duration).
- `watchedMs`: how long the player actually advanced: for each two consecutive reports of which the first had
  `playing: true`, the time between them (by the reports' anchors, `receipt − ageMs`), at most 60 s.
- `endReason`: `finished` (a `finished` report), `stopped` (a `stopped` report), `replaced` (the TV resolved another
  episode or channel), `lost` (silence: no report for 2 minutes while the last one said `playing` or none came yet,
  or the TV offline for 2 minutes whatever the last report said; a paused TV that stays online keeps its viewing
  running). A lost viewing ends at its last report (or its resolve). `endedAt` and `endReason` are null while it runs.
- `seen`: the viewing reached the end of the episode (see below); false while it runs, and for a channel.
- `trigger`: `viewer` (OK on Home, the episode list or Start over in the menu), `autoplay` (autoplay on start),
  `next` (auto-next, Up next's Play now, CH+/CH− between episodes or between channels), `command` (a remote `play`,
  `next` or `previous`; `actor` is who sent it and `commandId` names it) or `unknown` (a TV that does not say). Try
  again and the re-resolves repeat the trigger of the playback they continue. The TV says it in
  [`POST /tv/resolve`](#post-apiv1tvresolve). Other triggers have the TV as `actor` and a null `commandId`.
- A viewing that ends not `seen` with `watchedMs` under 10 s is dropped (a mis-press; a source that failed straight
  away is in the [problem reports](#problem-reports)); its `playback.ended` event says `dropped: true`.
- A channel's viewing has no played ranges, and its `endReason` is never `finished`; `watchedMs`, the drop rule and
  the `lost` rule apply as to an episode.

A viewing is **seen** when it ends with a `finished` report, or ends (`stopped`, `replaced`, `lost`) at 90 % of
`durationMs` or later. The TV reports `finished` at the end of the stream and when the viewer leaves within its
credits allowance (the last 2 minutes or 5 % of the duration, whichever is longer, at most 10 %); the 90 % rule also
catches the longer credits of films. Parts skipped on the way do not matter: reaching the end is what counts. The
90 % rule is the history's only: the TV's tiles and resume position follow its own `finished` reports, and a mark
changes nothing on the TV (that is `PUT …/cursor`).

An episode is **seen** when one of its viewings is seen, unless the owner marked it otherwise (a mark wins). A movie
is its single episode. The history covers all TVs of the server (the family) unless a route is given `device`; marks
are the family's, so `device` narrows the viewings and the counts, not `seen`.

| Route | Body | Response |
|---|---|---|
| `GET /api/v1/admin/history/viewings?device=&item=&episode=&from=&to=&before=&limit=` | | `{"viewings": [Viewing], "next"}`: newest first (by `startedAt`, then id), running ones included; `from`/`to` (ISO) bound `startedAt`; `limit` ≤ 200 (default 50); `next` (a viewing id, or null) is the `before` of the next page |
| `GET /api/v1/admin/history/viewings/:id` | | `{"viewing": Viewing, "ranges": [[fromMs, toMs], …]}`: the ranges played at least once, merged, in position order (empty for a channel's); `404 unknown_viewing` |
| `GET /api/v1/admin/history/titles?device=&status=&sort=&limit=` | | `{"titles": [TitleSummary]}`: titles with a viewing or a mark; `sort`: `recent` (default, last watched first), `watched` (most `watchedMs`), `title` (as the catalog search orders); `status`: one or more statuses, comma-separated; `limit` ≤ 500 (default 100) |
| `GET /api/v1/admin/history/titles/:itemId?device=` | | `{"title": TitleSummary, "episodes": [EpisodeHistory]}` (`episodes: []` for a channel); `404 unknown_item` (never in the catalog nor the history) |
| `GET /api/v1/admin/history/days?device=&from=&to=&tz=` | | `{"days": [{"date", "watchedMs", "viewings", "items": [{"itemId", "title", "watchedMs"}]}]}`: one entry per calendar day with a viewing, in `tz` (an IANA zone, default the server's), a viewing counted on the day it started; `from`/`to` are dates, default the last 30 days, at most 366 days; `400 invalid_request` for an unknown zone |
| `POST /api/v1/admin/history/marks` | `{"episodeIds": [...], "seen": true \| false \| null}` (1–500 ids, each in the catalog or the history) | `{"updated"}`; `null` removes the marks; `400 unknown_episode` (`episodeId`; channels are never marked) |
| `DELETE /api/v1/admin/history?device=&olderThan=` | | `{"deleted"}`: viewings (of that TV, started before `olderThan`, ISO; without them, all) are deleted, running ones too; owner token only |
| `DELETE /api/v1/admin/history/viewings/:id` | | `204`; `404 unknown_viewing`; owner token only |

`TitleSummary` = `{"itemId", "kind", "title", "inCatalog", "firstWatchedAt", "lastWatchedAt", "viewings",
"watchedMs", "status", "episodes": {"total", "seen", "started"}, "seasons": [{"season", "total", "seen",
"started"}], "rewatches", "shortViewings"}`:

- `title` and `kind` come from the current catalog, else from the newest viewing. `inCatalog: false`: the item left
  the catalog; `total` then counts the episodes seen or started.
- `total`: the item's playable episodes; `started`: episodes with a viewing; `seen`: by the rule above. `seasons` by
  `season` (null: episodes without one), series only.
- `status`: `finished` (every playable episode seen), `new_episodes` (every unseen playable episode entered the
  catalog after `lastWatchedAt`, by the [catalog history](#catalog-history)), `watching` (else, with a viewing in the
  last 30 days), `idle` (else: nothing watched for 30 days and nothing new, which is also a show between seasons).
- `rewatches`: seen viewings of an episode beyond its first seen one (marks do not count). `shortViewings`: ended
  viewings that are not seen, with `watchedMs` under 10 minutes (a hint that the title did not hold the viewer).
- A channel: `episodes` is null, `seasons` `[]`, `rewatches` 0 and `status` `watching` or `idle`, by the 30-day rule.

`EpisodeHistory` = `{"episodeId", "season", "number", "title", "inCatalog", "seen", "seenAt", "mark", "viewings",
"watchedMs", "coveredFraction", "lastWatchedAt", "lastPositionMs"}`, in play order, then the episodes that left the
catalog:

- `seenAt`: when the episode was first seen: the end of its first seen viewing, or the time of a `true` mark when
  that is earlier; null while not seen. `mark`: `true`, `false` or null (none).
- `coveredFraction`: the share of the episode's duration played at least once, over all its viewings (0–1, two
  decimals): the union of the position ranges between consecutive reports while the player advanced. Where playback
  should be at a report is the previous report's position, plus the time since its anchor when it said
  `playing: true`; a report more than 10 s from there is a seek (`playback.seeked`): it covers nothing and the next
  range starts at it. Null without a known duration. For information only: `seen` with a low `coveredFraction` means
  the end was reached by skipping.

### Remote play and command results

- **Any catalog item plays**, on the TV's home list or not: [`play`](#commands) needs a playable episode, or a
  channel with `playbackAllowed: true`. The item does not join the home list; Back returns to Home as always.
- **`play` by item:** `{"type": "play", "itemId"}` plays what OK would play for that item on this TV
  ([Play order](#play-order-and-the-cursor)), resolved by the server when the command is sent, or a channel. One of
  `itemId` and `episodeId` is required; with both, the episode must belong to the item (`400 unknown_episode`).
  `404 unknown_item`, `400 not_playable` (no playable episode, or a channel with `playbackAllowed: false`).
- **`play` at a position:** optional `positionMs` (integer 0…10¹²; `0` starts over) instead of the saved position;
  the payload carries it, except for a channel.
- **Results:** after acting on a command (or deciding not to) the TV reports
  `POST /api/v1/tv/commands/:id/result` `{"result": "done" | "ignored" | "failed", "reason"?}` → `{"ok": true}`;
  `404 unknown_command` (not this TV's), `409 already_reported`. `play` reports `done` once playback runs and
  `failed` when it ends on "Can't play right now"; the other commands report right away. `reason` (1–64 characters
  of `A-Z a-z 0-9 _ . : -`): `not_in_player` (a transport command without video showing), `not_ready` (the TV is on
  the pairing or server address screen), `no_episode` (`next`/`previous` at the end of the item), `live` (`pause`,
  `resume` or `seek` while a channel plays), `no_channel` (`next`/`previous` with no channel after / before the
  playing one), `unknown_type`, `no_playable_source` (the resolve found nothing) or `playback_error`; consumers MUST
  accept others. The acknowledgement stays separate and immediate, so a slow start is never replayed; the result is
  sent with the same retries as a final progress report, and stays null when it never arrives.
- `GET /api/v1/admin/devices/:id/commands/:commandId` → `{"command": {"id", "type", "payload", "actor",
  "createdAt", "deliveredAt", "result", "reason", "resultAt"}}` while the command is stored (7 days);
  `404 unknown_command`. `deliveredAt` is when the TV acknowledged it.

### Home list changes

Single changes, so that two editors (the owner, an agent) do not overwrite each other's lists:

| Route | Body | Response |
|---|---|---|
| `POST /api/v1/admin/devices/:id/home/items` | `{"itemId", "sectionId"?, "position"?}` (`sectionId` default `untitled`; `position` 0-based within the section, default and upper bound: its end) | `{"version", "home", "sections"}` |
| `PATCH /api/v1/admin/devices/:id/home/items/:itemId` | `{"position"?, "sectionId"?}`, at least one (`sectionId`: move it to that section; `position` 0-based within the section it ends up in, clamped to its end; default the end when the section changes) | `{"version", "home", "sections"}` |
| `DELETE /api/v1/admin/devices/:id/home/items/:itemId` | | `{"version", "home", "sections"}` |

Errors as for `PUT …/home`, plus `404 not_on_home` and `404 unknown_section`; every change emits `home.changed`.
`PUT …/home` takes an optional `expected` (what the caller saw, in the shape of the body: the `itemIds`, or the
`sections`): `409 home_changed` (with the current `itemIds` and `sections`) when the list is no longer that.

### Home sections

A TV's Home list is cut into **sections**, in an order the owner sets; every item on the list is in exactly one
section. `Section` = `{"id", "title", "layout", "itemIds"}`:

- `id`: 8 alphanumeric characters, made by the server; `untitled` for the untitled section.
- `title`: 1–40 characters with a non-space, trimmed; titles need not be unique. The TV shows it above the section.
- `layout`: `grid` (the default: the cards wrap in rows of `homeColumns`) or `row` (one line of cards that scrolls
  sideways). New layouts may be added within v1.
- `itemIds`: the section's items in display order, those gone from the catalog or unplayable included (the TV's
  [state](#get-apiv1tvstate) leaves them out, and with them the sections left empty).

There is always exactly one **untitled section** (`"id": "untitled"`, `"title": null`). It holds what was put on Home
without a section: it cannot be titled or deleted, and it is moved and given a layout like any other. A new TV has
only the untitled section (layout `grid`); a new section goes after the existing ones. Besides the untitled section a
Home has at most 20 (`sectionsMax`). **Home order** is the sections in order, each with its items in order: the order
of `home` in the TV's state and on the admin page, of `itemIds` in `home.changed`, and of CH+/CH− among channels.

| Route | Body | Response |
|---|---|---|
| `POST /api/v1/admin/devices/:id/home/sections` | `{"title", "layout"?, "position"?}` (`position` 0-based among the sections, default and upper bound: the end) | `{"version", "home", "sections", "sectionId"}` (the new section's) |
| `PATCH /api/v1/admin/devices/:id/home/sections/:sectionId` | any of `title`, `layout`, `position` (clamped to the end) | `{"version", "home", "sections"}` |
| `DELETE /api/v1/admin/devices/:id/home/sections/:sectionId` | | `{"version", "home", "sections"}`; its items move to the end of the untitled section, in their order: deleting a section takes nothing off Home |

`PUT …/home` takes either form:

- `{"itemIds"}` sets which items are on Home and their order, and keeps the sections: an item already on Home stays in
  its section, a new one goes to the untitled section, and within each section the items follow their order in
  `itemIds`. The answer's `home` is in Home order, which can differ from the body's.
- `{"sections": [{"id"?, "title", "layout"?, "itemIds"}]}` replaces the whole Home, sections in display order. A section
  without `id` is new; a titled section left out is deleted, and its items leave Home unless another section lists
  them. Without `layout` a section keeps its own (`grid` for a new one). The untitled section (`"id": "untitled"`,
  `title` null or absent) is listed exactly once.

Errors: `400 too_many_sections` (`max`), `404 unknown_section` (`sectionId`, also an `id` in `PUT …/home` that is not
this Home's), `400 untitled_section` (a title for the untitled section, deleting it, or a `PUT` that does not list it
exactly once), `400 duplicate_section` (an `id` twice in one `PUT`), `400 invalid_request` (a blank or too long title,
an unknown layout); `duplicate_item` covers the item in two sections. Every change bumps the state version and emits
`home.changed`.

### Replacing a TV

[`POST /admin/pair/approve`](#post-apiv1adminpairapprove) takes an optional `replaces` (the id of an active device;
`404 unknown_device` otherwise): no new device is created; when the TV collects its token it takes over that device,
with its id, name, settings, home list, progress, cursors and history, and the old TV's token stops working (the old
TV then shows a pairing code by itself, as after a deletion). Until the code is collected the device is unchanged,
and a code that expires uncollected changes nothing. `device.paired` says `replaced: true`. The approval answers
that device's id and name (a `name` given with `replaces` is ignored; `PATCH` renames).

Viewings of a deleted TV keep its id and name; `POST /api/v1/admin/devices/:id/history/adopt` `{"fromDeviceId"}` →
`{"moved"}` gives them to an existing TV, under its name (owner token only; `404 unknown_device` for `:id`,
`409 device_exists` while `fromDeviceId` is still a device); `history.changed` follows when any moved.

## Static routes

| Route | |
|---|---|
| `GET /healthz` | `{"ok": true}` |
| `GET /assets/<sha256>.<jpg\|png\|webp>` | catalog posters, `Cache-Control: public, max-age=31536000, immutable` |
| `GET /admin/` | the admin UI (`/` and `/admin` redirect here): `index.html` plus the allow-lists `ADMIN_FILES` and `ADMIN_VENDOR_FILES` in `server/src/admin-files.ts` (the ES modules flat in `server/admin/`, entry `app.js`; `style.css`, `icon.svg`, and the pinned hls.js build `vendor/hls.min.js`, see `server/admin/vendor/README.md`); anything else under `/admin/` is `404`; `Cache-Control: no-cache`, `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; …` |
| `GET /p/<token>/…` | [media proxy](#media-proxy) |

## Logging

One JSON object per line on stdout: `time`, `level`, `msg` and fields. Every line passes through one redaction step:
fields whose name contains a word like `url`, `uri`, `href`, `header(s)`, `authorization`, `cookie`, `token`, `ref`,
`config`, `playlist`, `password`, `secret` or `body` are dropped; a string starting with `#EXTM3U` becomes `<playlist>`;
`scheme://…` and protocol-relative `//host…` in strings become `<url host>`; runs of 20 or more base64url characters
become `<token>`, except a whole value of at most 120 characters in a top-level `catalogId`, `buildId`, `itemId`,
`episodeId`, `sourceId` or `adapterId` field (or each string of an `adapters` list) made of words joined by `-`, `.`,
`_` or `~`, each a lowercase, capitalized or CamelCase word or a run of at most 16 letters and digits of one case
(`20261023-78ece5b2deea`, `BigBuckBunny-2008.S01E01`), and not containing a UUID, or in `code` an identifier like
`ERROR_CODE_IO_BAD_HTTP_STATUS`, which is written as given; errors are reduced to their class name (an identifier of at
most 60 characters, else `Error`) and a short `code`, written as given when it is such an identifier. The access log
records the **route template** (e.g. `/api/v1/tv/items/:itemId`), status, duration and device id, never the raw path or
query; health checks and successful proxy requests at `debug` level only, proxy errors at `info`. Commands are logged
with their type and ids (never a message's text), problem reports with their kind and code (never their detail), a
request made with an [access token](#access-tokens) with the token's id (field `actorId`, since a key containing `token`
would be dropped), never the secret. The TV app APK is logged with its version, size, source and the first 12 hex digits
of its sha256 (`sha256Prefix`), never the whole digest, a file path or a download URL; a failed GitHub check with its
`reason` and `repo`.

## Configuration

`izle-server --config izle.json`; every key is optional, unknown keys are errors, relative paths resolve against the
file's directory:

```json
{
  "listen": { "host": "0.0.0.0", "port": 8787 },
  "publicUrl": "https://izle.example.org",
  "trustedProxies": ["127.0.0.1", "::1"],
  "dataDir": "./data",
  "catalog": { "dir": "./sample-catalog" },
  "resolver": { "module": "/opt/izle/resolver/index.js", "config": {}, "deadlineMs": 12000, "budgetMs": 30000 },
  "admin": { "tokenFile": "./data/admin.token" },
  "proxy": { "always": false, "sessionTtlSec": 21600, "alignTsSegments": false, "privateUpstreams": [] },
  "defaults": { "uiLanguage": "en", "preferredAudioLanguage": "en" },
  "log": { "level": "info" },
  "events": { "retentionDays": 7 },
  "appUpdates": { "source": "github", "repo": "mickeiik/izle", "checkIntervalHours": 24, "auto": true }
}
```

Without a file the server listens on `0.0.0.0:8787`, serves the sample catalog shipped with it and keeps its data
in `./data` (`izle.db`, `admin.token`). Deployment: [self-hosting](../deploy/self-hosting.md).

The example's values are the defaults, except the samples for `publicUrl`, `trustedProxies` (default `[]`),
`resolver` (its `deadlineMs` and `budgetMs` are the defaults) and `defaults`, which otherwise are null.

- `publicUrl`: the address izle is reached at, base of the `admin-token --link` sign-in link.
- `trustedProxies`: IP addresses or CIDR ranges (IPv4 or IPv6) of reverse proxies in front of the server. For a
  request whose socket address is listed, the client address is taken from `X-Forwarded-For`, walking from the right
  past further trusted hops. It is used only for the `pair/start` limits and the admin sign-in throttle; without the
  setting, all clients behind a proxy share them.
- `catalog.dir` (default: the sample catalog) and `resolver.module` are local paths, never downloaded;
  `resolver.config` is handed to the module as `ctx.config` (never logged), which gets `<dataDir>/resolver` as its
  own directory; `deadlineMs` and `budgetMs` (100–120000) bound one adapter call and one TV resolve request.
- `admin.tokenFile` (default `<dataDir>/admin.token`); `IZLE_ADMIN_TOKEN` in the environment wins over it.
- `proxy.always` sends every HLS/MP4/MPEG-TS stream through the proxy; `proxy.sessionTtlSec` (60–86400) is the
  sliding session lifetime; `proxy.privateUpstreams` (at most 64): the loopback, private or link-local upstreams the
  proxy may reach anyway, each a host name (`nas.lan`, any address it resolves to), an IP address or CIDR range
  (`192.168.1.20`, `10.0.0.0/8`), or one of those with a port (`127.0.0.1:8788`, `[::1]:9000`, `nas.lan:8080`),
  which then matches that port only.
- `defaults`: `uiLanguage` (`tr`/`en`) and `preferredAudioLanguage` (a language tag) for devices without their own;
  null falls back to the catalog's hints. `log.level`: `debug`, `info`, `warn` or `error`.
- `events.retentionDays` (1–90): the housekeeping that runs every 10 minutes deletes older events.
- `appUpdates` ([TV app](#tv-app)): `source` `github` or `manual` (only uploads; no request); `repo` (`owner/name`);
  `checkIntervalHours` (1–168); `auto`: TVs that can install silently update by themselves when idle.

## Changelog

- **v1 (2026-10-10)** — initial version.
- **v1, before the first deployment (2026-10-11 to 2026-10-22)** — changed in place, some changes breaking
  (pre-release): Listen along, remote management (access tokens, status, events, viewing history, command results,
  single home changes, replacing a TV), TV app updates, proxy destinations, the pairing pool, the home grid and
  backdrops, live channels, catalog browsing and home sections ([CHANGELOG.md](../../CHANGELOG.md) has the releases).
- **v1, in izle 0.6.0 before the first deployment (2026-10-23)** — [checks](#checks):
  `POST /admin/diagnostics/resolve` follows each source down to media bytes and stores its report; its `probe` field
  (request and answer) is replaced by `steps`, `codecs`, `warnings`, `verdict` and `checkMs`, breaking (pre-release).
  Added: check runs (`/admin/checks`), stored reports, `check` in catalog items and TV Home entries (with
  `checkAll`), the `check.*` events.
- **v1 (izle 0.6.0, 2026-10-23)** — the first deployment; from here on v1 changes only additively (see the top of
  this text).
- **v1 (2026-10-23)** — [logging](#logging): catalog ids in their own top-level fields (`catalogId`, `buildId`,
  `itemId`, `episodeId`, `sourceId`, `adapterId`, `adapters`) and identifier-shaped codes (`code`, an error's `code`)
  are written as given instead of `<token>`; nothing else changes.
