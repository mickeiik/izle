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
