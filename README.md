# izle

A senior-first Android TV player with a small self-hosted server.

izle is built for a viewer who only knows classic TV: switch on, pick a "channel", it plays. The TV shows one
screen of big poster tiles. OK plays the next unwatched episode (or resumes the half-watched one), episodes
advance on their own, and Back always returns to that single home screen. There is no browsing, no seasons
list, no settings in the viewer's path.

Everything else is done remotely by the owner from the server's admin page: which shows are on the home screen and
in what order, "continue from episode X", languages, playback control. The owner's phone can also **listen along**:
it plays another source of the episode the TV is showing (a dub in another language) in sync with the picture, with
an adjustable offset and speed for releases that differ in timing. The TV app always talks to the server; there is
no standalone mode.

## Bring your own catalog

izle ships no content of its own. The server reads a **catalog bundle** — a data-only directory described by a
versioned contract — and, optionally, a **resolver module** the owner writes to turn catalog references into
playable streams at play time. A small [sample catalog](sample-catalog/) of openly licensed films (Blender
Foundation open movies and public-domain titles) is included and served by default.

- Catalog bundle contract: [`docs/spec/catalog-bundle-v1.md`](docs/spec/catalog-bundle-v1.md); check a bundle with
  `npx izle-validate <dir>` (`--probe` also range-GETs every media URL)
- Resolver module API: [`docs/spec/resolver-module-v1.md`](docs/spec/resolver-module-v1.md), with a runnable
  [example module](server/examples/resolver-example/README.md)
- Server API: [`docs/spec/server-api-v1.md`](docs/spec/server-api-v1.md)

Streams that need upstream request headers (a `Referer`, say) or come as playlist text are served to the TV through
the server's media proxy, so those headers and the upstream URLs never reach the TV.

## Repository layout

| Path | What |
|---|---|
| `contract/` | `@izle/contract` — bundle types, JSON Schema, validator, `izle-validate` CLI |
| `server/` | `@izle/server` — Hono + `node:sqlite` server: pairing, TV and admin APIs, live events, resolver modules, media proxy, admin page (`server/admin/`) |
| `server/examples/resolver-example/` | example resolver module with a local stand-in upstream and catalog |
| `sample-catalog/` | sample bundle of openly licensed content |
| `android/` | Android TV app (Kotlin, Compose for TV, Media3) |
| `scripts/` | release tooling: server package build (`pack-server.mjs`) and smoke test, version bump/check |
| `Dockerfile` | container image of the server package |
| `docs/` | specs, [TV UX](docs/ux/senior-tv.md), [self-hosting](docs/deploy/self-hosting.md), [releasing](docs/releasing.md), [decision log](docs/decisions.md) |

Status: early development. The server, the TV app (English and Turkish), the admin page and the self-hosting setup
are implemented; private catalogs and their resolver modules live outside this repository.

## Self-hosting

Each [release](https://github.com/mickeiik/izle/releases) has the server as one dependency-free package
(`izle-server-X.Y.Z.tgz`, Node.js ≥ 22.13) and the TV app as an APK; [CHANGELOG.md](CHANGELOG.md) says what
changed. Installing the server (systemd, HTTPS with Caddy, Docker), backups and installing the app on a TV: the
[self-hosting guide](docs/deploy/self-hosting.md). Making releases: [docs/releasing.md](docs/releasing.md).
Security problems are reported privately: [SECURITY.md](SECURITY.md).

## Development

Requirements: Node.js ≥ 22.13 and npm; for the TV app a JDK 21+ and the Android SDK. Every command (tests,
typecheck, packaging, resolver check, the emulator loop) is listed in [AGENTS.md](AGENTS.md#commands).

```bash
npm ci && npm test
npm run -w server dev -- --config server/izle.dev.json            # sample catalog on :8787, state in server/data/
npm run -s -w server dev -- admin-token --config server/izle.dev.json   # prints the admin token
```

Open `http://localhost:8787/admin/` and sign in with the token (`admin-token --link` prints a sign-in link and its
QR code for a phone). There the owner approves the pairing code a TV shows; per TV, picks and orders the home
screen's shows, sets "continue from episode X", the menu, audio and subtitle languages and autoplay on start, sees
and controls what is playing (play, stop, pause, resume, seek, skip episodes), sends a short message and sees the
problems the TV ran into (its own reports, and failed resolves or proxy requests the server saw); and reloads the
catalog and tests episode sources.

### Try the API with curl

The flow a TV and its owner go through ([server API](docs/spec/server-api-v1.md)). Needs `curl` and `jq`; run it in
a second terminal while the server is running.

```bash
B=http://localhost:8787; JSON='Content-Type: application/json'
ADMIN=$(npm run -s -w server dev -- admin-token --config server/izle.dev.json)
# 1. The TV asks for a pairing code and shows it on screen.
START=$(curl -s -X POST $B/api/v1/pair/start); CODE=$(echo "$START" | jq -r .code); PAIR=$(echo "$START" | jq -r .pairToken)
# 2. The owner approves it (or: npm run -s -w server dev -- pair approve $CODE Living room --config server/izle.dev.json).
curl -s -X POST $B/api/v1/admin/pair/approve -H "Authorization: Bearer $ADMIN" -H "$JSON" -d "{\"code\":\"$CODE\",\"name\":\"Living room\"}"; echo
# 3. The TV's long-poll receives its device token (exactly once).
WAIT=$(curl -s "$B/api/v1/pair/wait?code=$CODE" -H "Authorization: Bearer $PAIR")
DEVICE=$(echo "$WAIT" | jq -r .deviceId); TV=$(echo "$WAIT" | jq -r .deviceToken)
# 4. The owner puts shows on the TV's home screen, in order; 5. the TV reads it: what OK plays per show.
curl -s -X PUT $B/api/v1/admin/devices/$DEVICE/home -H "Authorization: Bearer $ADMIN" -H "$JSON" \
  -d '{"itemIds":["caminandes","tears-of-steel","big-buck-bunny"]}' | jq '.home[].itemId'
curl -s $B/api/v1/tv/state -H "Authorization: Bearer $TV" | jq '.home[] | {show: .item.title, next: .continue.episodeId, status: .continue.status}'
# 6. OK on Caminandes resolves the stream; 7. "finished" progress moves the show on to the next episode.
PLAY=$(curl -s -X POST $B/api/v1/tv/resolve -H "Authorization: Bearer $TV" -H "$JSON" -d '{"episodeId":"caminandes.s01e01"}')
echo "$PLAY" | jq '{sourceId, media, next: .next.episodeId}'
curl -s -X POST $B/api/v1/tv/progress -H "Authorization: Bearer $TV" -H "$JSON" \
  -d "{\"sessionId\":$(echo "$PLAY" | jq .sessionId),\"episodeId\":\"caminandes.s01e01\",\"positionMs\":90000,\"durationMs\":90000,\"status\":\"finished\"}"; echo
curl -s $B/api/v1/tv/state -H "Authorization: Bearer $TV" | jq '.home[0].continue | {episodeId, status}'   # caminandes.s01e02, new
```

Live updates for the TV stream from `GET /api/v1/tv/events` (server-sent events): run
`curl -N $B/api/v1/tv/events -H "Authorization: Bearer $TV"` and change the home list from another terminal.

### Android

Build, install and start the app on a TV emulator as in the [emulator loop](AGENTS.md#emulator-loop); debug builds
prefill the host's server address. The TV then shows a 6-digit pairing code: approve it (admin page, or step 2
above) and put shows on its home screen; the tiles, and everything else the owner controls, apply live without a
restart. On the TV, the remote's Menu key or holding OK opens the [hidden menu](docs/ux/senior-tv.md#hidden-menu).

## License

[MIT](LICENSE). Sample-catalog media and posters keep their own licenses; see
[`sample-catalog/NOTICE.md`](sample-catalog/NOTICE.md).
