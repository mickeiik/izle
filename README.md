# izle

A senior-first Android TV player with a small self-hosted server.

izle is built for a viewer who only knows classic TV: switch on, pick a "channel", it plays. The TV shows one
screen of big poster tiles. OK plays the next unwatched episode (or resumes the half-watched one), episodes
advance on their own, and Back always returns to that single home screen. There is no browsing, no seasons
list, no settings in the viewer's path.

Everything else is done remotely by the owner from a browser: which shows are on the home screen and in what
order, "continue from episode X", language settings, play/stop.

## Bring your own catalog

izle ships no content of its own. The server reads a **catalog bundle** — a data-only directory described by a
versioned contract — and, optionally, a **resolver module** the owner writes to turn catalog references into
playable streams at play time. A small [sample catalog](sample-catalog/) of openly licensed films (Blender
Foundation open movies and public-domain titles) is included and served by default.

- Catalog bundle contract: [`docs/spec/catalog-bundle-v1.md`](docs/spec/catalog-bundle-v1.md)
- Resolver module API: [`docs/spec/resolver-module-v1.md`](docs/spec/resolver-module-v1.md)

Check a bundle with the validator from `@izle/contract`:

```bash
npx izle-validate sample-catalog          # schema + semantic checks
npm run sample:check                      # also range-GETs every sample media URL (network)
```

## Repository layout

| Path | What |
|---|---|
| `contract/` | `@izle/contract` — bundle types, JSON Schema, validator, `izle-validate` CLI |
| `server/` | `@izle/server` — Hono + `node:sqlite` server: pairing, TV API, admin API |
| `sample-catalog/` | sample bundle of openly licensed content |
| `android/` | Android TV app (Kotlin, Compose for TV, Media3) |
| `docs/` | [roadmap](docs/roadmap.md), [decision log](docs/decisions.md), specs |

## Status

Early development. Done: Phase 0 (bootstrap: `/healthz` server, hello-world TV app) and Phase 1 (catalog bundle
contract, validator, sample catalog). See the [roadmap](docs/roadmap.md) for what comes next.

## Development

Requirements: Node.js ≥ 22.13, npm; for the TV app a JDK 21+ and the Android SDK.

```bash
npm ci
npm test            # all workspaces
npm run typecheck
npm run -w server dev   # server on http://localhost:8787
curl -s localhost:8787/healthz
```

Android (from `android/`, with `JAVA_HOME` and `ANDROID_HOME` set):

```bash
./gradlew :app:assembleDebug :app:testDebugUnitTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## License

[MIT](LICENSE). Sample-catalog media and posters keep their own licenses; see
[`sample-catalog/NOTICE.md`](sample-catalog/NOTICE.md).
