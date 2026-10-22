# Releasing izle

Pushing a git tag `vX.Y.Z` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which publishes
a GitHub release with these files ([installed by owners](deploy/self-hosting.md)):

| File | What |
|---|---|
| `izle-server-X.Y.Z.tgz` | the server package (`npm pack` tarball, no dependencies; built by `scripts/pack-server.mjs` and checked by `scripts/smoke-server.mjs`) |
| `izle-tv-X.Y.Z.apk` | the Android TV app signed with the release key (only when the repository has the signing secrets, see below) |
| `izle-tv-X.Y.Z-debug.apk` | the debug build, always |
| `SHA256SUMS` | checksums |

Servers with `appUpdates.source: "github"` fetch `izle-tv-X.Y.Z.apk` and `SHA256SUMS` from the **latest
non-pre-release** and offer the APK to their TVs, so keep these file names, sign every release with the same key and
let the version (hence the `versionCode`) grow: a TV refuses an APK that is not newer or signed with another key.
Pre-releases are never fetched; test them with the admin page's upload.

## Cutting a release

1. `npm run version:set -- 0.2.0` sets the version of the contract and server packages, the lockfile and Android's
   `versionName` (`version:check` prints it); `versionCode` is derived (`1.2.3` → `10203`): minor and patch < 100.
2. In [`CHANGELOG.md`](../CHANGELOG.md), move the `## [Unreleased]` entries under a new `## [0.2.0] - YYYY-MM-DD`,
   keep the empty Unreleased heading and update the compare links; `git commit -am "Release 0.2.0" && git push`.
3. Wait for CI; optionally dry-run the workflow (artifacts on the run, no release): `gh workflow run release.yml`.
4. `git tag -a v0.2.0 -m "izle 0.2.0" && git push origin v0.2.0`. The workflow refuses a tag that does not match the
   repository's versions; a suffixed tag (`v0.2.0-rc.1`) becomes a pre-release.

Locally: `npm ci && npm run pack:server && npm run smoke:server` (into `dist/`); in `android/`, `./gradlew
:app:assembleDebug :app:assembleRelease`.

## Android release signing

Android only installs an update signed with the same key as the installed app; each CI run's debug APK has a new
throwaway key, which is why TVs should run the release APK. **Create the key once** and keep it and its password
safe and backed up: if it is lost, every TV has to uninstall izle (and pair again) for the next version. `keytool`
comes with any JDK (Android Studio: `/opt/android-studio/jbr/bin/keytool`):

```bash
keytool -genkeypair -v -keystore izle-release.jks -alias izle -keyalg RSA -keysize 4096 -validity 10000
```

Keep it outside the repository. **Local builds** read `android/keystore.properties` (git-ignored, like `*.jks`):

```properties
storeFile=/home/you/keys/izle-release.jks
storePassword=…
keyAlias=izle
keyPassword=…
```

`./gradlew :app:assembleRelease` then writes `app/build/outputs/apk/release/app-release.apk`; without the file or the
variables below it writes `app-release-unsigned.apk`, which Android does not install. Check a signature with
`$ANDROID_HOME/build-tools/<version>/apksigner verify --print-certs <apk>`.

**Releases from CI** use four repository secrets, which only the workflow's signing step (never a fork's pull
request) turns into the `IZLE_SIGNING_STORE_FILE`, `IZLE_SIGNING_STORE_PASSWORD`, `IZLE_SIGNING_KEY_ALIAS` and
`IZLE_SIGNING_KEY_PASSWORD` variables the Gradle build reads:

```bash
base64 -w0 izle-release.jks | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD      # prompts for the value
gh secret set ANDROID_KEY_ALIAS
gh secret set ANDROID_KEY_PASSWORD
```

A TV moving from a debug to a release APK needs `adb uninstall io.github.mickeiik.izle` first (else
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) and pairs again. Release builds are shrunk by R8 but not obfuscated
(`-dontobfuscate` in `android/app/proguard-rules.pro`), so stack traces and problem reports stay readable without a
mapping file; they start with an empty server address and ignore the debug-only `izle.server` extra. A crash or a
missing field only a release build shows is a missing keep rule for `proguard-rules.pro` (the libraries bring their
own). To try a release build over a debug install, sign `app-release-unsigned.apk` with the debug key
(`apksigner sign --ks ~/.android/debug.keystore --ks-pass pass:android`).

## Make-public checklist

The repository is private and was written to be published. Before switching its visibility, the owner (never an
automated session) goes through this list.

- [ ] **Secret scan of the whole history.** `gitleaks git .` (or
  `docker run --rm -v "$PWD":/repo:ro ghcr.io/gitleaks/gitleaks:latest git /repo`), then review every finding.
  Expect none: the made-up tokens of the log redaction tests are marked `gitleaks:allow` and listed in
  [`.gitleaksignore`](../.gitleaksignore).
- [ ] **Private names.** Search the history for your private catalogs, sources, hosts and repositories:
  `git log -p --all | grep -n -i -E 'name-one|name-two|private-host'`.
- [ ] **Author identities.** `git log --all --format='%an <%ae>' | sort -u`: every address becomes public; rewrite
  them (e.g. to your GitHub `noreply` address) if needed.
- [ ] **Tracked files.** `git ls-files | grep -E '\.(token|db|jks)$|keystore\.properties|(^|/)izle\.json$'` prints
  nothing.
- [ ] **Binary files are ours or licensed.** `git ls-files '*.jpg' '*.png' '*.apk'`: sample posters are listed in
  [`sample-catalog/NOTICE.md`](../sample-catalog/NOTICE.md), the example catalog's are generated, and the
  screenshots (`docs/images/`, `site/share-card.jpg`, and earlier commits') show only sample or generated content.
- [ ] **If something must go**, rewrite the history (`git filter-repo`) before publishing, and rotate whatever leaked.
- [ ] **Pinned actions.** Every `uses:` names a commit SHA with its release as a comment
  (`actions/checkout@<40-hex SHA> # v7.0.1`), which Dependabot ([`.github/dependabot.yml`](../.github/dependabot.yml))
  bumps together: `grep -h 'uses:' .github/workflows/*.yml | grep -v -E '@[0-9a-f]{40} # v[0-9]'` prints nothing.
- [ ] **Switch the visibility:** `gh repo edit mickeiik/izle --visibility public --accept-visibility-change-consequences`.
- [ ] **After publishing**, turn on Dependabot alerts and security updates, secret scanning with push protection, and
  private vulnerability reporting (where [`SECURITY.md`](../SECURITY.md) sends reporters; public repositories only).
  Then protect `main`, let only maintainers create `v*` tags (a ruleset), and keep "require approval for first-time
  contributors" for Actions. The security switches:
  ```bash
  gh api -X PUT repos/mickeiik/izle/vulnerability-alerts             # Dependabot alerts
  gh api -X PUT repos/mickeiik/izle/automated-security-fixes         # Dependabot security updates
  gh api -X PUT repos/mickeiik/izle/private-vulnerability-reporting
  gh api -X PATCH repos/mickeiik/izle -f 'security_and_analysis[secret_scanning][status]=enabled' \
    -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
  ```
