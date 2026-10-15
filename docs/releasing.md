# Releasing izle

Pushing a git tag `vX.Y.Z` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which
publishes a GitHub release with these files, installed by owners as in [deploy/self-hosting.md](deploy/self-hosting.md):

| File | What |
|---|---|
| `izle-server-X.Y.Z.tgz` | the server package (`npm pack` tarball, no dependencies; built by `scripts/pack-server.mjs` and checked by `scripts/smoke-server.mjs`) |
| `izle-tv-X.Y.Z.apk` | the Android TV app signed with the release key (only when the repository has the signing secrets, see below) |
| `izle-tv-X.Y.Z-debug.apk` | the debug build, always |
| `SHA256SUMS` | checksums |

## Cutting a release

1. Set the version everywhere (the contract and server packages, the lockfile and the Android `versionName`). The
   Android `versionCode` is derived from it (`1.2.3` → `10203`), so minor and patch stay below 100.
   ```bash
   npm run version:set -- 0.2.0
   npm run version:check                 # prints 0.2.0
   ```
2. In [`CHANGELOG.md`](../CHANGELOG.md), move the entries under `## [Unreleased]` to a new `## [0.2.0] - YYYY-MM-DD`
   heading, leave the Unreleased heading empty above it, and update the compare links at the bottom. Commit both
   steps together: `git commit -am "Release 0.2.0" && git push`.
3. Wait for CI to pass. Optionally dry-run the release workflow (same builds, artifacts attached to the run, no
   release): `gh workflow run release.yml --ref main`, or Actions → Release → Run workflow.
4. Tag and push: `git tag -a v0.2.0 -m "izle 0.2.0" && git push origin v0.2.0`. The workflow refuses a tag that does
   not match the versions in the repository; a tag with a suffix (`v0.2.0-rc.1`) becomes a pre-release.

To build the same files locally: `npm ci && npm run pack:server && npm run smoke:server` for the server (into
`dist/`), and `./gradlew :app:assembleDebug :app:assembleRelease` in `android/` for the APKs.

## Android release signing

Android only installs an update signed with the same key as the installed app. The debug APK of each CI run is
signed with a new throwaway key, which is why TVs should run the release APK.

**Create the key once** and keep it, with its password, somewhere safe and backed up: if it is lost, every TV has
to uninstall izle (and pair again) to get the next version. `keytool` comes with any JDK (Android Studio:
`/opt/android-studio/jbr/bin/keytool` or the equivalent):

```bash
keytool -genkeypair -v -keystore izle-release.jks -alias izle -keyalg RSA -keysize 4096 -validity 10000
```

Keep the keystore outside the repository (`*.jks` and `keystore.properties` are git-ignored anyway). **Local
builds** read `android/keystore.properties`:

```properties
storeFile=/home/you/keys/izle-release.jks
storePassword=…
keyAlias=izle
keyPassword=…
```

Then `./gradlew :app:assembleRelease` writes `app/build/outputs/apk/release/app-release.apk`; without the file (and
without the environment variables below) it produces `app-release-unsigned.apk`, which Android does not install.
Check a signature with `$ANDROID_HOME/build-tools/<version>/apksigner verify --print-certs <apk>`.

**Releases from CI** use four repository secrets, which the workflow's signing step (and nothing else; pull
requests from forks never get secrets) turns into the `IZLE_SIGNING_STORE_FILE`, `IZLE_SIGNING_STORE_PASSWORD`,
`IZLE_SIGNING_KEY_ALIAS` and `IZLE_SIGNING_KEY_PASSWORD` variables the Gradle build reads:

```bash
base64 -w0 izle-release.jks | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD      # prompts for the value
gh secret set ANDROID_KEY_ALIAS
gh secret set ANDROID_KEY_PASSWORD
```

**Moving a TV (or the emulator) from a debug to a release APK** needs `adb uninstall io.github.mickeiik.izle` before
`adb install izle-tv-X.Y.Z.apk`, because the keys differ (otherwise: `INSTALL_FAILED_UPDATE_INCOMPATIBLE`). The TV
then pairs again as a new TV: set up its home screen and forget the old entry on the admin page. Release builds have
no minification (R8 is off), start with an empty server address and ignore the debug-only `izle.server` launch
extra.

## Make-public checklist

The repository is private and was written to be published. Before switching its visibility, the owner (never an
automated session) goes through this list.

- [ ] **Secret scan of the whole history.** `gitleaks git .` (or
  `docker run --rm -v "$PWD":/repo:ro ghcr.io/gitleaks/gitleaks:latest git /repo`), then review every finding.
  Expect none: the only known hit, a made-up token the log redaction tests use as a hostile fixture, is marked
  with an inline `gitleaks:allow` and listed in [`.gitleaksignore`](../.gitleaksignore).
- [ ] **Private names.** Search the history for the names of your private catalogs, their sources, their hosts and
  your private repositories (only you know the list): `git log -p --all | grep -n -i -E 'name-one|name-two|private-host'`.
- [ ] **Author identities.** `git log --all --format='%an <%ae>' | sort -u`: every address shown becomes public;
  rewrite them (e.g. to your GitHub `noreply` address) if needed.
- [ ] **Tracked files.** Nothing like `*.token`, `*.db`, `*.jks`, `keystore.properties` or a local `izle.json`:
  `git ls-files | grep -E '\.(token|db|jks)$|keystore\.properties|(^|/)izle\.json$'` prints nothing.
- [ ] **Binary files are ours or licensed.** `git ls-files '*.jpg' '*.png' '*.apk'`: sample posters are listed in
  [`sample-catalog/NOTICE.md`](../sample-catalog/NOTICE.md), the example catalog's posters are generated, and the
  verification screenshots in earlier commits show only sample or generated content.
- [ ] **If something must go**, rewrite the history (`git filter-repo`) before publishing, and rotate whatever
  leaked anyway.
- [ ] **Pinned actions.** Every `uses:` in the workflows names a commit SHA with its release as a comment
  (`actions/checkout@<40-hex SHA> # v7.0.1`); Dependabot's weekly `github-actions` updates
  ([`.github/dependabot.yml`](../.github/dependabot.yml)) bump both together, so pin a new action the same way:
  `grep -h 'uses:' .github/workflows/*.yml | grep -v -E '@[0-9a-f]{40} # v[0-9]'` prints nothing.
- [ ] **Switch the visibility:** `gh repo edit mickeiik/izle --visibility public --accept-visibility-change-consequences`.
- [ ] **After publishing**, in the repository's security settings: turn on Dependabot alerts and Dependabot security
  updates (version updates run from `.github/dependabot.yml` already), secret scanning with push protection, and
  private vulnerability reporting, where [`SECURITY.md`](../SECURITY.md) sends reporters (GitHub offers it for public
  repositories only). Then protect `main`, add a ruleset so only maintainers can create `v*` tags, and keep "require
  approval for first-time contributors" for Actions. The security switches with `gh`:
  ```bash
  gh api -X PUT repos/mickeiik/izle/vulnerability-alerts             # Dependabot alerts
  gh api -X PUT repos/mickeiik/izle/automated-security-fixes         # Dependabot security updates
  gh api -X PUT repos/mickeiik/izle/private-vulnerability-reporting
  gh api -X PATCH repos/mickeiik/izle -f 'security_and_analysis[secret_scanning][status]=enabled' \
    -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
  ```
