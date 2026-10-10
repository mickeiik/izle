# AGENTS.md

Guidance for coding agents (and humans) working in this repository. The plan is
[docs/roadmap.md](docs/roadmap.md); routine decisions are logged in [docs/decisions.md](docs/decisions.md) —
read both before starting, and append to the decision log whenever you make a choice the roadmap does not
settle.

## Product principles

- The senior's path is **home → OK → plays**. Nothing else is visible on the TV: no browsing, no settings, no
  dialogs that need reading small text. Back always returns to the home screen; Back on Home is consumed.
- Every error path ends back on Home on its own (with a short, large message).
- Everything configurable is controlled remotely by the owner (admin API/UI), or hidden behind the long-press
  menu on the TV.

## Hard invariants

- The server loads catalog bundles and resolver modules **from local paths only**. It never downloads, installs
  or updates code or catalogs by itself.
- **No stream URLs, upstream headers, adapter refs, tokens or playlist text in logs.** Everything goes through
  the single `redact()` helper; tests assert this with hostile fixtures.
- Upstream request headers never reach the TV; header-bound media is served through the server proxy.
- The catalog bundle contract and the resolver module API are **versioned**. Within v1 only additive, optional
  changes are allowed (documented in the spec changelog); anything else bumps the version.
- **No source-specific code, fixtures, hostnames or links to private repositories.** izle is
  bring-your-own-catalog: private catalogs and their resolvers live out of tree. Never write secrets, tokens or
  private source names into this repository.
- Automated tests never touch the network; they use local fixtures and in-process servers.

## Commands

Root (npm workspaces `contract`, `server`):

```bash
npm ci
npm test                 # node:test in every workspace
npm run typecheck        # tsc --noEmit in every workspace
npm run sample:check     # probes every sample-catalog media URL (network; manual, not CI)
```

- `contract/`: `npm test -w contract`, `npx izle-validate <bundleDir> [--probe]`
- `server/`: `npm test -w server`, `npm run -w server dev -- --config server/izle.dev.json` (sample catalog on :8787,
  state in `server/data/`), `npm run -s -w server dev -- admin-token --config server/izle.dev.json`,
  `npm run -s -w server dev -- check-resolver --config <file>`
- Resolver module + proxy end to end: [server/examples/resolver-example/](server/examples/resolver-example/README.md)
  (`make-media.sh` needs ffmpeg; `upstream.js` is the local stand-in site; `izle.example.json` the server config,
  state in `server/data/example/`)
- `android/` (needs `JAVA_HOME` = JDK 21+ and `ANDROID_HOME`): `./gradlew :app:assembleDebug :app:testDebugUnitTest`

TypeScript is run directly by `tsx`; there is no build step for development. Use `.ts` extensions in relative
imports, ESM only, erasable syntax only (no enums, no parameter properties, no namespaces).

## Android notes

- AGP 9 has built-in Kotlin: **never apply `org.jetbrains.kotlin.android`**. It is declared `apply false` in the
  root build only to lift the Kotlin Gradle Plugin version; check with `./gradlew buildEnvironment`.
- `compileSdk` 37 (required by the compose BOM), `targetSdk` 36, `minSdk` 24.

## Emulator loop

```bash
$ANDROID_HOME/emulator/emulator -avd <tv-avd> -no-window -no-audio -gpu swiftshader_indirect -no-snapshot &
adb wait-for-device
(cd android && ./gradlew :app:assembleDebug) && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.github.mickeiik.izle/.MainActivity --es izle.server http://10.0.2.2:8787   # debug builds
adb shell input keyevent KEYCODE_DPAD_CENTER     # hidden menu: KEYCODE_MENU or --duration 1000 KEYCODE_DPAD_CENTER
adb exec-out screencap -p > /tmp/izle.png
```

The emulator reaches a server on the host at `http://10.0.2.2:8787`. Approve the TV's pairing code with
`POST /api/v1/admin/pair/approve` (see the README's curl flow). `input keyevent --longpress` holds OK for only
400 ms, shorter than the app's 0.6 s long press, so it acts as a click. The UX rules the app implements are in
[docs/ux/senior-tv.md](docs/ux/senior-tv.md).
