# izle

A senior-first Android TV player with a small self-hosted server.

izle is built for a viewer who only knows classic TV: switch on, pick a "channel", it plays. The TV shows one
screen of big poster tiles. OK plays the next unwatched episode (or resumes the half-watched one), episodes
advance on their own, and Back always returns to that single home screen. There is no browsing, no seasons
list, no settings in the viewer's path.

Everything else is done remotely by the owner: which shows are on the home screen and in what order, "continue
from episode X", language settings, play/stop.

## Bring your own catalog

izle ships no content of its own. The server reads a **catalog bundle** — a data-only directory described by a
versioned contract — and, optionally, a **resolver module** the owner writes to turn catalog references into
playable streams at play time. A small [sample catalog](sample-catalog/) of openly licensed films (Blender
Foundation open movies and public-domain titles) is included and served by default.

- Catalog bundle contract: [`docs/spec/catalog-bundle-v1.md`](docs/spec/catalog-bundle-v1.md)
- Resolver module API: [`docs/spec/resolver-module-v1.md`](docs/spec/resolver-module-v1.md)
- Server API: [`docs/spec/server-api-v1.md`](docs/spec/server-api-v1.md)

Check a bundle with the validator from `@izle/contract`:

```bash
npx izle-validate sample-catalog          # schema + semantic checks
npm run sample:check                      # also range-GETs every sample media URL (network)
```

## Repository layout

| Path | What |
|---|---|
| `contract/` | `@izle/contract` — bundle types, JSON Schema, validator, `izle-validate` CLI |
| `server/` | `@izle/server` — Hono + `node:sqlite` server: pairing, TV API, admin API, live events |
| `sample-catalog/` | sample bundle of openly licensed content |
| `android/` | Android TV app (Kotlin, Compose for TV, Media3) |
| `docs/` | [roadmap](docs/roadmap.md), [decision log](docs/decisions.md), specs |

## Status

Early development. Done: Phase 0 (bootstrap), Phase 1 (catalog bundle contract, validator, sample catalog),
Phase 2 (server core for direct sources: pairing, TV and admin APIs, live events, progress and play order) and
Phase 3 (the Android TV app: pairing, home tiles, player with resume, auto-next, fallback and live updates, the
hidden menu, English and Turkish). Next are resolver modules with the media proxy and the browser admin UI; see
the [roadmap](docs/roadmap.md). How the TV behaves is described in [docs/ux/senior-tv.md](docs/ux/senior-tv.md),
with screenshots in [docs/verification/phase3/](docs/verification/phase3/README.md).

## Development

Requirements: Node.js ≥ 22.13 and npm; for the TV app a JDK 21+ and the Android SDK.

```bash
npm ci
npm test            # all workspaces
npm run typecheck
```

### Run the server

```bash
npm run -w server dev -- --config server/izle.dev.json
```

This serves the sample catalog on port 8787 and keeps its state in `server/data/` (SQLite database and the
admin token, created on first start). Without `--config` the server uses the same defaults with `./data`.
Print the admin token with:

```bash
npm run -s -w server dev -- admin-token --config server/izle.dev.json
```

### Try the API with curl

The flow a TV and its owner go through: pair, put shows on the home screen, read the home state, resolve a
stream, report progress. Needs `curl` and `jq`; run it in a second terminal while the server is running.

```bash
B=http://localhost:8787
ADMIN=$(npm run -s -w server dev -- admin-token --config server/izle.dev.json)

# 1. The TV asks for a pairing code and shows it on screen.
START=$(curl -s -X POST $B/api/v1/pair/start)
CODE=$(echo "$START" | jq -r .code); PAIR=$(echo "$START" | jq -r .pairToken)
echo "code on the TV: $CODE"

# 2. The owner approves the code and names the TV.
curl -s -X POST $B/api/v1/admin/pair/approve -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\",\"name\":\"Living room\"}"; echo

# 3. The TV's long-poll receives its device token (exactly once).
WAIT=$(curl -s "$B/api/v1/pair/wait?code=$CODE" -H "Authorization: Bearer $PAIR")
DEVICE=$(echo "$WAIT" | jq -r .deviceId); TV=$(echo "$WAIT" | jq -r .deviceToken)

# 4. The owner chooses what appears on the TV's home screen, in order.
curl -s -X PUT $B/api/v1/admin/devices/$DEVICE/home -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"itemIds":["caminandes","tears-of-steel","big-buck-bunny"]}' | jq '.home[].itemId'

# 5. The TV reads its home screen: one tile per show, with what OK will play.
curl -s $B/api/v1/tv/state -H "Authorization: Bearer $TV" | jq '.home[] | {show: .item.title, next: .continue.episodeId, status: .continue.status}'

# 6. OK on Caminandes: resolve the stream for the episode the tile points at.
PLAY=$(curl -s -X POST $B/api/v1/tv/resolve -H "Authorization: Bearer $TV" \
  -H 'Content-Type: application/json' -d '{"episodeId":"caminandes.s01e01"}')
echo "$PLAY" | jq '{sourceId, media, next: .next.episodeId}'

# 7. The player reports progress; "finished" moves the show on to the next episode.
curl -s -X POST $B/api/v1/tv/progress -H "Authorization: Bearer $TV" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":$(echo "$PLAY" | jq .sessionId),\"episodeId\":\"caminandes.s01e01\",\"positionMs\":90000,\"durationMs\":90000,\"status\":\"finished\"}"; echo
curl -s $B/api/v1/tv/state -H "Authorization: Bearer $TV" | jq '.home[0].continue | {episodeId, status}'
```

The last command shows `caminandes.s01e02` with status `new`. Live updates for the TV stream from
`GET /api/v1/tv/events` (server-sent events): `curl -N $B/api/v1/tv/events -H "Authorization: Bearer $TV"`, then
change the home list again from another terminal.

### Android

From `android/`, with `JAVA_HOME` (JDK 21+, e.g. Android Studio's bundled JBR) and `ANDROID_HOME` set:

```bash
./gradlew :app:assembleDebug :app:testDebugUnitTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.github.mickeiik.izle/.MainActivity --es izle.server http://10.0.2.2:8787
```

The emulator reaches a server on the host at `http://10.0.2.2:8787` (debug builds also prefill that address on
the first-run screen; `--es izle.server` skips typing it). The TV then shows a 6-digit pairing code: approve it
as in step 2 of the curl flow above, put shows on its home screen (step 4), and the tiles appear on the TV
without a restart. Everything else the owner controls — order, "continue from", languages, play/stop — applies
live the same way. On the TV, the remote's Menu key or holding OK opens a hidden menu (episodes, start over,
audio, subtitles, settings, about).

## License

[MIT](LICENSE). Sample-catalog media and posters keep their own licenses; see
[`sample-catalog/NOTICE.md`](sample-catalog/NOTICE.md).
