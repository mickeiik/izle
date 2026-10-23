# izle

[![CI](https://github.com/mickeiik/izle/actions/workflows/ci.yml/badge.svg)](https://github.com/mickeiik/izle/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mickeiik/izle)](https://github.com/mickeiik/izle/releases/latest)
[![License: MIT](https://img.shields.io/github/license/mickeiik/izle)](LICENSE)

A senior-first Android TV player with a small self-hosted server. Project page: <https://mickeiik.github.io/izle/>

| The TV: one screen, OK plays | The owner's admin page |
|---|---|
| ![The TV's home screen: a grid of poster cards; the focused one is open, with the show's name, "Continue", "Episode 1" and a progress bar](docs/images/tv-home.jpg) | ![The admin page of a TV, its Home screen tab: the TV's home drawn to scale, its grid, its sections and the chosen show](docs/images/admin-tv-page.jpg) |
| ![The player, paused: show, episode and a progress bar in large type](docs/images/tv-player.jpg) | ![A message from the owner, "Dinner is ready!", in large letters over the picture](docs/images/tv-message.jpg) |

izle is built for a viewer who only knows classic TV: switch on, pick a "channel", it plays. The TV shows one
grid of big cards: shows and live channels. OK plays the next unwatched episode (or resumes the half-watched one)
or a channel at its live edge; episodes advance on their own, CH+/CH− switch between channels, and Back always
returns to that single home screen. There is no browsing, no seasons list, no settings in the viewer's path.

Everything else is done remotely by the owner from the server's admin page, on a phone or a computer:

- which shows are on each TV's home screen, in what order, and "continue from episode X"
- menu, audio and subtitle languages, autoplay when the TV starts
- what is playing right now: play, stop, pause, seek, skip episodes, and a short message in large letters on screen
- the problems a TV ran into, and a test of every episode's sources
- **listen along**: the phone plays another source of the episode the TV is showing (a dub in another language) in
  sync with the picture, with an adjustable offset and speed for releases that differ in timing
- the viewing history: what was watched when and how much of it, per TV and per title, with the owner's own marks
- access tokens with a scope, so the owner's own scripts or an AI agent can watch the TVs, play something, change a
  home screen, through the same API and a live event stream

The TV app always talks to the server (there is no standalone mode) and is in English and Turkish.

**Status:** early development (see the [changelog](CHANGELOG.md)). Server, TV app, admin page and self-hosting
setup work; expect rough edges.

## Quick start (about 10 minutes)

Try izle with the included sample catalog of openly licensed films. You need a computer with Docker and Git, and an
Android TV (or Google TV) on the same network, or an Android TV emulator.

**1. Start the server** on the computer, then print the admin token and sign in at `http://localhost:8787/admin/`
(from a phone: add `--link --base http://<computer's address>:8787` for a sign-in link and QR code):

```bash
git clone https://github.com/mickeiik/izle.git && cd izle
docker build -t izle-server .
docker run -d --name izle --restart unless-stopped -p 8787:8787 -v izle-data:/var/lib/izle izle-server
docker exec izle izle-server admin-token --config /etc/izle/izle.json
```

**2. Install the TV app.** Download `izle-tv-X.Y.Z-debug.apk` from the
[latest release](https://github.com/mickeiik/izle/releases/latest) and install it with
[adb](https://developer.android.com/tools/releases/platform-tools), after turning on USB or wireless debugging in
the TV's developer options:

```bash
adb connect <TV's address>:5555
adb install izle-tv-X.Y.Z-debug.apk
```

The debug APK is for trying izle: a later APK cannot be installed over it. For a TV you will keep using, take
`izle-tv-X.Y.Z.apk`; other ways to install, and how later releases reach the TV through the server:
[self-hosting guide § 8](docs/deploy/self-hosting.md#8-install-the-tv-app).

**3. Pair the TV.** Start izle on the TV and enter `http://<computer's address>:8787` (on the emulator, keep the
prefilled `http://10.0.2.2:8787`). Approve the 6-digit code it shows on the admin page under **TVs**.

**4. Put shows on its home screen.** On the TV's page, add a few sample films under **Home screen**; they appear on
the TV at once. Press OK on one, and try **Now playing** and **Message to the TV** from the admin page while it plays.

To remove everything afterwards: `docker rm -f izle && docker volume rm izle-data`, and uninstall the app.

## Your own content

izle ships no content of its own. The server reads a **catalog bundle**: a data-only directory (`bundle.json`,
`items.json` and the posters) that lists the shows (their episodes in play order) and the live channels, and where
each video or stream is. The [sample catalog](sample-catalog/) is one. Videos are HLS, DASH or progressive files
(MP4) at http(s) URLs; a channel is a live HLS or DASH playlist or a raw MPEG-TS stream.

- How a bundle is built: [catalog bundle contract](docs/spec/catalog-bundle-v1.md); check one with
  `npx izle-validate <dir>` (`--probe` also checks that every video answers).
- Streams that need resolving at play time (signed, expiring URLs, a required `Referer`): write a
  [resolver module](docs/spec/resolver-module-v1.md); a runnable [example](server/examples/resolver-example/README.md)
  comes with a local stand-in streaming site. Streams that need upstream headers or come as playlist text reach the TV
  through the server's media proxy, so those headers and the upstream URLs never do.

## Running it for real

Each [release](https://github.com/mickeiik/izle/releases) has the server as one dependency-free package
(`izle-server-X.Y.Z.tgz`, Node.js ≥ 22.13) and the TV app as an APK. The [self-hosting guide](docs/deploy/self-hosting.md)
covers systemd or Docker, HTTPS with Caddy for TVs outside your home, your own catalog and resolver module, backups
and updates, installing the app, and troubleshooting. Security problems are reported privately:
[SECURITY.md](SECURITY.md).

## Development

Node.js ≥ 22.13 and npm (`npm ci && npm test`); for the TV app a JDK 21+ and the Android SDK. Every command is in
[AGENTS.md](AGENTS.md#commands); making releases: [docs/releasing.md](docs/releasing.md).

| Path | What |
|---|---|
| `contract/` | `@izle/contract` — bundle types, JSON Schema, validator, `izle-validate` CLI |
| `server/` | `@izle/server` — Hono + `node:sqlite` server: pairing, TV and admin APIs, live events, resolver modules, media proxy, admin page (`server/admin/`) |
| `server/examples/resolver-example/` | example resolver module with a local stand-in upstream and catalog |
| `sample-catalog/` | sample bundle of openly licensed content |
| `android/` | Android TV app (Kotlin, Compose for TV, Media3) |
| `scripts/` | release tooling: server package build (`pack-server.mjs`) and smoke test, version bump/check |
| `Dockerfile` | container image of the server package |
| `docs/` | specs ([catalog bundle](docs/spec/catalog-bundle-v1.md), [resolver module](docs/spec/resolver-module-v1.md), [server API](docs/spec/server-api-v1.md)), UX ([TV](docs/ux/senior-tv.md), [admin Home](docs/ux/admin-home.md)), [self-hosting](docs/deploy/self-hosting.md), [releasing](docs/releasing.md), [decision log](docs/decisions.md) |

### Try the API with curl

What a TV and its owner do, against the development server with the sample catalog
([server API](docs/spec/server-api-v1.md)); needs `curl` and `jq`. Start `npm run -w server dev -- --config
server/izle.dev.json`, then in a second terminal:

```bash
B=http://localhost:8787; J='Content-Type: application/json'
dev() { npm run -s -w server dev -- "$@" --config server/izle.dev.json; }
ADMIN="Authorization: Bearer $(dev admin-token)"
START=$(curl -s -X POST $B/api/v1/pair/start); CODE=$(echo "$START" | jq -r .code)   # the TV shows a code
dev pair approve $CODE Living room                                                    # the owner approves it
WAIT=$(curl -s "$B/api/v1/pair/wait?code=$CODE" -H "Authorization: Bearer $(echo "$START" | jq -r .pairToken)")
DEVICE=$(echo "$WAIT" | jq -r .deviceId); TV="Authorization: Bearer $(echo "$WAIT" | jq -r .deviceToken)"
curl -s -X PUT $B/api/v1/admin/devices/$DEVICE/home -H "$ADMIN" -H "$J" -d '{"itemIds":["caminandes","sintel"]}' >/dev/null
curl -s $B/api/v1/tv/state -H "$TV" | jq -c '.home[] | {show: .item.title, next: .continue.episodeId}'
curl -s -X POST $B/api/v1/tv/resolve -H "$TV" -H "$J" -d '{"episodeId":"caminandes.s01e01"}' | jq -c '{sourceId, media}'
curl -s -X POST $B/api/v1/tv/progress -H "$TV" -H "$J" \
  -d '{"episodeId":"caminandes.s01e01","positionMs":90000,"durationMs":90000,"status":"finished"}'   # cursor moves on
AGENT="Authorization: Bearer $(dev token create Agent --scope control | tail -1)"                   # an access token
curl -s -X POST $B/api/v1/admin/devices/$DEVICE/commands -H "$AGENT" -H "$J" -d '{"type":"play","itemId":"sintel"}'
curl -s "$B/api/v1/admin/events?after=0&types=home.,command." -H "$AGENT" | jq -c '.events[] | {type, data}'
```

`curl -N $B/api/v1/tv/events -H "$TV"` follows the TV's live updates, `curl -N $B/api/v1/admin/events/stream -H
"$AGENT"` the event log.

## License

[MIT](LICENSE). Sample-catalog media and posters keep their own licenses; see
[`sample-catalog/NOTICE.md`](sample-catalog/NOTICE.md). The screenshots show sample-catalog films and generated test
media.
